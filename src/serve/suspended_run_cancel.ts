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
  type RunOwnerVerdict,
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
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { localOwnerLiveness } from "../infrastructure/persistence/run_tracker_store.ts";
import {
  runHasDeadOwner,
  settleDeadOwnerMethodRuns,
} from "../domain/workflows/orphaned_run_reaper.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "workflow-cancel"]);

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
 * Decides whether a run recorded `running` has lost its owner, for
 * {@link cancelSuspendedRunAndPush}. Never for a run this instance drives.
 *
 * A run with a tracker row from this host is judged on that row alone, by
 * host and pid: the
 * row a previous serve process left carries that process's instance id, so
 * this instance's own id would never count it local, and it would stay
 * uncancellable until its heartbeat aged out. A run of another instance with
 * no row from this host (none at all, or one written under another hostname,
 * as after a container restart) is gone when the control plane holds no
 * heartbeat for that instance while holding one for this instance, as the
 * boot reaper judges it where there is a remote control plane. Anything else is
 * not shown gone.
 *
 * `onDeadPid` receives the dead owner's pid when the tracker row decided.
 */
export function ownerGoneDecider(
  ctx: Pick<
    ConnectionContext,
    "activeRunRegistry" | "runTracker" | "controlPlaneStore" | "instanceId"
  >,
  onDeadPid?: (pid: number) => void,
): (run: WorkflowRun) => Promise<RunOwnerVerdict> {
  return async (run) => {
    if (ctx.activeRunRegistry?.get(run.id)) {
      return { gone: false, why: OWNER_IS_THIS_INSTANCE };
    }
    const liveness = localOwnerLiveness();
    const tracked = ctx.runTracker?.findById(run.id);
    // A row another host wrote says nothing here: its pid is not ours to
    // check. The run is then judged like one with no row.
    if (ctx.runTracker && tracked?.isLocalTo(liveness.hostname)) {
      if (!runHasDeadOwner(run, ctx.runTracker, liveness)) {
        return {
          gone: false,
          why: liveness.isDead(tracked.pid)
            ? OWNER_ROW_UNCLEAR
            : OWNER_PROCESS_ALIVE,
        };
      }
      onDeadPid?.(tracked.pid);
      return { gone: true };
    }
    if (
      ctx.controlPlaneStore && ctx.instanceId && run.instanceId &&
      run.instanceId !== ctx.instanceId
    ) {
      // A missing heartbeat means something only where heartbeats are
      // written. Without a control-plane-capable datastore serve keeps a
      // local store and writes none, so every instance would look gone,
      // including a live one on another host. This instance's own heartbeat
      // is the evidence that they are being recorded.
      const [own, theirs] = await Promise.all([
        ctx.controlPlaneStore.get(`heartbeats/${ctx.instanceId}`),
        ctx.controlPlaneStore.get(`heartbeats/${run.instanceId}`),
      ]);
      if (own === null) return { gone: false, why: OWNER_UNKNOWN };
      return theirs === null
        ? { gone: true }
        : { gone: false, why: OWNER_INSTANCE_ALIVE };
    }
    return { gone: false, why: OWNER_UNKNOWN };
  };
}

// Why a running run was not cancelled, as the caller allowed to cancel it
// reads it. None names a pid, host or instance id: the reply crosses to a
// client that holds `run` on the workflow, not admin on the server.
const OWNER_IS_THIS_INSTANCE =
  "this serve instance is running it. Cancel it again";
const OWNER_PROCESS_ALIVE =
  "the process running it on the serve host is still alive. Stop that process, then cancel the run again";
const OWNER_INSTANCE_ALIVE =
  "the serve instance running it still reports a heartbeat. Cancel the run through that instance, or again here once that instance has stopped and its heartbeat has expired";
const OWNER_ROW_UNCLEAR =
  "the run tracker on the serve host does not show the process that ran it as its unfinished owner, so swamp cannot tell that nothing is running it";
const OWNER_UNKNOWN =
  "the serve host has no run tracker record of the process running it, and no instance heartbeats to tell whether the serve instance that started it is alive, so swamp cannot tell that nothing is running it";

/**
 * Cancels a persisted run that no process in this serve instance is driving,
 * suspended or left `running` by an owner that is gone, and pushes the result.
 * Callers do not take the sync gate: this
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

  let deadOwnerPid: number | undefined;
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
    ownerGoneDecider(ctx, (pid) => {
      deadOwnerPid = pid;
    }),
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
        () => deadOwnerPid,
      ),
  );
}

/**
 * The gated half of {@link cancelSuspendedRunAndPush}: reserves the run id,
 * cancels the run read afresh from the workflow it was located in, releases
 * the reservation however that settles, and pushes. It runs in the request's
 * root unit of work, whose flush is that push, on every outcome.
 */
async function cancelLocatedRunAndPush(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  deps: WorkflowCancelSuspendedDeps,
  request: SuspendedRunCancelRequest,
  workflowId: string,
  deadOwnerPid: () => number | undefined,
): Promise<SuspendedRunCancelResult> {
  return await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
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
        if (result) {
          await settleMethodRunsOf(ctx, deadOwnerPid());
          return result;
        }
        if (failure?.code === CANCEL_SUSPENDED_NOT_SUSPENDED) {
          return { status: "not_suspended", message: failure.message };
        }
        return suspendedRunNotFound(request.runId);
      } finally {
        release();
      }
    },
  );
}

/**
 * Settles the method runs the dead owner of a just-cancelled run left
 * `running`, so its steps' method runs do not outlive the cancel. Best
 * effort: one left unsettled is kept for `run doctor --fix`.
 */
async function settleMethodRunsOf(
  ctx: ConnectionContext,
  pid: number | undefined,
): Promise<void> {
  if (pid === undefined || !ctx.runTracker) return;
  try {
    await settleDeadOwnerMethodRuns(
      ctx.repoContext.outputRepo,
      ctx.runTracker,
      localOwnerLiveness(),
      pid,
    );
  } catch (error) {
    logger.warn(
      "Could not settle the method runs of dead process {pid}: {error}",
      { pid, error: error instanceof Error ? error.message : String(error) },
    );
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
