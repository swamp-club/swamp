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

/**
 * The interrupt stage of `swamp serve` shutdown: the workflow runs the drain
 * aborted are marked `interrupted("server_shutdown")` and, on a remote
 * datastore, pushed (swamp-club#3252). Without the push the interrupted
 * record stayed in the local cache, and a restart against the datastore read
 * whatever the run had last pushed.
 *
 * The push is bounded by one short deadline, so it can miss. Each run's
 * tracker row is settled whatever happens, so the next boot's reaper does
 * not skip the run as still running, and the runs not pushed are reported
 * and recorded for the next start (swamp-club#3958).
 *
 * Before the runs are loaded, serve's run write fence is closed for them.
 * An executor that outlived the drain's abort grace can then no longer save
 * its own `running` copy of a run over the interrupted record, which would
 * otherwise be what the push uploads (swamp-club#4101).
 */

import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { RunTrackerRepository } from "../domain/models/run_tracker_repository.ts";
import type { WorkflowRunRepository } from "../domain/workflows/repositories.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { pushNamespaceCounted } from "../infrastructure/persistence/push_paths.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ActiveRun } from "./active_run_registry.ts";
import { type SyncGate, withSharedSyncGate } from "./sync_gate.ts";
import { recordUnpushedInterrupts } from "./unpushed_interrupts.ts";
import type { ServeRunWriteFence } from "./run_write_fence.ts";
import { keepActiveRunRecords } from "./active_run_tracker.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  type InstanceHeartbeatService,
  STOPPED_HEARTBEAT_WRITE_TIMEOUT_MS,
} from "./instance_heartbeat.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/**
 * How long shutdown waits for the shared sync gate and the push of the
 * interrupted runs together. It fits the headroom serve's design asks for
 * above the drain timeout, so an unreachable datastore cannot hold the
 * process past its termination grace period.
 */
export const SHUTDOWN_PUSH_TIMEOUT_MS = 5_000;

export interface ShutdownInterruptDeps {
  readonly repoContext:
    & Pick<RepositoryContext, "markDirty">
    & {
      readonly workflowRunRepo: Pick<
        WorkflowRunRepository,
        "findGlobalByStatus" | "save"
      >;
    };
  /**
   * Serve's run write fence. Closed for the runs about to be interrupted
   * before they are loaded, so an executor that outlived the abort grace
   * cannot save its running copy over the interrupt (swamp-club#4101).
   */
  readonly runWriteFence?: Pick<ServeRunWriteFence, "close">;
  /** The datastore sync service; absent on a filesystem datastore. */
  readonly syncService?: Pick<DatastoreSyncService, "pushChanged">;
  readonly namespace?: string;
  readonly syncGate?: SyncGate;
  /** Defaults to {@link SHUTDOWN_PUSH_TIMEOUT_MS}. */
  readonly pushTimeoutMs?: number;
  /** Called once for each run marked interrupted. */
  readonly onInterrupted?: (runId: string) => void;
  /**
   * The run tracker whose rows the aborted runs settle as interrupted. A
   * row left running makes the next boot's reaper skip the run.
   */
  readonly runTracker?: Pick<RunTrackerRepository, "complete">;
  /**
   * Where the runs not pushed are recorded for the next start
   * ({@link recordUnpushedInterrupts}); unset records nothing.
   */
  readonly unpushedMarkerPath?: string;
}

export interface ShutdownInterruptResult {
  readonly interrupted: readonly string[];
  /** Why the push of the interrupted runs failed, when it did. */
  readonly pushError?: string;
  /**
   * The aborted workflow runs whose interrupted record is not known to have
   * reached the datastore: every interrupted run when the push failed, and
   * each run that could not be loaded or saved. Set only on a synced
   * datastore, and only when not empty.
   */
  readonly unpushed?: readonly string[];
}

/**
 * Marks the aborted workflow runs in `remaining` interrupted, settles their
 * tracker rows and pushes them. A failed load, save, push or marker write is
 * logged and never thrown, so the rest of shutdown still runs.
 */
export async function interruptShutdownRuns(
  remaining: ReadonlyArray<
    & Pick<ActiveRun, "runId" | "kind" | "startedAt">
    & Partial<Pick<ActiveRun, "resourceId">>
  >,
  deps: ShutdownInterruptDeps,
): Promise<ShutdownInterruptResult> {
  const interrupted: string[] = [];
  const workflowRuns = remaining.filter((r) =>
    r.kind === "workflow-run" || r.kind === "workflow-resume"
  );
  if (workflowRuns.length === 0) return { interrupted };
  const { repoContext, syncService } = deps;
  await deps.runWriteFence?.close(workflowRuns.map((r) => r.runId));
  const settleTrackerRow = (runId: string) => {
    try {
      deps.runTracker?.complete(runId, "interrupted", "server_shutdown");
    } catch (err) {
      logger.warn("Failed to settle the tracker row of run {runId}: {error}", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const earliestCutoff = new Date(
    Math.min(...workflowRuns.map((r) => r.startedAt.getTime())) - 60_000,
  );
  let allRuns:
    | Awaited<ReturnType<typeof repoContext.workflowRunRepo.findGlobalByStatus>>
    | undefined;
  try {
    allRuns = await repoContext.workflowRunRepo.findGlobalByStatus(
      ["running", "cancelled"],
      earliestCutoff,
    );
  } catch (err) {
    logger.warn("Failed to load workflow runs for interrupt: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    for (const run of workflowRuns) settleTrackerRow(run.runId);
    return await reported(
      { interrupted },
      workflowRuns.map((r) => r.runId),
      workflowRuns,
      deps,
    );
  }
  const loaded = allRuns;
  let pushError: string | undefined;
  const notSaved: string[] = [];
  const pushTimeoutMs = deps.pushTimeoutMs ?? SHUTDOWN_PUSH_TIMEOUT_MS;
  await runInRootUnitOfWork(
    repoContext,
    {
      // The interrupted records are pushed under the shared gate, as a run's
      // post-run push is. One deadline bounds the gate wait and the push
      // together; a push that misses it is left to finish or fail on its own.
      flush: syncService
        ? async () => {
          if (interrupted.length === 0) return;
          const controller = new AbortController();
          const deadline = new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(controller.signal.reason),
            );
          });
          // Ref'd so a shutdown with nothing else pending still waits for
          // the deadline; cleared below as soon as the push settles.
          const timer = setTimeout(
            () =>
              controller.abort(
                new Error(`timed out after ${pushTimeoutMs}ms`),
              ),
            pushTimeoutMs,
          );
          const push = withSharedSyncGate(
            deps.syncGate,
            // A gate that frees only after the deadline gets no push: by then
            // shutdown has moved on to tearing down.
            async () => {
              if (controller.signal.aborted) return;
              await pushNamespaceCounted(
                syncService,
                deps.namespace,
                controller.signal,
              );
            },
          );
          // Handled here as well, so a push that outlives the deadline never
          // rejects unhandled.
          push.catch(() => {});
          try {
            await Promise.race([push, deadline]);
          } catch (err) {
            pushError = err instanceof Error ? err.message : String(err);
            logger.warn(
              "Failed to push interrupted workflow run(s) {runIds} to the datastore; their interrupted status was not saved there yet: {error}. The next serve in this checkout pushes them, and other instances settle them when they reconcile this one",
              { runIds: interrupted, error: pushError },
            );
          } finally {
            clearTimeout(timer);
          }
        }
        : undefined,
    },
    async () => {
      for (const run of workflowRuns) {
        try {
          const match = loaded.find((r) => r.run.id === run.runId);
          if (
            match &&
            (match.run.status === "running" ||
              match.run.status === "cancelled")
          ) {
            match.run.interrupt("server_shutdown");
            await repoContext.workflowRunRepo.save(
              match.workflowId,
              match.run,
            );
            interrupted.push(run.runId);
            settleTrackerRow(run.runId);
            deps.onInterrupted?.(run.runId);
          }
        } catch (err) {
          logger.warn("Failed to interrupt run {runId}: {error}", {
            runId: run.runId,
            error: err instanceof Error ? err.message : String(err),
          });
          notSaved.push(run.runId);
          settleTrackerRow(run.runId);
        }
      }
    },
  );
  return await reported(
    pushError === undefined ? { interrupted } : { interrupted, pushError },
    pushError === undefined ? notSaved : [...interrupted, ...notSaved],
    workflowRuns,
    deps,
    loaded,
  );
}

/**
 * Adds `unpushed` to `result` on a synced datastore and records it at the
 * marker path, when there is any.
 */
async function reported(
  result: ShutdownInterruptResult,
  unpushed: readonly string[],
  aborted: ReadonlyArray<
    & Pick<ActiveRun, "runId">
    & Partial<Pick<ActiveRun, "resourceId">>
  >,
  deps: ShutdownInterruptDeps,
  loaded: ReadonlyArray<{ run: { id: string }; workflowId: string }> = [],
): Promise<ShutdownInterruptResult> {
  if (!deps.syncService || unpushed.length === 0) return result;
  if (deps.unpushedMarkerPath !== undefined) {
    // The workflow id lets the next start read each record by id.
    const workflowIdOf = (runId: string) =>
      loaded.find((r) => r.run.id === runId)?.workflowId ??
        aborted.find((r) => r.runId === runId)?.resourceId;
    try {
      await recordUnpushedInterrupts(
        deps.unpushedMarkerPath,
        unpushed.map((runId) => {
          const workflowId = workflowIdOf(runId);
          return workflowId === undefined ? { runId } : { runId, workflowId };
        }),
      );
    } catch (err) {
      logger.warn(
        "Failed to record the unpushed interrupted workflow run(s) {runIds} for the next start: {error}",
        {
          runIds: unpushed,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return { ...result, unpushed };
}

/**
 * The heartbeat stage of shutdown. With no run left unpushed the heartbeat
 * is deleted. Otherwise the unpushed runs' active-run records are written
 * back first, since a run that ended in the abort grace deleted its own and
 * a peer finds the runs it must settle only through them, and then a stopped
 * heartbeat takes the heartbeat's place so a peer reconciles this instance
 * (swamp-club#3958). Each write is bounded by `writeTimeoutMs`.
 */
export async function stopHeartbeatAtShutdown(
  heartbeat: Pick<InstanceHeartbeatService, "stop">,
  options: {
    readonly store: ControlPlaneStore;
    readonly instanceId: string;
    readonly aborted: ReadonlyArray<
      & Pick<ActiveRun, "runId" | "kind" | "resourceName" | "startedAt">
      & Partial<Pick<ActiveRun, "resourceId">>
    >;
    readonly unpushed: readonly string[];
    readonly writeTimeoutMs?: number;
  },
): Promise<void> {
  const writeTimeoutMs = options.writeTimeoutMs ??
    STOPPED_HEARTBEAT_WRITE_TIMEOUT_MS;
  if (options.unpushed.length === 0) {
    await heartbeat.stop();
    return;
  }
  const unpushed = new Set(options.unpushed);
  const kept = await keepActiveRunRecords(
    options.store,
    options.instanceId,
    options.aborted.filter((run) => unpushed.has(run.runId)),
    writeTimeoutMs,
  );
  if (!kept) {
    logger.warn(
      "The active-run records of the unpushed interrupted workflow run(s) {runIds} were not confirmed written in time; a peer may not find them",
      { runIds: options.unpushed },
    );
  }
  await heartbeat.stop({ leaveStoppedRecord: true, writeTimeoutMs });
}
