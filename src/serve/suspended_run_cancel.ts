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
  createLibSwampContext,
  createWorkflowCancelSuspendedDeps,
  type SwampError,
  workflowCancelSuspended,
} from "../libswamp/mod.ts";
import type { ConnectionContext } from "./handlers/shared.ts";

export interface SuspendedRunCancelRequest {
  runId: string;
  workflowIdOrName?: string;
  reason: string;
}

export type SuspendedRunCancelResult =
  | { status: "cancelled"; runId: string; workflowName: string }
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

/**
 * Cancels a persisted suspended run that no process in this serve instance is
 * driving. Holds the run id's reservation in the active-run registry for the
 * whole load, check and save, so it never interleaves with a resume, approve
 * or reject of the same run in this process, and releases it however the
 * cancel settles. It neither takes the sync gate nor pushes: the caller runs
 * it inside `withSyncGate` and pushes afterwards, like any handler mutation.
 *
 * `authorize` is asked about the run's own workflow before anything about the
 * run is revealed; a refusal is reported as not found.
 */
export async function cancelSuspendedRunInServe(
  ctx: ConnectionContext,
  request: SuspendedRunCancelRequest,
  authorize: (workflow: CancelTargetWorkflow) => Promise<boolean> | boolean,
): Promise<SuspendedRunCancelResult> {
  const notFound: SuspendedRunCancelResult = {
    status: "not_found",
    message: `No cancellable run with id ${request.runId}`,
  };
  const registry = ctx.activeRunRegistry;
  // Without a registry nothing can serialize the cancel against a resume.
  if (!registry) return notFound;

  const release = registry.reserve(request.runId);
  if (!release) {
    return registry.get(request.runId)
      ? { status: "active" }
      : { status: "busy", message: SUSPENDED_RUN_BUSY_MESSAGE };
  }
  try {
    const deps = createWorkflowCancelSuspendedDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.workflowRunRepo,
      authorize,
      ctx.runTracker,
    );
    let failure: SwampError | undefined;
    let result: SuspendedRunCancelResult | undefined;
    for await (
      const event of workflowCancelSuspended(createLibSwampContext(), deps, {
        runId: request.runId,
        workflowIdOrName: request.workflowIdOrName,
        reason: request.reason,
      })
    ) {
      if (event.kind === "completed") {
        result = {
          status: "cancelled",
          runId: event.data.runId,
          workflowName: event.data.workflowName,
        };
      } else if (event.kind === "error") {
        failure = event.error;
      }
    }
    if (result) return result;
    if (failure?.code === CANCEL_SUSPENDED_NOT_SUSPENDED) {
      return { status: "not_suspended", message: failure.message };
    }
    return notFound;
  } finally {
    release();
  }
}
