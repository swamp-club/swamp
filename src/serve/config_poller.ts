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
import type {
  ExtensionReloadResult,
  ExtensionReloadStatus,
} from "./extension_reload.ts";
import {
  gatedPull,
  type PollerGateState,
  type PollerGateTiming,
  pollerGateTiming,
  type SyncGate,
} from "./sync_gate.ts";

const logger = getLogger(["swamp", "serve", "config-poller"]);

const DEFAULT_CONFIG_POLL_INTERVAL_MS = 30_000;

/**
 * Failed reloads of one lockfile version before the poller stops retrying.
 * The next lockfile change starts a fresh run of attempts.
 */
export const MAX_FAILED_RELOAD_ATTEMPTS = 3;

export interface ConfigPollerOptions {
  /**
   * Pulls `config/` each poll when set. Without one the poller only watches
   * the lockfile hash, which still catches writes from the same host.
   */
  syncService?: DatastoreSyncService;
  syncGate?: SyncGate;
  catalogInvalidate: () => void;
  /**
   * Runs when the lockfile changes, and again while its result is pending.
   * A failed result's errors are logged by the poller, so the reloader
   * should not log them itself.
   */
  extensionReloader: () => Promise<ExtensionReloadResult>;
  /** Hash of the managedConfig tier lockfile, or `null` when it is missing. */
  lockfileHash: () => Promise<string | null>;
  /**
   * The hash the loaded extension set came from, read at serve boot. When
   * omitted, the first poll seeds the baseline without reloading.
   */
  baselineLockfileHash?: string | null;
  pollIntervalMs?: number;
  namespace?: string;
}

/**
 * Keeps serve in step with the managedConfig tier. Each poll pulls `config/`
 * (when a sync service exists) and invalidates the catalogs if anything
 * changed, then compares the tier lockfile's hash with the last one it acted
 * on. A different hash means the extension set changed — a peer's pull,
 * update, rm or pin — and the extension reloader runs. A busy or failed
 * reload stays pending and is retried on later polls.
 */
export class ConfigPoller {
  readonly #syncService?: DatastoreSyncService;
  readonly #syncGate?: SyncGate;
  readonly #catalogInvalidate: () => void;
  readonly #extensionReloader: () => Promise<ExtensionReloadResult>;
  readonly #lockfileHash: () => Promise<string | null>;
  readonly #pollIntervalMs: number;
  readonly #namespace?: string;
  readonly #gateTiming: PollerGateTiming;
  readonly #gateState: PollerGateState = { consecutiveSkips: 0 };
  #stopController = new AbortController();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingPull: Promise<void> = Promise.resolve();
  #pulling = false;
  /** Last lockfile hash acted on; `undefined` until seeded. */
  #baselineHash: string | null | undefined;
  #reloadPending = false;
  #failedReloads = 0;

  constructor(options: ConfigPollerOptions) {
    this.#syncService = options.syncService;
    this.#syncGate = options.syncGate;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#extensionReloader = options.extensionReloader;
    this.#lockfileHash = options.lockfileHash;
    this.#baselineHash = options.baselineLockfileHash;
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

    this.#pendingPull = this.#pendingPull.then(() => this.#pollOnce());
  }

  async #pollOnce(): Promise<void> {
    this.#pulling = true;
    try {
      if (this.#syncService) {
        await this.#pullAndInvalidate(this.#syncService);
      }
      await this.#reloadOnLockfileChange();
    } finally {
      this.#pulling = false;
    }
  }

  async #pullAndInvalidate(syncService: DatastoreSyncService): Promise<void> {
    try {
      // Set inside the callback: gatedPull also resolves to undefined when it
      // skips the cycle, and a skip must not read as a changed cache.
      let changed = false;
      let count: number | undefined;
      await gatedPull(
        this.#syncGate,
        "config poller",
        async (signal) => {
          const result = await syncService.pullChanged({
            signal,
            subdirs: ["config"],
            namespace: this.#namespace,
          });
          // void means the count is unknown; the sync contract treats it as
          // changed.
          count = typeof result === "number" ? result : undefined;
          changed = count === undefined || count > 0;
        },
        {
          state: this.#gateState,
          signal: this.#stopController.signal,
          timing: this.#gateTiming,
        },
      );

      if (changed) {
        if (count === undefined) {
          logger
            .info`Config poller: pull reported an unknown count, invalidating catalogs`;
        } else {
          logger
            .info`Config poller: ${count} file(s) updated, invalidating catalogs`;
        }
        this.#catalogInvalidate();
      }
    } catch (error) {
      logger
        .warn`Config poller pull failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  async #reloadOnLockfileChange(): Promise<void> {
    let hash: string | null;
    try {
      hash = await this.#lockfileHash();
    } catch (error) {
      logger
        .warn`Config poller could not read the extension lockfile: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return;
    }

    if (this.#baselineHash === undefined) {
      this.#baselineHash = hash;
      return;
    }
    // Advance the baseline before reloading: a change that lands while the
    // reloader runs then differs from it and triggers on the next poll.
    if (hash !== this.#baselineHash) {
      this.#baselineHash = hash;
      this.#reloadPending = true;
      this.#failedReloads = 0;
      logger.info`Config poller: extension lockfile changed, reloading`;
    }
    if (!this.#reloadPending) return;

    let status: ExtensionReloadStatus;
    let errors: readonly string[];
    try {
      ({ status, errors } = await this.#extensionReloader());
    } catch (error) {
      status = "failed";
      errors = [error instanceof Error ? error.message : String(error)];
    }

    if (status === "ok") {
      this.#reloadPending = false;
      this.#failedReloads = 0;
      return;
    }
    if (status === "busy") {
      logger
        .debug`Config poller: another reload is running, retrying on the next poll`;
      return;
    }

    // At most MAX_FAILED_RELOAD_ATTEMPTS per lockfile version, and only the
    // first and last are warnings, so a broken extension does not flood logs.
    this.#failedReloads++;
    const attempts = this.#failedReloads;
    const loud = attempts === 1 || attempts >= MAX_FAILED_RELOAD_ATTEMPTS;
    for (const err of errors) {
      if (loud) {
        logger.warn`Config poller extension reload: ${err}`;
      } else {
        logger.debug`Config poller extension reload: ${err}`;
      }
    }
    if (attempts >= MAX_FAILED_RELOAD_ATTEMPTS) {
      this.#reloadPending = false;
      logger
        .warn`Config poller extension reload failed ${attempts} times; retrying when the lockfile changes again`;
    } else if (attempts === 1) {
      logger
        .warn`Config poller extension reload failed; retrying on the next poll`;
    } else {
      logger.debug`Config poller extension reload failed (attempt ${attempts})`;
    }
  }
}
