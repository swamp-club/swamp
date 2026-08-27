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

const logger = getLogger(["swamp", "serve", "config-poller"]);

const DEFAULT_CONFIG_POLL_INTERVAL_MS = 30_000;

export interface ConfigPollerOptions {
  syncService: DatastoreSyncService;
  catalogInvalidate: () => void;
  extensionCatalogInvalidate: () => void;
  pollIntervalMs?: number;
  namespace?: string;
}

export class ConfigPoller {
  readonly #syncService: DatastoreSyncService;
  readonly #catalogInvalidate: () => void;
  readonly #extensionCatalogInvalidate: () => void;
  readonly #pollIntervalMs: number;
  readonly #namespace?: string;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingPull: Promise<void> = Promise.resolve();
  #pulling = false;

  constructor(options: ConfigPollerOptions) {
    this.#syncService = options.syncService;
    this.#catalogInvalidate = options.catalogInvalidate;
    this.#extensionCatalogInvalidate = options.extensionCatalogInvalidate;
    this.#pollIntervalMs = options.pollIntervalMs ??
      DEFAULT_CONFIG_POLL_INTERVAL_MS;
    this.#namespace = options.namespace;
  }

  start(): void {
    if (this.#timer) return;
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
    await this.#pendingPull;
  }

  #poll(): void {
    if (this.#pulling) return;

    this.#pendingPull = this.#pendingPull.then(() => this.#pullAndInvalidate());
  }

  async #pullAndInvalidate(): Promise<void> {
    this.#pulling = true;
    try {
      const result = await this.#syncService.pullChanged({
        subdirs: ["config"],
        namespace: this.#namespace,
      });
      const count = typeof result === "number" ? result : 0;
      if (count > 0) {
        logger
          .info`Config poller: ${count} file(s) updated, invalidating catalogs`;
        this.#catalogInvalidate();
        this.#extensionCatalogInvalidate();
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
