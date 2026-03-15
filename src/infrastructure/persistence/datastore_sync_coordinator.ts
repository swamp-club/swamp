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
 * Supports both global locking (structural commands) and per-model
 * locking (model method run). Uses a Map of named entries so multiple
 * independent locks can be held concurrently.
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

/** Internal entry tracking a single lock/sync pair. */
interface SyncEntry {
  service?: S3CacheSyncService;
  lock?: DistributedLock;
}

/** Key used by the global (structural) lock. */
export const GLOBAL_LOCK_KEY = "__global__";

/** Map of all registered lock entries, keyed by lock name. */
const entries: Map<string, SyncEntry> = new Map();
let signalHandler: (() => void) | null = null;

/**
 * Installs or updates the SIGINT handler to release all held locks.
 */
function installSignalHandler(): void {
  if (signalHandler) return;

  signalHandler = () => {
    const forceExit = setTimeout(() => Deno.exit(130), 5_000);
    const releases = [...entries.values()]
      .filter((e) => e.lock)
      .map((e) => e.lock!.release().catch(() => {}));
    Promise.all(releases).finally(() => {
      clearTimeout(forceExit);
      Deno.exit(130);
    });
  };
  Deno.addSignalListener("SIGINT", signalHandler);
}

/**
 * Removes the SIGINT handler if no entries remain.
 */
function maybeRemoveSignalHandler(): void {
  if (entries.size > 0 || !signalHandler) return;
  try {
    Deno.removeSignalListener("SIGINT", signalHandler);
  } catch {
    // May already be removed
  }
  signalHandler = null;
}

/**
 * Registers the datastore sync lifecycle (global lock).
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
  await registerDatastoreSyncNamed(GLOBAL_LOCK_KEY, options);
}

/**
 * Registers a named datastore sync lifecycle.
 *
 * Acquires the lock (if provided), pulls from S3 (if service provided),
 * and registers for cleanup on flush/SIGINT.
 */
export async function registerDatastoreSyncNamed(
  key: string,
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  const { service, lock } = options;
  const entry: SyncEntry = { service, lock };
  entries.set(key, entry);

  // Acquire distributed lock if provided
  if (lock) {
    await lock.acquire();
    installSignalHandler();
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
 * Flushes the datastore sync lifecycle (global lock).
 *
 * - If a sync service is registered, pushes changed files to S3.
 * - Releases the distributed lock if held.
 * - Clears all references after flushing.
 */
export async function flushDatastoreSync(): Promise<void> {
  // Flush all entries (global + any per-model entries)
  const keys = [...entries.keys()];
  for (const key of keys) {
    await flushDatastoreSyncNamed(key);
  }
  maybeRemoveSignalHandler();
}

/**
 * Flushes a single named sync entry.
 *
 * Pushes to S3 if a service is registered, then releases the lock.
 */
export async function flushDatastoreSyncNamed(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;

  entries.delete(key);

  if (entry.service) {
    const logger = getSwampLogger(["datastore", "sync"]);
    try {
      logger.info`Pushing changes to S3...`;
      const pushed = await entry.service.pushChanged();
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

  // Release distributed lock
  if (entry.lock) {
    try {
      await entry.lock.release();
    } catch (error) {
      const logger = getSwampLogger(["datastore", "sync"]);
      logger.warn("Failed to release sync lock: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  maybeRemoveSignalHandler();
}

/**
 * Returns all currently registered lock keys.
 */
export function getRegisteredLockKeys(): string[] {
  return [...entries.keys()];
}
