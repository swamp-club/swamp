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

import {
  OWNER_STOPPED_STEP_ERROR,
  type WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  cancelAndSettle,
  type EvaluatedWorkflowLookup,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import {
  withGeneratorSpan,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import type { DetachedNestedRunData } from "./nested_runs.ts";
import {
  type CascadedNestedRunData,
  type NestedCascade,
  nestedCascadeFields,
  settleNestedRunsOf,
} from "./nested_cascade.ts";

export interface WorkflowCancelSuspendedData {
  runId: string;
  workflowName: string;
  previousStatus: "suspended" | "running";
  status: "cancelled";
  detachedNestedRuns?: DetachedNestedRunData[];
  cancelledNestedRuns?: CascadedNestedRunData[];
  stopRequestedNestedRuns?: CascadedNestedRunData[];
}

export type WorkflowCancelSuspendedEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowCancelSuspendedData }
  | { kind: "error"; error: SwampError };

export interface WorkflowCancelSuspendedInput {
  runId: string;
  /**
   * checked against the workflow of the run found by runId, never resolved on
   * its own, so an unknown name costs no workflow lookup
   */
  workflowIdOrName?: string;
  /**
   * The id of the workflow {@link locateSuspendedRunToCancel} found the run
   * in. When given, the run is loaded from that workflow alone and
   * `workflowIdOrName` is not consulted.
   */
  workflowId?: string;
  reason: string;
}

export type LocateSuspendedRunInput = Pick<
  WorkflowCancelSuspendedInput,
  "runId" | "workflowIdOrName"
>;

export interface LocatedSuspendedRun {
  workflowId: string;
  workflow: CancelTargetWorkflow;
}

export interface CancelTargetWorkflow {
  id: string;
  name: string;
}

/** structural so the WorkflowRunRepository port does not grow findGlobalById */
type CancelRunRepository =
  & Pick<WorkflowRunRepository, "findById" | "save" | "findStepStarts">
  & {
    findGlobalById(
      runId: WorkflowRunId,
    ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null>;
  };

export interface WorkflowCancelSuspendedDeps {
  workflowRepo: WorkflowRepository;
  runRepo: CancelRunRepository;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  runTracker?: RunTrackerRepository;
  /**
   * Decides whether the caller may cancel runs of the run's own workflow.
   * Called after the run is loaded and before its status is revealed or it is
   * changed; a false result is reported as not found.
   */
  authorize: (workflow: CancelTargetWorkflow) => Promise<boolean> | boolean;
  /**
   * Decides whether a run recorded `running` has lost its owner: no process
   * drives it and the one that did is shown to be gone. Only then is a
   * running run cancelled here; without this, or when the owner is not shown
   * gone, it is refused, since a live owner would save over the cancel.
   */
  ownerGone?: (run: WorkflowRun) => Promise<RunOwnerVerdict> | RunOwnerVerdict;
  cascade?: NestedCascade;
}

export type RunOwnerVerdict =
  | { gone: true }
  | { gone: false; why: string };

const OWNER_NOT_JUDGED: RunOwnerVerdict = {
  gone: false,
  why:
    "nothing here can tell whether the process running it has stopped. Cancel it where it was started",
};

export function createWorkflowCancelSuspendedDeps(
  workflowRepo: WorkflowRepository,
  runRepo: CancelRunRepository,
  authorize: WorkflowCancelSuspendedDeps["authorize"],
  findEvaluatedWorkflow: EvaluatedWorkflowLookup,
  runTracker?: RunTrackerRepository,
  ownerGone?: WorkflowCancelSuspendedDeps["ownerGone"],
): WorkflowCancelSuspendedDeps {
  return {
    workflowRepo,
    runRepo,
    authorize,
    findEvaluatedWorkflow,
    runTracker,
    ownerGone,
  };
}

export const CANCEL_SUSPENDED_NOT_FOUND = "not_found";

export const CANCEL_SUSPENDED_NOT_SUSPENDED = "not_suspended";

function cancelNotFound(runId: string): SwampError {
  return {
    code: CANCEL_SUSPENDED_NOT_FOUND,
    message: `No cancellable run with id ${runId}`,
  };
}

/**
 * returns null for a missing run, another workflow's run and an unauthorized
 * caller alike, so an id reveals nothing; needs no claim, since
 * workflowCancelSuspended reads and authorizes again under its own
 */
export async function locateSuspendedRunToCancel(
  deps: WorkflowCancelSuspendedDeps,
  input: LocateSuspendedRunInput,
): Promise<LocatedSuspendedRun | null> {
  return await withSpan(
    "swamp.workflow.cancel_suspended.locate",
    { "workflow.run_id": input.runId },
    async () => {
      const found = await findAuthorizedRun(deps, input);
      return found
        ? { workflowId: found.workflowId, workflow: found.target }
        : null;
    },
  );
}

/**
 * authorizes against the run's own workflow, never a caller-supplied name; a
 * running run is cancelled only when ownerGone shows its process is gone. Does
 * no locking: the caller must hold a claim keeping other writers off the run
 */
export async function* workflowCancelSuspended(
  ctx: LibSwampContext,
  deps: WorkflowCancelSuspendedDeps,
  input: WorkflowCancelSuspendedInput,
): AsyncIterable<WorkflowCancelSuspendedEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.cancel_suspended",
      { "workflow.run_id": input.runId },
      (async function* () {
        yield { kind: "resolving" };

        const found = await findAuthorizedRun(deps, input);
        if (!found) {
          yield { kind: "error", error: cancelNotFound(input.runId) };
          return;
        }
        const { run, workflowId, target, workflow } = found;

        const previousStatus = run.status;
        const owner = previousStatus !== "running"
          ? undefined
          : deps.ownerGone
          ? await deps.ownerGone(run)
          : OWNER_NOT_JUDGED;
        if (owner && !owner.gone) {
          yield {
            kind: "error",
            error: {
              ...validationFailed(
                `Run ${run.id} is recorded as running and was not cancelled: ${owner.why}`,
              ),
              code: CANCEL_SUSPENDED_NOT_SUSPENDED,
            },
          };
          return;
        }
        if (previousStatus !== "suspended" && previousStatus !== "running") {
          yield {
            kind: "error",
            error: {
              ...validationFailed(
                `Run ${run.id} is not suspended (status: ${run.status})`,
              ),
              code: CANCEL_SUSPENDED_NOT_SUSPENDED,
            },
          };
          return;
        }

        if (previousStatus === "running") {
          run.applyStepStarts(
            await deps.runRepo.findStepStarts(workflowId, run.id),
          );
        }
        cancelAndSettle(
          run,
          await resolveSettlementWorkflow(
            run,
            workflow,
            deps.findEvaluatedWorkflow,
          ),
          input.reason,
          // The steps the dead owner had in flight, as an offline cancel
          // settles them.
          previousStatus === "running"
            ? { inFlightStepError: OWNER_STOPPED_STEP_ERROR }
            : undefined,
        );
        await deps.runRepo.save(workflowId, run);
        if (deps.runTracker) {
          deps.runTracker.complete(run.id, "cancelled", input.reason);
        }
        const nested = await settleNestedRunsOf(deps, deps.cascade, run)
          .catch(() => undefined);

        yield {
          kind: "completed",
          data: {
            runId: run.id,
            workflowName: target.name,
            previousStatus,
            status: "cancelled",
            ...(nested ? nestedCascadeFields(nested) : {}),
          },
        };
      })(),
    ));
}

async function findAuthorizedRun(
  deps: WorkflowCancelSuspendedDeps,
  input: LocateSuspendedRunInput & { workflowId?: string },
): Promise<
  | {
    run: WorkflowRun;
    workflowId: WorkflowId;
    target: CancelTargetWorkflow;
    workflow: Workflow | undefined;
  }
  | null
> {
  const found = await findRun(deps, input);
  if (!found) return null;
  const { run, workflowId } = found;

  const workflow = await deps.workflowRepo.findById(workflowId);
  const target: CancelTargetWorkflow = {
    id: run.workflowId,
    name: workflow?.name ?? run.workflowName,
  };
  if (
    input.workflowId === undefined &&
    input.workflowIdOrName !== undefined &&
    input.workflowIdOrName !== target.id &&
    input.workflowIdOrName !== target.name
  ) {
    return null;
  }
  if (!(await deps.authorize(target))) return null;
  return { run, workflowId, target, workflow: workflow ?? undefined };
}

/**
 * finds the run by id alone so nothing the caller sent is resolved before a run
 * exists; a non-UUID id is not found without a repository read
 */
async function findRun(
  deps: WorkflowCancelSuspendedDeps,
  input: LocateSuspendedRunInput & { workflowId?: string },
): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null> {
  if (!isUuid(input.runId)) return null;
  const runId = createWorkflowRunId(input.runId);
  if (input.workflowId !== undefined) {
    const workflowId = createWorkflowId(input.workflowId);
    const run = await deps.runRepo.findById(workflowId, runId);
    return run ? { run, workflowId } : null;
  }
  const found = await deps.runRepo.findGlobalById(runId);
  if (!found) return null;
  // without a workflow to check against, only a suspended or running run is
  // reported; any other status stays not found
  if (
    input.workflowIdOrName === undefined &&
    found.run.status !== "suspended" && found.run.status !== "running"
  ) {
    return null;
  }
  return found;
}
