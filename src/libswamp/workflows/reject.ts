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

import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import {
  resolveSuspendedRun,
  suspendedRunClaimKey,
  type SuspendedRunInfo,
} from "../../domain/workflows/suspended_run_resolver.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import {
  completeAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";
import {
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "../../domain/workflows/approval_timeout.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import {
  ambiguousGateRefusal,
  type GateTarget,
  reopenedGateRefusal,
  waitingGate,
} from "./gate_refusals.ts";
import {
  type AwaitingParentData,
  awaitingParentOf,
  type DetachedNestedRunData,
  nestedWaitGateError,
  orphanedNestedRunError,
} from "./nested_runs.ts";
import {
  type CascadedNestedRunData,
  type NestedCascade,
  nestedCascadeFields,
  settleNestedRunsOf,
} from "./nested_cascade.ts";
import { settleOrphanedNestedRun } from "../../domain/workflows/orphaned_nested_run.ts";
import type { RunRecordCurrency } from "../../domain/workflows/continuation_claim.ts";

export interface WorkflowRejectData {
  runId: string;
  workflowId: string;
  workflowName: string;
  stepName: string;
  approved: false;
  decidedBy: string;
  client?: string;
  reason: string | null;
  runStatus: string;
  /**
   * nested runs the rejected run's nested steps still waited on, left suspended
   * on their own
   */
  detachedNestedRuns?: DetachedNestedRunData[];
  cancelledNestedRuns?: CascadedNestedRunData[];
  stopRequestedNestedRuns?: CascadedNestedRunData[];
  awaitingParent?: AwaitingParentData;
}

export type WorkflowRejectEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRejectData }
  | { kind: "error"; error: SwampError };

export interface WorkflowRejectInput extends GateTarget {
  workflowIdOrName: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only, so the decision lands on the workflow the
   * caller authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
  client?: string;
}

export interface WorkflowRejectDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  /**
   * claims the run so the decision is made on the run as stored and no other
   * writer saves over it
   */
  runClaims: WorkflowRunClaims;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  runTracker?: RunTrackerRepository;
  /**
   * confirms a parent run that still reads as waiting against the datastore
   * before a nested run's gate is decided
   */
  runRecordCurrency?: RunRecordCurrency;
  fetchMissing?: (
    run: { workflowId: string; runId: string },
  ) => Promise<void>;
  /** decides the run about to be acted on; set by serve, which replies itself */
  authorizeRun?: (run: WorkflowRun) => boolean;
  /**
   * cancels the nested runs the ended run waited on; without it they are only
   * reported
   */
  cascade?: NestedCascade;
}

export function createWorkflowRejectDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
  findEvaluatedWorkflow: EvaluatedWorkflowLookup,
  runTracker?: RunTrackerRepository,
): WorkflowRejectDeps {
  return {
    workflowRepo,
    runRepo,
    runClaims,
    findEvaluatedWorkflow,
    runTracker,
  };
}

type RejectOutcome =
  | { error: SwampError }
  | { storedAs: string }
  | {
    run: WorkflowRun;
    workflowName: string;
    workflowId: string;
    decidedBy: string;
  };

/**
 * the caller holds the run's claim, so nothing saves between this read and this
 * save
 */
async function rejectClaimedRun(
  deps: WorkflowRejectDeps,
  input: WorkflowRejectInput,
  runId: string,
  claimKey: string,
): Promise<RejectOutcome> {
  let resolved: SuspendedRunInfo;
  try {
    resolved = await resolveSuspendedRun(
      deps.workflowRepo,
      deps.runRepo,
      input.workflowIdOrName,
      runId,
      { byId: input.byId, expectedName: input.expectedName },
    );
  } catch (error) {
    return {
      error: validationFailed(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  const { run, workflowName, workflowId, workflow } = resolved;
  // decided only under the claim of the id as stored
  if (run.id !== claimKey) return { storedAs: run.id };

  // first, on the record this claim holds, before anything here writes
  if (deps.authorizeRun && !deps.authorizeRun(run)) {
    return { error: validationFailed("Not authorized to decide this run") };
  }

  const orphaned = await settleOrphanedNestedRun(deps, run, workflow);
  if (orphaned) return { error: orphanedNestedRunError(orphaned) };

  const ambiguous = ambiguousGateRefusal(run, input);
  if (ambiguous) return { error: ambiguous };

  const gate = waitingGate(run, input);
  const step = gate?.step;
  const jobName = gate?.jobName;
  if (!step) {
    return {
      error: nestedWaitGateError(run, input.stepName) ??
        validationFailed(
          `Step "${input.stepName}" is not awaiting approval in the suspended run`,
        ),
    };
  }

  const reopened = reopenedGateRefusal(step, input);
  if (reopened) return { error: reopened };

  const wfJob = workflow.jobs.find((j) => j.name === jobName);
  const timeout = evaluateApprovalTimeout(
    step.startedAt,
    gateTimeoutSeconds(step, wfJob?.steps),
    new Date(),
  );
  if (timeout?.expired) {
    return {
      error: validationFailed(
        `Approval timed out: step "${input.stepName}" has been waiting ${
          Math.round(timeout.elapsedSeconds)
        }s (timeout: ${timeout.timeoutSeconds}s)`,
      ),
    };
  }

  // Read before anything changes on the run.
  const settlementWorkflow = await resolveSettlementWorkflow(
    run,
    workflow,
    deps.findEvaluatedWorkflow,
  );

  const decidedBy = input.decidedBy ?? Deno.env.get("USER") ??
    Deno.env.get("USERNAME") ?? "unknown";
  step.recordApprovalDecision({
    approved: false,
    reason: input.reason,
    decidedBy,
    ...(input.client !== undefined ? { client: input.client } : {}),
    decidedAt: new Date().toISOString(),
  });
  step.fail(input.reason ?? "Approval rejected");
  // The gate's job is left open: settling ends it from its failed gate,
  // along with every other job and step the rejection leaves unfinished.
  completeAndSettle(run, settlementWorkflow);
  await deps.runRepo.save(createWorkflowId(workflowId), run);
  if (deps.runTracker) {
    deps.runTracker.complete(run.id, "failed");
  }
  return { run, workflowName, workflowId, decidedBy };
}

export async function* workflowReject(
  ctx: LibSwampContext,
  deps: WorkflowRejectDeps,
  input: WorkflowRejectInput,
): AsyncIterable<WorkflowRejectEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.reject",
      {
        "workflow.id_or_name": input.workflowIdOrName,
        "step.name": input.stepName,
      },
      (async function* () {
        yield { kind: "resolving" };

        // Only the read under the run's claim is decided on.
        let claimKey: string;
        try {
          claimKey = await suspendedRunClaimKey(
            deps.workflowRepo,
            deps.runRepo,
            input.workflowIdOrName,
            input.runId,
            { byId: input.byId, expectedName: input.expectedName },
          );
        } catch (error) {
          yield {
            kind: "error",
            error: validationFailed(
              error instanceof Error ? error.message : String(error),
            ),
          };
          return;
        }

        const readId = input.runId ?? claimKey;
        let outcome = await deps.runClaims.withClaim(
          claimKey,
          () => rejectClaimedRun(deps, input, readId, claimKey),
        );
        if ("storedAs" in outcome) {
          const storedAs = outcome.storedAs;
          outcome = await deps.runClaims.withClaim(
            storedAs,
            () => rejectClaimedRun(deps, input, storedAs, storedAs),
          );
        }
        if ("storedAs" in outcome) {
          yield {
            kind: "error",
            error: validationFailed(
              `Workflow run ${readId} changed while it was claimed. Reject it again.`,
            ),
          };
          return;
        }
        if ("error" in outcome) {
          yield { kind: "error", error: outcome.error };
          return;
        }
        const { run, workflowName, workflowId, decidedBy } = outcome;
        // The decision is saved: an unreadable linked run must not turn it
        // into an error, so these reads are best effort.
        const nested = await settleNestedRunsOf(deps, deps.cascade, run)
          .catch(() => undefined);
        const awaitingParent = await awaitingParentOf(deps, run).catch(() =>
          undefined
        );

        yield {
          kind: "completed",
          data: {
            runId: run.id,
            workflowId,
            workflowName,
            stepName: input.stepName,
            approved: false,
            decidedBy,
            ...(input.client !== undefined ? { client: input.client } : {}),
            reason: input.reason ?? null,
            runStatus: "failed",
            ...(nested ? nestedCascadeFields(nested) : {}),
            ...(awaitingParent ? { awaitingParent } : {}),
          },
        };
      })(),
    ));
}
