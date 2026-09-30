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

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "@std/path";
import {
  applyLockfileDelta,
  diffLockfileEntries,
  isEmptyLockfileDelta,
} from "../../domain/extensions/lockfile_delta.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { runBoundedSync } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  clearLockfilePublishPending,
  type LockfileEntryDelta,
  markLockfilePublishPending,
  type PendingLockfilePublish,
  readLockfilePublishPending,
} from "../../infrastructure/persistence/pending_lockfile_publish.ts";
import {
  readUpstreamExtensions,
  type UpstreamExtensionsMap,
} from "../../infrastructure/persistence/upstream_extensions.ts";

/**
 * Moves the shared extension lockfile between the datastore and the local
 * cache.
 */
export interface ManagedLockfileSyncPort {
  /** Fetches the datastore's lockfile into the local cache. */
  hydrate(): Promise<void>;
  /** Publishes the local cache's lockfile to the datastore. */
  publish(): Promise<void>;
}

/** The datastore global lock, held for a whole lockfile transaction. */
export interface ManagedLockfileLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

/** Where a lockfile change that failed to publish is recorded. */
export interface PendingLockfileDeltaStore {
  read(): Promise<PendingLockfilePublish>;
  /** Records the outstanding change, replacing any earlier record. */
  write(delta: LockfileEntryDelta): Promise<void>;
  clear(): Promise<void>;
}

/** Serializes a checkout's writes to one managed lockfile. */
export interface LockfileTransaction {
  readonly lockfilePath: string;
  /**
   * Runs `fn`, which may write the lockfile, as one transaction against
   * the datastore's copy. Nested calls join the outer transaction.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Brings the local lockfile up to date with the datastore's before a
   * command reads it to decide what to change.
   */
  refresh(): Promise<void>;
}

export interface ManagedLockfileTransactionOptions {
  lockfilePath: string;
  lock: ManagedLockfileLock;
  sync: ManagedLockfileSyncPort;
  pending: PendingLockfileDeltaStore;
  /**
   * `throw` (the default) rethrows a failed publish once the change is
   * recorded as pending. `defer` reports it to `onWarning` and completes
   * normally; the next transaction publishes it. Serve defers, as its
   * handlers have already answered the client.
   */
  publishFailure?: "throw" | "defer";
  onWarning?: (message: string, error?: unknown) => void;
}

/**
 * Makes a checkout's changes to the shared extension lockfile safe against
 * other checkouts writing it too (swamp-club#2838).
 *
 * The datastore stores each file last-writer-wins, so a checkout that
 * publishes the lockfile from a stale cache erases entries other checkouts
 * added. A transaction therefore, under the datastore global lock:
 *
 * 1. fetches the datastore's lockfile into the cache,
 * 2. replays any change an earlier transaction failed to publish,
 * 3. runs the caller's change,
 * 4. records the whole outstanding change (the diff against the fetched
 *    lockfile) as pending, publishes, and clears the record.
 *
 * Step 4 also runs when the change throws, since an install can fail after
 * its lockfile entry landed; the original error is rethrown. Lock order:
 * this lock, then the pulled-extensions lock, then the lockfile's own
 * advisory lock. An install downloads before `run`, outside every lock;
 * its dependencies download inside it, because whether one needs
 * installing is only known from the lockfile read under the lock.
 */
export class ManagedLockfileTransaction implements LockfileTransaction {
  readonly lockfilePath: string;
  readonly #lock: ManagedLockfileLock;
  readonly #sync: ManagedLockfileSyncPort;
  readonly #pending: PendingLockfileDeltaStore;
  readonly #publishFailure: "throw" | "defer";
  readonly #onWarning: (message: string, error?: unknown) => void;
  readonly #leases = new AsyncLocalStorage<{ active: boolean }>();

  constructor(options: ManagedLockfileTransactionOptions) {
    this.lockfilePath = options.lockfilePath;
    this.#lock = options.lock;
    this.#sync = options.sync;
    this.#pending = options.pending;
    this.#publishFailure = options.publishFailure ?? "throw";
    this.#onWarning = options.onWarning ?? (() => {});
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#leases.getStore()?.active) return await fn();
    await this.#lock.acquire();
    try {
      return await this.#runLocked(fn);
    } finally {
      await this.#lock.release().catch((error) =>
        this.#onWarning("Failed to release the datastore lock", error)
      );
    }
  }

  async refresh(): Promise<void> {
    await this.run(() => Promise.resolve());
  }

  async #runLocked<T>(fn: () => Promise<T>): Promise<T> {
    const pending = await this.#pending.read();
    const localBefore = pending.kind === "unknown"
      ? await this.#readEntries()
      : undefined;
    await this.#sync.hydrate();
    const fetched = await this.#readEntries();
    if (pending.kind === "delta") {
      await this.#writeEntries(applyLockfileDelta(fetched, pending.delta));
    } else if (localBefore) {
      // An older swamp recorded that a change was unpublished but not
      // what it was. Keep every local entry: nothing added is lost, though
      // an entry another checkout removed may come back.
      this.#onWarning(
        "An earlier extension lockfile change was not published and its " +
          "content was not recorded; merging the local entries into the " +
          "datastore's lockfile.",
      );
      await this.#writeEntries({ ...fetched, ...localBefore });
    }

    const lease = { active: true };
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await this.#leases.run(lease, fn) };
    } catch (error) {
      result = { ok: false, error };
    } finally {
      lease.active = false;
    }

    const hadPending = pending.kind !== "none";
    if (result.ok) {
      await this.#settle(fetched, hadPending, false);
      return result.value;
    }
    try {
      await this.#settle(fetched, hadPending, true);
    } catch (error) {
      this.#onWarning("Failed to publish the extension lockfile", error);
    }
    throw result.error;
  }

  /**
   * Records and publishes everything the local lockfile changed relative
   * to the fetched one.
   *
   * With a pending record from an earlier transaction, the lockfile is
   * published even when that diff is empty: a fetch that found nothing to
   * download (no lockfile in the datastore yet, or a sync service that
   * keeps a locally changed file) leaves the pending change in the fetched
   * copy, so the diff cannot show it (swamp-club#2752).
   */
  async #settle(
    fetched: UpstreamExtensionsMap,
    hadPending: boolean,
    changeFailed: boolean,
  ): Promise<void> {
    const delta = diffLockfileEntries(fetched, await this.#readEntries());
    if (isEmptyLockfileDelta(delta) && !hadPending) return;
    // Written ahead of the publish, so a crash or a failed publish leaves
    // the change for the next transaction to replay. An empty diff keeps
    // the earlier record, which still describes the unpublished change.
    if (!isEmptyLockfileDelta(delta)) await this.#pending.write(delta);
    try {
      await this.#sync.publish();
    } catch (error) {
      if (changeFailed || this.#publishFailure === "throw") throw error;
      this.#onWarning(
        "The extension lockfile change was not published to the datastore; " +
          "the next extension change retries it",
        error,
      );
      return;
    }
    await this.#pending.clear().catch(() => {
      // A stale record only replays a change the datastore already has.
    });
  }

  #readEntries(): Promise<UpstreamExtensionsMap> {
    return readUpstreamExtensions(this.lockfilePath);
  }

  async #writeEntries(entries: UpstreamExtensionsMap): Promise<void> {
    await new LockfileRepository(this.lockfilePath).replaceAll(entries);
  }
}

const ambientTransaction = new AsyncLocalStorage<LockfileTransaction>();

/**
 * Runs `fn` with `transaction` governing writes to its lockfile: installs
 * and removals inside `fn` that write that lockfile run through it. With no
 * transaction (repos without managedConfig, filesystem datastores), runs
 * `fn` as is.
 */
export async function withManagedLockfileTransaction<T>(
  transaction: LockfileTransaction | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!transaction) return await fn();
  return await ambientTransaction.run(transaction, fn);
}

function transactionFor(lockfilePath: string): LockfileTransaction | undefined {
  const transaction = ambientTransaction.getStore();
  if (!transaction) return undefined;
  return resolve(transaction.lockfilePath) === resolve(lockfilePath)
    ? transaction
    : undefined;
}

/**
 * Runs `fn`, a write to the lockfile at `lockfilePath`, inside the
 * transaction the caller established for that lockfile, if any.
 */
export async function inManagedLockfileTransaction<T>(
  lockfilePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const transaction = transactionFor(lockfilePath);
  return transaction ? await transaction.run(fn) : await fn();
}

/**
 * Brings `repository`'s snapshot up to date with the datastore's lockfile,
 * when a transaction governs it. For reads that decide what a command will
 * change (the rm preview, update targets, install restore).
 */
export async function refreshManagedLockfile(
  repository: LockfileRepository,
): Promise<void> {
  const transaction = transactionFor(repository.lockfilePath);
  if (!transaction) return;
  await transaction.refresh();
  await repository.refresh();
}

/**
 * A {@link ManagedLockfileSyncPort} over a datastore sync service. The fetch
 * is a pull scoped to the `config` tier; the publish marks exactly the
 * lockfile and pushes. Both are bounded by `timeoutMs`.
 */
export function createDatastoreLockfileSync(options: {
  syncService: Pick<DatastoreSyncService, "pullChanged" | "pushChanged">;
  namespace: string | undefined;
  timeoutMs: number;
  lockfilePath: string;
  /** Marks a file changed, by absolute path, for the next push. */
  markDirty: (absPath: string) => Promise<void>;
}): ManagedLockfileSyncPort {
  const { syncService, namespace, timeoutMs } = options;
  return {
    hydrate: async () => {
      await runBoundedSync(
        "managed config",
        "pull",
        timeoutMs,
        (signal) =>
          syncService.pullChanged({ subdirs: ["config"], namespace, signal }),
      );
    },
    publish: async () => {
      await options.markDirty(options.lockfilePath);
      await runBoundedSync(
        "managed config",
        "push",
        timeoutMs,
        (signal) => syncService.pushChanged({ namespace, signal }),
      );
    },
  };
}

/**
 * The pending-change record in the repo's own `.swamp/` directory, which is
 * never synced.
 */
export function createRepoPendingLockfileStore(
  repoDir: string,
): PendingLockfileDeltaStore {
  return {
    read: () => readLockfilePublishPending(repoDir),
    write: (delta) => markLockfilePublishPending(repoDir, delta),
    clear: () => clearLockfilePublishPending(repoDir),
  };
}
