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
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
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
 * record may still say `running`.
 *
 * Returns true when the run was interrupted.
 */
export async function settleDeadOwnerRun(
  runRepo: WorkflowRunRepository,
  runTracker: RunTrackerRepository,
  workflowId: WorkflowId,
  runId: WorkflowRunId,
  liveness: OwnerLiveness,
): Promise<boolean> {
  const run = await runRepo.findById(workflowId, runId);
  if (!run || !runHasDeadOwner(run, runTracker, liveness)) return false;
  logger.warn(
    "Interrupting workflow run {runId} (workflow: {workflowName}): its owning process {pid} is gone",
    { runId: run.id, workflowName: run.workflowName, pid: run.pid },
  );
  runTracker.complete(run.id, "interrupted");
  run.interruptOrphaned("owner_process_dead");
  await runRepo.save(workflowId, run);
  runTracker.markSettled(run.id, "owner_process_dead");
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
