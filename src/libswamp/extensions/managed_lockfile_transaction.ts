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
import { UserError } from "../../domain/errors.ts";
import {
  applyLockfileDelta,
  diffLockfileEntries,
  emptyLockfileDelta,
  isEmptyLockfileDelta,
  mergeLockfileDeltas,
} from "../../domain/extensions/lockfile_delta.ts";
import type {
  DatastoreSyncService,
  MarkDirtyHook,
} from "../../domain/datastore/datastore_sync_service.ts";
import { runBoundedSync } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  clearLockfilePublishPending,
  type LockfileEntryDelta,
  markLockfilePublishPending,
  type PendingLockfilePublish,
  readLockfilePublishPending,
} from "../../infrastructure/persistence/pending_lockfile_publish.ts";
import { currentRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import {
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
  type UpstreamExtensionsMap,
} from "../../infrastructure/persistence/upstream_extensions.ts";

export interface ManagedLockfileSyncPort {
  hydrate(): Promise<void>;
  /**
   * mustUpload: the lockfile differs from the datastore's, so a push sending
   * nothing rejects; earlierChangeOnly: this command changed nothing, so the
   * publish carries only an earlier unpublished change
   */
  publish(
    options: { mustUpload: boolean; earlierChangeOnly: boolean },
  ): Promise<void>;
}

export interface ManagedLockfileLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface PendingLockfileDeltaStore {
  read(): Promise<PendingLockfilePublish>;
  write(delta: LockfileEntryDelta): Promise<void>;
  clear(): Promise<void>;
}

/**
 * the change itself succeeded: callers that report per-item results count the
 * item as done and raise this after reporting, so the command still fails and
 * names the retry
 */
export class ManagedLockfileUnpublishedError extends UserError {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      cause instanceof UserError && cause.code
        ? cause.code
        : "managed_config_unpublished",
    );
    this.name = "ManagedLockfileUnpublishedError";
    this.cause = cause;
  }
}

/**
 * a wiring mistake in the code that built the transaction, not a datastore
 * failure: thrown as itself, never wrapped or deferred to a warning, so it
 * cannot read as a datastore problem
 */
export class LockfilePublishWiringError extends Error {
  constructor() {
    super(
      "the extension lockfile was published outside a root unit of work " +
        "over its datastore hook; open one around the transaction",
    );
    this.name = "LockfilePublishWiringError";
  }
}

export interface LockfileTransaction {
  readonly lockfilePath: string;
  run<T>(fn: () => Promise<T>): Promise<T>;
  refresh(): Promise<void>;
}

export interface ManagedLockfileTransactionOptions {
  lockfilePath: string;
  lock: ManagedLockfileLock;
  sync: ManagedLockfileSyncPort;
  pending: PendingLockfileDeltaStore;
  /**
   * the checkpoint lands before the lock is released; a nested run joins the
   * outer one and its root
   */
  inRoot: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * defer reports a failed publish to onWarning and completes; serve defers
   * because the change has applied on the instance and failing the request
   * would report it as not made
   */
  publishFailure?: "throw" | "defer";
  onWarning?: (message: string, error?: unknown) => void;
}

/**
 * last-writer-wins storage means a stale cache erases other checkouts' entries,
 * so under the global lock: fetch, replay any unpublished change, run, record
 * and publish, even if the change throws
 */
export class ManagedLockfileTransaction implements LockfileTransaction {
  readonly lockfilePath: string;
  readonly #lock: ManagedLockfileLock;
  readonly #sync: ManagedLockfileSyncPort;
  readonly #pending: PendingLockfileDeltaStore;
  readonly #inRoot: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly #publishFailure: "throw" | "defer";
  readonly #onWarning: (message: string, error?: unknown) => void;
  readonly #leases = new AsyncLocalStorage<{ active: boolean }>();

  constructor(options: ManagedLockfileTransactionOptions) {
    this.lockfilePath = options.lockfilePath;
    this.#lock = options.lock;
    this.#sync = options.sync;
    this.#pending = options.pending;
    this.#inRoot = options.inRoot;
    this.#publishFailure = options.publishFailure ?? "throw";
    this.#onWarning = options.onWarning ?? (() => {});
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#leases.getStore()?.active) return await fn();
    return await this.#inRoot(async () => {
      await this.#lock.acquire();
      try {
        return await this.#runLocked(fn);
      } finally {
        await this.#lock.release().catch((error) =>
          this.#onWarning("Failed to release the datastore lock", error)
        );
      }
    });
  }

  async refresh(): Promise<void> {
    await this.run(() => Promise.resolve());
  }

  async #runLocked<T>(fn: () => Promise<T>): Promise<T> {
    const pending = await this.#pending.read();
    let prior = pending.kind === "delta"
      ? pending.delta
      : emptyLockfileDelta<UpstreamExtensionEntry>();
    if (pending.kind === "unknown") {
      // An older swamp recorded that a change was unpublished but not what
      // it was: keep every local entry. Nothing added is lost, though it
      // may undo another checkout's removal or upgrade of those entries.
      this.#onWarning(
        "An earlier extension lockfile change was not published and its " +
          "content was not recorded; merging every local entry into the " +
          "datastore's lockfile, which may undo other checkouts' removals " +
          "or upgrades of those extensions.",
      );
      prior = { upserts: await this.#readEntries(), removals: [] };
      // Saved before the fetch, which may overwrite the local lockfile and
      // then fail.
      await this.#pending.write(prior);
    }
    await this.#sync.hydrate();
    const fetched = await this.#readEntries();
    let current = fetched;
    if (pending.kind !== "none") {
      current = applyLockfileDelta(current, prior);
      await this.#writeEntries(current);
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
      await this.#settle(fetched, current, prior, hadPending, false);
      return result.value;
    }
    try {
      await this.#settle(fetched, current, prior, hadPending, true);
    } catch (error) {
      if (error instanceof LockfilePublishWiringError) throw error;
      this.#onWarning("Failed to publish the extension lockfile", error);
    }
    throw result.error;
  }

  /**
   * with an earlier record it publishes even when the change did nothing; the
   * record is cleared only once the change reached the datastore
   */
  async #settle(
    fetched: UpstreamExtensionsMap,
    start: UpstreamExtensionsMap,
    prior: LockfileEntryDelta,
    hadPending: boolean,
    changeFailed: boolean,
  ): Promise<void> {
    const final = await this.#readEntries();
    const change = diffLockfileEntries(start, final);
    const record = mergeLockfileDeltas(prior, change);
    if (isEmptyLockfileDelta(record) && !hadPending) return;
    const tolerate = changeFailed || this.#publishFailure === "defer";
    try {
      await this.#pending.write(record);
    } catch (error) {
      // The publish below may still succeed; if it fails too, the change
      // is lost when the next fetch overwrites the local lockfile.
      this.#onWarning("Failed to record the extension lockfile change", error);
    }
    try {
      await this.#sync.publish({
        mustUpload: !isEmptyLockfileDelta(diffLockfileEntries(fetched, final)),
        earlierChangeOnly: isEmptyLockfileDelta(change),
      });
    } catch (error) {
      if (error instanceof LockfilePublishWiringError) throw error;
      if (!tolerate) {
        throw error instanceof ManagedLockfileUnpublishedError
          ? error
          : new ManagedLockfileUnpublishedError(error);
      }
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

export async function inManagedLockfileTransaction<T>(
  lockfilePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const transaction = transactionFor(lockfilePath);
  return transaction ? await transaction.run(fn) : await fn();
}

export async function refreshManagedLockfile(
  repository: LockfileRepository,
): Promise<void> {
  const transaction = transactionFor(repository.lockfilePath);
  if (!transaction) return;
  await transaction.refresh();
  await repository.refresh();
}

/**
 * the publish stages one write of exactly the lockfile into the open root unit
 * and pushes at its checkpoint, rejecting a push that reports 0 files sent when
 * the lockfile had to be uploaded
 */
export function createRootLockfileSync(options: {
  syncService: Pick<DatastoreSyncService, "pullChanged">;
  namespace: string | undefined;
  timeoutMs: number;
  lockfilePath: string;
  markDirty: MarkDirtyHook;
}): ManagedLockfileSyncPort {
  const { syncService, namespace, timeoutMs, lockfilePath, markDirty } =
    options;
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
    publish: async ({ mustUpload }) => {
      const root = currentRootUnitOfWork(markDirty);
      if (root === undefined) throw new LockfilePublishWiringError();
      // The legacy root forwards this as markDirty(lockfilePath), and the
      // stage awaits it, as the direct mark did, outside the bound. The
      // checkpoint's wait for marks in flight therefore finds none.
      await root.stage({ kind: "write", path: lockfilePath });
      const pushed = await runBoundedSync(
        "managed config",
        "push",
        timeoutMs,
        (signal) => root.checkpoint({ signal }),
      );
      if (mustUpload && pushed === 0) {
        throw new UserError(
          "the datastore reported that the push uploaded nothing; if this " +
            "repeats, update the datastore extension",
          "managed_config_unpublished",
        );
      }
    },
  };
}

/** the repo's own .swamp/, which is never synced */
export function createRepoPendingLockfileStore(
  repoDir: string,
): PendingLockfileDeltaStore {
  return {
    read: () => readLockfilePublishPending(repoDir),
    write: (delta) => markLockfilePublishPending(repoDir, delta),
    clear: () => clearLockfilePublishPending(repoDir),
  };
}

/** its entries may have come from another checkout through the fetch */
export function isManagedLockfile(lockfilePath: string): boolean {
  return transactionFor(lockfilePath) !== undefined;
}
