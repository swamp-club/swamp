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

/**
 * File-based distributed lock using advisory lockfiles.
 *
 * Uses `Deno.open({ createNew: true })` for atomic check-and-create.
 * Includes a self-contained heartbeat that extends the lock by rewriting
 * the lockfile with a fresh timestamp.
 */

import { hostname } from "node:os";
import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type {
  DistributedLock,
  LockInfo,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import {
  LockTimeoutError,
  MAX_LOCK_SKIPPING,
} from "../../domain/datastore/distributed_lock.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { isProcessDead } from "../runtime/process.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_LOCK_PATH = ".datastore.lock";
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const JITTER_FACTOR = 0.25;

/** {@link LockOptions} plus settings that only apply to {@link FileLock}. */
export interface FileLockOptions extends LockOptions {
  /** Ceiling for the doubling retry backoff in ms (default: 8_000). */
  maxBackoffMs?: number;
}

/**
 * Computes one retry of the acquire loop's jittered exponential backoff.
 *
 * `jitterSample` is a value in [0, 1) that scales the backoff by ±25%. The
 * jittered sleep is clamped to both `remainingMs` and `maxBackoffMs`, so no
 * sleep exceeds the cap or overshoots the wait budget. The next backoff
 * doubles up to `maxBackoffMs`.
 */
export function nextBackoffSleep(
  currentBackoffMs: number,
  jitterSample: number,
  remainingMs: number,
  maxBackoffMs: number,
): { sleepMs: number; nextBackoffMs: number } {
  const jitter = 1 + (jitterSample * 2 - 1) * JITTER_FACTOR;
  const sleepMs = Math.min(
    currentBackoffMs * jitter,
    remainingMs,
    maxBackoffMs,
  );
  return {
    sleepMs,
    nextBackoffMs: Math.min(currentBackoffMs * 2, maxBackoffMs),
  };
}

/** Build a LockInfo for the current process. */
function buildLockInfo(
  ttlMs: number,
  nonce: string,
  skipping?: readonly string[],
): LockInfo {
  const host = hostname();
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  return {
    holder: `${user}@${host}`,
    hostname: host,
    pid: Deno.pid,
    acquiredAt: new Date().toISOString(),
    ttlMs,
    nonce,
    ...(skipping && skipping.length > 0 ? { skipping: [...skipping] } : {}),
  };
}

/**
 * File-based distributed lock using advisory lockfiles.
 *
 * Acquire uses `Deno.open({ createNew: true })` for atomic creation.
 * Heartbeat runs as a background interval, rewriting the lockfile content
 * with a fresh timestamp every ttlMs/3.
 * Staleness: if `acquiredAt + ttlMs < now`, the lock holder is assumed crashed.
 */
export class FileLock implements DistributedLock {
  private readonly lockPath: string;
  private readonly ttlMs: number;
  /** Initial backoff before the first retry. Readable so callers' lock
   * policy can be asserted without timing the acquire loop. */
  readonly retryIntervalMs: number;
  /** Ceiling for the doubling backoff. Readable for the same reason. */
  readonly maxBackoffMs: number;
  private readonly maxWaitMs: number;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private held = false;
  private releasing = false;
  private nonce: string | undefined;
  private skipping: readonly string[] | undefined;
  /** Serializes the rewrites of a held lock file; see {@link rewriting}. */
  private rewrites: Promise<unknown> = Promise.resolve();

  constructor(basePath: string, options?: FileLockOptions) {
    const lockFile = options?.lockKey ?? DEFAULT_LOCK_PATH;
    const ns = options?.namespace;
    this.lockPath = ns
      ? join(basePath, ns, lockFile)
      : join(basePath, lockFile);
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.retryIntervalMs = options?.retryIntervalMs ??
      DEFAULT_RETRY_INTERVAL_MS;
    this.maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  async acquire(): Promise<void> {
    const startTime = Date.now();
    this.releasing = false;

    await ensureDir(dirname(this.lockPath));

    const nonce = crypto.randomUUID();
    let contentionLogged = false;
    let retryCount = 0;
    let currentBackoff = this.retryIntervalMs;

    while (true) {
      // Check timeout on every iteration — including retries after stale lock cleanup
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxWaitMs) {
        const existing = await this.readLockFile();
        throw markErrorPaths(
          new LockTimeoutError(this.lockPath, existing, elapsed),
          [this.lockPath],
        );
      }

      if (await this.tryCreate(nonce)) {
        if (retryCount > 0) {
          const waitMs = Date.now() - startTime;
          const logger = getSwampLogger(["datastore", "lock"]);
          logger
            .info`Acquired lock ${this.lockPath} after ${retryCount} retries (${waitMs}ms)`;
        }
        return;
      }

      retryCount++;

      const holder = await this.clearStaleHolder();
      if (holder === "cleared") continue; // Retry create (timeout checked at top of loop)

      if (holder !== "unreadable" && !contentionLogged) {
        const ageMs = Date.now() - new Date(holder.acquiredAt).getTime();
        const logger = getSwampLogger(["datastore", "lock"]);
        logger
          .warn`Waiting for lock ${this.lockPath} held by ${holder.holder} (pid ${holder.pid}, acquired ${ageMs}ms ago)`;
        contentionLogged = true;
      }

      // Jittered exponential backoff, clamped to remaining budget
      const remaining = this.maxWaitMs - (Date.now() - startTime);
      const { sleepMs, nextBackoffMs } = nextBackoffSleep(
        currentBackoff,
        Math.random(),
        remaining,
        this.maxBackoffMs,
      );
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      currentBackoff = nextBackoffMs;
    }
  }

  /**
   * Makes one attempt to take the lock, without waiting. Returns true
   * and starts the heartbeat when it is taken; returns false while a
   * live holder has it. A stale holder is cleared the same way
   * {@link acquire} clears one, and the create is retried once. Never
   * throws {@link LockTimeoutError}.
   */
  async tryAcquire(): Promise<boolean> {
    this.releasing = false;
    await ensureDir(dirname(this.lockPath));
    const nonce = crypto.randomUUID();
    if (await this.tryCreate(nonce)) return true;
    if (await this.clearStaleHolder() !== "cleared") return false;
    return await this.tryCreate(nonce);
  }

  async release(): Promise<void> {
    // Set releasing flag BEFORE stopping heartbeat so any in-flight
    // extend() sees it and skips writing — prevents orphaned lock files.
    this.releasing = true;
    this.stopHeartbeat();

    if (!this.held) return;
    this.held = false;
    this.nonce = undefined;
    this.skipping = undefined;

    try {
      await Deno.remove(this.lockPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // NotFound is expected (file already gone), but other errors
        // indicate a real problem — log so operators can investigate
        const logger = getSwampLogger(["datastore", "lock"]);
        logger.warn(
          "Failed to delete lock {path} during release: {error}",
          {
            path: this.lockPath,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /**
   * The nonce written to the lock file while this instance holds it, or
   * undefined when it does not (never acquired, released, or self-revoked
   * after another process took the lock). The heartbeat rewrites the file
   * with the same nonce; only {@link rekey} changes it during a hold.
   */
  get heldNonce(): string | undefined {
    return this.held ? this.nonce : undefined;
  }

  /**
   * Gives the held lock a fresh nonce and returns the one it retires, or
   * undefined when this instance does not hold the lock. A swamp that was
   * handed the retired nonce no longer matches the lock file and waits on
   * the lock like any other (design/enablers/datastores.md, "Parent-Process
   * Lock Awareness"). The file is replaced whole, never rewritten in place:
   * a reader that catches a lock file mid-write takes the lock for absent.
   */
  rekey(): Promise<string | undefined> {
    return this.rewriting(async () => {
      if (!await this.stillOwned()) return undefined;
      const retired = this.nonce!;
      const nonce = crypto.randomUUID();
      await this.replaceLockFile(
        buildLockInfo(this.ttlMs, nonce, this.skipping),
      );
      if (!await this.keptAfterWrite()) return undefined;
      this.nonce = nonce;
      return retired;
    });
  }

  /**
   * Records in the held lock file the per-model lock nonces its holder, a
   * structural command, skipped; the heartbeat keeps the list. At most
   * {@link MAX_LOCK_SKIPPING} are written. Does nothing when this instance
   * does not hold the lock. The file is replaced whole, as {@link rekey}
   * does.
   */
  async publishSkipping(nonces: readonly string[]): Promise<void> {
    await this.rewriting(async () => {
      if (!await this.stillOwned()) return;
      this.skipping = nonces.slice(0, MAX_LOCK_SKIPPING);
      await this.replaceLockFile(
        buildLockInfo(this.ttlMs, this.nonce!, this.skipping),
      );
      await this.keptAfterWrite();
    });
  }

  /**
   * Runs one rewrite of the held lock file after any already under way, so
   * the heartbeat never compares the file against a nonce that
   * {@link rekey} is changing and revokes a lock this instance still holds.
   */
  private rewriting<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.rewrites.then(fn, fn);
    this.rewrites = run.catch(() => {});
    return run;
  }

  /**
   * True while the lock file still carries this instance's nonce. When
   * another process has taken the lock (this one was paused past its ttl)
   * the instance revokes itself, as the heartbeat does.
   */
  private async stillOwned(): Promise<boolean> {
    if (!this.held || !this.nonce || this.releasing) return false;
    const current = await this.readLockFile();
    if (!current || current.nonce !== this.nonce) {
      this.held = false;
      this.stopHeartbeat();
      return false;
    }
    return !this.releasing;
  }

  /**
   * Replaces the lock file through a temp file and a rename. Windows can
   * refuse a rename onto a file another process has open; the file is then
   * rewritten in place, as the heartbeat rewrites it.
   */
  private async replaceLockFile(info: LockInfo): Promise<void> {
    const content = JSON.stringify(info, null, 2);
    try {
      await atomicWriteTextFile(this.lockPath, content);
    } catch (error) {
      if (Deno.build.os !== "windows") throw error;
      await Deno.writeTextFile(this.lockPath, content);
    }
  }

  /**
   * False when release() ran while a write was in flight: the lock file
   * that write put back is removed so it is not orphaned.
   */
  private async keptAfterWrite(): Promise<boolean> {
    if (this.held) return true;
    try {
      await Deno.remove(this.lockPath);
    } catch {
      // Best-effort cleanup
    }
    return false;
  }

  async inspect(): Promise<LockInfo | null> {
    return await this.readLockFile();
  }

  async forceRelease(expectedNonce: string): Promise<boolean> {
    const current = await this.readLockFile();
    if (!current || current.nonce !== expectedNonce) {
      return false;
    }
    try {
      await Deno.remove(this.lockPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return true;
  }

  /**
   * Atomically creates the lock file for `nonce`. Returns false when it
   * already exists; on success marks the lock held and starts the
   * heartbeat.
   */
  private async tryCreate(nonce: string): Promise<boolean> {
    const content = JSON.stringify(buildLockInfo(this.ttlMs, nonce), null, 2);
    try {
      const file = await Deno.open(this.lockPath, {
        createNew: true,
        write: true,
      });
      await file.write(new TextEncoder().encode(content));
      file.close();
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) return false;
      throw error;
    }
    this.nonce = nonce;
    this.held = true;
    this.startHeartbeat();
    return true;
  }

  /**
   * Inspects an existing lock file and removes it when its holder is
   * stale. Returns "cleared" when the caller should retry the create
   * (removed, or gone meanwhile), the live holder's info, or
   * "unreadable" for a fresh file a holder is still writing.
   *
   * Best-effort: if we accidentally delete a fresh lock, the nonce
   * fencing in extend() ensures the old holder self-revokes.
   */
  private async clearStaleHolder(): Promise<
    "cleared" | "unreadable" | LockInfo
  > {
    const existing = await this.readLockFile();
    if (existing) {
      const isStale = isProcessDead(existing.pid) ||
        Date.now() - new Date(existing.acquiredAt).getTime() > existing.ttlMs;
      if (!isStale) return existing;
      try {
        await Deno.remove(this.lockPath);
      } catch {
        // Another process may have already cleaned it up
      }
      return "cleared";
    }
    // Lock file exists on disk but is unreadable (0 bytes, corrupt
    // JSON, or partial write). A live holder's file is briefly empty
    // between create and write, and during each heartbeat rewrite, so
    // only a file untouched for a full TTL is stale: removing a fresh
    // one lets two holders in at once (swamp-club#2571).
    const mtime = await this.readLockFileMtime();
    if (mtime === null) return "cleared"; // Removed meanwhile
    if (Date.now() - mtime > this.ttlMs) {
      const logger = getSwampLogger(["datastore", "lock"]);
      logger
        .warn`Removing unreadable lock file ${this.lockPath}`;
      try {
        await Deno.remove(this.lockPath);
      } catch {
        // Another process may have already cleaned it up
      }
      return "cleared";
    }
    // Fresh: a holder is mid-write. Back off like any held lock.
    return "unreadable";
  }

  private extend(): Promise<void> {
    return this.rewriting(async () => {
      // Verify we still own the lock before extending (fencing).
      // If another process acquired the lock (e.g., after we were paused
      // beyond TTL), the nonce will differ and we must self-revoke.
      if (!await this.stillOwned()) return;

      const info = buildLockInfo(this.ttlMs, this.nonce!, this.skipping);
      const content = JSON.stringify(info, null, 2);
      await Deno.writeTextFile(this.lockPath, content);

      // If release() was called while the write was in flight,
      // clean up the lock we just wrote so we don't orphan it.
      await this.keptAfterWrite();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.floor(this.ttlMs / 3);
    this.heartbeatId = setInterval(() => {
      this.extend().catch(() => {
        // Heartbeat failure is non-fatal — lock will expire via TTL
      });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatId !== undefined) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = undefined;
    }
  }

  /** The lock file's mtime in ms, or null when it no longer exists. */
  private async readLockFileMtime(): Promise<number | null> {
    try {
      return (await Deno.stat(this.lockPath)).mtime?.getTime() ?? 0;
    } catch {
      return null;
    }
  }

  private async readLockFile(): Promise<LockInfo | null> {
    try {
      const content = await Deno.readTextFile(this.lockPath);
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }
}
