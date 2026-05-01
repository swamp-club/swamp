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
 * File-based distributed lock using advisory lockfiles.
 *
 * Uses `Deno.open({ createNew: true })` for atomic check-and-create.
 * Includes a self-contained heartbeat that extends the lock by rewriting
 * the lockfile with a fresh timestamp.
 */

import { hostname } from "node:os";
import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import type {
  DistributedLock,
  LockInfo,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../logging/logger.ts";

/**
 * Check if a process with the given PID is no longer running.
 *
 * POSIX hosts use `Deno.kill(pid, "SIGCONT")` — a no-op for live
 * processes, `NotFound` when the PID is gone. Windows shells out to
 * `tasklist`. Returns `false` (not dead) on any unexpected error so
 * TTL-based detection remains the fallback and a busted probe never
 * clobbers a valid lock.
 */
function isProcessDead(pid: number): boolean {
  if (Deno.build.os === "windows") {
    return isProcessDeadWindows(pid);
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return false; // Process exists
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return true; // Process does not exist
    }
    // PermissionDenied or other error — can't determine, fall back to TTL
    return false;
  }
}

function isProcessDeadWindows(pid: number): boolean {
  try {
    const result = new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) {
      // Non-zero exit from tasklist itself — fall back to TTL.
      return false;
    }
    const stdout = new TextDecoder().decode(result.stdout);
    // tasklist always exits 0 — alive vs dead is signalled by output content.
    // The CSV row (with /NH) always quotes the PID in the second column:
    //   "swamp.exe","1234","Console","1","123,456 K"
    // The "no match" message is localized on non-English Windows
    // (`INFO:` / `信息:` / `情報:` / `INFORMATIONEN:` …) but never
    // contains a bare-quoted PID, so substring-matching `"<pid>"` is
    // locale-agnostic.
    return !stdout.includes(`"${pid}"`);
  } catch {
    // tasklist not on PATH, or spawn failed — fall back to TTL.
    return false;
  }
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_LOCK_PATH = ".datastore.lock";

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
  private readonly retryIntervalMs: number;
  private readonly maxWaitMs: number;
  private heartbeatId: number | undefined;
  private held = false;
  private releasing = false;
  private nonce: string | undefined;

  constructor(basePath: string, options?: LockOptions) {
    const lockFile = options?.lockKey ?? DEFAULT_LOCK_PATH;
    this.lockPath = `${basePath}/${lockFile}`;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.retryIntervalMs = options?.retryIntervalMs ??
      DEFAULT_RETRY_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  async acquire(): Promise<void> {
    const startTime = Date.now();
    this.releasing = false;

    await ensureDir(dirname(this.lockPath));

    const nonce = crypto.randomUUID();

    while (true) {
      // Check timeout on every iteration — including retries after stale lock cleanup
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxWaitMs) {
        const existing = await this.readLockFile();
        throw new LockTimeoutError(
          this.lockPath,
          existing,
          elapsed,
        );
      }

      const info = buildLockInfo(this.ttlMs, nonce);
      const content = JSON.stringify(info, null, 2);

      try {
        // Atomic check-and-create
        const file = await Deno.open(this.lockPath, {
          createNew: true,
          write: true,
        });
        await file.write(new TextEncoder().encode(content));
        file.close();

        this.nonce = nonce;
        this.held = true;
        this.startHeartbeat();
        return;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
      }

      // Lock file exists — check if stale.
      // Best-effort: if we accidentally delete a fresh lock, the nonce
      // fencing in extend() ensures the old holder self-revokes.
      const existing = await this.readLockFile();
      if (existing) {
        const isStale = isProcessDead(existing.pid) ||
          Date.now() - new Date(existing.acquiredAt).getTime() > existing.ttlMs;
        if (isStale) {
          try {
            await Deno.remove(this.lockPath);
          } catch {
            // Another process may have already cleaned it up
          }
          continue; // Retry atomic create (timeout checked at top of loop)
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

  private async extend(): Promise<void> {
    if (!this.held || !this.nonce || this.releasing) return;

    // Verify we still own the lock before extending (fencing).
    // If another process acquired the lock (e.g., after we were paused
    // beyond TTL), the nonce will differ and we must self-revoke.
    const current = await this.readLockFile();
    if (!current || current.nonce !== this.nonce) {
      this.held = false;
      this.stopHeartbeat();
      return;
    }

    // Re-check releasing flag after the async read — release() may have
    // been called while we were reading the lock file.
    if (this.releasing) return;

    const info = buildLockInfo(this.ttlMs, this.nonce);
    const content = JSON.stringify(info, null, 2);
    await Deno.writeTextFile(this.lockPath, content);

    // If release() was called while the write was in flight,
    // clean up the lock we just wrote so we don't orphan it.
    if (!this.held) {
      try {
        await Deno.remove(this.lockPath);
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

  private async readLockFile(): Promise<LockInfo | null> {
    try {
      const content = await Deno.readTextFile(this.lockPath);
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }
}
