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
import type { StepStart } from "./step_start.ts";
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
 * serve calls this at boot before starting any run, so a tracker row not
 * running is trusted as the verdict and a run with no row falls back to a pid
 * check; not safe while other swamp processes run
 */
export async function reapOrphanedWorkflowRuns(
  runs: { run: WorkflowRun; workflowId: WorkflowId }[],
  save: (workflowId: WorkflowId, run: WorkflowRun) => Promise<void>,
  startsOf: (
    workflowId: WorkflowId,
    run: WorkflowRun,
  ) => Promise<readonly StepStart[]>,
  trackerLookup: (
    runId: string,
  ) => { status: string; instanceId?: string } | null,
  isDeadFn: (pid: number) => boolean,
  localInstanceId?: string,
  heartbeatLookup?: (instanceId: string) => Promise<boolean>,
  options: {
    /**
     * judge a tracker row another serve instance left by heartbeatLookup
     * instead of trusting it: in team mode only the leader runs work, so a row
     * of any other instance says nothing about the run
     */
    readonly judgeForeignRows?: boolean;
  } = {},
): Promise<ReapResult> {
  let reaped = 0;
  let skipped = 0;

  for (const { run, workflowId } of runs) {
    if (run.status !== "running") continue;

    const tracked = trackerLookup(run.id);
    // a row of one instance against a record another instance now owns says
    // nothing about the run as it stands, so that instance's heartbeat judges
    // it; without heartbeats the row decides
    const takenOver = heartbeatLookup !== undefined && tracked !== null &&
      tracked.instanceId !== undefined && run.instanceId !== undefined &&
      (tracked.instanceId !== run.instanceId ||
        (options.judgeForeignRows === true &&
          tracked.instanceId !== localInstanceId));
    if (tracked && !takenOver) {
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
      run.interruptOrphaned("server_crash", await startsOf(workflowId, run));
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
        run.interruptOrphaned(
          "server_crash",
          await startsOf(workflowId, run),
        );
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
    run.interruptOrphaned("server_crash", await startsOf(workflowId, run));
    await save(workflowId, run);
    reaped++;
  }

  return { reaped, skipped };
}

export interface OwnerLiveness {
  readonly hostname: string;
  readonly instanceId?: string;
  isDead(pid: number): boolean;
}

/**
 * a row owned on this host, running or interrupted, with a dead pid; an
 * interrupted row's pid is checked too as its reaper may not have;
 * owner-settled or foreign rows never count, so a reused pid only looks alive
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

export interface GoneInstanceCheck {
  readonly liveness: OwnerLiveness & { readonly instanceId: string };
  /** The caller's own pid, which says nothing about another instance's row. */
  readonly selfPid: number;
  hasHeartbeat(instanceId: string): boolean;
  readonly staleTtlMs: number;
  readonly now: number;
}

/**
 * a missing heartbeat is the only signal left once a peer reaps a crashed
 * instance; rows whose pid cannot be checked here are judged on age, as a
 * reused pid or same-hostname sibling container looks alive
 */
export function goneInstanceIds(
  running: readonly ActiveRun[],
  check: GoneInstanceCheck,
): Set<string> {
  const gone = new Set<string>();
  const kept = new Set<string>();
  for (const row of running) {
    const id = row.instanceId;
    if (row.status !== "running" || !id || kept.has(id)) continue;
    if (id === check.liveness.instanceId || check.hasHeartbeat(id)) continue;
    const pidCheckable = row.hostname === check.liveness.hostname &&
      row.pid !== check.selfPid;
    const ownerGone = pidCheckable
      ? check.liveness.isDead(row.pid)
      : check.now - row.heartbeatAt.getTime() > check.staleTtlMs;
    if (ownerGone) {
      gone.add(id);
    } else {
      gone.delete(id);
      kept.add(id);
    }
  }
  return gone;
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
 * until the level drains, the suspending owner keeps saving the record from
 * memory without the claim, so a resume taking the run over now would be saved
 * over; foreign or absent rows are never judged
 */
export function suspendedRunOwnerStillRuns(
  run: WorkflowRun,
  runTracker: RunTrackerRepository,
  liveness: OwnerLiveness,
): boolean {
  if (run.status !== "suspended") return false;
  const tracked = runTracker.findById(run.id);
  if (!tracked || tracked.status !== "running") return false;
  if (!tracked.isLocalTo(liveness.hostname, liveness.instanceId)) return false;
  return !liveness.isDead(tracked.pid);
}

/**
 * the run is read fresh and settled only while still running under the dead
 * owner's pid, so one its owner finished or another process took over is never
 * overwritten; the row is settled only after the save
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
  run.interruptOrphaned(
    "owner_process_dead",
    await runRepo.findStepStarts(workflowId, run.id),
  );
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

export interface RunRecord {
  readonly run: WorkflowRun;
  readonly workflowId: WorkflowId;
}

export interface RunRecordStore {
  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null>;
  listWorkflowIds(): Promise<WorkflowId[]>;
}

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
    // listed afresh for each miss, never from a snapshot: a record arriving
    // meanwhile must not have its row settled as missing
    for (const workflowId of await runRepo.listWorkflowIds()) {
      if (workflowId === workflow?.id) continue;
      const run = await runRepo.findById(workflowId, runId);
      if (run) return { run, workflowId };
    }
    return null;
  };
}

/**
 * safe while other swamp processes run: an interrupted row is never taken back
 * by its owner and only its record decides; a row whose record is still running
 * or unreadable is left as it is
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

export type MethodRunOutputs = Pick<OutputRepository, "findByIds" | "save">;

export function ownerExitedReason(pid: number): string {
  return `cancelled: the process running this method run (pid ${pid}) exited before it finished`;
}

export interface OrphanedMethodRun {
  readonly row: ActiveRun;
  readonly type: ModelType;
  readonly output: ModelOutput;
}

export interface MethodRunMatch {
  readonly running: OrphanedMethodRun[];
  /**
   * Rows with nothing left to settle: the output is missing, finished, or
   * owned by another pid, or the row cannot name an output.
   */
  readonly done: ActiveRun[];
}

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

export async function settleOrphanedMethodRun(
  outputRepo: Pick<OutputRepository, "save">,
  { row, type, output }: OrphanedMethodRun,
  reason: string | undefined,
): Promise<void> {
  output.markCancelled(reason);
  await outputRepo.save(type, row.methodName!, output);
}

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

export interface MethodRunCancellation {
  readonly closed: ActiveRun[];
  readonly failed: ActiveRun[];
  readonly errors: unknown[];
}

/**
 * a failed read or save is collected, not thrown, so the cancel can still
 * settle its run; the caller leaves a failed row interrupted
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
