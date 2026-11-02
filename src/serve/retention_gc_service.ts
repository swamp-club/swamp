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

import { runDetached } from "../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { RetentionPolicy } from "../domain/retention/retention_policy.ts";
import type { RetentionWatermarkRepository } from "../domain/retention/retention_watermark.ts";
import { hourStartOf } from "../infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import type { RetentionPassResult } from "../libswamp/retention/pass.ts";
import type { GcMutex } from "./gc_mutex.ts";

const logger = getSwampLogger(["serve", "retention"]);

export const DEFAULT_RETENTION_GC_INTERVAL_MS = 60 * 60 * 1000;
/**
 * the first pass runs this long after start, not a full interval later, so a
 * serve restarted more often than hourly still applies retention without
 * slowing boot
 */
export const DEFAULT_RETENTION_GC_INITIAL_DELAY_MS = 5 * 60 * 1000;
/**
 * budget of one pass: a bigger backlog clears over several passes, and the
 * mutex a manual gc waits on is never held longer
 */
export const DEFAULT_RETENTION_GC_BUDGET_MS = 5 * 60 * 1000;

export interface RetentionPassControl {
  readonly budgetMs: number;
  isStopping(): boolean;
  manualGcWaiting(): boolean;
}

export interface RetentionGcDeps {
  readonly intervalMs: number;
  readonly initialDelayMs?: number;
  readonly budgetMs?: number;
  readonly instanceId: string;
  readPolicy(): Promise<RetentionPolicy>;
  readonly watermarks?: RetentionWatermarkRepository;
  readonly mutex: GcMutex;
  runPass(
    policy: RetentionPolicy,
    control: RetentionPassControl,
  ): Promise<RetentionPassResult>;
  onPass?(result: RetentionPassResult): void;
  now?(): Date;
}

/**
 * runs only when garbageCollection.automatic is true; of serves sharing a
 * datastore the one claiming the hour runs its pass. A pass stops at a batch
 * boundary on shutdown, spent budget or a waiting manual gc.
 */
export class RetentionGcService {
  readonly #deps: RetentionGcDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(deps: RetentionGcDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info("Starting retention service (interval: {interval}ms)", {
      interval: this.#deps.intervalMs,
    });
    this.#scheduleNext(this.#deps.initialDelayMs ?? this.#deps.intervalMs);
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

  async runOnce(): Promise<RetentionPassResult | undefined> {
    return await this.#sweep();
  }

  #scheduleNext(delayMs = this.#deps.intervalMs): void {
    if (this.#disposed) return;
    this.#timer = runDetached(() =>
      setTimeout(() => {
        void this.#tick();
      }, delayMs)
    );
    Deno.unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    this.#running = true;
    try {
      await this.#sweep();
    } catch (err) {
      logger.error`Retention pass failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  async #sweep(): Promise<RetentionPassResult | undefined> {
    const policy = await this.#deps.readPolicy();
    if (!policy.automatic || !policy.hasAnyRetention) return undefined;

    const now = this.#deps.now?.() ?? new Date();
    // The hour is claimed only once this process holds the mutex, so a
    // manual gc running here never costs the datastore its hourly pass.
    const outcome = await this.#deps.mutex.tryRun(async () => {
      if (this.#deps.watermarks) {
        const claimed = await this.#deps.watermarks.claimHourlyPass(
          hourStartOf(now),
          this.#deps.instanceId,
          "serve",
        );
        if (!claimed) return "claimed-elsewhere" as const;
      }
      return await this.#deps.runPass(policy, {
        budgetMs: this.#deps.budgetMs ?? DEFAULT_RETENTION_GC_BUDGET_MS,
        isStopping: () => this.#disposed,
        manualGcWaiting: () => this.#deps.mutex.waiting,
      });
    });
    if (outcome === undefined) {
      logger.debug("Skipping retention pass: a garbage collection is running");
      return undefined;
    }
    if (outcome === "claimed-elsewhere") {
      logger.debug("Retention pass for this hour already claimed elsewhere");
      return undefined;
    }
    const result = outcome;
    this.#deps.onPass?.(result);
    return result;
  }
}
