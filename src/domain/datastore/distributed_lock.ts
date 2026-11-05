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

import { UserError } from "../errors.ts";
import { LOCK_NONCE_PATTERN } from "./lock_holder_marker.ts";

export interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  /**
   * Fencing token for the lock. A holder may replace it during a hold (a
   * re-key), so it names the lock as it is now, not one acquisition.
   */
  nonce?: string;
  /**
   * set when the lock is held but its holder is still writing it: holder,
   * hostname and pid are placeholders, there is no nonce, and it cannot be
   * force-released until readable
   */
  holderUnknown?: true;
  /**
   * per-model lock nonces the structural command holding the global lock
   * skipped; written by another process, so read it through lockSkipping
   */
  skipping?: string[];
  /**
   * on a v3 writer lease: the fence its holder took; every commit the holder
   * makes names it
   */
  fence?: number;
}

/**
 * compares with the backend's own earlier reading, never this process's
 * identity, since backends write differing holder and pid; matching nonces also
 * tell two holds by one process apart
 */
export function lockStillNames(
  current: LockInfo | null,
  taken: LockInfo,
): boolean {
  return current !== null && current.holderUnknown !== true &&
    current.holder === taken.holder && current.hostname === taken.hostname &&
    current.pid === taken.pid &&
    (current.nonce === undefined || taken.nonce === undefined ||
      current.nonce === taken.nonce);
}

export const MAX_LOCK_SKIPPING = 1024;

/**
 * returns none unless the whole list is valid: the lock file is written by
 * another process and a holder must never wait on a list it cannot fully
 * validate
 */
export function lockSkipping(info: LockInfo | null): ReadonlySet<string> {
  const raw: unknown = info?.skipping;
  if (
    !Array.isArray(raw) || raw.length > MAX_LOCK_SKIPPING ||
    !raw.every((id) => typeof id === "string" && LOCK_NONCE_PATTERN.test(id))
  ) {
    return new Set();
  }
  return new Set(raw as string[]);
}

export interface LockOptions {
  lockKey?: string;
  /**
   * places the key under {namespace}/ so IAM credentials scoped to that prefix
   * can reach it
   */
  namespace?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface DistributedLock {
  /** an aborted signal stops the wait with its reason, holding nothing */
  acquire(signal?: AbortSignal): Promise<void>;

  release(): Promise<void>;

  withLock<T>(fn: () => Promise<T>): Promise<T>;

  inspect(): Promise<LockInfo | null>;

  /**
   * breakglass for stuck locks: the nonce check narrows but cannot close the
   * window between verification and delete, where another process could take a
   * new lock
   */
  forceRelease(expectedNonce: string): Promise<boolean>;
}

function isGlobalDatastoreLock(lockKey: string): boolean {
  return lockKey === ".datastore.lock";
}

export class LockTimeoutError extends UserError {
  override readonly name = "LockTimeoutError";

  constructor(
    public readonly lockKey: string,
    public readonly holder: LockInfo | null,
    public readonly waitedMs: number,
    options?: LockTimeoutErrorOptions,
  ) {
    const base = options?.message ??
      (holder
        ? `Lock "${lockKey}" held by ${holder.holder} (pid ${holder.pid}) — ` +
          `timed out after ${waitedMs}ms`
        : `Lock "${lockKey}" — timed out after ${waitedMs}ms`);

    const hint = isGlobalDatastoreLock(lockKey)
      ? `\n\nMultiple repos sharing this datastore serialize all writes ` +
        `behind a single global lock. To scope each repo to its own lock ` +
        `and index, run:\n` +
        `  swamp datastore namespace set <name>\n` +
        `  swamp datastore namespace migrate --confirm`
      : "";

    super(base + hint, "lock_timeout");
    this.lockKey = lockKey;
    this.holder = holder;
    this.waitedMs = waitedMs;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export interface LockWaitCycleDetails {
  opponentPid: number;
  waitedMs: number;
  waitingOnLockPaths: readonly string[];
}

/**
 * not a LockTimeoutError; exits 1 rather than 75 because retrying while the run
 * that started this command still holds its lock meets the same wait and gives
 * way again
 */
export class LockWaitCycleError extends UserError {
  override readonly name = "LockWaitCycleError";
  readonly opponentPid: number;
  readonly waitedMs: number;

  constructor(details: LockWaitCycleDetails) {
    const paths = details.waitingOnLockPaths.join(", ");
    super(
      `Lock "per-model locks" — stopped after ${details.waitedMs}ms: this ` +
        `command and swamp pid ${details.opponentPid} are each waiting on ` +
        `a per-model lock that is held until the other one exits` +
        `${paths ? ` (this command waits on ${paths})` : ""}. Parallel ` +
        `runs that each start a nested structural command (for example ` +
        `swamp data gc) wait on each other. Run those commands one at a ` +
        `time, or in a workflow step of their own. The other command ` +
        `continues once the run that started this one finishes and ` +
        `releases its lock.`,
      "lock_wait_cycle",
    );
    this.opponentPid = details.opponentPid;
    this.waitedMs = details.waitedMs;
  }
}

export interface LockTimeoutErrorOptions {
  message?: string;
  cause?: unknown;
}

/**
 * extensions cannot import the core class, so they throw their own shape;
 * callers recognise only the core class, so every extension lock is wrapped at
 * the provider boundary
 */
export function toCoreLockTimeoutError(
  error: unknown,
): LockTimeoutError | null {
  if (error instanceof LockTimeoutError) return error;
  if (typeof error !== "object" || error === null) return null;
  const fields = error as Record<string, unknown>;
  if (
    typeof fields.code !== "string" ||
    fields.code.toLowerCase() !== "lock_timeout"
  ) {
    return null;
  }
  const lockKey = typeof fields.lockKey === "string" ? fields.lockKey : null;
  const waitedMs = typeof fields.waitedMs === "number" &&
      Number.isFinite(fields.waitedMs)
    ? fields.waitedMs
    : null;
  const holder = isLockInfoLike(fields.holder) ? fields.holder : null;
  const originalMessage = error instanceof Error
    ? error.message
    : typeof fields.message === "string"
    ? fields.message
    : "Lock acquisition timed out";
  // Without the lock fields the core message would invent them, so keep
  // the extension's own message instead.
  const keepMessage = lockKey === null || waitedMs === null;
  return new LockTimeoutError(lockKey ?? "unknown", holder, waitedMs ?? 0, {
    message: keepMessage ? originalMessage : undefined,
    cause: error,
  });
}

function isLockInfoLike(value: unknown): value is LockInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.holder === "string" && typeof info.pid === "number";
}

export function withCoreLockErrors(lock: DistributedLock): DistributedLock {
  const rethrow = (error: unknown): never => {
    throw toCoreLockTimeoutError(error) ?? error;
  };
  return {
    acquire: (signal?: AbortSignal) => lock.acquire(signal).catch(rethrow),
    release: () => lock.release(),
    withLock: <T>(fn: () => Promise<T>) => lock.withLock(fn).catch(rethrow),
    inspect: () => lock.inspect(),
    forceRelease: (expectedNonce: string) => lock.forceRelease(expectedNonce),
  };
}
