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

import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { WORKER_MODEL_TYPE } from "../domain/models/worker/worker_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { WorkerPruneResult } from "../libswamp/worker/prune.ts";
import type { BookkeepingReapResult } from "./bookkeeping_gc.ts";
import { ownNamespaceTerm } from "./namespace_predicate.ts";
import { type SyncGate, withSyncGate } from "./sync_gate.ts";

const logger = getSwampLogger(["serve", "worker-gc"]);

export const DEFAULT_WORKER_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_WORKER_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WorkerGcDeps {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;
  runPrune(gracePeriodMs: number): Promise<WorkerPruneResult>;
  /** Reaps ended step leases and pending dispatches; gates its own batches. */
  reapBookkeeping?(
    gracePeriodMs: number,
    isStopping: () => boolean,
  ): Promise<BookkeepingReapResult>;
  readonly syncService?: Pick<DatastoreSyncService, "pushChanged">;
  /** Datastore namespace passed to `pushChanged`. */
  readonly syncNamespace?: string;
  readonly syncGate?: SyncGate;
}

/** Outcome of one GC cycle; a part is null when it failed or is not wired. */
export interface WorkerGcSweepResult {
  readonly workers: WorkerPruneResult | null;
  readonly bookkeeping: BookkeepingReapResult | null;
}

/**
 * Catalog predicate listing this repository's worker state records. Scoped
 * to the repo's own namespace so a disconnected worker from another
 * namespace can never drive the delete of a same-named local worker.
 */
export function workerGcListPredicate(namespace: string): string {
  return `modelType == ${JSON.stringify(WORKER_MODEL_TYPE.normalized)} && ` +
    `name == "state-main" && ${ownNamespaceTerm(namespace)}`;
}

/**
 * Prunes stale workers, then pushes. Must run inside the exclusive sync gate
 * (`withSyncGate`) so a poller pull cannot restore a deleted worker between
 * the delete and its push (swamp-club#2247) — the same unit the admin
 * `worker.prune` handler runs.
 */
async function pruneWorkersAndPush(
  deps: WorkerGcDeps,
): Promise<WorkerPruneResult> {
  try {
    return await deps.runPrune(deps.gracePeriodMs);
  } finally {
    // Guarded so a push rejection never masks a prune error.
    try {
      await deps.syncService?.pushChanged({ namespace: deps.syncNamespace });
    } catch (error) {
      logger.warn("Failed to push pruned worker records: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class WorkerGcService {
  readonly #deps: WorkerGcDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(deps: WorkerGcDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting worker GC service (interval: {interval}ms, grace period: {grace}ms)",
      {
        interval: this.#deps.intervalMs,
        grace: this.#deps.gracePeriodMs,
      },
    );
    this.#scheduleNext();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async runOnce(): Promise<WorkerGcSweepResult> {
    return await this.#sweep();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, this.#deps.intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    this.#running = true;
    try {
      await this.#sweep();
    } catch (err) {
      logger.error`Worker GC cycle failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  async #sweep(): Promise<WorkerGcSweepResult> {
    // Each part runs on its own, so a failure in one never skips the other.
    let workers: WorkerPruneResult | null = null;
    try {
      workers = await withSyncGate(
        this.#deps.syncGate,
        () => pruneWorkersAndPush(this.#deps),
      );
      if (workers.workersDeleted > 0 || workers.bindingsPruned > 0) {
        logger.info(
          "Worker GC: pruned {workers} worker(s), {bindings} binding(s) from {tokens} token(s), {failed} failed",
          {
            workers: workers.workersDeleted,
            bindings: workers.bindingsPruned,
            tokens: workers.tokensCleaned,
            failed: workers.workersFailed,
          },
        );
      }
    } catch (err) {
      logger.error`Worker GC prune failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    let bookkeeping: BookkeepingReapResult | null = null;
    if (this.#deps.reapBookkeeping && !this.#disposed) {
      try {
        bookkeeping = await this.#deps.reapBookkeeping(
          this.#deps.gracePeriodMs,
          () => this.#disposed,
        );
        if (
          bookkeeping.leasesDeleted > 0 || bookkeeping.dispatchesDeleted > 0 ||
          bookkeeping.failed > 0 || bookkeeping.unreadable > 0 ||
          bookkeeping.pushFailures > 0
        ) {
          logger.info(
            "Worker GC: reaped {leases} lease(s), {dispatches} pending dispatch(es) in {batches} batch(es), {failed} failed, {unreadable} unreadable, {pushFailures} push failure(s)",
            {
              leases: bookkeeping.leasesDeleted,
              dispatches: bookkeeping.dispatchesDeleted,
              batches: bookkeeping.batches,
              failed: bookkeeping.failed,
              unreadable: bookkeeping.unreadable,
              pushFailures: bookkeeping.pushFailures,
            },
          );
        }
      } catch (err) {
        logger.error`Worker GC bookkeeping reap failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    return { workers, bookkeeping };
  }
}
