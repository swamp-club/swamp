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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { WorkerPruneResult } from "../libswamp/worker/prune.ts";

const logger = getSwampLogger(["serve", "worker-gc"]);

export const DEFAULT_WORKER_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_WORKER_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WorkerGcDeps {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;
  runPrune(gracePeriodMs: number): Promise<WorkerPruneResult>;
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

  async runOnce(): Promise<WorkerPruneResult> {
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

  async #sweep(): Promise<WorkerPruneResult> {
    const result = await this.#deps.runPrune(this.#deps.gracePeriodMs);

    if (result.workersDeleted > 0 || result.bindingsPruned > 0) {
      logger.info(
        "Worker GC: pruned {workers} worker(s), {bindings} binding(s) from {tokens} token(s), {failed} failed",
        {
          workers: result.workersDeleted,
          bindings: result.bindingsPruned,
          tokens: result.tokensCleaned,
          failed: result.workersFailed,
        },
      );
    }

    return result;
  }
}
