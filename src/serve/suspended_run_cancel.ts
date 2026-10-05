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
  CANCEL_SUSPENDED_NOT_SUSPENDED,
  type CancelTargetWorkflow,
  createWorkflowCancelSuspendedDeps,
  locateSuspendedRunToCancel,
  type SwampError,
  workflowCancelSuspended,
  type WorkflowCancelSuspendedDeps,
} from "../libswamp/mod.ts";
import {
  type ConnectionContext,
  handlerLibSwampContext,
  pushChangedToRemote,
} from "./handlers/shared.ts";
import type { ActiveRunRegistry } from "./active_run_registry.ts";
import { withSyncGate } from "./sync_gate.ts";
import type { DetachedNestedRunData } from "../libswamp/mod.ts";
import { YamlEvaluatedWorkflowRepository } from "../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { SWAMP_SUBDIRS } from "../infrastructure/persistence/paths.ts";

export interface SuspendedRunCancelRequest {
  runId: string;
  workflowIdOrName?: string;
  reason: string;
}

export type SuspendedRunCancelResult =
  | {
    status: "cancelled";
    runId: string;
    workflowName: string;
    /**
     * Nested runs the cancelled run waited on, left suspended on their own
     * (swamp-club#2736).
     */
    detachedNestedRuns?: DetachedNestedRunData[];
  }
  /** A run is registered under the id: cancel it through the registry. */
  | { status: "active" }
  /** Another operation holds the id's reservation. */
  | { status: "busy"; message: string }
  /** Missing, unauthorized, or of another workflow; indistinguishable. */
  | { status: "not_found"; message: string }
  /** Authorized, but no longer suspended. */
  | { status: "not_suspended"; message: string };

export const SUSPENDED_RUN_BUSY_MESSAGE =
  "Another operation on this run is in progress; try again";

function suspendedRunNotFound(runId: string): SuspendedRunCancelResult {
  return {
    status: "not_found",
    message: `No cancellable run with id ${runId}`,
  };
}

/**
 * Cancels a persisted suspended run that no process in this serve instance is
 * driving, and pushes the result. Callers do not take the sync gate: this
 * takes it itself, only once the caller is known to be allowed.
 *
 * The run is first located and `authorize` asked about its own workflow while
 * holding neither the sync gate nor the run id's reservation, so a caller
 * refused or naming an unknown run gets not found without ever blocking other
 * handlers or another operation on the run (swamp-club#2648, #2649). Only then
 * is the gate taken and the id reserved for the fresh read, check, save and
 * push, so the cancel never interleaves with a resume, approve or reject of the
 * same run in this process.
 */
export async function cancelSuspendedRunAndPush(
  ctx: ConnectionContext,
  request: SuspendedRunCancelRequest,
  authorize: (workflow: CancelTargetWorkflow) => Promise<boolean> | boolean,
): Promise<SuspendedRunCancelResult> {
  const notFound = suspendedRunNotFound(request.runId);
  const registry = ctx.activeRunRegistry;
  // Without a registry nothing can serialize the cancel against a resume.
  if (!registry) return notFound;

  const deps = createWorkflowCancelSuspendedDeps(
    ctx.repoContext.workflowRepo,
    ctx.repoContext.workflowRunRepo,
    authorize,
    // Read only when the run has a snapshot, from the datastore-resolved
    // path the run wrote it to.
    (runId) =>
      new YamlEvaluatedWorkflowRepository(
        ctx.repoDir,
        ctx.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
      ).findByRunId(runId),
    ctx.runTracker,
  );
  const located = await locateSuspendedRunToCancel(deps, {
    runId: request.runId,
    workflowIdOrName: request.workflowIdOrName,
  });
  if (!located) {
    // A resume may have registered the run since the caller looked; the
    // caller authorizes a registered run against its registry entry.
    return registry.get(request.runId) ? { status: "active" } : notFound;
  }
  return await withSyncGate(
    ctx.syncGate,
    () =>
      cancelLocatedRunAndPush(
        ctx,
        registry,
        deps,
        request,
        located.workflowId,
      ),
  );
}

/**
 * The gated half of {@link cancelSuspendedRunAndPush}: reserves the run id,
 * cancels the run read afresh from the workflow it was located in, releases
 * the reservation however that settles, and pushes.
 */
async function cancelLocatedRunAndPush(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  deps: WorkflowCancelSuspendedDeps,
  request: SuspendedRunCancelRequest,
  workflowId: string,
): Promise<SuspendedRunCancelResult> {
  try {
    const release = registry.reserve(request.runId);
    if (!release) {
      return registry.get(request.runId)
        ? { status: "active" }
        : { status: "busy", message: SUSPENDED_RUN_BUSY_MESSAGE };
    }
    try {
      let failure: SwampError | undefined;
      let result: SuspendedRunCancelResult | undefined;
      for await (
        const event of workflowCancelSuspended(
          handlerLibSwampContext(ctx),
          deps,
          {
            runId: request.runId,
            workflowId,
            reason: request.reason,
          },
        )
      ) {
        if (event.kind === "completed") {
          result = {
            status: "cancelled",
            runId: event.data.runId,
            workflowName: event.data.workflowName,
            ...(event.data.detachedNestedRuns
              ? { detachedNestedRuns: event.data.detachedNestedRuns }
              : {}),
          };
        } else if (event.kind === "error") {
          failure = event.error;
        }
      }
      if (result) return result;
      if (failure?.code === CANCEL_SUSPENDED_NOT_SUSPENDED) {
        return { status: "not_suspended", message: failure.message };
      }
      return suspendedRunNotFound(request.runId);
    } finally {
      release();
    }
  } finally {
    await pushChangedToRemote(ctx);
  }
}

/** How long a cancel waits for an aborted run to leave the registry. */
export const RUN_CANCEL_GRACE_MS = 5_000;

/**
 * Waits for an aborted run to finish and leave the registry, up to `graceMs`.
 * Returns whether it left. A run that left may have saved itself suspended
 * rather than cancelled: a resume that reached another approval gate just
 * before the abort. The caller then cancels the persisted run.
 */
export async function awaitAbortedRun(
  registry: ActiveRunRegistry,
  runId: string,
  graceMs: number = RUN_CANCEL_GRACE_MS,
): Promise<boolean> {
  const run = registry.get(runId);
  if (!run) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.completion,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return registry.get(runId) === undefined;
}
