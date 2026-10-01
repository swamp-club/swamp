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
import { markErrorPaths } from "../../domain/errors.ts";
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
 * **Lock order.** Datastore global lock (when held, including by a
 * managed lockfile transaction), then the auto-resolve
 * `.extension-install.lock`, then this lock, then the lockfile's own
 * advisory lock (`lockfileAdvisoryLockPath`). Never take an outer lock
 * while holding this one.
 */
export class PulledExtensionsLock {
  readonly #queues = new Map<string, MutexQueue>();
  readonly #leases = new AsyncLocalStorage<Lease>();
  readonly #maxWaitMs: number;
  readonly #createFileLock: (
    swampDir: string,
    maxWaitMs: number,
  ) => PulledExtensionsFileLock;

  constructor(options?: {
    /**
     * Total time a section waits for both layers before throwing
     * {@link LockTimeoutError}. Defaults to 180s.
     */
    maxWaitMs?: number;
    /**
     * Test seam: builds the cross-process layer for a checkout's
     * `.swamp` dir, waiting at most `maxWaitMs` (what is left of the
     * section's budget). Called once per section, so each section gets
     * a fresh lock instance.
     */
    createFileLock?: (
      swampDir: string,
      maxWaitMs: number,
    ) => PulledExtensionsFileLock;
  }) {
    this.#maxWaitMs = options?.maxWaitMs ?? PULLED_EXTENSIONS_LOCK_MAX_WAIT_MS;
    this.#createFileLock = options?.createFileLock ??
      ((swampDir, maxWaitMs) =>
        new FileLock(swampDir, {
          lockKey: PULLED_EXTENSIONS_LOCK_KEY,
          ttlMs: PULLED_EXTENSIONS_LOCK_TTL_MS,
          maxWaitMs,
          retryIntervalMs: PULLED_EXTENSIONS_LOCK_RETRY_INTERVAL_MS,
        }));
  }

  /**
   * Runs `fn` holding the lock for `repoDir`, waiting for it if needed.
   * The wait behind other sections in this process and the wait for
   * another process's file lock share one budget. Past it, throws
   * {@link LockTimeoutError} naming the lock file (and, for another
   * process, its holder).
   */
  async withLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(repoDir);
    if (this.#holds(key)) return await fn();

    const deadline = Date.now() + this.#maxWaitMs;
    const exitMutex = await this.#enterMutex(key, repoDir);
    try {
      const fileLock = this.#createFileLock(
        swampPath(repoDir),
        // FileLock gives up before its first attempt at 0.
        Math.max(1, deadline - Date.now()),
      );
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
      const fileLock = this.#createFileLock(
        swampPath(repoDir),
        this.#maxWaitMs,
      );
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

  /**
   * Queues behind the current holder and resolves to the release
   * function. Gives up after the max wait: the abandoned place is
   * released, so sections queued behind it wait only for the ones
   * ahead of it.
   */
  async #enterMutex(key: string, repoDir: string): Promise<() => void> {
    const { entered, exit } = this.#queue(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#maxWaitMs);
    });
    try {
      if (!await Promise.race([entered.then(() => true), timedOut])) {
        exit();
        throw timeoutError(
          swampPath(repoDir, PULLED_EXTENSIONS_LOCK_KEY),
          null,
          this.#maxWaitMs,
          "Another operation in this swamp process",
        );
      }
    } finally {
      clearTimeout(timer);
    }
    return exit;
  }

  /** Enters only when nobody holds or waits for `key`. */
  #tryEnterMutex(key: string): (() => void) | undefined {
    if (this.#queues.has(key)) return undefined;
    return this.#queue(key).exit;
  }

  /**
   * Takes a place at the back of `key`'s queue. `entered` resolves when
   * every place ahead has exited. The queue's map entry is dropped once
   * every place has exited, so the map does not grow and a later
   * {@link tryWithLock} sees the checkout free.
   */
  #queue(key: string): { entered: Promise<void>; exit: () => void } {
    const queue = this.#queues.get(key) ?? { tail: Promise.resolve(), size: 0 };
    const entered = queue.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => release = r);
    queue.tail = entered.then(() => mine);
    queue.size++;
    this.#queues.set(key, queue);
    let exited = false;
    return {
      entered,
      exit: () => {
        if (exited) return;
        exited = true;
        release();
        if (--queue.size === 0) this.#queues.delete(key);
      },
    };
  }
}

/** A checkout's in-process FIFO: the last place's promise, and places held. */
interface MutexQueue {
  tail: Promise<void>;
  size: number;
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
  return timeoutError(
    error.lockKey,
    error.holder,
    error.waitedMs,
    "Another swamp process",
    error,
  );
}

function timeoutError(
  lockPath: string,
  holder: LockTimeoutError["holder"],
  waitedMs: number,
  who: string,
  cause?: unknown,
): LockTimeoutError {
  const heldBy = holder ? ` held by ${holder.holder} (pid ${holder.pid})` : "";
  return markErrorPaths(
    new LockTimeoutError(lockPath, holder, waitedMs, {
      message: `${who} is changing this repository's pulled extensions: ` +
        `lock ${lockPath}${heldBy} — timed out after ${waitedMs}ms. ` +
        `Retry once it finishes.`,
      cause,
    }),
    [lockPath],
  );
}

/** The process-wide lock every install and removal goes through. */
export const pulledExtensionsLock = new PulledExtensionsLock();
