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

export const PULLED_EXTENSIONS_LOCK_KEY = "pulled-extensions.lock";
/** Long enough for another process's apply, including dependency installs. */
const PULLED_EXTENSIONS_LOCK_MAX_WAIT_MS = 180_000;
const PULLED_EXTENSIONS_LOCK_TTL_MS = 30_000;
const PULLED_EXTENSIONS_LOCK_RETRY_INTERVAL_MS = 100;

export type PulledExtensionsFileLock = Pick<
  FileLock,
  "acquire" | "tryAcquire" | "release"
>;

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
 * lock order: datastore global lock, auto-resolve .extension-install.lock, this
 * lock, the lockfile advisory lock; never take an outer lock while holding this
 * one. Always await nested sections
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
    maxWaitMs?: number;
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
   * gives up after the max wait and releases the abandoned place, so sections
   * queued behind it wait only for those ahead
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

  #tryEnterMutex(key: string): (() => void) | undefined {
    if (this.#queues.has(key)) return undefined;
    return this.#queue(key).exit;
  }

  /**
   * the queue's map entry is dropped once every place has exited, so the map
   * does not grow and a later tryWithLock sees the checkout free
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

export const pulledExtensionsLock = new PulledExtensionsLock();
