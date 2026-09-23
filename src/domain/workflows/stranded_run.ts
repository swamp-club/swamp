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

import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";

/**
 * Cancels a run that an aborted execution left `running` with nothing
 * driving it, and completes its tracker row as `cancelled`.
 *
 * The run is reloaded from the repository, so a terminal status the
 * execution already saved is never overwritten: a missing run, or one in
 * any status other than `running`, is left untouched. Call this only after
 * the execution stream has finished or been disposed.
 *
 * Returns true when the run was cancelled.
 */
export async function cancelStrandedRun(
  runRepo: WorkflowRunRepository,
  runTracker: RunTrackerRepository,
  workflowId: WorkflowId,
  runId: WorkflowRunId,
  reason: string,
): Promise<boolean> {
  const run = await runRepo.findById(workflowId, runId);
  if (!run || run.status !== "running") return false;
  run.cancel(reason);
  await runRepo.save(workflowId, run);
  runTracker.complete(run.id, "cancelled");
  return true;
}
