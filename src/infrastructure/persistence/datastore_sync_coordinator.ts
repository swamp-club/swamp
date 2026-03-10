// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Global datastore sync coordinator with distributed locking.
 *
 * Supports two modes:
 * - **Full sync** (S3 datastores): lock + pull → execute → push + unlock
 * - **Lock-only** (filesystem datastores): lock → execute → unlock
 *
 * Registered in requireInitializedRepo, flushed from runCli() after the
 * command completes.
 */

import type { S3CacheSyncService } from "./s3_cache_sync.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../logging/logger.ts";

/** Options for registering a datastore sync lifecycle. */
export interface RegisterDatastoreSyncOptions {
  /** S3 sync service for pull/push operations. */
  service?: S3CacheSyncService;
  /** Distributed lock for concurrency control. */
  lock?: DistributedLock;
}

let registeredService: S3CacheSyncService | null = null;
let registeredLock: DistributedLock | null = null;
let signalHandler: (() => void) | null = null;

/**
 * Registers the datastore sync lifecycle.
 *
 * - If `lock` is provided, acquires it and installs a SIGINT handler
 *   for best-effort release on Ctrl-C.
 * - If `service` is provided, pulls changed files from S3.
 * - Either can be used independently (lock-only for filesystem datastores,
 *   or service-only if no lock is needed).
 */
export async function registerDatastoreSync(
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  const { service, lock } = options;

  if (service) {
    registeredService = service;
  }

  // Acquire distributed lock if provided
  if (lock) {
    registeredLock = lock;
    await lock.acquire();

    // Install SIGINT handler for best-effort lock release on Ctrl-C.
    // We await the release before exiting to give it time to complete.
    signalHandler = () => {
      lock.release().catch(() => {}).finally(() => {
        Deno.exit(130); // 128 + SIGINT(2)
      });
    };
    Deno.addSignalListener("SIGINT", signalHandler);
  }

  // Pull changed files if a sync service is registered
  if (service) {
    const logger = getSwampLogger(["datastore", "sync"]);
    try {
      logger.info`Syncing from S3...`;
      const pulled = await service.pullChanged();
      if (pulled > 0) {
        logger.info`Synced ${pulled} file(s) from S3`;
      } else {
        logger.info`S3 sync complete, already up to date`;
      }
    } catch (error) {
      logger.warn("Failed to pull changes from S3: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Flushes the datastore sync lifecycle.
 *
 * - If a sync service is registered, pushes changed files to S3.
 * - Releases the distributed lock if held.
 * - Clears all references after flushing.
 */
export async function flushDatastoreSync(): Promise<void> {
  const service = registeredService;
  const lock = registeredLock;
  const handler = signalHandler;

  registeredService = null;
  registeredLock = null;
  signalHandler = null;

  if (service) {
    const logger = getSwampLogger(["datastore", "sync"]);
    try {
      logger.info`Pushing changes to S3...`;
      const pushed = await service.pushChanged();
      if (pushed > 0) {
        logger.info`Pushed ${pushed} file(s) to S3`;
      } else {
        logger.info`S3 push complete, no changes`;
      }
    } catch (error) {
      logger.warn("Failed to push changes to S3: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Remove SIGINT handler before releasing lock
  if (handler) {
    try {
      Deno.removeSignalListener("SIGINT", handler);
    } catch {
      // May already be removed
    }
  }

  // Release distributed lock
  if (lock) {
    try {
      await lock.release();
    } catch (error) {
      const logger = getSwampLogger(["datastore", "sync"]);
      logger.warn("Failed to release sync lock: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
