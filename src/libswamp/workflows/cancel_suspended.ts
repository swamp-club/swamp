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
import { isUuid } from "../../domain/models/model_lookup.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import {
  withGeneratorSpan,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  type DetachedNestedRunData,
  detachedNestedRunsOf,
} from "./nested_runs.ts";

export interface WorkflowCancelSuspendedData {
  runId: string;
  workflowName: string;
  previousStatus: "suspended";
  status: "cancelled";
  /**
   * Nested runs the cancelled run's nested steps still waited on, left
   * suspended on their own (swamp-club#2736).
   */
  detachedNestedRuns?: DetachedNestedRunData[];
}

export type WorkflowCancelSuspendedEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowCancelSuspendedData }
  | { kind: "error"; error: SwampError };

export interface WorkflowCancelSuspendedInput {
  runId: string;
  /**
   * When given, the run must belong to this workflow (name or id). It is
   * checked against the workflow of the run found by `runId`, never resolved
   * on its own, so an unknown name costs no workflow lookup.
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

/** What {@link locateSuspendedRunToCancel} needs to find a run. */
export type LocateSuspendedRunInput = Pick<
  WorkflowCancelSuspendedInput,
  "runId" | "workflowIdOrName"
>;

/** A run the caller may cancel, as located before anything is changed. */
export interface LocatedSuspendedRun {
  /** The id of the workflow whose runs hold the run. */
  workflowId: string;
  workflow: CancelTargetWorkflow;
}

/** The workflow a run belongs to, as the authorize callback sees it. */
export interface CancelTargetWorkflow {
  id: string;
  name: string;
}

/**
 * The run repository surface cancel needs: a run found by id alone, loading
 * only that run's file, plus the workflow-scoped read and the save. Structural
 * so the {@link WorkflowRunRepository} port does not grow `findGlobalById`.
 */
type CancelRunRepository =
  & Pick<WorkflowRunRepository, "findById" | "save">
  & {
    findGlobalById(
      runId: WorkflowRunId,
    ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null>;
  };

export interface WorkflowCancelSuspendedDeps {
  workflowRepo: WorkflowRepository;
  runRepo: CancelRunRepository;
  runTracker?: RunTrackerRepository;
  /**
   * Decides whether the caller may cancel runs of the run's own workflow.
   * Called after the run is loaded and before its status is revealed or it is
   * changed; a false result is reported as not found.
   */
  authorize: (workflow: CancelTargetWorkflow) => Promise<boolean> | boolean;
}

export function createWorkflowCancelSuspendedDeps(
  workflowRepo: WorkflowRepository,
  runRepo: CancelRunRepository,
  authorize: WorkflowCancelSuspendedDeps["authorize"],
  runTracker?: RunTrackerRepository,
): WorkflowCancelSuspendedDeps {
  return { workflowRepo, runRepo, authorize, runTracker };
}

/** Code of the error reported for a missing, unauthorized or mismatched run. */
export const CANCEL_SUSPENDED_NOT_FOUND = "not_found";

/** Code of the error reported for an authorized run that is not suspended. */
export const CANCEL_SUSPENDED_NOT_SUSPENDED = "not_suspended";

function cancelNotFound(runId: string): SwampError {
  return {
    code: CANCEL_SUSPENDED_NOT_FOUND,
    message: `No cancellable run with id ${runId}`,
  };
}

/**
 * Finds the run a cancel names and authorizes the caller against the workflow
 * it belongs to, without changing anything. Returns null for a missing run, a
 * run of another workflow than `workflowIdOrName`, and an unauthorized caller
 * alike, so an id reveals nothing. Needs no claim on the run: a caller that
 * goes on to cancel passes the returned `workflowId` to
 * {@link workflowCancelSuspended}, which reads and authorizes the run again
 * under its claim.
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
 * Cancels a persisted suspended run found by its id alone, such as one started
 * by `swamp serve` that no process is driving. The run is loaded, then the
 * caller is authorized against the workflow the run belongs to (never a name
 * the caller supplied), then it is cancelled and saved. A missing run, a run
 * of another workflow than `workflowIdOrName`, and an unauthorized caller all
 * get the same not-found error, so an id reveals nothing.
 *
 * Does no locking: the caller must hold whatever claim keeps other writers
 * off the run for the whole call, so the load here is a fresh read.
 */
export async function* workflowCancelSuspended(
  _ctx: LibSwampContext,
  deps: WorkflowCancelSuspendedDeps,
  input: WorkflowCancelSuspendedInput,
): AsyncIterable<WorkflowCancelSuspendedEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.cancel_suspended",
    { "workflow.run_id": input.runId },
    (async function* () {
      yield { kind: "resolving" };

      const found = await findAuthorizedRun(deps, input);
      if (!found) {
        yield { kind: "error", error: cancelNotFound(input.runId) };
        return;
      }
      const { run, workflowId, target } = found;

      if (run.status !== "suspended") {
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

      run.cancel(input.reason);
      await deps.runRepo.save(workflowId, run);
      if (deps.runTracker) {
        deps.runTracker.complete(run.id, "cancelled", input.reason);
      }
      const detachedNestedRuns = await detachedNestedRunsOf(deps, run);

      yield {
        kind: "completed",
        data: {
          runId: run.id,
          workflowName: target.name,
          previousStatus: "suspended",
          status: "cancelled",
          ...(detachedNestedRuns.length > 0 ? { detachedNestedRuns } : {}),
        },
      };
    })(),
  );
}

/**
 * Loads the run, resolves the workflow it belongs to, and checks it against
 * `workflowIdOrName` and the caller's authorization, in that order. Null for
 * any failure, which callers report as not found.
 */
async function findAuthorizedRun(
  deps: WorkflowCancelSuspendedDeps,
  input: LocateSuspendedRunInput & { workflowId?: string },
): Promise<
  | { run: WorkflowRun; workflowId: WorkflowId; target: CancelTargetWorkflow }
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
  return { run, workflowId, target };
}

/**
 * Finds the run by its id alone, so nothing the caller sent is resolved before
 * a run exists: `workflowIdOrName` is checked afterwards against the run's own
 * workflow by {@link findAuthorizedRun}. A run id is always a UUID, so any
 * other id is not found without a repository read.
 *
 * Should one id ever sit under two workflows (only a hand-copied `.swamp`
 * tree could do that), the first found is used and a name naming the other
 * does not match.
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
  // Without a workflow to check against, only a suspended run is reported:
  // any other status stays not found, as it always has on this path.
  if (
    input.workflowIdOrName === undefined && found.run.status !== "suspended"
  ) {
    return null;
  }
  return found;
}
