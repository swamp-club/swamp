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
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
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
  /**
   * Claims each run while it is cancelled, so the cancel acts on the run as
   * stored and no other writer saves over it (swamp-club#2919).
   */
  runClaims: WorkflowRunClaims;
}

/** Whether a new run of the workflow with `newInputs` supersedes `run`. */
function isSuperseded(
  run: WorkflowRun,
  newInputs: Readonly<Record<string, unknown>>,
): boolean {
  if (run.status !== "suspended") return false;
  if (run.instanceId !== undefined) return false;
  // A nested workflow's run belongs to the parent step that started it,
  // not to a direct run of the same workflow.
  if (run.parentRun !== undefined) return false;
  return inputsMatch(run.inputs, newInputs);
}

/**
 * Cancels the workflow's locally-owned suspended runs whose inputs match the
 * new run's, settling each one's unfinished jobs and steps against its
 * evaluated snapshot, or else `workflow`.
 */
export async function supersedeSuspendedRuns(
  workflow: Workflow,
  newInputs: Readonly<Record<string, unknown>>,
  { findSuspendedRuns, findEvaluatedWorkflow, runClaims }: SupersedeDeps,
  runRepo: WorkflowRunRepository,
): Promise<SupersedeResult> {
  const suspendedRuns = await findSuspendedRuns(workflow.id);
  const cancelledRunIds: string[] = [];
  const detachedNestedRuns: DetachedNestedRunData[] = [];

  for (const listed of suspendedRuns) {
    if (!isSuperseded(listed, newInputs)) continue;

    // The listed copy only picks the candidate. The run is read again under
    // its claim, where an approve, reject or cancel since the listing shows.
    const run = await runClaims.withClaim(listed.id, async () => {
      const current = await runRepo.findById(workflow.id, listed.id);
      if (!current || !isSuperseded(current, newInputs)) return null;
      cancelAndSettle(
        current,
        await resolveSettlementWorkflow(
          current,
          workflow,
          findEvaluatedWorkflow,
        ),
        "Superseded by new run with matching inputs",
      );
      await runRepo.save(workflow.id, current);
      return current;
    });
    if (!run) continue;
    cancelledRunIds.push(run.id);
    for (const detached of await detachedNestedRunsOf({ runRepo }, run)) {
      detachedNestedRuns.push(detached);
    }
  }

  return { cancelledRunIds, detachedNestedRuns };
}
