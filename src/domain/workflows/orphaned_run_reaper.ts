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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { ActiveRun } from "../models/active_run.ts";
import type { ModelOutput } from "../models/model_output.ts";
import { ModelType } from "../models/model_type.ts";
import type { OutputRepository } from "../models/repositories.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "./workflow_id.ts";
import type { WorkflowRun } from "./workflow_run.ts";

const logger = getSwampLogger(["workflows", "orphaned-runs"]);

export interface ReapResult {
  readonly reaped: number;
  readonly skipped: number;
}

/**
 * Interrupts workflow runs that a previous `swamp serve` process left
 * `running`. Serve calls this at boot, before it starts any run of its own,
 * so a tracker row that is no longer running is trusted as the verdict, and
 * a run with no tracker row falls back to a pid check. Not safe while other
 * swamp processes may be running; the CLI uses {@link settleDeadOwnerRun}.
 */
export async function reapOrphanedWorkflowRuns(
  runs: { run: WorkflowRun; workflowId: WorkflowId }[],
  save: (workflowId: WorkflowId, run: WorkflowRun) => Promise<void>,
  trackerLookup: (runId: string) => { status: string } | null,
  isDeadFn: (pid: number) => boolean,
  localInstanceId?: string,
  heartbeatLookup?: (instanceId: string) => Promise<boolean>,
): Promise<ReapResult> {
  let reaped = 0;
  let skipped = 0;

  for (const { run, workflowId } of runs) {
    if (run.status !== "running") continue;

    const tracked = trackerLookup(run.id);
    if (tracked) {
      if (tracked.status === "running") {
        logger.info(
          "Skipping workflow run {runId} (workflow: {workflowName}) — tracker reports still running",
          { runId: run.id, workflowName: run.workflowName },
        );
        skipped++;
        continue;
      }
      logger.warn(
        "Reaping orphaned workflow run {runId} (workflow: {workflowName}, reason: {reason})",
        {
          runId: run.id,
          workflowName: run.workflowName,
          reason: "tracker confirmed stale",
        },
      );
      run.interruptOrphaned("server_crash");
      await save(workflowId, run);
      reaped++;
      continue;
    }

    // Not in tracker — check instanceId before falling back to PID check.
    // A run with a foreign instanceId belongs to another instance and must
    // not be PID-checked against the local process table.
    if (
      localInstanceId && run.instanceId &&
      run.instanceId !== localInstanceId
    ) {
      if (heartbeatLookup) {
        const hasHeartbeat = await heartbeatLookup(run.instanceId);
        if (hasHeartbeat) {
          logger.info(
            "Skipping workflow run {runId} (workflow: {workflowName}) — remote instance {instanceId} still has a heartbeat",
            {
              runId: run.id,
              workflowName: run.workflowName,
              instanceId: run.instanceId,
            },
          );
          skipped++;
          continue;
        }
        logger.warn(
          "Reaping orphaned workflow run {runId} (workflow: {workflowName}, reason: {reason})",
          {
            runId: run.id,
            workflowName: run.workflowName,
            reason: "remote instance dead (no heartbeat)",
          },
        );
        run.interruptOrphaned("server_crash");
        await save(workflowId, run);
        reaped++;
        continue;
      }
      logger.info(
        "Skipping workflow run {runId} (workflow: {workflowName}) — belongs to remote instance {instanceId}",
        {
          runId: run.id,
          workflowName: run.workflowName,
          instanceId: run.instanceId,
        },
      );
      skipped++;
      continue;
    }

    // Legacy run or same-instance run — fall back to PID check
    const pid = run.pid;
    if (pid !== undefined && !isDeadFn(pid)) {
      logger.info(
        "Skipping workflow run {runId} (workflow: {workflowName}) — owning process {pid} is still alive (no tracker record)",
        { runId: run.id, workflowName: run.workflowName, pid },
      );
      skipped++;
      continue;
    }

    const reason = pid === undefined
      ? "daemon restarted (no PID recorded, no tracker record)"
      : "daemon restarted (owning process dead, no tracker record)";
    logger.warn(
      "Reaping orphaned workflow run {runId} (workflow: {workflowName}, reason: {reason})",
      { runId: run.id, workflowName: run.workflowName, reason },
    );
    run.interruptOrphaned("server_crash");
    await save(workflowId, run);
    reaped++;
  }

  return { reaped, skipped };
}

/**
 * How the caller sees a tracker row's owner: the host and serve instance it
 * runs on, and a pid liveness check that is only meaningful for this host.
 */
export interface OwnerLiveness {
  readonly hostname: string;
  readonly instanceId?: string;
  isDead(pid: number): boolean;
}

/**
 * Whether a tracker row says its owner is gone: the row is owned on this
 * host, is `running` or already reaped as `interrupted`, and its pid is
 * dead. The pid is checked for an `interrupted` row too, because the reaper
 * that marked it may not have checked it: a serve instance reaps another
 * instance's row on heartbeat age alone, even when both share this host and
 * its tracker. Rows the owner settled itself (completed, failed, cancelled,
 * suspended) never count, and neither do rows owned elsewhere. So this is
 * safe to ask while other swamp processes are running; a reused pid can
 * only make a dead owner look alive.
 */
export function trackerShowsDeadOwner(
  tracked: ActiveRun | null,
  liveness: OwnerLiveness,
): boolean {
  if (!tracked) return false;
  if (!tracked.isLocalTo(liveness.hostname, liveness.instanceId)) {
    return false;
  }
  return (tracked.status === "running" || tracked.status === "interrupted") &&
    liveness.isDead(tracked.pid);
}

/**
 * Whether a run record says `running` while its tracker row shows the owner
 * is gone. A run with no tracker row is never judged: the record carries no
 * hostname, so its pid means nothing on a shared datastore.
 */
export function runHasDeadOwner(
  run: WorkflowRun,
  runTracker: RunTrackerRepository,
  liveness: OwnerLiveness,
): boolean {
  if (run.status !== "running") return false;
  const tracked = runTracker.findById(run.id);
  if (!tracked || !trackerShowsDeadOwner(tracked, liveness)) return false;
  return run.pid === undefined || run.pid === tracked.pid;
}

/**
 * Interrupts a run whose owning process died without settling it, for
 * example a `workflow run` or `resume` force-exited by a second Ctrl-C, and
 * marks its tracker row `interrupted` and then settled. The run then shows
 * its in-flight steps as `unknown` and `swamp workflow recover` accepts it.
 *
 * The run is read fresh from the repository and settled only while it is
 * still `running` under the dead owner's pid, so a run its owner finished
 * or another process took over is never overwritten. The row is marked
 * settled only after the record is saved, so retention keeps it while the
 * record may still say `running`. The method runs of its steps that the dead
 * owner left `running` are then settled too, best-effort (see
 * {@link settleDeadOwnerMethodRuns}).
 *
 * Returns true when the run was interrupted.
 */
export async function settleDeadOwnerRun(
  runRepo: WorkflowRunRepository,
  runTracker: RunTrackerRepository,
  workflowId: WorkflowId,
  runId: WorkflowRunId,
  liveness: OwnerLiveness,
  outputRepo: MethodRunOutputs,
): Promise<boolean> {
  const run = await runRepo.findById(workflowId, runId);
  if (!run || !runHasDeadOwner(run, runTracker, liveness)) return false;
  // runHasDeadOwner found the row, and the run's pid, if any, matches it.
  const ownerPid = runTracker.findById(run.id)!.pid;
  logger.warn(
    "Interrupting workflow run {runId} (workflow: {workflowName}): its owning process {pid} is gone",
    { runId: run.id, workflowName: run.workflowName, pid: run.pid },
  );
  runTracker.complete(run.id, "interrupted");
  run.interruptOrphaned("owner_process_dead");
  await runRepo.save(workflowId, run);
  runTracker.markSettled(run.id, "owner_process_dead");
  // The run is settled; its method runs are best-effort, and a row left
  // unsettled is kept for `run doctor --fix`.
  try {
    await settleDeadOwnerMethodRuns(outputRepo, runTracker, liveness, ownerPid);
  } catch (error) {
    logger.warn(
      "Could not settle the method runs of workflow run {runId}: {error}",
      {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return true;
}

/**
 * The runs of a workflow, or the one run `runId` names, that are still
 * `running` while their tracker row shows a dead owner.
 */
export async function findDeadOwnerRuns(
  runRepo: WorkflowRunRepository,
  runTracker: RunTrackerRepository,
  workflowId: WorkflowId,
  liveness: OwnerLiveness,
  runId?: string,
): Promise<WorkflowRun[]> {
  const runs = runId
    ? [await runRepo.findById(workflowId, createWorkflowRunId(runId))]
    : await runRepo.findAllByWorkflowId(workflowId);
  return runs.filter((run): run is WorkflowRun =>
    run !== null && runHasDeadOwner(run, runTracker, liveness)
  );
}

/** A workflow run record and the workflow it is stored under. */
export interface RunRecord {
  readonly run: WorkflowRun;
  readonly workflowId: WorkflowId;
}

/** The run record reads {@link runRecordFinder} needs. */
export interface RunRecordStore {
  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null>;
  /** Every workflow with a runs directory, whether or not it still exists. */
  listWorkflowIds(): Promise<WorkflowId[]>;
}

/**
 * Finds the run record behind a workflow tracker row: under the workflow
 * the row names, and failing that under any workflow, so a run of a
 * workflow since renamed or deleted is still found by its run id. Null only
 * when no workflow stores it; a read that fails otherwise throws.
 */
export function runRecordFinder(
  runRepo: RunRecordStore,
  workflowRepo: Pick<WorkflowRepository, "findByName">,
): (row: ActiveRun) => Promise<RunRecord | null> {
  return async (row) => {
    const runId = createWorkflowRunId(row.id);
    const workflow = row.workflowName
      ? await workflowRepo.findByName(row.workflowName)
      : null;
    if (workflow) {
      const run = await runRepo.findById(workflow.id, runId);
      if (run) return { run, workflowId: workflow.id };
    }
    // Listed afresh for each miss, never from a snapshot: a record that
    // arrives meanwhile must not have its row settled as missing. A miss
    // settles its row, so this is paid once per row.
    for (const workflowId of await runRepo.listWorkflowIds()) {
      if (workflowId === workflow?.id) continue;
      const run = await runRepo.findById(workflowId, runId);
      if (run) return { run, workflowId };
    }
    return null;
  };
}

/**
 * Marks settled every `interrupted` workflow row whose run record no longer
 * says `running`: `record_settled` when the record finished some other way,
 * `record_missing` when no workflow stores it any more. Retention can then
 * purge the row. A row whose record is still `running` is left for the
 * dead-owner settle, and a row whose record cannot be read is left as it
 * is. Safe while other swamp processes run: an interrupted row is never
 * taken back by its owner, and only its record decides. Returns how many
 * rows were settled (swamp-club#2917).
 */
export async function settleInterruptedWorkflowRows(
  runTracker: RunTrackerRepository,
  findRecord: (row: ActiveRun) => Promise<RunRecord | null>,
): Promise<number> {
  let settled = 0;
  for (const row of runTracker.findAll()) {
    if (
      row.runKind !== "workflow" || row.status !== "interrupted" ||
      row.settled
    ) continue;
    let record: RunRecord | null;
    try {
      record = await findRecord(row);
    } catch (error) {
      logger.warn(
        "Could not read the run record of interrupted run {runId}: {error}",
        {
          runId: row.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      continue;
    }
    if (record?.run.status === "running") continue;
    runTracker.markSettled(
      row.id,
      record ? "record_settled" : "record_missing",
    );
    settled++;
  }
  return settled;
}

/** The output repository reads and writes method-run settlement needs. */
export type MethodRunOutputs = Pick<OutputRepository, "findByIds" | "save">;

/**
 * The reason a method run is settled `cancelled` with when its owning process
 * exited before saving the run's final state.
 */
export function ownerExitedReason(pid: number): string {
  return `cancelled: the process running this method run (pid ${pid}) exited before it finished`;
}

/** A method-run row whose output record is still `running` under its pid. */
export interface OrphanedMethodRun {
  readonly row: ActiveRun;
  readonly type: ModelType;
  readonly output: ModelOutput;
}

/** How method-run rows matched their output records. */
export interface MethodRunMatch {
  /** Rows whose output is still `running` under the row's pid. */
  readonly running: OrphanedMethodRun[];
  /**
   * Rows with nothing left to settle: the output is missing, finished, or
   * owned by another pid, or the row cannot name an output.
   */
  readonly done: ActiveRun[];
}

/**
 * The type a model_method row's output is stored under, or null when the row
 * cannot name one: it has no type or method, or the method name would leave
 * the type's output directory.
 */
function outputTypeOf(row: ActiveRun): ModelType | null {
  const method = row.methodName;
  if (
    row.runKind !== "model_method" || !row.modelType || !method ||
    method.includes("/") || method.includes("\\") || method.includes("..")
  ) {
    return null;
  }
  try {
    return ModelType.create(row.modelType);
  } catch {
    return null;
  }
}

/**
 * Reads the output records behind method-run rows, one read per model type
 * and method however many rows share them. A row's output has its id, and
 * the row's model type and method locate it.
 */
export async function matchMethodRunOutputs(
  outputRepo: Pick<OutputRepository, "findByIds">,
  rows: readonly ActiveRun[],
): Promise<MethodRunMatch> {
  const running: OrphanedMethodRun[] = [];
  const done: ActiveRun[] = [];
  const groups = new Map<
    string,
    { type: ModelType; method: string; rows: ActiveRun[] }
  >();
  for (const row of rows) {
    const type = outputTypeOf(row);
    if (!type) {
      done.push(row);
      continue;
    }
    const method = row.methodName!;
    const key = `${type.normalized}\0${method}`;
    const group = groups.get(key) ?? { type, method, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const { type, method, rows: grouped } of groups.values()) {
    const outputs = await outputRepo.findByIds(
      type,
      method,
      new Set(grouped.map((row) => row.id)),
    );
    for (const row of grouped) {
      const output = outputs.get(row.id);
      if (
        output && output.status === "running" &&
        (output.pid === undefined || output.pid === row.pid)
      ) {
        running.push({ row, type, output });
      } else {
        done.push(row);
      }
    }
  }
  return { running, done };
}

/**
 * Settles one method run its owner left `running`: marks the output
 * `cancelled` with `reason` and saves it. The caller has matched the output
 * against its row, so the owner is known to be gone.
 */
export async function settleOrphanedMethodRun(
  outputRepo: Pick<OutputRepository, "save">,
  { row, type, output }: OrphanedMethodRun,
  reason: string | undefined,
): Promise<void> {
  output.markCancelled(reason);
  await outputRepo.save(type, row.methodName!, output);
}

/**
 * The method-run rows owned on this host whose owner is gone (see
 * {@link trackerShowsDeadOwner}), or only those of process `pid`, matched
 * against their output records. A row already settled is skipped, so its
 * outputs are not read again while retention keeps it.
 */
export async function findDeadOwnerMethodRuns(
  outputRepo: Pick<OutputRepository, "findByIds">,
  runTracker: RunTrackerRepository,
  liveness: OwnerLiveness,
  pid?: number,
): Promise<MethodRunMatch> {
  const rows = runTracker.findAll().filter((row) =>
    row.runKind === "model_method" && !row.settled &&
    (pid === undefined || row.pid === pid) &&
    trackerShowsDeadOwner(row, liveness)
  );
  return await matchMethodRunOutputs(outputRepo, rows);
}

/**
 * Settles the method runs a dead owner left `running`, for example the steps
 * of a workflow run whose process was force-exited or killed after a cancel
 * grace. Only rows owned on this host with a dead pid count, as for
 * {@link settleDeadOwnerRun}, and an output is written only while it is still
 * `running` under that pid. Each row is marked `interrupted`, its output
 * `cancelled` with {@link ownerExitedReason}, and the row settled only after
 * the output is saved. A row with no output left to settle is marked settled
 * too, so retention may purge it.
 *
 * Returns the method runs whose output was settled.
 */
export async function settleDeadOwnerMethodRuns(
  outputRepo: MethodRunOutputs,
  runTracker: RunTrackerRepository,
  liveness: OwnerLiveness,
  pid?: number,
): Promise<OrphanedMethodRun[]> {
  const { running, done } = await findDeadOwnerMethodRuns(
    outputRepo,
    runTracker,
    liveness,
    pid,
  );
  for (const row of done) {
    runTracker.complete(row.id, "interrupted");
    runTracker.markSettled(row.id, "record_settled");
  }
  for (const orphan of running) {
    const { row } = orphan;
    logger.warn(
      "Cancelling method run {runId} ({modelType} {methodName}): its owning process {pid} is gone",
      {
        runId: row.id,
        modelType: row.modelType,
        methodName: row.methodName,
        pid: row.pid,
      },
    );
    runTracker.complete(row.id, "interrupted");
    await settleOrphanedMethodRun(
      outputRepo,
      orphan,
      ownerExitedReason(row.pid),
    );
    runTracker.markSettled(row.id, "owner_process_dead");
  }
  return running;
}

/** How a cancel's attempt to cancel stopped method runs' outputs went. */
export interface MethodRunCancellation {
  /** Rows whose output was cancelled, or had nothing left to cancel. */
  readonly closed: ActiveRun[];
  /** Rows whose output could not be read or saved; still `running`. */
  readonly failed: ActiveRun[];
  readonly errors: unknown[];
}

/**
 * Cancels the outputs a stopped owner left `running` for `rows`, with
 * `reason`, one model type and method at a time. A failed read or save is
 * collected, not thrown, so the cancel can still settle its run; the caller
 * leaves a failed row `interrupted` for `run doctor --fix`.
 */
export async function cancelOrphanedMethodRuns(
  outputRepo: MethodRunOutputs,
  rows: readonly ActiveRun[],
  reason: string,
): Promise<MethodRunCancellation> {
  let match: MethodRunMatch;
  try {
    match = await matchMethodRunOutputs(outputRepo, rows);
  } catch (error) {
    return { closed: [], failed: [...rows], errors: [error] };
  }
  const closed = [...match.done];
  const failed: ActiveRun[] = [];
  const errors: unknown[] = [];
  for (const orphan of match.running) {
    try {
      await settleOrphanedMethodRun(outputRepo, orphan, reason);
      closed.push(orphan.row);
    } catch (error) {
      failed.push(orphan.row);
      errors.push(error);
    }
  }
  return { closed, failed, errors };
}

/**
 * Logs that `count` method runs were left `interrupted` for
 * `run doctor --fix` because their outputs could not be read or saved.
 */
export function warnUnsettledMethodRuns(
  count: number,
  errors: readonly unknown[],
): void {
  if (count === 0) return;
  const first = errors[0];
  logger.warn(
    "Could not cancel {count} method run(s) whose owner stopped ({error}); run 'swamp run doctor --fix' to settle them",
    {
      count,
      error: first instanceof Error ? first.message : String(first),
    },
  );
}
