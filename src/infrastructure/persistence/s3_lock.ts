// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * S3-backed distributed lock using conditional writes.
 *
 * Uses S3 `PutObject` with `If-None-Match: *` (conditional write) for atomic
 * lock acquisition. Includes a self-contained heartbeat that extends the lock
 * periodically while held.
 */

import { hostname } from "node:os";
import type {
  DistributedLock,
  LockInfo,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import type { S3Client } from "./s3_client.ts";
import { getSwampLogger } from "../logging/logger.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_LOCK_KEY = ".datastore.lock";

/** Build a LockInfo for the current process. */
function buildLockInfo(ttlMs: number, nonce: string): LockInfo {
  const host = hostname();
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  return {
    holder: `${user}@${host}`,
    hostname: host,
    pid: Deno.pid,
    acquiredAt: new Date().toISOString(),
    ttlMs,
    nonce,
  };
}

/** Encode LockInfo as a UTF-8 Uint8Array. */
function encodeLockInfo(info: LockInfo): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(info, null, 2));
}

/** Decode a Uint8Array into LockInfo. */
function decodeLockInfo(data: Uint8Array): LockInfo {
  return JSON.parse(new TextDecoder().decode(data)) as LockInfo;
}

/**
 * S3-backed distributed lock.
 *
 * Acquire uses conditional writes (`If-None-Match: *`).
 * Heartbeat runs as a background interval, extending the lock every ttlMs/3.
 * Staleness detection: if a lock's S3 LastModified + ttlMs < now, it's stale
 * and will be force-acquired.
 */
export class S3Lock implements DistributedLock {
  private readonly s3: S3Client;
  private readonly lockKey: string;
  private readonly ttlMs: number;
  private readonly retryIntervalMs: number;
  private readonly maxWaitMs: number;
  private heartbeatId: number | undefined;
  private held = false;
  private releasing = false;
  private nonce: string | undefined;

  constructor(s3: S3Client, options?: LockOptions) {
    this.s3 = s3;
    this.lockKey = options?.lockKey ?? DEFAULT_LOCK_KEY;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.retryIntervalMs = options?.retryIntervalMs ??
      DEFAULT_RETRY_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  async acquire(): Promise<void> {
    const startTime = Date.now();
    this.releasing = false;

    const nonce = crypto.randomUUID();

    while (true) {
      // Check timeout on every iteration — including retries after stale lock cleanup
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxWaitMs) {
        const existing = await this.readLock();
        throw new LockTimeoutError(this.lockKey, existing, elapsed);
      }

      const info = buildLockInfo(this.ttlMs, nonce);
      const body = encodeLockInfo(info);

      // Attempt conditional write — atomic create
      const created = await this.s3.putObjectConditional(this.lockKey, body);
      if (created) {
        this.nonce = nonce;
        this.held = true;
        this.startHeartbeat();
        return;
      }

      // Lock exists — check if stale.
      // Best-effort: if we accidentally delete a fresh lock, the nonce
      // fencing in extend() ensures the old holder self-revokes.
      const existing = await this.readLock();
      if (existing) {
        const head = await this.s3.headObject(this.lockKey);
        if (head.exists && head.lastModified) {
          const lockAge = Date.now() - head.lastModified.getTime();
          if (lockAge > existing.ttlMs) {
            try {
              await this.s3.deleteObject(this.lockKey);
            } catch {
              // Another process may have already cleaned it up
            }
            continue; // Retry conditional write (timeout checked at top of loop)
          }
        }
      }

      // Wait and retry
      await new Promise((resolve) => setTimeout(resolve, this.retryIntervalMs));
    }
  }

  async release(): Promise<void> {
    // Set releasing flag BEFORE stopping heartbeat so any in-flight
    // extend() sees it and skips writing — prevents orphaned lock files.
    this.releasing = true;
    this.stopHeartbeat();

    if (!this.held) return;
    this.held = false;
    this.nonce = undefined;

    try {
      await this.s3.deleteObject(this.lockKey);
    } catch (error) {
      // Best-effort release — if S3 is unreachable, the lock expires via TTL
      const logger = getSwampLogger(["datastore", "lock"]);
      logger.warn(
        "Failed to delete lock {key} during release: {error}",
        {
          key: this.lockKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
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

  async inspect(): Promise<LockInfo | null> {
    return await this.readLock();
  }

  async forceRelease(expectedNonce: string): Promise<boolean> {
    const current = await this.readLock();
    if (!current || current.nonce !== expectedNonce) {
      return false;
    }
    await this.s3.deleteObject(this.lockKey);
    return true;
  }

  private async extend(): Promise<void> {
    if (!this.held || !this.nonce || this.releasing) return;

    // Verify we still own the lock before extending (fencing).
    // If another process acquired the lock (e.g., after we were paused
    // beyond TTL), the nonce will differ and we must self-revoke.
    const current = await this.readLock();
    if (!current || current.nonce !== this.nonce) {
      this.held = false;
      this.stopHeartbeat();
      return;
    }

    // Re-check releasing flag after the async read — release() may have
    // been called while we were reading the lock.
    if (this.releasing) return;

    const info = buildLockInfo(this.ttlMs, this.nonce);
    const body = encodeLockInfo(info);
    await this.s3.putObject(this.lockKey, body);

    // If release() was called while the write was in flight,
    // clean up the lock we just wrote so we don't orphan it.
    if (!this.held) {
      try {
        await this.s3.deleteObject(this.lockKey);
      } catch {
        // Best-effort cleanup
      }
    }
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

  private async readLock(): Promise<LockInfo | null> {
    try {
      const data = await this.s3.getObject(this.lockKey);
      return decodeLockInfo(data);
    } catch {
      return null;
    }
  }
}
