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
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface WorkflowCancelSuspendedData {
  runId: string;
  workflowName: string;
  previousStatus: "suspended";
  status: "cancelled";
}

export type WorkflowCancelSuspendedEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowCancelSuspendedData }
  | { kind: "error"; error: SwampError };

export interface WorkflowCancelSuspendedInput {
  runId: string;
  /** When given, the run must belong to this workflow (name or id). */
  workflowIdOrName?: string;
  reason: string;
}

/** The workflow a run belongs to, as the authorize callback sees it. */
export interface CancelTargetWorkflow {
  id: string;
  name: string;
}

export interface WorkflowCancelSuspendedDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
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
  runRepo: WorkflowRunRepository,
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

      const found = await findRun(deps, input);
      if (!found) {
        yield { kind: "error", error: cancelNotFound(input.runId) };
        return;
      }
      const { run, workflowId } = found;

      const workflow = await deps.workflowRepo.findById(workflowId);
      const target: CancelTargetWorkflow = {
        id: run.workflowId,
        name: workflow?.name ?? run.workflowName,
      };
      if (
        input.workflowIdOrName !== undefined &&
        input.workflowIdOrName !== target.id &&
        input.workflowIdOrName !== target.name
      ) {
        yield { kind: "error", error: cancelNotFound(input.runId) };
        return;
      }
      if (!(await deps.authorize(target))) {
        yield { kind: "error", error: cancelNotFound(input.runId) };
        return;
      }

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

      yield {
        kind: "completed",
        data: {
          runId: run.id,
          workflowName: target.name,
          previousStatus: "suspended",
          status: "cancelled",
        },
      };
    })(),
  );
}

async function findRun(
  deps: WorkflowCancelSuspendedDeps,
  input: WorkflowCancelSuspendedInput,
): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null> {
  if (input.workflowIdOrName !== undefined) {
    const workflow =
      await deps.workflowRepo.findByName(input.workflowIdOrName) ??
        await deps.workflowRepo.findById(
          createWorkflowId(input.workflowIdOrName),
        );
    if (!workflow) return null;
    const run = await deps.runRepo.findById(
      workflow.id,
      createWorkflowRunId(input.runId),
    );
    return run ? { run, workflowId: workflow.id } : null;
  }
  // Only a suspended run can be cancelled here, so the status index narrows
  // the search without hydrating every run of every workflow.
  const suspended = await deps.runRepo.findGlobalByStatus("suspended");
  return suspended.find(({ run }) => run.id === input.runId) ?? null;
}
