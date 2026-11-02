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

import { mayHoldPlaintextSensitiveValues } from "../../domain/expressions/persisted_evaluation.ts";
import { replayInputs } from "../../domain/workflows/persisted_workflow.ts";
import type { EvaluatedWorkflowCache } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
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
  detachedNestedRuns: DetachedNestedRunData[];
  cancelledNestedRuns: CascadedNestedRunData[];
  stopRequestedNestedRuns: CascadedNestedRunData[];
  /**
   * left alone because a step of theirs or a nested run waits for a signal:
   * cancelling discards the wait, and an input-less workflow would cancel its
   * own waiting run each start; past-deadline waits too
   */
  skippedRuns: SkippedSupersedeData[];
}

export interface SkippedSupersedeData {
  runId: string;
  waitIds: string[];
}

export interface SupersedeDeps {
  /**
   * superseding passes the new run's signal, so a cancelled run stops reading
   * them
   */
  findSuspendedRuns: (
    workflowId: WorkflowId,
    signal?: AbortSignal,
  ) => Promise<WorkflowRun[]>;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  /**
   * claims each run while it is cancelled, so the cancel acts on the run as
   * stored and no other writer saves over it
   */
  runClaims: WorkflowRunClaims;
  /**
   * cancels the nested runs the ended run waited on; without it they are only
   * reported
   */
  cascade?: NestedCascade;
  /**
   * loaded once per start, matched on here and handed to the execution service
   * to replay, so a cache rewritten between the two cannot split them.
   * Required, so no superseding caller leaves the run to load another copy.
   */
  evaluatedCache: (
    workflowName: string,
  ) => Promise<EvaluatedWorkflowCache | null>;
}

/**
 * matched on the inputs the new run will record; a --last-evaluated run records
 * its cache's inputs under the supplied ones, so it matches on `cache`, the
 * copy it executes. Undefined when the run will be refused before it starts.
 */
export function supersedeMatchInputs(
  supplied: Record<string, unknown>,
  lastEvaluated: boolean,
  cache: EvaluatedWorkflowCache | null | undefined,
): Record<string, unknown> | undefined {
  if (!lastEvaluated) return supplied;
  if (!cache) return undefined;
  // What execution refuses before it replays, so a refused run supersedes
  // nothing: a cache that may hold plaintext secrets, or one whose
  // provenance cannot be read.
  if (mayHoldPlaintextSensitiveValues(cache)) return undefined;
  if (cache.provenance === "unreadable") return undefined;
  const replay = replayInputs(cache, supplied);
  return "inputs" in replay ? replay.inputs : undefined;
}

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
 * settles each cancelled run's unfinished jobs and steps against its evaluated
 * snapshot; only the read stops on abort, and a stopped read supersedes
 * nothing, so a finished read's runs are all settled
 */
export async function supersedeSuspendedRuns(
  workflow: Workflow,
  newInputs: Readonly<Record<string, unknown>>,
  { findSuspendedRuns, findEvaluatedWorkflow, runClaims, cascade }:
    SupersedeDeps,
  runRepo: WorkflowRunRepository,
  signal?: AbortSignal,
): Promise<SupersedeResult> {
  let suspendedRuns: WorkflowRun[];
  try {
    suspendedRuns = await findSuspendedRuns(workflow.id, signal);
  } catch (error) {
    // whatever reason the run was cancelled with
    if (!signal?.aborted) throw error;
    suspendedRuns = [];
  }
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
