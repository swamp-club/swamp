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
 */

import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { WorkflowRunRepository } from "../domain/workflows/repositories.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { pushNamespaceCounted } from "../infrastructure/persistence/push_paths.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ActiveRun } from "./active_run_registry.ts";
import { type SyncGate, withSharedSyncGate } from "./sync_gate.ts";

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
  /** The datastore sync service; absent on a filesystem datastore. */
  readonly syncService?: Pick<DatastoreSyncService, "pushChanged">;
  readonly namespace?: string;
  readonly syncGate?: SyncGate;
  /** Defaults to {@link SHUTDOWN_PUSH_TIMEOUT_MS}. */
  readonly pushTimeoutMs?: number;
  /** Called once for each run marked interrupted. */
  readonly onInterrupted?: (runId: string) => void;
}

export interface ShutdownInterruptResult {
  readonly interrupted: readonly string[];
  /** Why the push of the interrupted runs failed, when it did. */
  readonly pushError?: string;
}

/**
 * Marks the aborted workflow runs in `remaining` interrupted and pushes them.
 * A failed load, save or push is logged and never thrown, so the rest of
 * shutdown still runs.
 */
export async function interruptShutdownRuns(
  remaining: ReadonlyArray<Pick<ActiveRun, "runId" | "kind" | "startedAt">>,
  deps: ShutdownInterruptDeps,
): Promise<ShutdownInterruptResult> {
  const interrupted: string[] = [];
  const workflowRuns = remaining.filter((r) =>
    r.kind === "workflow-run" || r.kind === "workflow-resume"
  );
  if (workflowRuns.length === 0) return { interrupted };
  const { repoContext, syncService } = deps;
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
    return { interrupted };
  }
  const loaded = allRuns;
  let pushError: string | undefined;
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
              "Failed to push interrupted workflow run(s) {runIds} to the datastore; their interrupted status was not saved there: {error}",
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
            deps.onInterrupted?.(run.runId);
          }
        } catch (err) {
          logger.warn("Failed to interrupt run {runId}: {error}", {
            runId: run.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  );
  return pushError === undefined ? { interrupted } : { interrupted, pushError };
}
