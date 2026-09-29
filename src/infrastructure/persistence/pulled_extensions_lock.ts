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
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { canonicalizePath } from "./canonicalize_path.ts";
import { FileLock } from "./file_lock.ts";
import { swampPath } from "./paths.ts";

/** Lock file, under the checkout's `.swamp` dir. */
export const PULLED_EXTENSIONS_LOCK_KEY = "pulled-extensions.lock";
/** Long enough for another process's apply, including dependency installs. */
const PULLED_EXTENSIONS_LOCK_MAX_WAIT_MS = 180_000;
const PULLED_EXTENSIONS_LOCK_TTL_MS = 30_000;
const PULLED_EXTENSIONS_LOCK_RETRY_INTERVAL_MS = 100;

/** The cross-process layer of the lock. */
export type PulledExtensionsFileLock = Pick<
  FileLock,
  "acquire" | "tryAcquire" | "release"
>;

/** Result of {@link PulledExtensionsLock.tryWithLock}. */
export type TryLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

/**
 * A held section. `parent` is the lease this section was entered under,
 * so a section for one checkout nested inside another's still sees the
 * outer lease.
 */
interface Lease {
  readonly key: string;
  readonly parent: Lease | undefined;
  active: boolean;
}

/**
 * Serializes changes to one checkout's pulled extensions: the files
 * under the pulled root and skills dirs, the lockfile entries, and the
 * catalog rows (swamp-club#2709).
 *
 * A section takes two layers, in order:
 *
 * 1. An in-process FIFO mutex keyed by the canonical repo dir, so
 *    concurrent requests in one process (e.g. `swamp serve`) queue
 *    without polling.
 * 2. A {@link FileLock} on `.swamp/pulled-extensions.lock`, so other
 *    processes wait too. Its TTL and heartbeat clear a crashed holder.
 *
 * **Reentrancy.** Each section runs under an `AsyncLocalStorage` lease.
 * A section entered while the caller's lease for the same checkout is
 * active runs inline (e.g. dependency installs under the parent's
 * install). The lease is deactivated when its section exits, so a
 * promise created inside it that enters a section after the exit has to
 * take the lock normally. The check happens at section entry only: a
 * nested section that entered inline and was not awaited keeps running
 * after the outer section exits. Always await nested sections.
 *
 * **Lock order.** Datastore global lock (when held), then the
 * auto-resolve `.extension-install.lock`, then this lock, then the
 * lockfile's own `upstream_extensions.json.lock`. Never take an outer
 * lock while holding this one.
 */
export class PulledExtensionsLock {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #leases = new AsyncLocalStorage<Lease>();
  readonly #createFileLock: (swampDir: string) => PulledExtensionsFileLock;

  constructor(options?: {
    /**
     * Test seam: builds the cross-process layer for a checkout's
     * `.swamp` dir. Called once per section, so each section gets a
     * fresh lock instance.
     */
    createFileLock?: (swampDir: string) => PulledExtensionsFileLock;
  }) {
    this.#createFileLock = options?.createFileLock ??
      ((swampDir) =>
        new FileLock(swampDir, {
          lockKey: PULLED_EXTENSIONS_LOCK_KEY,
          ttlMs: PULLED_EXTENSIONS_LOCK_TTL_MS,
          maxWaitMs: PULLED_EXTENSIONS_LOCK_MAX_WAIT_MS,
          retryIntervalMs: PULLED_EXTENSIONS_LOCK_RETRY_INTERVAL_MS,
        }));
  }

  /**
   * Runs `fn` holding the lock for `repoDir`, waiting for it if needed.
   * Throws {@link LockTimeoutError} naming the lock file and its holder
   * when another process holds it past the max wait.
   */
  async withLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(repoDir);
    if (this.#holds(key)) return await fn();

    const exitMutex = await this.#enterMutex(key);
    try {
      const fileLock = this.#createFileLock(swampPath(repoDir));
      try {
        await fileLock.acquire();
      } catch (error) {
        throw error instanceof LockTimeoutError
          ? describeTimeout(error)
          : error;
      }
      try {
        return await this.#runLeased(key, fn);
      } finally {
        await fileLock.release();
      }
    } finally {
      exitMutex();
    }
  }

  /**
   * Runs `fn` holding the lock for `repoDir` when it is free, and
   * reports busy instead of waiting when it is not. Inside an active
   * lease for the same checkout, runs `fn` inline.
   */
  async tryWithLock<T>(
    repoDir: string,
    fn: () => Promise<T>,
  ): Promise<TryLockResult<T>> {
    const key = lockKey(repoDir);
    if (this.#holds(key)) return { acquired: true, value: await fn() };

    const exitMutex = this.#tryEnterMutex(key);
    if (!exitMutex) return { acquired: false };
    try {
      const fileLock = this.#createFileLock(swampPath(repoDir));
      if (!await fileLock.tryAcquire()) return { acquired: false };
      try {
        return { acquired: true, value: await this.#runLeased(key, fn) };
      } finally {
        await fileLock.release();
      }
    } finally {
      exitMutex();
    }
  }

  #holds(key: string): boolean {
    for (let l = this.#leases.getStore(); l; l = l.parent) {
      if (l.key === key && l.active) return true;
    }
    return false;
  }

  async #runLeased<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lease: Lease = {
      key,
      parent: this.#leases.getStore(),
      active: true,
    };
    try {
      return await this.#leases.run(lease, fn);
    } finally {
      lease.active = false;
    }
  }

  /** Queues behind the current holder; resolves to the release function. */
  async #enterMutex(key: string): Promise<() => void> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const exit = this.#queue(key, prev);
    await prev;
    return exit;
  }

  /** Enters only when nobody holds or waits for `key`. */
  #tryEnterMutex(key: string): (() => void) | undefined {
    if (this.#tails.has(key)) return undefined;
    return this.#queue(key, Promise.resolve());
  }

  #queue(key: string, prev: Promise<void>): () => void {
    let release!: () => void;
    const mine = new Promise<void>((r) => release = r);
    const tail = prev.then(() => mine);
    this.#tails.set(key, tail);
    return () => {
      release();
      // Drop the entry once the queue drains so the map does not grow.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
  }
}

/** One key per checkout, whichever form of its path a caller passes. */
function lockKey(repoDir: string): string {
  const absolute = resolve(repoDir);
  let real = absolute;
  try {
    real = Deno.realPathSync(absolute);
  } catch {
    // Not created yet: the resolved path is the best key available.
  }
  return canonicalizePath(real);
}

function describeTimeout(error: LockTimeoutError): LockTimeoutError {
  const holder = error.holder
    ? ` held by ${error.holder.holder} (pid ${error.holder.pid})`
    : "";
  return new LockTimeoutError(error.lockKey, error.holder, error.waitedMs, {
    message:
      `Another swamp process is changing this repository's pulled extensions: ` +
      `lock ${error.lockKey}${holder} — timed out after ${error.waitedMs}ms. ` +
      `Retry once it finishes.`,
    cause: error,
  });
}

/** The process-wide lock every install and removal goes through. */
export const pulledExtensionsLock = new PulledExtensionsLock();
