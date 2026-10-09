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
  /** The id of the workflow the rejected run belongs to. */
  workflowId: string;
  workflowName: string;
  stepName: string;
  approved: false;
  decidedBy: string;
  reason: string | null;
  runStatus: string;
  /**
   * Nested runs the rejected run's nested steps still waited on: left
   * suspended on their own (swamp-club#2736).
   */
  detachedNestedRuns?: DetachedNestedRunData[];
  /**
   * Nested runs cancelled with this run, and running ones asked to stop
   * (swamp-club#2867).
   */
  cancelledNestedRuns?: CascadedNestedRunData[];
  stopRequestedNestedRuns?: CascadedNestedRunData[];
  /** The parent run still waiting on this nested run, to resume next. */
  awaitingParent?: AwaitingParentData;
}

export type WorkflowRejectEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRejectData }
  | { kind: "error"; error: SwampError };

export interface WorkflowRejectInput {
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
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowRejectDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  /**
   * Claims the run for the decision, so it is made on the run as stored and
   * no other writer saves over it (swamp-club#2919).
   */
  runClaims: WorkflowRunClaims;
  /**
   * Reads the run's own evaluated workflow snapshot, which its unfinished
   * jobs and steps are settled against (swamp-club#2905).
   */
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  runTracker?: RunTrackerRepository;
  /**
   * Confirms a parent run that still reads as waiting against the datastore
   * before a nested run's gate is decided (swamp-club#2867).
   */
  runRecordCurrency?: RunRecordCurrency;
  /** Fetches a parent run's record this host does not have. */
  fetchMissing?: (
    run: { workflowId: string; runId: string },
  ) => Promise<void>;
  /**
   * Cancels the nested runs the ended run waited on (swamp-club#2867).
   * Without it they are only reported.
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

/** A decision saved under the run's claim, or the refusal to make it. */
type RejectOutcome =
  | { error: SwampError }
  | {
    run: WorkflowRun;
    workflowName: string;
    workflowId: string;
    decidedBy: string;
  };

/**
 * Records the rejection on the run as read now, and settles the work the
 * rejection leaves unfinished, so the failed run keeps no other gate waiting
 * and no job running. The caller holds the run's claim, so nothing saves
 * between this read and this save.
 */
async function rejectClaimedRun(
  deps: WorkflowRejectDeps,
  input: WorkflowRejectInput,
  runId: string,
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

  const orphaned = await settleOrphanedNestedRun(deps, run, workflow);
  if (orphaned) return { error: orphanedNestedRunError(orphaned) };

  let step:
    | import("../../domain/workflows/workflow_run.ts").StepRun
    | undefined;
  let jobName: string | undefined;
  for (const job of run.jobs) {
    const s = job.getStep(input.stepName);
    // A nested workflow step waiting on its child run is not a gate.
    if (s && s.status === "waiting_approval" && !s.isNestedWait) {
      step = s;
      jobName = job.jobName;
      break;
    }
  }
  if (!step) {
    return {
      error: nestedWaitGateError(run, input.stepName) ??
        validationFailed(
          `Step "${input.stepName}" is not awaiting approval in the suspended run`,
        ),
    };
  }

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

        // Resolved once to learn which run is meant, then again under that
        // run's claim: only the second read is decided on.
        let located: SuspendedRunInfo;
        try {
          located = await resolveSuspendedRun(
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

        const outcome = await deps.runClaims.withClaim(
          located.run.id,
          () => rejectClaimedRun(deps, input, located.run.id),
        );
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
            reason: input.reason ?? null,
            runStatus: "failed",
            ...(nested ? nestedCascadeFields(nested) : {}),
            ...(awaitingParent ? { awaitingParent } : {}),
          },
        };
      })(),
    ));
}
