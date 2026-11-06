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
import {
  resolveSuspendedRun,
  suspendedRunClaimKey,
  type SuspendedRunInfo,
} from "../../domain/workflows/suspended_run_resolver.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
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
import { NestedRunLink } from "../../domain/workflows/nested_run_link.ts";
import { settleOrphanedNestedRun } from "../../domain/workflows/orphaned_nested_run.ts";
import type { EvaluatedWorkflowLookup } from "../../domain/workflows/abort_settlement.ts";
import type { RunRecordCurrency } from "../../domain/workflows/continuation_claim.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import {
  type AwaitingParentData,
  awaitingParentOf,
  nestedWaitGateError,
  orphanedNestedRunError,
} from "./nested_runs.ts";

export interface WorkflowApproveData {
  runId: string;
  workflowName: string;
  stepName: string;
  approved: true;
  decidedBy: string;
  client?: string;
  reason: string | null;
  allGatesDecided: boolean;
  /**
   * set by serve on a run a member drives: serve does not resume it, the run's
   * owner does
   */
  ownerResumes?: boolean;
  awaitingParent?: AwaitingParentData;
}

export type WorkflowApproveEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowApproveData }
  | { kind: "error"; error: SwampError };

export interface WorkflowApproveInput {
  workflowIdOrName: string;
  /**
   * look up by id only, so the decision lands on the workflow the caller
   * authorized
   */
  byId?: boolean;
  /**
   * ids are not guaranteed unique, so only a workflow with this name and the id
   * is accepted
   */
  expectedName?: string;
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
  client?: string;
}

export interface WorkflowApproveDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  /**
   * claims the run so the decision is made on the run as stored and no other
   * writer saves over it
   */
  runClaims: WorkflowRunClaims;
  findEvaluatedWorkflow?: EvaluatedWorkflowLookup;
  runTracker?: RunTrackerRepository;
  runRecordCurrency?: RunRecordCurrency;
  fetchMissing?: (
    run: { workflowId: string; runId: string },
  ) => Promise<void>;
  /** decides the run about to be acted on; set by serve, which replies itself */
  authorizeRun?: (run: WorkflowRun) => boolean;
}

export function createWorkflowApproveDeps(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
): WorkflowApproveDeps {
  return { workflowRepo, runRepo, runClaims };
}

type ApproveOutcome =
  | { error: SwampError }
  | { storedAs: string }
  | { run: WorkflowRun; workflowName: string; decidedBy: string };

async function approveClaimedRun(
  deps: WorkflowApproveDeps,
  input: WorkflowApproveInput,
  runId: string,
  claimKey: string,
): Promise<ApproveOutcome> {
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

  const { run, workflowName, workflow } = resolved;
  // decided only under the claim of the id as stored
  if (run.id !== claimKey) return { storedAs: run.id };

  // first, on the record this claim holds, before anything here writes
  if (deps.authorizeRun && !deps.authorizeRun(run)) {
    return { error: validationFailed("Not authorized to decide this run") };
  }

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
  if (!step || !jobName) {
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

  const decidedBy = input.decidedBy ?? Deno.env.get("USER") ??
    Deno.env.get("USERNAME") ?? "unknown";
  step.recordApprovalDecision({
    approved: true,
    reason: input.reason,
    decidedBy,
    ...(input.client !== undefined ? { client: input.client } : {}),
    decidedAt: new Date().toISOString(),
  });
  step.succeed();
  await deps.runRepo.save(createWorkflowId(run.workflowId), run);
  return { run, workflowName, decidedBy };
}

export async function* workflowApprove(
  ctx: LibSwampContext,
  deps: WorkflowApproveDeps,
  input: WorkflowApproveInput,
): AsyncIterable<WorkflowApproveEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.approve",
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
          () => approveClaimedRun(deps, input, readId, claimKey),
        );
        if ("storedAs" in outcome) {
          const storedAs = outcome.storedAs;
          outcome = await deps.runClaims.withClaim(
            storedAs,
            () => approveClaimedRun(deps, input, storedAs, storedAs),
          );
        }
        if ("storedAs" in outcome) {
          yield {
            kind: "error",
            error: validationFailed(
              `Workflow run ${readId} changed while it was claimed. Approve it again.`,
            ),
          };
          return;
        }
        if ("error" in outcome) {
          yield { kind: "error", error: outcome.error };
          return;
        }
        const { run, workflowName, decidedBy } = outcome;
        // whether a nested wait's child finished is derived from the child,
        // never stored; the decision is already saved, so an unreadable linked
        // run must not turn it into an error
        const allGatesDecided = run.status === "suspended" &&
          run.findWaitingApprovalStep() === undefined &&
          run.findSignalWaits().length === 0 &&
          await new NestedRunLink(deps).childrenSettled(run).catch(() => false);
        const awaitingParent = await awaitingParentOf(deps, run).catch(() =>
          undefined
        );

        yield {
          kind: "completed",
          data: {
            runId: run.id,
            workflowName,
            stepName: input.stepName,
            approved: true,
            decidedBy,
            ...(input.client !== undefined ? { client: input.client } : {}),
            reason: input.reason ?? null,
            allGatesDecided,
            ...(awaitingParent ? { awaitingParent } : {}),
          },
        };
      })(),
    ));
}
