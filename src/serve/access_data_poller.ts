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
import { withPollCycleSpan } from "../infrastructure/tracing/mod.ts";
import {
  type DiagnosticResult,
  observeDiagnosticPhase,
  type PhaseTally,
  startDiagnosticPhase,
  withDiagnosticArea,
  withDiagnosticAttributes,
} from "../domain/diagnostics/diagnostic_phase.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import {
  gatedPull,
  type PollerGateState,
  type PollerGateTiming,
  pollerGateTiming,
  type SyncGate,
} from "./sync_gate.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type { EventBus } from "../domain/events/event_bus.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreEngine } from "../domain/datastore/datastore_format.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { FilesystemAccessDataChangeSource } from "./filesystem_access_data_change_source.ts";

const logger = getLogger(["swamp", "serve", "access-data-poller"]);

const DEFAULT_ACCESS_DATA_POLL_INTERVAL_MS = 30_000;

/**
 * Consecutive failed cycles after which each further failure is logged at
 * error rather than warning: peers' grant and revoke changes have stopped
 * reaching this instance (swamp-club#3386).
 */
export const ACCESS_DATA_POLLER_ESCALATE_AFTER = 3;

export const ACCESS_DATA_SUBDIRS: readonly string[] = [
  "data/swamp/grant",
  "data/swamp/group",
  "data/@swamp/grant",
  "data/@swamp/group",
];

interface AccessDataPollerCommonOptions {
  policySnapshotLoader: PolicySnapshotLoader;
  catalogInvalidate: () => void;
  pollIntervalMs?: number;
}

/**
 * Where the poller learns of peers' grant and group changes: a pull from the
 * sync service, or, on a v2 filesystem datastore with nothing to pull, a
 * local change source over the shared directories (swamp-club#3371).
 */
export type AccessDataPollerOptions =
  & AccessDataPollerCommonOptions
  & (
    | {
      syncService: DatastoreSyncService;
      syncGate?: SyncGate;
      namespace?: string;
    }
    | { changeSource: FilesystemAccessDataChangeSource }
  );

export class AccessDataPoller {
  readonly #syncService?: DatastoreSyncService;
  readonly #changeSource?: FilesystemAccessDataChangeSource;
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
  #consecutiveFailures = 0;

  constructor(options: AccessDataPollerOptions) {
    if ("changeSource" in options) {
      this.#changeSource = options.changeSource;
    } else {
      this.#syncService = options.syncService;
      this.#syncGate = options.syncGate;
      this.#namespace = options.namespace;
    }
    this.#policySnapshotLoader = options.policySnapshotLoader;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#pollIntervalMs = options.pollIntervalMs ??
      DEFAULT_ACCESS_DATA_POLL_INTERVAL_MS;
    this.#gateTiming = pollerGateTiming(this.#pollIntervalMs);
  }

  start(): void {
    if (this.#timer) return;
    if (this.#stopController.signal.aborted) {
      this.#stopController = new AbortController();
    }
    this.#changeSource?.listen();
    this.#timer = setInterval(() => {
      this.#poll();
    }, this.#pollIntervalMs);
    Deno.unrefTimer(this.#timer);
    const intervalSec = this.#pollIntervalMs / 1000;
    if (this.#changeSource) {
      logger
        .info`Access data poller started (filesystem datastore, interval: ${intervalSec}s)`;
    } else {
      logger.info`Access data poller started (interval: ${intervalSec}s)`;
    }
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
    this.#changeSource?.dispose();
  }

  #poll(): void {
    if (this.#pulling) return;

    this.#pendingPull = this.#pendingPull.then(() =>
      withPollCycleSpan("access_data", () =>
        withDiagnosticArea(
          "access_poll",
          () =>
            withDiagnosticAttributes(
              {
                "swamp.diagnostic.source_mode": this.#changeSource
                  ? "local_change_source"
                  : "sync_pull",
              },
              () => this.#pullAndReloadPolicy(),
            ),
          this.#stopController.signal,
        ))
    );
  }

  /**
   * One cycle, exported as the access_poll diagnostic phases
   * (design/enablers/serve-phase-telemetry.md): a `poll_cycle` holding
   * `change_detection` on a local change source or `gate_wait` and
   * `remote_pull` on a sync pull, then `catalog_invalidate` and the
   * snapshot phases when it reloads.
   */
  async #pullAndReloadPolicy(): Promise<void> {
    this.#pulling = true;
    const cycle = startDiagnosticPhase("poll_cycle");
    try {
      const pending = this.#needsReload;
      const detected = await cycle.run(() => this.#changedCount());
      const count = detected ?? 0;
      cycle.tally.add("changed", count);
      if (count > 0) {
        if (this.#changeSource) {
          logger
            .info`Access data poller: ${count} record(s) changed by another process, reloading policy snapshot`;
        } else {
          logger
            .info`Access data poller: ${count} file(s) updated, reloading policy snapshot`;
        }
        await cycle.run(() =>
          observeDiagnosticPhase("catalog_invalidate", {}, () => {
            this.#catalogInvalidate();
            return Promise.resolve();
          })
        );
        this.#needsReload = true;
      }
      // A snapshot missing records it could not read is rebuilt every cycle
      // until it is whole, whoever built it: the change source cannot see a
      // file turning readable again (a mode change moves only its ctime),
      // and a remote datastore's read can fail for one cycle. A corrupt
      // record never reads by itself, and the write that fixes it is a
      // change, so it is not retried.
      const reason = count > 0
        ? "changed"
        : pending
        ? "pending_retry"
        : this.#unreadableRecords(cycle.tally) > 0
        ? "unreadable_retry"
        : "none";
      cycle.attributes({ "swamp.diagnostic.reload_reason": reason });
      if (reason !== "none") {
        await cycle.run(() => this.#policySnapshotLoader.load());
        this.#needsReload = false;
      }
      // A pull that never ran (the gate was busy, or stop() ended the wait)
      // is a skip; a stop is also the cycle's cancellation.
      const result: DiagnosticResult = reason !== "none"
        ? "applied"
        : detected === null
        ? "skipped"
        : "no_change";
      cycle.result(result);
      if (this.#consecutiveFailures >= ACCESS_DATA_POLLER_ESCALATE_AFTER) {
        logger
          .info`Access data poller recovered after ${this.#consecutiveFailures} failed cycles`;
      }
      this.#consecutiveFailures = 0;
      cycle.end(
        detected === null && this.#stopController.signal.aborted
          ? "cancelled"
          : "ok",
      );
    } catch (error) {
      this.#consecutiveFailures++;
      cycle.attributes({
        "swamp.diagnostic.consecutive_failures": this.#consecutiveFailures,
      });
      cycle.fail(error);
      const message = error instanceof Error ? error.message : String(error);
      if (this.#consecutiveFailures >= ACCESS_DATA_POLLER_ESCALATE_AFTER) {
        logger
          .error`Access data poller cycle failed ${this.#consecutiveFailures} times in a row, so grant and revoke changes made by other processes are not being applied on this instance: ${message}`;
      } else {
        logger.warn`Access data poller cycle failed: ${message}`;
      }
    } finally {
      this.#pulling = false;
    }
  }

  /** Records the snapshot is missing because they could not be read. */
  #unreadableRecords(tally: PhaseTally): number {
    const count =
      this.#policySnapshotLoader.unreadable.filter((record) =>
        record.cause === "unreadable"
      ).length;
    tally.add("unreadable_records", count);
    return count;
  }

  /**
   * The number of records peers changed, or null when the sync pull never
   * ran because the gate was not acquired.
   */
  async #changedCount(): Promise<number | null> {
    const changeSource = this.#changeSource;
    if (changeSource) {
      return await observeDiagnosticPhase(
        "change_detection",
        { "swamp.diagnostic.baseline_missing": !changeSource.hasBaseline },
        () => changeSource.detect(),
      );
    }
    const syncService = this.#syncService!;
    let pulled = false;
    const result = await gatedPull(
      this.#syncGate,
      "access data poller",
      (signal) => {
        pulled = true;
        return syncService.pullChanged({
          signal,
          subdirs: [...ACCESS_DATA_SUBDIRS],
          namespace: this.#namespace,
        });
      },
      {
        state: this.#gateState,
        signal: this.#stopController.signal,
        timing: this.#gateTiming,
      },
    );
    if (!pulled) return null;
    return typeof result === "number" ? result : 0;
  }
}

export interface CreateAccessDataPollerOptions
  extends AccessDataPollerCommonOptions {
  syncService?: DatastoreSyncService;
  syncGate?: SyncGate;
  namespace?: string;
  datastoreConfig: DatastoreConfig;
  /** The engine serve resolved for the datastore; v3 gets no poller. */
  datastoreEngine: DatastoreEngine;
  datastoreResolver: DatastorePathResolver;
  eventBus: EventBus;
}

/**
 * The access data poller serve runs, or null when nothing can change access
 * data behind its back. A sync service pulls peers' changes. A v2
 * filesystem datastore has none, but its peers share the files, so a local
 * change source watches them; it is primed here, so call this before the
 * boot policy load. A v3 datastore allows one writer at a time and gets
 * none.
 */
export async function createAccessDataPoller(
  options: CreateAccessDataPollerOptions,
): Promise<AccessDataPoller | null> {
  const common: AccessDataPollerCommonOptions = {
    policySnapshotLoader: options.policySnapshotLoader,
    catalogInvalidate: options.catalogInvalidate,
    pollIntervalMs: options.pollIntervalMs,
  };
  if (options.syncService) {
    return new AccessDataPoller({
      ...common,
      syncService: options.syncService,
      syncGate: options.syncGate,
      namespace: options.namespace,
    });
  }
  if (
    isCustomDatastoreConfig(options.datastoreConfig) ||
    options.datastoreEngine === "v3"
  ) {
    return null;
  }
  const changeSource = new FilesystemAccessDataChangeSource({
    dirs: ACCESS_DATA_SUBDIRS.map((subdir) => {
      const [root, ...rest] = subdir.split("/");
      return options.datastoreResolver.resolvePath(root, ...rest);
    }),
    eventBus: options.eventBus,
  });
  try {
    await changeSource.prime();
  } catch (error) {
    logger
      .warn`Access data poller could not read the access data directories, reloading on its first cycle: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return new AccessDataPoller({ ...common, changeSource });
}
