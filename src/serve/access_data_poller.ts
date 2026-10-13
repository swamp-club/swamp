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
      withPollCycleSpan("access_data", () => this.#pullAndReloadPolicy())
    );
  }

  async #pullAndReloadPolicy(): Promise<void> {
    this.#pulling = true;
    try {
      const count = await this.#changedCount();
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

  async #changedCount(): Promise<number> {
    if (this.#changeSource) return await this.#changeSource.detect();
    const syncService = this.#syncService!;
    const result = await gatedPull(
      this.#syncGate,
      "access data poller",
      (signal) =>
        syncService.pullChanged({
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
