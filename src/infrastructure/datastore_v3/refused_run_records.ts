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

/**
 * Closes decision 7's rule that a run record never names data whose
 * partition was refused (swamp-club#3257): the `onRefused` a workflow run's
 * commit-log root passes. Dormant until the v3 opt-in wires a run root.
 *
 * @module
 */

import type { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

/**
 * Saves each run `error` held back again, with every step that wrote a
 * refused data version failed (`WorkflowRun.failStepsNamingRefusedData`), so
 * the record the root then commits names no refused data as a success. The
 * save runs in the root, so it supersedes the held record. A held run that
 * names no refused version is left as it is: its held record is already
 * right, and the root commits it once the refusal is acknowledged.
 */
export async function reconcileRefusedRuns(
  runRepo: WorkflowRunRepository,
  error: PartitionsRefusedError,
): Promise<void> {
  const refused = error.refusals.flatMap((refusal) => refusal.versions);
  const reason = `The datastore refused the data this step wrote: ${
    error.refusals.map((refusal) => refusal.message).join("; ")
  }`;
  for (const partition of error.heldRuns) {
    const identity = partition.identity;
    if (identity.kind !== "run") continue;
    const workflowId = createWorkflowId(identity.workflowId);
    const run = await runRepo.findById(
      workflowId,
      createWorkflowRunId(identity.runId),
    );
    if (run === null) continue;
    const status = run.status;
    const failed = run.failStepsNamingRefusedData(refused, reason);
    // A run failed only by a workflow-scope report artifact fails no step.
    if (failed.length === 0 && run.status === status) continue;
    await runRepo.save(workflowId, run);
  }
}
