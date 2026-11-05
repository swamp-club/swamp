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
import { makeDirectories } from "./make_directories.ts";
import { syncDirectoryStrict } from "./sync_directory.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { isProcessGone } from "../runtime/process.ts";
import { currentRunProgress } from "../../domain/remote/run_progress.ts";
import {
  observeDiagnosticPhase,
  startDiagnosticPhase,
} from "../../domain/diagnostics/diagnostic_phase.ts";

// Nonces are used only to join diagnostics to a locally observed acquisition.
// A process ID alone cannot distinguish concurrent runs in one serve process.
const observedOwners = new Map<string, string>();

export const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_LOCK_PATH = ".datastore.lock";
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const JITTER_FACTOR = 0.25;

export interface FileLockOptions extends LockOptions {
  maxBackoffMs?: number;
  /**
   * judge a holder on another host by TTL alone, since on a shared mount its
   * pid means nothing here; the v3 writer lock sets it, other locks clear a
   * holder whose pid is not running
   */
  sameHostPidCheck?: boolean;
  diagnosticKind?: "auto_definition" | "file";
  /**
   * create the lock directory one level at a time, syncing each created
   * directory's parent so its entry is durable; the per-model lock sets it on a
   * durable v2 datastore
   */
  syncCreatedDirectories?: boolean;
}

/**
 * jitter scales the backoff by plus or minus 25%; the sleep is clamped to the
 * remaining wait and the cap, and the next backoff doubles up to the cap
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

export type LockFileState =
  | { kind: "absent" }
  | { kind: "readable"; info: LockInfo }
  | { kind: "unreadable"; fresh: boolean; mtimeMs: number };

/**
 * a live holder's file is briefly empty or partial around create and each
 * heartbeat rewrite, so an unreadable file counts as held until untouched for a
 * full ttl
 */
export async function readLockFileState(
  path: string,
  ttlMs: number,
): Promise<LockFileState> {
  try {
    const info: unknown = JSON.parse(await Deno.readTextFile(path));
    if (typeof info === "object" && info !== null) {
      return { kind: "readable", info: info as LockInfo };
    }
  } catch {
    // Fall through: missing, or present but unreadable
  }
  let mtimeMs: number;
  try {
    mtimeMs = (await Deno.stat(path)).mtime?.getTime() ?? 0;
  } catch {
    return { kind: "absent" };
  }
  return { kind: "unreadable", fresh: Date.now() - mtimeMs <= ttlMs, mtimeMs };
}

/**
 * on Windows, creating a file another process is deleting fails with Access
 * Denied, not AlreadyExists: contention while the file exists, one more create
 * once it is gone
 */
export async function classifyLockCreateError(
  error: unknown,
  lockPath: string,
  isWindows: boolean,
): Promise<"contention" | "retry" | "error"> {
  if (error instanceof Deno.errors.AlreadyExists) return "contention";
  if (!isWindows || !(error instanceof Deno.errors.PermissionDenied)) {
    return "error";
  }
  try {
    await Deno.stat(lockPath);
    return "contention";
  } catch (statError) {
    return statError instanceof Deno.errors.PermissionDenied
      ? "contention"
      : "retry";
  }
}

/**
 * a Windows Access Denied with no lock file left is retried once; a genuine
 * permission error fails the second create too and is thrown
 */
export async function createLockFileExclusive(
  lockPath: string,
  isWindows: boolean,
  open: (path: string, options: Deno.OpenOptions) => Promise<Deno.FsFile> =
    Deno.open,
): Promise<Deno.FsFile | null> {
  for (let attempt = 1;; attempt++) {
    try {
      return await open(lockPath, { createNew: true, write: true });
    } catch (error) {
      const outcome = await classifyLockCreateError(
        error,
        lockPath,
        isWindows,
      );
      if (outcome === "contention") return null;
      if (outcome === "retry" && attempt === 1) continue;
      throw error;
    }
  }
}

/**
 * staleness: if acquiredAt + ttlMs < now the holder is assumed crashed; the
 * heartbeat rewrites the file every ttlMs/3
 */
export class FileLock implements DistributedLock {
  private readonly lockPath: string;
  private readonly ttlMs: number;
  /**
   * readable so callers' lock policy can be asserted without timing the acquire
   * loop
   */
  readonly retryIntervalMs: number;
  readonly maxBackoffMs: number;
  private readonly maxWaitMs: number;
  private readonly sameHostPidCheck: boolean;
  private readonly diagnosticKind: "auto_definition" | "file";
  readonly syncCreatedDirectories: boolean;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private held = false;
  private releasing = false;
  private nonce: string | undefined;
  private skipping: readonly string[] | undefined;
  private rewrites: Promise<unknown> = Promise.resolve();

  constructor(basePath: string, options?: FileLockOptions) {
    const lockFile = options?.lockKey ?? DEFAULT_LOCK_PATH;
    const ns = options?.namespace;
    this.lockPath = ns
      ? join(basePath, ns, lockFile)
      : join(basePath, lockFile);
    this.ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    this.retryIntervalMs = options?.retryIntervalMs ??
      DEFAULT_RETRY_INTERVAL_MS;
    this.maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.sameHostPidCheck = options?.sameHostPidCheck ?? false;
    this.diagnosticKind = options?.diagnosticKind ?? "file";
    this.syncCreatedDirectories = options?.syncCreatedDirectories ?? false;
  }

  private async ensureLockDir(): Promise<void> {
    const dir = dirname(this.lockPath);
    if (this.syncCreatedDirectories) {
      await makeDirectories(dir, syncDirectoryStrict);
    } else {
      await ensureDir(dir);
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const details: { resource: string; holderRunId?: string } = {
      resource: this.lockPath,
    };
    const leave = currentRunProgress()?.enter("waiting_for_lock", details);
    const wait = startDiagnosticPhase("lock_wait", {
      "swamp.diagnostic.lock_kind": this.diagnosticKind,
    });
    const attempts = { retries: 0 };
    try {
      await wait.run(() => this.acquireObserved(details, attempts, signal));
      wait.attributes({
        "swamp.diagnostic.acquired": true,
        "swamp.diagnostic.retries": attempts.retries,
      });
      wait.end();
    } catch (error) {
      wait.attributes({
        "swamp.diagnostic.acquired": false,
        "swamp.diagnostic.retries": attempts.retries,
      });
      // Running out of wait is the lock's deadline, not a failure.
      if (error instanceof LockTimeoutError) wait.end("timeout");
      else wait.fail(error);
      throw error;
    } finally {
      leave?.();
    }
  }

  private async acquireObserved(
    details: { holderRunId?: string },
    attempts: { retries: number },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const startTime = Date.now();
    this.releasing = false;

    await this.ensureLockDir();

    const nonce = crypto.randomUUID();
    let contentionLogged = false;
    let retryCount = 0;
    let currentBackoff = this.retryIntervalMs;

    while (true) {
      signal?.throwIfAborted();
      // checked on every iteration, including retries after stale lock cleanup
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
      attempts.retries = retryCount;

      const holder = await this.clearStaleHolder();
      if (holder === "cleared") continue;
      details.holderRunId = holder !== "unreadable" && holder.nonce
        ? observedOwners.get(holder.nonce)
        : undefined;

      if (holder !== "unreadable" && !contentionLogged) {
        const ageMs = Date.now() - new Date(holder.acquiredAt).getTime();
        const logger = getSwampLogger(["datastore", "lock"]);
        logger
          .warn`Waiting for lock ${this.lockPath} held by ${holder.holder} (pid ${holder.pid}, acquired ${ageMs}ms ago)`;
        contentionLogged = true;
      }

      const remaining = this.maxWaitMs - (Date.now() - startTime);
      const { sleepMs, nextBackoffMs } = nextBackoffSleep(
        currentBackoff,
        Math.random(),
        remaining,
        this.maxBackoffMs,
      );
      if (sleepMs > 0) await sleepUnlessAborted(sleepMs, signal);
      currentBackoff = nextBackoffMs;
    }
  }

  async tryAcquire(): Promise<boolean> {
    this.releasing = false;
    await this.ensureLockDir();
    const nonce = crypto.randomUUID();
    if (await this.tryCreate(nonce)) return true;
    if (await this.clearStaleHolder() !== "cleared") return false;
    return await this.tryCreate(nonce);
  }

  async release(): Promise<void> {
    // set releasing before stopping the heartbeat so an in-flight extend sees
    // it and skips writing, which would orphan the lock file
    this.releasing = true;
    this.stopHeartbeat();
    // Let a rewrite already under way finish first. One that replaced the
    // file after this removed it could otherwise overwrite, and then
    // remove, a lock another process had taken in between.
    await this.rewrites;

    if (!this.held) return;
    this.held = false;
    if (this.nonce) observedOwners.delete(this.nonce);
    this.nonce = undefined;
    this.skipping = undefined;

    try {
      await Deno.remove(this.lockPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // NotFound is expected; other errors are logged so operators can
        // investigate
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
      return await observeDiagnosticPhase("lock_held", {
        "swamp.diagnostic.lock_kind": this.diagnosticKind,
      }, () => fn());
    } finally {
      await this.release();
    }
  }

  get heldNonce(): string | undefined {
    return this.held ? this.nonce : undefined;
  }

  /**
   * the file is replaced whole, never rewritten in place, since a reader
   * catching it mid-write would take the lock for absent
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
      const owner = observedOwners.get(retired);
      observedOwners.delete(retired);
      if (owner) observedOwners.set(nonce, owner);
      return retired;
    });
  }

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
   * runs after any rewrite under way so the heartbeat never compares the file
   * against a nonce rekey is changing and revokes a lock this instance still
   * holds
   */
  private rewriting<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.rewrites.then(fn, fn);
    this.rewrites = run.catch(() => {});
    return run;
  }

  private async stillOwned(): Promise<boolean> {
    if (!this.held || !this.nonce || this.releasing) return false;
    const current = await this.readLockFile();
    if (!current || current.nonce !== this.nonce) {
      observedOwners.delete(this.nonce);
      this.held = false;
      this.stopHeartbeat();
      return false;
    }
    return !this.releasing;
  }

  /**
   * replaced through a temp file and rename so a reader never sees it partly
   * written; if Windows refuses the rename onto an open file, it is rewritten
   * in place
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

  private async keptAfterWrite(): Promise<boolean> {
    if (this.held) return true;
    try {
      await Deno.remove(this.lockPath);
    } catch {
      // Best-effort cleanup
    }
    return false;
  }

  /**
   * a lock file its holder is still writing cannot name that holder, so it is
   * reported as held by an unknown holder (holderUnknown, no nonce) rather than
   * as no lock
   */
  async inspect(): Promise<LockInfo | null> {
    const state = await readLockFileState(this.lockPath, this.ttlMs);
    if (state.kind === "readable") return state.info;
    if (state.kind === "absent" || !state.fresh) return null;
    return {
      holder: "unknown (lock file is being written)",
      hostname: "unknown",
      pid: 0,
      acquiredAt: new Date(state.mtimeMs).toISOString(),
      ttlMs: this.ttlMs,
      holderUnknown: true,
    };
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

  private async tryCreate(nonce: string): Promise<boolean> {
    const content = JSON.stringify(buildLockInfo(this.ttlMs, nonce), null, 2);
    const file = await createLockFileExclusive(
      this.lockPath,
      Deno.build.os === "windows",
    );
    if (!file) return false;
    try {
      await file.write(new TextEncoder().encode(content));
    } catch (error) {
      // The file is ours and incomplete: remove it so no one waits on it.
      file.close();
      await Deno.remove(this.lockPath).catch(() => {});
      throw error;
    }
    file.close();
    this.nonce = nonce;
    this.held = true;
    const progress = currentRunProgress();
    if (progress) observedOwners.set(nonce, progress.identity.runId);
    this.startHeartbeat();
    return true;
  }

  /**
   * best-effort: if a fresh lock is deleted by accident, nonce fencing in
   * extend() makes the old holder self-revoke
   */
  private async clearStaleHolder(): Promise<
    "cleared" | "unreadable" | LockInfo
  > {
    const state = await readLockFileState(this.lockPath, this.ttlMs);
    if (state.kind === "absent") return "cleared";
    if (state.kind === "readable") {
      const existing = state.info;
      const pidDead = this.sameHostPidCheck && existing.hostname !== hostname()
        ? false
        : isProcessGone(existing.pid);
      const isStale = pidDead ||
        Date.now() - new Date(existing.acquiredAt).getTime() > existing.ttlMs;
      if (!isStale) return existing;
      try {
        await Deno.remove(this.lockPath);
      } catch {
        // Another process may have already cleaned it up
      }
      return "cleared";
    }
    // an unreadable file may be a live holder mid-write, so only one untouched
    // for a full TTL is stale: removing a fresh one lets two holders in at once
    if (!state.fresh) {
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
    return "unreadable";
  }

  private extend(): Promise<void> {
    return this.rewriting(async () => {
      // fencing: if another process took the lock (e.g. after we were paused
      // past TTL) the nonce differs and we must self-revoke
      if (!await this.stillOwned()) return;

      // Replaced whole, like every rewrite of a held lock: a reader that
      // caught the file mid-write would take the lock for absent.
      await this.replaceLockFile(
        buildLockInfo(this.ttlMs, this.nonce!, this.skipping),
      );

      // if release ran while the write was in flight, remove the lock just
      // written so it is not orphaned
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

  private async readLockFile(): Promise<LockInfo | null> {
    try {
      const content = await Deno.readTextFile(this.lockPath);
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }
}

/** resolves early on abort; the caller's next check throws the reason */
function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
