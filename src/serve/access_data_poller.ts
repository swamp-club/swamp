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

export const ACCESS_DATA_POLLER_ESCALATE_AFTER = 3;

export const ACCESS_DATA_SUBDIRS: readonly string[] = [
  "data/swamp/grant",
  "data/swamp/group",
  "data/@swamp/grant",
  "data/@swamp/group",
];

export const INTEGRATION_DATA_SUBDIRS: readonly string[] = [
  "data/swamp/integration",
  "data/@swamp/integration",
];

/** what a poller keeps current: the policy snapshot, or the integration list */
export interface AccessDataReloadTarget {
  load(): Promise<unknown>;
  readonly unreadable: readonly { readonly cause: string }[];
}

interface AccessDataPollerCommonOptions {
  policySnapshotLoader: AccessDataReloadTarget;
  subdirs?: readonly string[];
  /** names what it reloads in its logs */
  reloading?: string;
  /** a workflow step's own write shows as no change here, so don't wait for one */
  reloadEveryCycle?: boolean;
  catalogInvalidate: () => void;
  pollIntervalMs?: number;
}

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
  readonly #policySnapshotLoader: AccessDataReloadTarget;
  readonly #subdirs: readonly string[];
  readonly #reloadEveryCycle: boolean;
  readonly #reloading: string;
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
    this.#subdirs = options.subdirs ?? ACCESS_DATA_SUBDIRS;
    this.#reloadEveryCycle = options.reloadEveryCycle ?? false;
    this.#reloading = options.reloading ?? "policy snapshot";
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
        .info`Access data poller for the ${this.#reloading} started (filesystem datastore, interval: ${intervalSec}s)`;
    } else {
      logger
        .info`Access data poller for the ${this.#reloading} started (interval: ${intervalSec}s)`;
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

  async #pullAndReloadPolicy(): Promise<void> {
    this.#pulling = true;
    const cycle = startDiagnosticPhase("poll_cycle");
    try {
      const pending = this.#needsReload;
      const detected = await cycle.run(() => this.#changedCount());
      const count = detected ?? 0;
      if (detected !== null) cycle.tally.add("changed", count);
      if (count > 0) {
        if (this.#changeSource) {
          logger
            .info`Access data poller: ${count} record(s) changed by another process, reloading the ${this.#reloading}`;
        } else {
          logger
            .info`Access data poller: ${count} file(s) updated, reloading the ${this.#reloading}`;
        }
        await cycle.run(() =>
          observeDiagnosticPhase("catalog_invalidate", {}, () => {
            this.#catalogInvalidate();
            return Promise.resolve();
          })
        );
        this.#needsReload = true;
      }
      // a snapshot missing unreadable records is rebuilt each cycle until
      // whole, since the change source cannot see a file become readable;
      // corrupt records are not retried
      const reason = count > 0
        ? "changed"
        : this.#reloadEveryCycle
        ? "every_cycle"
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
        result === "skipped" && this.#stopController.signal.aborted
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

  #unreadableRecords(tally: PhaseTally): number {
    const count =
      this.#policySnapshotLoader.unreadable.filter((record) =>
        record.cause === "unreadable"
      ).length;
    tally.add("unreadable_records", count);
    return count;
  }

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
          subdirs: [...this.#subdirs],
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
  datastoreEngine: DatastoreEngine;
  datastoreResolver: DatastorePathResolver;
  eventBus: EventBus;
  dataNames?: readonly string[];
  modelTypes?: readonly string[];
}

export async function createAccessDataPoller(
  options: CreateAccessDataPollerOptions,
): Promise<AccessDataPoller | null> {
  const common: AccessDataPollerCommonOptions = {
    policySnapshotLoader: options.policySnapshotLoader,
    subdirs: options.subdirs,
    reloadEveryCycle: options.reloadEveryCycle,
    reloading: options.reloading,
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
    dirs: (options.subdirs ?? ACCESS_DATA_SUBDIRS).map((subdir) => {
      const [root, ...rest] = subdir.split("/");
      return options.datastoreResolver.resolvePath(root, ...rest);
    }),
    eventBus: options.eventBus,
    dataNames: options.dataNames,
    modelTypes: options.modelTypes,
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
