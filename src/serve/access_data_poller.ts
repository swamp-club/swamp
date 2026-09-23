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
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";

const logger = getLogger(["swamp", "serve", "access-data-poller"]);

const DEFAULT_ACCESS_DATA_POLL_INTERVAL_MS = 30_000;

export const ACCESS_DATA_SUBDIRS: readonly string[] = [
  "data/swamp/grant",
  "data/swamp/group",
  "data/@swamp/grant",
  "data/@swamp/group",
];

export interface AccessDataPollerOptions {
  syncService: DatastoreSyncService;
  syncGate?: SyncGate;
  policySnapshotLoader: PolicySnapshotLoader;
  catalogInvalidate: () => void;
  pollIntervalMs?: number;
  namespace?: string;
}

export class AccessDataPoller {
  readonly #syncService: DatastoreSyncService;
  readonly #syncGate?: SyncGate;
  readonly #policySnapshotLoader: PolicySnapshotLoader;
  readonly #catalogInvalidate: () => void;
  readonly #pollIntervalMs: number;
  readonly #namespace?: string;
  readonly #gateTiming: PollerGateTiming;
  readonly #gateState: PollerGateState = { consecutiveSkips: 0 };
  #stopController = new AbortController();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingPull: Promise<void> = Promise.resolve();
  #pulling = false;
  #needsReload = false;

  constructor(options: AccessDataPollerOptions) {
    this.#syncService = options.syncService;
    this.#syncGate = options.syncGate;
    this.#policySnapshotLoader = options.policySnapshotLoader;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#pollIntervalMs = options.pollIntervalMs ??
      DEFAULT_ACCESS_DATA_POLL_INTERVAL_MS;
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
    logger.info`Access data poller started (interval: ${intervalSec}s)`;
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

    this.#pendingPull = this.#pendingPull.then(() =>
      this.#pullAndReloadPolicy()
    );
  }

  async #pullAndReloadPolicy(): Promise<void> {
    this.#pulling = true;
    try {
      const result = await gatedPull(
        this.#syncGate,
        "access data poller",
        (signal) =>
          this.#syncService.pullChanged({
            signal,
            subdirs: [...ACCESS_DATA_SUBDIRS],
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
          .info`Access data poller: ${count} file(s) updated, reloading policy snapshot`;
        this.#catalogInvalidate();
        this.#needsReload = true;
      }
      if (this.#needsReload) {
        await this.#policySnapshotLoader.load();
        this.#needsReload = false;
      }
    } catch (error) {
      logger
        .warn`Access data poller cycle failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      this.#pulling = false;
    }
  }
}
