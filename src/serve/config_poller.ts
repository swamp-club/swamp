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

const logger = getLogger(["swamp", "serve", "config-poller"]);

const DEFAULT_CONFIG_POLL_INTERVAL_MS = 30_000;

export interface ConfigPollerOptions {
  syncService: DatastoreSyncService;
  syncGate?: SyncGate;
  catalogInvalidate: () => void;
  extensionReloader: () => Promise<void>;
  extensionSubdirs?: readonly string[];
  pollIntervalMs?: number;
  namespace?: string;
}

export class ConfigPoller {
  readonly #syncService: DatastoreSyncService;
  readonly #syncGate?: SyncGate;
  readonly #catalogInvalidate: () => void;
  readonly #extensionReloader: () => Promise<void>;
  readonly #extensionSubdirs: readonly string[];
  readonly #pollIntervalMs: number;
  readonly #namespace?: string;
  readonly #gateTiming: PollerGateTiming;
  readonly #gateState: PollerGateState = { consecutiveSkips: 0 };
  #stopController = new AbortController();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingPull: Promise<void> = Promise.resolve();
  #pulling = false;

  constructor(options: ConfigPollerOptions) {
    this.#syncService = options.syncService;
    this.#syncGate = options.syncGate;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#extensionReloader = options.extensionReloader;
    this.#extensionSubdirs = options.extensionSubdirs ?? [];
    this.#pollIntervalMs = options.pollIntervalMs ??
      DEFAULT_CONFIG_POLL_INTERVAL_MS;
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
    logger.info`Config poller started (interval: ${intervalSec}s)`;
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
      let extensionCount = 0;
      let definitionCount = 0;

      await gatedPull(
        this.#syncGate,
        "config poller",
        async (signal) => {
          if (this.#extensionSubdirs.length > 0) {
            const extResult = await this.#syncService.pullChanged({
              signal,
              subdirs: this.#extensionSubdirs,
              namespace: this.#namespace,
            });
            extensionCount = typeof extResult === "number" ? extResult : 0;
          }

          const defResult = await this.#syncService.pullChanged({
            signal,
            subdirs: ["config"],
            namespace: this.#namespace,
          });
          definitionCount = typeof defResult === "number" ? defResult : 0;
        },
        {
          state: this.#gateState,
          signal: this.#stopController.signal,
          timing: this.#gateTiming,
        },
      );

      const totalCount = extensionCount + definitionCount;
      if (totalCount > 0) {
        logger
          .info`Config poller: ${totalCount} file(s) updated, invalidating catalogs`;
        this.#catalogInvalidate();
        if (extensionCount > 0) {
          try {
            await this.#extensionReloader();
          } catch (error) {
            logger
              .warn`Config poller extension reload failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
      }
    } catch (error) {
      logger
        .warn`Config poller pull failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      this.#pulling = false;
    }
  }
}
