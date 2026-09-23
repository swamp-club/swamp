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

import { getLogger } from "@logtape/logtape";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import {
  gatedPull,
  type PollerGateState,
  type PollerGateTiming,
  pollerGateTiming,
  type SyncGate,
} from "./sync_gate.ts";

const logger = getLogger(["swamp", "serve", "runtime-data-poller"]);

const DEFAULT_RUNTIME_DATA_POLL_INTERVAL_MS = 30_000;

export interface RuntimeDataPollerOptions {
  syncService: DatastoreSyncService;
  syncGate?: SyncGate;
  catalogInvalidate: () => void;
  pollIntervalMs?: number;
  namespace?: string;
}

export class RuntimeDataPoller {
  readonly #syncService: DatastoreSyncService;
  readonly #syncGate?: SyncGate;
  readonly #catalogInvalidate: () => void;
  readonly #pollIntervalMs: number;
  readonly #namespace?: string;
  readonly #gateTiming: PollerGateTiming;
  readonly #gateState: PollerGateState = { consecutiveSkips: 0 };
  #stopController = new AbortController();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingPull: Promise<void> = Promise.resolve();
  #pulling = false;

  constructor(options: RuntimeDataPollerOptions) {
    this.#syncService = options.syncService;
    this.#syncGate = options.syncGate;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#pollIntervalMs = options.pollIntervalMs ??
      DEFAULT_RUNTIME_DATA_POLL_INTERVAL_MS;
    this.#namespace = options.namespace;
    this.#gateTiming = pollerGateTiming(this.#pollIntervalMs);
  }

  start(): void {
    if (this.#timer) return;
    if (this.#stopController.signal.aborted) {
      this.#stopController = new AbortController();
    }
    this.#timer = setInterval(() => {
      this.#poll();
    }, this.#pollIntervalMs);
    Deno.unrefTimer(this.#timer);
    const intervalSec = this.#pollIntervalMs / 1000;
    logger.info`Runtime data poller started (interval: ${intervalSec}s)`;
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    // Ends a wait for the sync gate at once, so shutdown is never held by a
    // poller retrying for a busy gate. A pull already running completes.
    this.#stopController.abort();
    await this.#pendingPull;
  }

  #poll(): void {
    if (this.#pulling) return;

    this.#pendingPull = this.#pendingPull.then(() => this.#pullAndInvalidate());
  }

  async #pullAndInvalidate(): Promise<void> {
    this.#pulling = true;
    try {
      const result = await gatedPull(
        this.#syncGate,
        "runtime data poller",
        (signal) =>
          this.#syncService.pullChanged({
            signal,
            subdirs: ["data"],
            namespace: this.#namespace,
          }),
        {
          state: this.#gateState,
          signal: this.#stopController.signal,
          timing: this.#gateTiming,
        },
      );
      const count = typeof result === "number" ? result : 0;
      if (count > 0) {
        logger
          .info`Runtime data poller: ${count} file(s) updated, invalidating catalog`;
        this.#catalogInvalidate();
      }
      this.#logHeapStats();
    } catch (error) {
      logger
        .warn`Runtime data poller pull failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      this.#pulling = false;
    }
  }

  #logHeapStats(): void {
    try {
      const mem = Deno.memoryUsage();
      const rss = Math.round(mem.rss / 1024 / 1024);
      const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
      const external = Math.round(mem.external / 1024 / 1024);
      logger
        .debug`Heap: rss=${rss}MB heapUsed=${heapUsed}MB heapTotal=${heapTotal}MB external=${external}MB`;
    } catch {
      // Deno.memoryUsage may not be available in all environments
    }
  }
}
