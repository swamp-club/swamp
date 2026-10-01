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

import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { inputsMatch } from "../../domain/workflows/input_matching.ts";
import {
  type DetachedNestedRunData,
  detachedNestedRunsOf,
} from "./nested_runs.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";

export interface SupersedeResult {
  cancelledRunIds: string[];
  /**
   * Nested runs the superseded runs were still waiting on, left suspended
   * on their own (swamp-club#2736).
   */
  detachedNestedRuns: DetachedNestedRunData[];
}

/**
 * What superseding needs beyond the run repository: the workflow's
 * suspended runs, and each run's own evaluated workflow snapshot to settle
 * a superseded run against.
 */
export interface SupersedeDeps {
  findSuspendedRuns: (workflowId: WorkflowId) => Promise<WorkflowRun[]>;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
}

/**
 * Cancels the workflow's locally-owned suspended runs whose inputs match the
 * new run's, settling each one's unfinished jobs and steps against its
 * evaluated snapshot, or else `workflow`.
 */
export async function supersedeSuspendedRuns(
  workflow: Workflow,
  newInputs: Readonly<Record<string, unknown>>,
  { findSuspendedRuns, findEvaluatedWorkflow }: SupersedeDeps,
  runRepo: WorkflowRunRepository,
): Promise<SupersedeResult> {
  const suspendedRuns = await findSuspendedRuns(workflow.id);
  const cancelledRunIds: string[] = [];
  const detachedNestedRuns: DetachedNestedRunData[] = [];

  for (const run of suspendedRuns) {
    if (run.status !== "suspended") continue;
    if (run.instanceId !== undefined) continue;
    // A nested workflow's run belongs to the parent step that started it,
    // not to a direct run of the same workflow.
    if (run.parentRun !== undefined) continue;
    if (!inputsMatch(run.inputs, newInputs)) continue;

    cancelAndSettle(
      run,
      await resolveSettlementWorkflow(run, workflow, findEvaluatedWorkflow),
      "Superseded by new run with matching inputs",
    );
    await runRepo.save(workflow.id, run);
    cancelledRunIds.push(run.id);
    for (const detached of await detachedNestedRunsOf({ runRepo }, run)) {
      detachedNestedRuns.push(detached);
    }
  }

  return { cancelledRunIds, detachedNestedRuns };
}
