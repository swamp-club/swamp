// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  createWorkflowRunClaims,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import { renderNestedCascade } from "./nested_run_hints.ts";
import { UserError } from "../../domain/errors.ts";
import {
  normalizeServerUrl,
  redactServerUrl,
} from "../../domain/auth/server_url.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  type WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { CLEANUP_GRACE_TIMEOUT_MS } from "../../domain/workflows/execution_service.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  isProcessAlive,
  killProcessTree,
} from "../../infrastructure/process/process_kill.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import {
  cancelOrphanedMethodRuns,
  type MethodRunOutputs,
  type OwnerLiveness,
  warnUnsettledMethodRuns,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import {
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { RUN_CANCEL_GRACE_MS } from "../../serve/suspended_run_cancel.ts";
import { GATE_WAIT_TIMEOUT_MS } from "../../serve/sync_gate.ts";
import {
  type BrokenWorkflow,
  listBrokenWorkflows,
  workflowsDirFor,
} from "../../libswamp/workflows/broken_workflow.ts";
import type { DetachedNestedRunData } from "../../libswamp/workflows/nested_runs.ts";
import {
  type CascadedNestedRunData,
  emptyNestedCascade,
  mergeNestedCascade,
  nestedCascadeFields,
  type NestedCascadeResult,
} from "../../libswamp/workflows/nested_cascade.ts";
import { localNestedCascade } from "../local_nested_cascade.ts";
import type { WorkflowRunSummary } from "../../domain/workflows/workflow_run_summary.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { basename } from "@std/path";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Builds the serve cancel endpoint URL from the --server value. Starts from
 * the normalized http(s) URL, so userinfo, query string and fragment never
 * reach the request URL or its error text.
 */
export function buildCancelUrl(server: string, runId: string): string {
  let base: string;
  try {
    base = normalizeServerUrl(server);
  } catch {
    const shown = redactServerUrl(server);
    throw new UserError(
      `Invalid --server URL${
        shown === undefined ? "" : ` '${shown}'`
      } — expected ws://host:port (or http://)`,
    );
  }
  return `${base}/api/v1/cancel/workflow-run/${encodeURIComponent(runId)}`;
}

/**
 * How long `--server` waits for the cancel endpoint to answer. Cancelling a
 * run serve is driving waits up to {@link RUN_CANCEL_GRACE_MS} for it to stop,
 * then may wait for the sync gate (up to {@link GATE_WAIT_TIMEOUT_MS}) to
 * cancel a run the resume left suspended, then pushes. The margin covers the
 * suspended-run lookup and the push.
 */
export const SERVER_CANCEL_TIMEOUT_MS = RUN_CANCEL_GRACE_MS +
  GATE_WAIT_TIMEOUT_MS + 30_000;

/**
 * The error for a `--server` cancel request that got no answer. A timeout
 * says the cancel may still complete, because the server keeps working on it
 * after the client stops waiting.
 */
export function serverCancelFailure(
  server: string,
  runId: string,
  error: unknown,
): UserError {
  const shown = redactServerUrl(server) ?? "(invalid URL)";
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new UserError(
      `No answer from ${shown} within ${
        SERVER_CANCEL_TIMEOUT_MS / 1000
      }s. The cancel may still complete on the server; check it with 'swamp workflow history get ${runId} --server ${shown}'.`,
    );
  }
  return new UserError(
    `Could not connect to ${shown}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/**
 * The error for a `--server` cancel the server refused. Serve answers most
 * refusals with a JSON `{status, message}` body, whose message is shown on its
 * own; plain-text answers (401, 429) keep the status for context.
 */
export function serverCancelRejection(
  status: number,
  statusText: string,
  text: string,
): UserError {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const message = (body as Record<string, unknown>).message;
      if (typeof message === "string" && message !== "") {
        return new UserError(message);
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return new UserError(`Server returned ${status}: ${text || statusText}`);
}

export function isServeOwnedRun(run: WorkflowRun): boolean {
  return run.instanceId !== undefined;
}

/**
 * How long cancel waits for a run's owning process to exit after SIGTERM
 * before it SIGKILLs it. The owner runs the cancelled run's always/completed
 * cleanup steps under {@link CLEANUP_GRACE_TIMEOUT_MS}; the margin covers the
 * wait for the model methods the abort interrupted to stop and save their
 * method runs (at most `STEP_STOP_GRACE_MS` after the abort) and the owner's
 * final save of the run. It does not budget a slow push to a remote datastore
 * after cleanup, nor a second cleanup level; an owner still running then is
 * killed, and the record it left is settled with
 * {@link OWNER_STOPPED_STEP_ERROR}.
 */
export const OWNER_STOP_GRACE_MS = CLEANUP_GRACE_TIMEOUT_MS + 10_000;

const STOP_GRACE_SECONDS = OWNER_STOP_GRACE_MS / 1000;

export interface CancelLocalRunDeps {
  runRepo: Pick<WorkflowRunRepository, "findById" | "save">;
  /** Reads a run's own evaluated workflow snapshot, to settle it against. */
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  /** The tracker rows of the stopped owner, closed once it is gone. */
  runTracker: RunTrackerRepository;
  /**
   * Claims the run while its record is settled, so the cancel acts on the
   * run as stored and no other writer saves over it (swamp-club#2919).
   */
  runClaims: WorkflowRunClaims;
  /** The method-run records of the stopped owner's steps. */
  outputRepo: MethodRunOutputs;
  killProcess?: (
    pid: number,
    options: { maxWaitMs: number },
  ) => Promise<boolean>;
  /** Whether a stopped owner is gone; defaults to this host's process table. */
  liveness?: OwnerLiveness;
}

/**
 * The id of the workflow whose runs hold `run`. A run whose definition is
 * gone has only the id it recorded.
 */
function workflowIdOf(
  run: WorkflowRun,
  workflow: Workflow | undefined,
): WorkflowId {
  return workflow?.id ?? createWorkflowId(run.workflowId);
}

/** The workflow's current name, or the one `run` recorded when it is gone. */
function workflowNameOf(
  run: WorkflowRun,
  workflow: Workflow | undefined,
): string {
  return workflow?.name ?? run.workflowName;
}

/** The pid of the process to stop for `run`, if another process owns it. */
function ownerPidToStop(run: WorkflowRun): number | undefined {
  return run.pid && run.pid !== Deno.pid ? run.pid : undefined;
}

/** Whether cancel will wait on a live process to stop for `run`. */
function waitsOnOwner(run: WorkflowRun): boolean {
  const pid = ownerPidToStop(run);
  return pid !== undefined && isProcessAlive(pid);
}

async function stopOwner(
  pid: number,
  killProcess: NonNullable<CancelLocalRunDeps["killProcess"]>,
): Promise<void> {
  await killProcess(pid, { maxWaitMs: OWNER_STOP_GRACE_MS });
}

/**
 * Closes what a stopped owner left open: an owner killed after its grace, or
 * one that died before the cancel, never completed its tracker rows or saved
 * its steps' method runs. Each method run still `running` under its pid is
 * cancelled with {@link OWNER_STOPPED_STEP_ERROR}, as its step is, and then
 * its method rows, and the rows of the `cancelled` runs, still `running` on
 * this host are completed `cancelled` with `reason`. Another workflow run of
 * the same process, such as a nested child this cancel does not settle,
 * keeps its row for `run doctor`. An owner that settled itself left nothing
 * running, and one still alive is left alone. A method run whose output
 * cannot be read or saved does not stop the cancel: its row is marked
 * `interrupted` instead, so `run doctor --fix` settles it later.
 */
async function closeStoppedOwnerRuns(
  pid: number,
  cancelled: ReadonlySet<string>,
  reason: string,
  { runTracker, outputRepo, liveness = localOwnerLiveness() }: Pick<
    CancelLocalRunDeps,
    "runTracker" | "outputRepo" | "liveness"
  >,
): Promise<void> {
  if (!liveness.isDead(pid)) return;
  const rows = runTracker.findAllRunning().filter((row) =>
    row.pid === pid &&
    row.isLocalTo(liveness.hostname, liveness.instanceId) &&
    (row.runKind === "model_method" || cancelled.has(row.id))
  );
  const { failed, errors } = await cancelOrphanedMethodRuns(
    outputRepo,
    rows.filter((row) => row.runKind === "model_method"),
    OWNER_STOPPED_STEP_ERROR,
  );
  warnUnsettledMethodRuns(failed.length, errors);
  const unsettled = new Set(failed.map((row) => row.id));
  for (const row of rows) {
    if (unsettled.has(row.id)) {
      runTracker.complete(row.id, "interrupted");
    } else {
      runTracker.complete(row.id, "cancelled", reason);
    }
  }
}

/**
 * A run this cancel left as it found it under the claim, because another
 * process had taken it over.
 */
export class RunNotCancelledError extends UserError {
  constructor(message: string, readonly status: string) {
    super(message);
    this.name = "RunNotCancelledError";
  }
}

/** A live process that took the run over before cancel claimed it. */
interface TakenOver {
  takenOverBy: number;
}

/**
 * How many times one cancel stops a process that took the run over before
 * giving up. Each needs a new `workflow resume` to win the run's claim in the
 * moment between a stop and the settle that follows it.
 */
const MAX_TAKE_OVER_STOPS = 3;

/**
 * Settles the run's record (see {@link settleCancelledRun}), first stopping
 * any process that took the run over since the caller stopped its owners.
 * `stopped` holds the pids already stopped and gains each one stopped here.
 * Throws {@link RunNotCancelledError}, having saved nothing, for a run a
 * serve instance took over or one that keeps being taken over.
 */
async function settleStoppingNewOwners(
  run: WorkflowRun,
  workflow: Workflow | undefined,
  reason: string,
  stopped: Set<number>,
  killProcess: NonNullable<CancelLocalRunDeps["killProcess"]>,
  deps: Omit<CancelLocalRunDeps, "killProcess">,
): Promise<WorkflowRun | null> {
  for (let stops = 0;; stops++) {
    const outcome = await settleCancelledRun(
      run,
      workflow,
      reason,
      stopped,
      deps,
    );
    if (outcome === null || !("takenOverBy" in outcome)) return outcome;
    const pid = outcome.takenOverBy;
    if (stops >= MAX_TAKE_OVER_STOPS) {
      throw new RunNotCancelledError(
        `Run ${run.id} is running under another process (pid ${pid}) and was not cancelled. Cancel it again.`,
        "running",
      );
    }
    await stopOwner(pid, killProcess);
    await closeStoppedOwnerRuns(pid, new Set([run.id]), reason, deps);
    stopped.add(pid);
  }
}

/**
 * Re-reads a run whose owner was stopped: the owner saves its own final
 * record while handling SIGTERM, and saving the pre-kill snapshot would
 * overwrite it. A run the owner already finished keeps its record (a
 * cancelled one gets this reason); a run still active is cancelled, its
 * unfinished jobs and steps settled against the run's evaluated snapshot, or
 * else `workflow`, or from its records alone when the definition is gone
 * too, with the steps its stopped owner left running failed with
 * {@link OWNER_STOPPED_STEP_ERROR}. Returns the persisted run, or null when
 * the record no longer exists.
 *
 * The read, the settlement and the save hold the run's claim, so an approve
 * or reject of the same run lands wholly before or wholly after them.
 *
 * A resume can take the run over after the caller chose which owners to stop
 * and before the claim is taken here. The record then reads `running` under a
 * live process that is not in `stopped`. Nothing is saved over it: its pid is
 * returned as {@link TakenOver} for the caller to stop first.
 */
async function settleCancelledRun(
  run: WorkflowRun,
  workflow: Workflow | undefined,
  reason: string,
  stopped: ReadonlySet<number>,
  {
    runRepo,
    findEvaluatedWorkflow,
    runClaims,
    liveness = localOwnerLiveness(),
  }: Pick<
    CancelLocalRunDeps,
    "runRepo" | "findEvaluatedWorkflow" | "runClaims" | "liveness"
  >,
): Promise<WorkflowRun | TakenOver | null> {
  const workflowId = workflowIdOf(run, workflow);
  return await runClaims.withClaim(run.id, async () => {
    const current = await runRepo.findById(workflowId, run.id);
    if (!current) {
      return null;
    }
    const owner = ownerPidToStop(current);
    if (
      current.status === "running" && owner !== undefined &&
      !stopped.has(owner) && !liveness.isDead(owner)
    ) {
      // A serve instance resumed the run. Its pid is the server's own, which
      // drives every other run it has: it is never stopped from here.
      if (isServeOwnedRun(current)) {
        throw new RunNotCancelledError(
          `Run ${run.id} was taken over by a serve instance and was not cancelled. ` +
            `Use --server to cancel it: swamp workflow cancel --run ${run.id} --server <url>`,
          current.status,
        );
      }
      return { takenOverBy: owner };
    }
    if (current.isCancellable) {
      cancelAndSettle(
        current,
        await resolveSettlementWorkflow(
          current,
          workflow,
          findEvaluatedWorkflow,
        ),
        reason,
        current.status === "running"
          ? { inFlightStepError: OWNER_STOPPED_STEP_ERROR }
          : undefined,
      );
    } else if (current.status === "cancelled") {
      current.recordCancelReason(reason);
    } else {
      return current;
    }
    await runRepo.save(workflowId, current);
    return current;
  });
}

/**
 * Cancels a locally-owned run. Stops the owning process first, giving it
 * {@link OWNER_STOP_GRACE_MS} to run cleanup and save its own outcome, closes
 * what it left open (see {@link closeStoppedOwnerRuns}), then settles the
 * record (see {@link settleCancelledRun}), stopping a process that took the
 * run over in between. `workflow` is undefined for a run whose definition
 * was deleted. Returns the persisted run, or null when the record no longer
 * exists.
 */
export async function cancelLocalRun(
  run: WorkflowRun,
  workflow: Workflow | undefined,
  reason: string,
  { killProcess = killProcessTree, ...deps }: CancelLocalRunDeps,
): Promise<WorkflowRun | null> {
  const stopped = new Set<number>();
  const pid = ownerPidToStop(run);
  if (pid !== undefined) {
    await stopOwner(pid, killProcess);
    await closeStoppedOwnerRuns(pid, new Set([run.id]), reason, deps);
    stopped.add(pid);
  }
  return await settleStoppingNewOwners(
    run,
    workflow,
    reason,
    stopped,
    killProcess,
    deps,
  );
}

/** Runs `fn` with the repository's run tracker open. */
async function withRunTracker<T>(
  repoDir: string,
  fn: (runTracker: RunTrackerRepository) => Promise<T>,
): Promise<T> {
  const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  try {
    return await fn(runTracker);
  } finally {
    runTracker.close();
  }
}

/** A run to cancel, with its workflow's definition when one still exists. */
export interface LocalCancelTarget {
  run: WorkflowRun;
  workflow: Workflow | undefined;
}

export interface CancelAllResult {
  cancelled: { runId: string; workflowName: string; previousStatus: string }[];
  /** Runs that reached another terminal status before the cancel landed. */
  finished: {
    runId: string;
    workflowName: string;
    previousStatus: string;
    status: string;
  }[];
  /** Runs whose record was deleted during the cancel. */
  deleted: { runId: string; workflowName: string }[];
  /**
   * Runs left as they were: another process took them over during the
   * cancel, or their claim could not be taken in time.
   */
  notCancelled: {
    runId: string;
    workflowName: string;
    status: string;
    reason: string;
  }[];
  /** A run in `notCancelled` is there because its claim timed out. */
  claimTimedOut: boolean;
}

/** The exit code of a lock timeout (EX_TEMPFAIL): retry with backoff. */
const LOCK_TIMEOUT_EXIT_CODE = 75;

/** Whether `error` is a lock timeout, core's or a datastore extension's. */
function isLockTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code.toLowerCase() === "lock_timeout";
}

/**
 * Cancels locally-owned runs and sorts the outcomes, so only runs that
 * actually ended cancelled count as cancelled. The owning processes are
 * stopped together so their cleanup grace periods overlap, each process once:
 * a nested workflow run shares its parent's process, and a second SIGTERM
 * makes an owner exit at once, skipping its cleanup. Records are then settled
 * in input order.
 */
export async function cancelAllLocalRuns(
  runs: LocalCancelTarget[],
  reason: string,
  { killProcess = killProcessTree, ...deps }: CancelLocalRunDeps,
): Promise<CancelAllResult> {
  const pids = new Set<number>();
  for (const { run } of runs) {
    const pid = ownerPidToStop(run);
    if (pid !== undefined) pids.add(pid);
  }
  await Promise.all([...pids].map((pid) => stopOwner(pid, killProcess)));
  const cancelled = new Set(runs.map(({ run }) => run.id as string));
  for (const pid of pids) {
    await closeStoppedOwnerRuns(pid, cancelled, reason, deps);
  }

  const result: CancelAllResult = {
    cancelled: [],
    finished: [],
    deleted: [],
    notCancelled: [],
    claimTimedOut: false,
  };
  for (const { run, workflow } of runs) {
    const workflowName = workflowNameOf(run, workflow);
    const previousStatus = run.status;
    let finalRun: WorkflowRun | null;
    try {
      finalRun = await settleStoppingNewOwners(
        run,
        workflow,
        reason,
        pids,
        killProcess,
        deps,
      );
    } catch (error) {
      // The other runs' owners are already stopped: their records still
      // have to be settled.
      if (error instanceof RunNotCancelledError) {
        result.notCancelled.push({
          runId: run.id,
          workflowName,
          status: error.status,
          reason: error.message,
        });
        continue;
      }
      if (!isLockTimeout(error)) throw error;
      // The claim could not be taken, so nothing was settled here. The
      // record is reported as it stands: a stopped owner may have saved its
      // own outcome.
      finalRun = await deps.runRepo.findById(
        workflowIdOf(run, workflow),
        run.id,
      );
      if (finalRun && !TERMINAL_STATUSES.has(finalRun.status)) {
        result.claimTimedOut = true;
        result.notCancelled.push({
          runId: run.id,
          workflowName,
          status: finalRun.status,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    if (!finalRun) {
      result.deleted.push({ runId: run.id, workflowName });
    } else if (finalRun.status === "cancelled") {
      result.cancelled.push({ runId: run.id, workflowName, previousStatus });
    } else {
      result.finished.push({
        runId: run.id,
        workflowName,
        previousStatus,
        status: finalRun.status,
      });
    }
  }
  return result;
}

const cancelLogger = getSwampLogger(["workflow", "cancel"]);

/**
 * What cancel finds its runs through: a run by its id alone, and the runs of
 * workflows whose definition is gone, read through each run directory's index
 * so no run is parsed that is not a candidate. Structural so the
 * {@link WorkflowRunRepository} port does not grow these lookups.
 */
export interface CancelTargetDeps {
  workflowRepo: Pick<WorkflowRepository, "findByName" | "findById" | "findAll">;
  runRepo:
    & Pick<WorkflowRunRepository, "findById" | "findAllByWorkflowId">
    & {
      findGlobalById(
        runId: WorkflowRunId,
      ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null>;
      listWorkflowIds(): Promise<WorkflowId[]>;
      findAllSummariesFromIndex(
        workflowId: WorkflowId,
      ): Promise<WorkflowRunSummary[]>;
    };
  /**
   * The workflow files that fail to load. The repository skips them, so their
   * workflows look like deleted ones; they are not.
   */
  listBrokenWorkflows: () => Promise<BrokenWorkflow[]>;
}

/** An active run whose workflow file exists but fails to load. */
export interface UnloadableWorkflowRun {
  run: WorkflowRun;
  broken: BrokenWorkflow;
}

/**
 * The broken workflow file that is `run`'s definition, if any. A file too
 * broken to give its id or name is matched on its file name, which carries
 * one or the other.
 */
function brokenDefinitionOf(
  run: WorkflowRun,
  workflowId: WorkflowId,
  broken: BrokenWorkflow[],
): BrokenWorkflow | undefined {
  return broken.find((candidate) => {
    const stem = basename(candidate.file)
      .replace(/^workflow-/, "").replace(/\.yaml$/, "");
    return [candidate.id, candidate.name, stem].some((key) =>
      key === workflowId || key === run.workflowName
    );
  });
}

/**
 * The active runs in run directories that no loaded definition owns, newest
 * first within each workflow. Only those directories are read, and each
 * through its index: a run is loaded only when the index says it is active
 * and, with `matching`, that its workflow id or recorded name is that value.
 *
 * With `skipUnreadable`, a directory that cannot be read is skipped with a
 * warning instead of failing the lookup.
 */
async function findActiveRunsWithoutDefinition(
  { runRepo }: CancelTargetDeps,
  defined: ReadonlySet<string>,
  options: { matching?: string; skipUnreadable: boolean },
): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
  const { matching, skipUnreadable } = options;
  const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
  for (const workflowId of await runRepo.listWorkflowIds()) {
    if (defined.has(workflowId)) continue;
    const runs: WorkflowRun[] = [];
    try {
      for (
        const summary of await runRepo.findAllSummariesFromIndex(workflowId)
      ) {
        if (TERMINAL_STATUSES.has(summary.status)) continue;
        if (
          matching !== undefined && workflowId !== matching &&
          summary.workflowName !== matching
        ) {
          continue;
        }
        const run = await runRepo.findById(
          workflowId,
          createWorkflowRunId(summary.id),
        );
        // The index can trail the record: the record decides.
        if (run && !TERMINAL_STATUSES.has(run.status)) runs.push(run);
      }
    } catch (error) {
      if (!skipUnreadable) throw error;
      cancelLogger
        .warn`Skipped the runs of workflow ${workflowId}, which could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`;
      continue;
    }
    runs.sort((a, b) =>
      (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0)
    );
    for (const run of runs) results.push({ run, workflowId });
  }
  return results;
}

/**
 * Every run that has not finished, across all workflows, grouped by workflow
 * in definition order with each workflow's newest run first. The runs of
 * deleted workflows follow, without a workflow. A run whose workflow file
 * exists but fails to load is not cancelled with the rest: it is returned
 * apart, as `unloadable`.
 */
export async function findAllActiveRuns(
  deps: CancelTargetDeps,
): Promise<
  { active: LocalCancelTarget[]; unloadable: UnloadableWorkflowRun[] }
> {
  const { workflowRepo, runRepo } = deps;
  const active: LocalCancelTarget[] = [];
  const defined = new Set<string>();
  for (const workflow of await workflowRepo.findAll()) {
    if (defined.has(workflow.id)) continue;
    defined.add(workflow.id);
    for (const run of await runRepo.findAllByWorkflowId(workflow.id)) {
      if (!TERMINAL_STATUSES.has(run.status)) active.push({ run, workflow });
    }
  }
  const undefinedRuns = await findActiveRunsWithoutDefinition(deps, defined, {
    skipUnreadable: false,
  });
  const broken = undefinedRuns.length > 0
    ? await deps.listBrokenWorkflows()
    : [];
  const unloadable: UnloadableWorkflowRun[] = [];
  for (const { run, workflowId } of undefinedRuns) {
    const brokenDefinition = brokenDefinitionOf(run, workflowId, broken);
    if (brokenDefinition) unloadable.push({ run, broken: brokenDefinition });
    else active.push({ run, workflow: undefined });
  }
  return { active, unloadable };
}

/** The run started last; a run that never started loses to one that did. */
function latestRun(runs: WorkflowRun[]): WorkflowRun {
  return runs.reduce((latest, current) => {
    if (!latest.startedAt) return current;
    if (!current.startedAt) return latest;
    return current.startedAt > latest.startedAt ? current : latest;
  });
}

async function findWorkflow(
  workflowRepo: CancelTargetDeps["workflowRepo"],
  workflowIdOrName: string,
): Promise<Workflow | null> {
  return await workflowRepo.findByName(workflowIdOrName) ??
    await workflowRepo.findById(createWorkflowId(workflowIdOrName));
}

/**
 * The latest active run of a deleted workflow whose id or recorded name is
 * `workflowIdOrName`. A workflow whose file exists but fails to load is not
 * deleted: its runs are refused, naming the file. Run directories that cannot
 * be read are skipped, so a damaged record elsewhere does not turn a mistyped
 * name into a read error.
 */
async function latestRunOfDeletedWorkflow(
  deps: CancelTargetDeps,
  workflowIdOrName: string,
): Promise<WorkflowRun> {
  const defined = new Set<string>();
  for (const workflow of await deps.workflowRepo.findAll()) {
    defined.add(workflow.id);
  }
  const candidates = await findActiveRunsWithoutDefinition(deps, defined, {
    matching: workflowIdOrName,
    skipUnreadable: true,
  });
  const broken = candidates.length > 0 ? await deps.listBrokenWorkflows() : [];
  const deleted: WorkflowRun[] = [];
  let unloadable: UnloadableWorkflowRun | undefined;
  for (const { run, workflowId } of candidates) {
    const brokenDefinition = brokenDefinitionOf(run, workflowId, broken);
    if (brokenDefinition) unloadable ??= { run, broken: brokenDefinition };
    else deleted.push(run);
  }
  if (deleted.length > 0) return latestRun(deleted);
  if (unloadable) {
    throw new UserError(unloadableWorkflowMessage(unloadable));
  }
  throw new UserError(`Workflow not found: ${workflowIdOrName}`);
}

/** Why a run of a workflow whose file fails to load was left alone. */
export function unloadableWorkflowMessage(
  { run, broken }: UnloadableWorkflowRun,
): string {
  // A YAML error carries a multi-line excerpt; its first line says what failed.
  const error = broken.error.split("\n")[0].replace(/:$/, "");
  return `Workflow file ${broken.file} could not be loaded (${error}), so run ${run.id} was left as it is. ` +
    `Fix the file, or cancel the run by its id: swamp workflow cancel --run ${run.id}`;
}

/**
 * Finds the run a local cancel names. The run is looked up in the run store,
 * so one whose workflow file was deleted is still found; its `workflow` is
 * then undefined.
 *
 * With a run id, the run is found by that id alone. A workflow given with it
 * must be the run's own: its workflow id, the name the run recorded, or its
 * definition's current name.
 *
 * Without a run id, the workflow's latest active run is picked. A name or id
 * that resolves no definition falls back to the active runs of deleted
 * workflows that carry it, so a name reused by a newer workflow always means
 * the newer one.
 */
export async function resolveLocalCancelTarget(
  deps: CancelTargetDeps,
  input: { workflowIdOrName?: string; runId?: string },
): Promise<LocalCancelTarget> {
  const { workflowRepo, runRepo } = deps;
  const { workflowIdOrName, runId } = input;

  if (runId !== undefined) {
    const found = await runRepo.findGlobalById(createWorkflowRunId(runId));
    const workflow = found
      ? await workflowRepo.findById(found.workflowId) ?? undefined
      : undefined;
    const isOwnWorkflow = found !== null && (
      workflowIdOrName === undefined ||
      workflowIdOrName === found.workflowId ||
      workflowIdOrName === found.run.workflowName ||
      workflowIdOrName === workflow?.name
    );
    if (!found || !isOwnWorkflow) {
      if (
        workflowIdOrName !== undefined &&
        !(await findWorkflow(workflowRepo, workflowIdOrName))
      ) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    return { run: found.run, workflow };
  }

  if (workflowIdOrName === undefined) {
    throw new UserError("Provide a workflow name or ID, or a run ID");
  }
  const workflow = await findWorkflow(workflowRepo, workflowIdOrName);
  if (!workflow) {
    return {
      run: await latestRunOfDeletedWorkflow(deps, workflowIdOrName),
      workflow: undefined,
    };
  }
  const activeRuns = (await runRepo.findAllByWorkflowId(workflow.id)).filter(
    (r) => !TERMINAL_STATUSES.has(r.status),
  );
  if (activeRuns.length === 0) {
    throw new UserError(
      `No active runs found for workflow "${workflow.name}"`,
    );
  }
  return { run: latestRun(activeRuns), workflow };
}

export const workflowCancelCommand = withRemoteOptions(
  new Command()
    .name("cancel")
    .description("Cancel a running workflow run")
    .example(
      "Cancel latest running run",
      "swamp workflow cancel my-workflow",
    )
    .example(
      "Cancel a specific run",
      "swamp workflow cancel my-workflow --run <run-id>",
    )
    .example(
      "Cancel a run by its ID alone",
      "swamp workflow cancel --run <run-id>",
    )
    .example(
      "Cancel all running runs",
      "swamp workflow cancel --all",
    )
    .example(
      "Cancel with reason",
      "swamp workflow cancel my-workflow --reason 'No longer needed'",
    )
    .example(
      "Cancel via server",
      "swamp workflow cancel --run <run-id> --server ws://localhost:9090",
    )
    .arguments("[workflow_id_or_name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--run <run_id:string>",
      "Target a specific run ID (required with --server)",
    )
    .option("--all", "Cancel all running workflow runs")
    .option("--reason <reason:string>", "Reason for cancellation"),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "cancel",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      if (!options.run) {
        throw new UserError(
          "Remote cancel requires --run <run-id>. Use 'swamp workflow history search --server' to find run IDs.",
        );
      }
      if (options.all) {
        throw new UserError(
          "--all is not supported with --server",
        );
      }
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const cancelUrl = buildCancelUrl(server, options.run as string);
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      let requestBody: string | undefined;
      if (options.reason) {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify({ reason: options.reason });
      }
      let body: Record<string, unknown>;
      try {
        const response = await fetch(cancelUrl, {
          method: "POST",
          headers,
          body: requestBody,
          signal: AbortSignal.timeout(SERVER_CANCEL_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw serverCancelRejection(
            response.status,
            response.statusText,
            await response.text(),
          );
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw serverCancelFailure(server, options.run as string, error);
      }
      if (
        body.status !== "cancelled" &&
        body.status !== "cancellation_requested"
      ) {
        throw new UserError(
          (body.message as string | undefined) ??
            `Failed to cancel run ${options.run as string}: ${body.status}`,
        );
      }
      const runId = options.run as string;
      // The reason the server applied; an older serve reports none.
      const recordedReason = typeof body.reason === "string"
        ? body.reason
        : undefined;
      if (options.reason && recordedReason === undefined) {
        cliCtx.logger
          .warn`The server did not confirm the reason; it may predate cancel reasons over HTTP`;
      }
      // What became of the nested runs the cancelled run waited on
      // (swamp-club#2736, #2867). An older serve reports none, or only the
      // ones left unfinished.
      const remoteNested: Partial<NestedCascadeResult> = {
        ...(Array.isArray(body.cancelledNestedRuns) &&
            body.cancelledNestedRuns.length > 0
          ? {
            cancelledNestedRuns: body
              .cancelledNestedRuns as CascadedNestedRunData[],
          }
          : {}),
        ...(Array.isArray(body.stopRequestedNestedRuns) &&
            body.stopRequestedNestedRuns.length > 0
          ? {
            stopRequestedNestedRuns: body
              .stopRequestedNestedRuns as CascadedNestedRunData[],
          }
          : {}),
        ...(Array.isArray(body.detachedNestedRuns) &&
            body.detachedNestedRuns.length > 0
          ? {
            detachedNestedRuns: body
              .detachedNestedRuns as DetachedNestedRunData[],
          }
          : {}),
      };
      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          runId: body.executionId ?? runId,
          status: body.status,
          ...(recordedReason !== undefined ? { reason: recordedReason } : {}),
          ...remoteNested,
        }));
      } else {
        if (body.status === "cancelled") {
          cliCtx.logger.info`Cancelled run ${runId} on server`;
        } else {
          cliCtx.logger
            .warn`Cancellation requested for run ${runId} on server (run may still be active — check health endpoint to confirm)`;
        }
        if (recordedReason !== undefined) {
          cliCtx.logger.info`Reason: ${recordedReason}`;
        }
        renderNestedCascade(cliCtx, remoteNested, {
          server: options.server as string | undefined,
        });
      }
      return;
    }

    if (!options.all && !workflowIdOrName && !options.run) {
      throw new UserError(
        "Provide a workflow name or ID, a run with --run <run-id>, or use --all to cancel all running runs",
      );
    }

    const { repoDir, repoContext, datastoreResolver, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });
    const runClaims = createWorkflowRunClaims(datastoreConfig);

    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;
    // The evaluated snapshots live where ExecutionService wrote them: the
    // datastore-resolved path, not the repo-dir default.
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
    const findEvaluatedWorkflow: EvaluatedWorkflowLookup = (runId) =>
      evaluatedWorkflowRepo.findByRunId(runId);
    const reason = options.reason ?? "Cancelled by user";
    const lookup: CancelTargetDeps = {
      workflowRepo,
      runRepo,
      listBrokenWorkflows: () => listBrokenWorkflows(workflowsDirFor(repoDir)),
    };

    if (options.all) {
      const { active: activeRuns, unloadable } = await findAllActiveRuns(
        lookup,
      );
      if (activeRuns.length === 0 && unloadable.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(
            JSON.stringify({
              cancelled: [],
              finished: [],
              deleted: [],
              notCancelled: [],
              skipped: [],
            }),
          );
        } else {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
        return;
      }

      const localRuns = activeRuns.filter(({ run }) => !isServeOwnedRun(run));
      const serveRuns = activeRuns.filter(({ run }) => isServeOwnedRun(run));

      const stopping = localRuns.filter(({ run }) => waitsOnOwner(run))
        .length;
      if (stopping > 0 && cliCtx.outputMode !== "json") {
        cliCtx.logger
          .info`Stopping ${stopping} run(s); waiting up to ${STOP_GRACE_SECONDS}s for cleanup steps to finish (cancel again to stop immediately)`;
      }

      const {
        cancelled,
        finished,
        deleted,
        claimTimedOut,
        nested,
        ...settled
      } =
        // In a root unit of work with no push, so the run saves stage into
        // it instead of reaching the hook through signalChange's fallback
        // (swamp-club#3056). Nothing pushes, as before.
        await runCommandInRootUnit(
          repoContext,
          { push: undefined },
          () =>
            withRunTracker(
              repoDir,
              async (runTracker) => {
                const result = await cancelAllLocalRuns(localRuns, reason, {
                  runRepo,
                  findEvaluatedWorkflow,
                  runTracker,
                  runClaims,
                  outputRepo: repoContext.outputRepo,
                });
                // A nested run that was itself active is in the list and
                // already cancelled; the cascade reaches the suspended ones
                // the cancelled runs waited on (swamp-club#2867).
                const cascade = localNestedCascade({
                  workflowRepo,
                  runRepo,
                  runClaims,
                  findEvaluatedWorkflow,
                  runTracker,
                });
                const nested = emptyNestedCascade();
                const cancelledIds = new Set(
                  result.cancelled.map((entry) => entry.runId),
                );
                for (const { run } of localRuns) {
                  if (!cancelledIds.has(run.id)) continue;
                  const ended = await runRepo
                    .findById(createWorkflowId(run.workflowId), run.id)
                    .catch(() => null);
                  if (!ended) continue;
                  mergeNestedCascade(nested, await cascade(ended));
                }
                return { ...result, nested: nestedCascadeFields(nested) };
              },
            ),
        );

      // Runs whose workflow file fails to load are left for the user to
      // decide: the file is not gone, so the workflow is not deleted.
      const notCancelled = [
        ...settled.notCancelled,
        ...unloadable.map((entry) => ({
          runId: entry.run.id as string,
          workflowName: entry.run.workflowName,
          status: entry.run.status as string,
          reason: unloadableWorkflowMessage(entry),
        })),
      ];

      const serveSkipped = serveRuns.map(({ run, workflow }) => ({
        runId: run.id,
        workflowName: workflowNameOf(run, workflow),
        status: run.status,
      }));

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          cancelled,
          finished,
          deleted,
          notCancelled,
          skipped: serveSkipped,
          count: cancelled.length,
          reason,
          ...nested,
        }));
      } else {
        if (cancelled.length > 0) {
          cliCtx.logger
            .info`Cancelled ${cancelled.length} workflow run(s)`;
          for (const entry of cancelled) {
            cliCtx.logger
              .info`  ${entry.workflowName} (${entry.runId}): ${entry.previousStatus} -> cancelled`;
          }
        }
        renderNestedCascade(cliCtx, nested);
        if (finished.length > 0) {
          cliCtx.logger
            .warn`${finished.length} run(s) finished before the cancel took effect`;
          for (const entry of finished) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId}): ${entry.previousStatus} -> ${entry.status}`;
          }
        }
        if (deleted.length > 0) {
          cliCtx.logger
            .warn`Skipped ${deleted.length} run(s) whose record no longer exists`;
          for (const entry of deleted) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId})`;
          }
        }
        if (notCancelled.length > 0) {
          cliCtx.logger
            .warn`${notCancelled.length} run(s) were not cancelled`;
          for (const entry of notCancelled) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId}): ${entry.status} - ${entry.reason}`;
          }
        }
        if (serveSkipped.length > 0) {
          cliCtx.logger
            .warn`Skipped ${serveSkipped.length} serve-owned run(s) — cancel these individually via --server --run <id>`;
          for (const entry of serveSkipped) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId}): ${entry.status}`;
          }
        }
        if (
          cancelled.length === 0 && finished.length === 0 &&
          deleted.length === 0 && notCancelled.length === 0 &&
          serveSkipped.length === 0
        ) {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
      }
      // Every run was reported; a claim that timed out is still a temporary
      // failure to retry, as it is for a single cancel.
      if (claimTimedOut) {
        Deno.exitCode = LOCK_TIMEOUT_EXIT_CODE;
      }
      return;
    }

    // Single run cancel path
    const { run, workflow } = await resolveLocalCancelTarget(lookup, {
      workflowIdOrName,
      runId: options.run as string | undefined,
    });
    const workflowName = workflowNameOf(run, workflow);

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new UserError(
        `Run ${run.id} is already in a terminal state (status: ${run.status})`,
      );
    }

    if (isServeOwnedRun(run)) {
      throw new UserError(
        `Run ${run.id} belongs to a serve instance and cannot be cancelled locally. ` +
          `Use --server to cancel it: swamp workflow cancel --run ${run.id} --server <url>`,
      );
    }

    if (waitsOnOwner(run) && cliCtx.outputMode !== "json") {
      cliCtx.logger
        .info`Stopping run ${run.id}; waiting up to ${STOP_GRACE_SECONDS}s for cleanup steps to finish (cancel again to stop immediately)`;
    }

    const previousStatus = run.status;
    // In a root unit of work with no push, as for --all above
    // (swamp-club#3056).
    const { finalRun, nested } = await runCommandInRootUnit(
      repoContext,
      { push: undefined },
      () =>
        withRunTracker(
          repoDir,
          async (runTracker) => {
            const finalRun = await cancelLocalRun(run, workflow, reason, {
              runRepo,
              findEvaluatedWorkflow,
              runTracker,
              runClaims,
              outputRepo: repoContext.outputRepo,
            });
            // The suspended nested runs a cancelled run waited on are
            // cancelled with it; the rest are reported (swamp-club#2867).
            const nested: Partial<NestedCascadeResult> =
              finalRun?.status === "cancelled"
                ? nestedCascadeFields(
                  await localNestedCascade({
                    workflowRepo,
                    runRepo,
                    runClaims,
                    findEvaluatedWorkflow,
                    runTracker,
                  })(finalRun),
                )
                : {};
            return { finalRun, nested };
          },
        ),
    );
    if (!finalRun) {
      throw new UserError(`Workflow run no longer exists: ${run.id}`);
    }
    const status = finalRun.status;

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({
        runId: run.id,
        workflowName,
        previousStatus,
        status,
        ...(status === "cancelled" ? { reason } : {}),
        ...nested,
      }));
    } else {
      if (status === "cancelled") {
        cliCtx.logger
          .info`Cancelled run ${run.id} of workflow ${workflowName}`;
      } else {
        cliCtx.logger
          .warn`Run ${run.id} of workflow ${workflowName} finished as ${status} before the cancel took effect`;
      }
      cliCtx.logger
        .info`Status: ${previousStatus} -> ${status}`;
      if (options.reason && status === "cancelled") {
        cliCtx.logger.info`Reason: ${reason}`;
      }
      renderNestedCascade(cliCtx, nested);
    }
  },
);
