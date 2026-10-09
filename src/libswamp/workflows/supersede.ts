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
import { NestedRunLink } from "../../domain/workflows/nested_run_link.ts";
import type { DetachedNestedRunData } from "./nested_runs.ts";
import {
  type CascadedNestedRunData,
  emptyNestedCascade,
  mergeNestedCascade,
  type NestedCascade,
  settleNestedRunsOf,
} from "./nested_cascade.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";

export interface SupersedeResult {
  cancelledRunIds: string[];
  /**
   * Nested runs the superseded runs were still waiting on and that were
   * left unfinished (swamp-club#2736).
   */
  detachedNestedRuns: DetachedNestedRunData[];
  /**
   * Nested runs cancelled with the superseded runs, and running ones asked
   * to stop (swamp-club#2867).
   */
  cancelledNestedRuns: CascadedNestedRunData[];
  stopRequestedNestedRuns: CascadedNestedRunData[];
  /**
   * Suspended runs with matching inputs left alone because a step of theirs,
   * or of a nested run they wait on, waits for a signal. Cancelling one would discard the wait, and a
   * workflow with no inputs would cancel its own waiting run each time it is
   * started. A wait past its deadline is left too: a resume fails its step,
   * so `failed` handlers run.
   */
  skippedRuns: SkippedSupersedeData[];
}

/** A run supersede left alone, with the ids of the waits it holds. */
export interface SkippedSupersedeData {
  runId: string;
  waitIds: string[];
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
  /**
   * Cancels the nested runs the ended run waited on (swamp-club#2867).
   * Without it they are only reported.
   */
  cascade?: NestedCascade;
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
  { findSuspendedRuns, findEvaluatedWorkflow, runClaims, cascade }:
    SupersedeDeps,
  runRepo: WorkflowRunRepository,
): Promise<SupersedeResult> {
  const suspendedRuns = await findSuspendedRuns(workflow.id);
  const cancelledRunIds: string[] = [];
  const nested = emptyNestedCascade();
  const skippedRuns: SkippedSupersedeData[] = [];
  // Only child runs are read through it: no workflow is looked up.
  const nestedLink = new NestedRunLink({
    runRepo,
    workflowRepo: { findById: () => Promise.resolve(null) },
  });

  for (const listed of suspendedRuns) {
    if (!isSuperseded(listed, newInputs)) continue;

    // The listed copy only picks the candidate. The run is read again under
    // its claim, where an approve, reject or cancel since the listing shows.
    const run = await runClaims.withClaim(listed.id, async () => {
      const current = await runRepo.findById(workflow.id, listed.id);
      if (!current || !isSuperseded(current, newInputs)) return null;
      // A nested run's wait counts as the run's own: superseding the run
      // would cancel that child, or leave it with no parent to signal for.
      const signalWaits = [
        ...current.findSignalWaits(),
        ...await nestedLink.signalWaitsBelow(current),
      ];
      if (signalWaits.length > 0) {
        skippedRuns.push({
          runId: current.id,
          waitIds: signalWaits.flatMap((ref) => ref.wait ? [ref.wait.id] : []),
        });
        return null;
      }
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
    // After the run's claim is released: each child is claimed on its own.
    mergeNestedCascade(
      nested,
      await settleNestedRunsOf({ runRepo }, cascade, run),
    );
  }

  return { cancelledRunIds, ...nested, skippedRuns };
}
