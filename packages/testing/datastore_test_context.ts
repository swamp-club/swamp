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

import type {
  DatastoreHealthResult,
  DatastoreProvider,
  DatastoreSyncService,
  DatastoreVerifier,
  DistributedLock,
  LockInfo,
  LockOptions,
} from "./datastore_types.ts";

export interface LockOperation {
  method: "acquire" | "release" | "withLock" | "inspect" | "forceRelease";
  lockKey?: string;
  timestamp: number;
}

export interface SyncOperation {
  method: "pullChanged" | "pushChanged" | "markDirty";
  timestamp: number;
  /**
   * Cache-relative path forwarded by core on this call. Only set for
   * `markDirty` calls when core attributes the dirty signal to a single
   * path. Undefined for bulk `markDirty` calls and always undefined for
   * `pullChanged`/`pushChanged`.
   */
  relPath?: string;
}

export interface DatastoreTestContextOptions {
  datastorePath?: string;
  cachePath?: string;
  healthResult?: Partial<DatastoreHealthResult>;
  lockAcquireFails?: boolean;
  withSyncService?: boolean;
}

export interface DatastoreTestContextResult {
  provider: DatastoreProvider;
  getLockOperations(): LockOperation[];
  getSyncOperations(): SyncOperation[];
  isLockHeld(): boolean;
}

export function createDatastoreTestContext(
  options?: DatastoreTestContextOptions,
): DatastoreTestContextResult {
  const lockOperations: LockOperation[] = [];
  const syncOperations: SyncOperation[] = [];
  const heldLocks = new Map<string, boolean>();

  const datastorePath = options?.datastorePath ?? "/tmp/swamp-test-datastore";
  const cachePath = options?.cachePath;
  const lockAcquireFails = options?.lockAcquireFails ?? false;
  const withSyncService = options?.withSyncService ?? false;

  const defaultHealthResult: DatastoreHealthResult = {
    healthy: true,
    message: "Test datastore is healthy",
    latencyMs: 1,
    datastoreType: "test",
    ...options?.healthResult,
  };

  function createLock(
    _datastorePath: string,
    lockOptions?: LockOptions,
  ): DistributedLock {
    const baseLockKey = lockOptions?.lockKey ?? "default";
    const lockKey = lockOptions?.namespace
      ? `${lockOptions.namespace}/${baseLockKey}`
      : baseLockKey;
    const nonce = crypto.randomUUID();

    const lock: DistributedLock = {
      acquire(): Promise<void> {
        lockOperations.push({
          method: "acquire",
          lockKey,
          timestamp: Date.now(),
        });
        if (lockAcquireFails) {
          return Promise.reject(
            new Error(`Failed to acquire lock "${lockKey}"`),
          );
        }
        heldLocks.set(lockKey, true);
        return Promise.resolve();
      },

      release(): Promise<void> {
        lockOperations.push({
          method: "release",
          lockKey,
          timestamp: Date.now(),
        });
        heldLocks.set(lockKey, false);
        return Promise.resolve();
      },

      async withLock<T>(fn: () => Promise<T>): Promise<T> {
        lockOperations.push({
          method: "withLock",
          lockKey,
          timestamp: Date.now(),
        });
        if (lockAcquireFails) {
          throw new Error(`Failed to acquire lock "${lockKey}"`);
        }
        heldLocks.set(lockKey, true);
        try {
          return await fn();
        } finally {
          heldLocks.set(lockKey, false);
        }
      },

      inspect(): Promise<LockInfo | null> {
        lockOperations.push({
          method: "inspect",
          lockKey,
          timestamp: Date.now(),
        });
        if (!heldLocks.get(lockKey)) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          holder: "test-user@test-host",
          hostname: "test-host",
          pid: 1234,
          acquiredAt: new Date().toISOString(),
          ttlMs: lockOptions?.ttlMs ?? 30_000,
          nonce,
        });
      },

      forceRelease(expectedNonce: string): Promise<boolean> {
        lockOperations.push({
          method: "forceRelease",
          lockKey,
          timestamp: Date.now(),
        });
        if (heldLocks.get(lockKey) && expectedNonce === nonce) {
          heldLocks.set(lockKey, false);
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      },
    };

    return lock;
  }

  function createVerifier(): DatastoreVerifier {
    return {
      verify(): Promise<DatastoreHealthResult> {
        return Promise.resolve(defaultHealthResult);
      },
    };
  }

  const syncService: DatastoreSyncService | undefined = withSyncService
    ? {
      pullChanged(): Promise<void> {
        syncOperations.push({ method: "pullChanged", timestamp: Date.now() });
        return Promise.resolve();
      },
      pushChanged(): Promise<void> {
        syncOperations.push({ method: "pushChanged", timestamp: Date.now() });
        return Promise.resolve();
      },
      markDirty(options?: { relPath?: string }): Promise<void> {
        syncOperations.push({
          method: "markDirty",
          timestamp: Date.now(),
          relPath: options?.relPath,
        });
        return Promise.resolve();
      },
    }
    : undefined;

  const provider: DatastoreProvider = {
    createLock,
    createVerifier,
    resolveDatastorePath(_repoDir: string): string {
      return datastorePath;
    },
    ...(withSyncService
      ? {
        createSyncService(
          _repoDir: string,
          _cachePath: string,
        ): DatastoreSyncService {
          return syncService!;
        },
      }
      : {}),
    ...(cachePath !== undefined
      ? {
        resolveCachePath(_repoDir: string): string {
          return cachePath;
        },
      }
      : {}),
  };

  return {
    provider,
    getLockOperations: () => [...lockOperations],
    getSyncOperations: () => [...syncOperations],
    isLockHeld: () => [...heldLocks.values()].some((held) => held),
  };
}
