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
 * Returns true when the lock key identifies the global (non-namespaced)
 * datastore lock. Covers both the bare key (`".datastore.lock"` from
 * S3/GCS locks) and the full filesystem path (`"/…/.datastore.lock"`
 * from FileLock). Namespaced keys live under `.locks/` and won't match.
 */
function isGlobalDatastoreLock(lockKey: string): boolean {
  return (lockKey === ".datastore.lock" ||
    lockKey.endsWith("/.datastore.lock")) &&
    !lockKey.includes("/.locks/");
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
  ) {
    const base = holder
      ? `Lock "${lockKey}" held by ${holder.holder} (pid ${holder.pid}) — ` +
        `timed out after ${waitedMs}ms`
      : `Lock "${lockKey}" — timed out after ${waitedMs}ms`;

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
  }
}
