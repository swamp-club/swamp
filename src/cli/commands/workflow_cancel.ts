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
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import { UserError } from "../../domain/errors.ts";
import {
  normalizeServerUrl,
  redactServerUrl,
} from "../../domain/auth/server_url.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
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
  type DetachedNestedRunData,
  detachedNestedRunsOf,
} from "../../libswamp/mod.ts";

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
 * Re-reads a run whose owner was stopped: the owner saves its own final
 * record while handling SIGTERM, and saving the pre-kill snapshot would
 * overwrite it. A run the owner already finished keeps its record (a
 * cancelled one gets this reason); a run still active is cancelled, its
 * unfinished jobs and steps settled against the run's evaluated snapshot, or
 * else `workflow`, with the steps its stopped owner left running failed with
 * {@link OWNER_STOPPED_STEP_ERROR}. Returns the persisted run, or null when
 * the record no longer exists.
 *
 * The read, the settlement and the save hold the run's claim, so an approve
 * or reject of the same run lands wholly before or wholly after them.
 */
async function settleCancelledRun(
  run: WorkflowRun,
  workflow: Workflow,
  reason: string,
  { runRepo, findEvaluatedWorkflow, runClaims }: Pick<
    CancelLocalRunDeps,
    "runRepo" | "findEvaluatedWorkflow" | "runClaims"
  >,
): Promise<WorkflowRun | null> {
  const workflowId = workflow.id;
  return await runClaims.withClaim(run.id, async () => {
    const current = await runRepo.findById(workflowId, run.id);
    if (!current) {
      return null;
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
 * record (see {@link settleCancelledRun}). Returns the persisted run, or null
 * when the record no longer exists.
 */
export async function cancelLocalRun(
  run: WorkflowRun,
  workflow: Workflow,
  reason: string,
  { killProcess = killProcessTree, ...deps }: CancelLocalRunDeps,
): Promise<WorkflowRun | null> {
  const pid = ownerPidToStop(run);
  if (pid !== undefined) {
    await stopOwner(pid, killProcess);
    await closeStoppedOwnerRuns(pid, new Set([run.id]), reason, deps);
  }
  return await settleCancelledRun(run, workflow, reason, deps);
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
  runs: { run: WorkflowRun; workflow: Workflow }[],
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

  const result: CancelAllResult = { cancelled: [], finished: [], deleted: [] };
  for (const { run, workflow } of runs) {
    const workflowName = workflow.name;
    const previousStatus = run.status;
    const finalRun = await settleCancelledRun(run, workflow, reason, deps);
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

async function findAllActiveRuns(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): Promise<{ run: WorkflowRun; workflow: Workflow }[]> {
  const workflows = await workflowRepo.findAll();
  const results: { run: WorkflowRun; workflow: Workflow }[] = [];

  for (const workflow of workflows) {
    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    for (const run of runs) {
      if (!TERMINAL_STATUSES.has(run.status)) {
        results.push({ run, workflow });
      }
    }
  }
  return results;
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
      // Nested runs the cancelled run waited on, left suspended
      // (swamp-club#2736). An older serve reports none.
      const remoteDetached = Array.isArray(body.detachedNestedRuns)
        ? (body.detachedNestedRuns as DetachedNestedRunData[])
        : [];
      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          runId: body.executionId ?? runId,
          status: body.status,
          ...(recordedReason !== undefined ? { reason: recordedReason } : {}),
          ...(remoteDetached.length > 0
            ? { detachedNestedRuns: remoteDetached }
            : {}),
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
        for (const detached of remoteDetached) {
          cliCtx.logger
            .warn`Nested run ${detached.runId} of workflow ${detached.workflowName} was left unfinished. Cancel it with ${detached.cancelCommand}`;
        }
      }
      return;
    }

    if (!options.all && !workflowIdOrName) {
      throw new UserError(
        "Provide a workflow name or ID, or use --all to cancel all running runs",
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

    if (options.all) {
      const activeRuns = await findAllActiveRuns(workflowRepo, runRepo);
      if (activeRuns.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(
            JSON.stringify({
              cancelled: [],
              finished: [],
              deleted: [],
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

      const { cancelled, finished, deleted } = await withRunTracker(
        repoDir,
        (runTracker) =>
          cancelAllLocalRuns(localRuns, reason, {
            runRepo,
            findEvaluatedWorkflow,
            runTracker,
            runClaims,
            outputRepo: repoContext.outputRepo,
          }),
      );

      const serveSkipped = serveRuns.map(({ run, workflow }) => ({
        runId: run.id,
        workflowName: workflow.name,
        status: run.status,
      }));

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          cancelled,
          finished,
          deleted,
          skipped: serveSkipped,
          count: cancelled.length,
          reason,
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
          deleted.length === 0 && serveSkipped.length === 0
        ) {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
      }
      return;
    }

    // Single workflow cancel path
    const workflow = await workflowRepo.findByName(workflowIdOrName!) ??
      await workflowRepo.findById(
        createWorkflowId(workflowIdOrName!),
      );
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    let run: WorkflowRun;
    if (options.run) {
      const found = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(options.run),
      );
      if (!found) {
        throw new UserError(`Workflow run not found: ${options.run}`);
      }
      run = found;
    } else {
      const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
      const activeRuns = allRuns.filter(
        (r) => !TERMINAL_STATUSES.has(r.status),
      );

      if (activeRuns.length === 0) {
        throw new UserError(
          `No active runs found for workflow "${workflow.name}"`,
        );
      }

      run = activeRuns.reduce((latest, current) => {
        if (!latest.startedAt) return current;
        if (!current.startedAt) return latest;
        return current.startedAt > latest.startedAt ? current : latest;
      });
    }

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
    const finalRun = await withRunTracker(
      repoDir,
      (runTracker) =>
        cancelLocalRun(run, workflow, reason, {
          runRepo,
          findEvaluatedWorkflow,
          runTracker,
          runClaims,
          outputRepo: repoContext.outputRepo,
        }),
    );
    if (!finalRun) {
      throw new UserError(`Workflow run no longer exists: ${run.id}`);
    }
    const status = finalRun.status;
    // Cancelling a parent leaves the nested runs it waited on suspended on
    // their own (swamp-club#2736).
    const detachedNestedRuns = status === "cancelled"
      ? await detachedNestedRunsOf({ runRepo }, finalRun)
      : [];

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({
        runId: run.id,
        workflowName: workflow.name,
        previousStatus,
        status,
        ...(status === "cancelled" ? { reason } : {}),
        ...(detachedNestedRuns.length > 0 ? { detachedNestedRuns } : {}),
      }));
    } else {
      if (status === "cancelled") {
        cliCtx.logger
          .info`Cancelled run ${run.id} of workflow ${workflow.name}`;
      } else {
        cliCtx.logger
          .warn`Run ${run.id} of workflow ${workflow.name} finished as ${status} before the cancel took effect`;
      }
      cliCtx.logger
        .info`Status: ${previousStatus} -> ${status}`;
      if (options.reason && status === "cancelled") {
        cliCtx.logger.info`Reason: ${reason}`;
      }
      for (const detached of detachedNestedRuns) {
        cliCtx.logger
          .warn`Nested run ${detached.runId} of workflow ${detached.workflowName} was left unfinished. Cancel it with ${detached.cancelCommand}`;
      }
    }
  },
);
