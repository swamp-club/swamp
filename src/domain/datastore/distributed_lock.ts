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
 * Domain interface for distributed locking.
 *
 * Provides a backend-agnostic contract for acquiring and releasing locks
 * across processes and machines. Implementations handle backend-specific
 * mechanics (S3 conditional writes, file locks, blob leases, etc.).
 */

import { UserError } from "../errors.ts";

/** Procfile-style metadata stored in the lock. */
export interface LockInfo {
  /** Who holds the lock, e.g. "user@hostname". */
  holder: string;
  /** Machine name. */
  hostname: string;
  /** Process ID of the lock holder. */
  pid: number;
  /** ISO timestamp when the lock was acquired or last extended. */
  acquiredAt: string;
  /** Lock duration in ms before considered stale. */
  ttlMs: number;
  /** Unique identifier for this lock acquisition (fencing token). */
  nonce?: string;
}

/** Configuration for lock behavior. */
export interface LockOptions {
  /** Backend-specific key/path for the lock (default varies by backend). */
  lockKey?: string;
  /**
   * Namespace prefix for scoping the lock key. When set, the lock provider
   * places the key under `{namespace}/` so IAM credentials scoped to the
   * namespace prefix can access it.
   */
  namespace?: string;
  /** TTL in ms (default: 30_000). */
  ttlMs?: number;
  /** Retry interval in ms (default: 1_000). */
  retryIntervalMs?: number;
  /** Max wait before giving up in ms (default: 60_000). */
  maxWaitMs?: number;
}

/** A distributed lock that can be acquired and released. */
export interface DistributedLock {
  /**
   * Acquire the lock. Starts internal heartbeat. Retries until maxWaitMs.
   * Force-acquires stale locks (TTL expired).
   * @throws {LockTimeoutError} if the lock cannot be acquired within maxWaitMs.
   * Extension locks may throw their own error shape; core wraps them with
   * {@link withCoreLockErrors} so callers always see the core class.
   */
  acquire(): Promise<void>;

  /**
   * Release the lock. Stops internal heartbeat.
   * Safe to call multiple times.
   */
  release(): Promise<void>;

  /** Execute a callback while holding the lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;

  /** Read the current lock info without acquiring. */
  inspect(): Promise<LockInfo | null>;

  /**
   * Force-release a lock only if its nonce matches the expected value.
   *
   * This is a breakglass operation for releasing stuck locks. The nonce check
   * reduces the TOCTOU window but cannot fully eliminate it — between the
   * final nonce verification and the actual delete, another process could
   * theoretically acquire a new lock. Each backend minimises this window
   * as much as the underlying storage allows.
   *
   * @returns true if the lock was deleted, false if the nonce didn't match.
   */
  forceRelease(expectedNonce: string): Promise<boolean>;
}

/**
 * Returns true when the lock key identifies the solo-mode (non-namespaced)
 * global datastore lock. Matches the short display key `.datastore.lock`
 * used by `acquireModelLocks` error paths. Full filesystem paths from
 * `FileLock.acquire()` do not match — the hint is only shown for the
 * display-key paths where it can reliably distinguish solo from namespaced
 * (e.g. `infra/.datastore.lock`).
 */
function isGlobalDatastoreLock(lockKey: string): boolean {
  return lockKey === ".datastore.lock";
}

/**
 * Thrown when a lock cannot be acquired within the configured timeout.
 *
 * Extends `UserError` so the message renders clean (no stack trace) at
 * the CLI error boundary — the message is already hand-crafted to be
 * actionable, and a stack would bury the remedies.
 */
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

/** Optional construction details for {@link LockTimeoutError}. */
export interface LockTimeoutErrorOptions {
  /** Message to use instead of the one built from the lock fields. */
  message?: string;
  /** The underlying error this timeout was translated from. */
  cause?: unknown;
}

/**
 * Translates a lock-timeout error thrown by a datastore extension into the
 * core {@link LockTimeoutError}.
 *
 * Extensions cannot import the core class, so they throw their own error
 * shape (the S3 and GCS datastores use `code: "LOCK_TIMEOUT"`). Callers of
 * {@link DistributedLock.acquire} — the exit-code mapping, serve's
 * `lock_timeout` client error — recognise only the core class, so every
 * extension lock is wrapped with {@link withCoreLockErrors} at the provider
 * boundary.
 *
 * Returns the error unchanged when it is already a core `LockTimeoutError`,
 * a translated error when its `code` is `lock_timeout` in any case, and
 * `null` for anything else.
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

/**
 * Wraps a lock so `acquire()` and `withLock()` reject with the core
 * {@link LockTimeoutError} whatever error shape the backend throws on
 * timeout. Other members delegate unchanged.
 */
export function withCoreLockErrors(lock: DistributedLock): DistributedLock {
  const rethrow = (error: unknown): never => {
    throw toCoreLockTimeoutError(error) ?? error;
  };
  return {
    acquire: () => lock.acquire().catch(rethrow),
    release: () => lock.release(),
    withLock: <T>(fn: () => Promise<T>) => lock.withLock(fn).catch(rethrow),
    inspect: () => lock.inspect(),
    forceRelease: (expectedNonce: string) => lock.forceRelease(expectedNonce),
  };
}
