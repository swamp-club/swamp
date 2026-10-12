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
 * The Phase 3 single-writer lock of a filesystem v3 datastore
 * (swamp-club#3279). One process at a time may write a v3 datastore: the
 * commit log has no lease or fence until Phase 4, so two writers on a shared
 * mount could not be told apart. The lock is a `FileLock` at
 * `<datastore>/_control/writer.lock`, with its heartbeat, stale-lock
 * takeover and `swamp datastore lock status|release` handling.
 *
 * It is process-scoped. The first writer in a process takes it and the last
 * one to finish releases it: serve holds it from start-up to shutdown, a CLI
 * write command for as long as it runs. Roots never take it themselves, so a
 * long workflow run does not queue every other root in serve behind it.
 * Read-only commands never take it.
 *
 * A holder on another host is treated as alive until its TTL expires, never
 * judged by its pid. A holder paused past its TTL is not fenced: its later
 * writes are not refused. The Phase 4 writer lease at `_control/writer`,
 * which carries the fence every commit names, replaces it.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { UserError } from "../../domain/errors.ts";
import { FileLock } from "../persistence/file_lock.ts";

/** The lock's key under the datastore root. */
export const V3_WRITER_LOCK_KEY = join("_control", "writer.lock");

/** Error code for a second process refused as a v3 datastore's writer. */
export const V3_WRITER_BUSY_CODE = "datastore_v3_writer_busy";

/** Thrown when another process holds a v3 datastore's writer lock. */
export class V3WriterBusyError extends UserError {
  constructor(datastorePath: string, cause: LockTimeoutError) {
    const holder = cause.holder;
    super(
      `Another swamp process is writing the v3 datastore at ${datastorePath}` +
        (holder ? ` (${holder.holder}, pid ${holder.pid})` : "") +
        ". A v3 datastore takes one writer at a time. Wait for it to finish, " +
        "or, if it is swamp serve, run this command through serve. If that " +
        "process is gone, `swamp datastore lock status` shows the lock and " +
        "`swamp datastore lock release --force` clears it. Nothing was changed.",
      V3_WRITER_BUSY_CODE,
    );
    this.name = "V3WriterBusyError";
    this.cause = cause;
  }
}

interface Held {
  readonly lock: FileLock;
  refs: number;
  /** The acquire in flight, which later callers in the process share. */
  acquiring?: Promise<void>;
}

const held = new Map<string, Held>();

/** Options for {@link acquireV3WriterLock}. */
export interface AcquireV3WriterLockOptions {
  /** How long to wait for another process to finish (`SWAMP_LOCK_TIMEOUT_MS`). */
  readonly maxWaitMs?: number;
  /** The lock's TTL; its heartbeat renews it. */
  readonly ttlMs?: number;
}

/**
 * Takes the writer lock of the v3 datastore at `datastorePath` for this
 * process, or joins the hold it already has. Resolves with the release for
 * this caller; the lock is released when every caller has released.
 *
 * @throws V3WriterBusyError when another process holds it past the wait
 */
export async function acquireV3WriterLock(
  datastorePath: string,
  options: AcquireV3WriterLockOptions = {},
): Promise<() => Promise<void>> {
  const key = resolve(datastorePath);
  let entry = held.get(key);
  if (entry === undefined) {
    const lock = new FileLock(key, {
      lockKey: V3_WRITER_LOCK_KEY,
      // Two hosts on a shared mount must never both write commits.db.
      sameHostPidCheck: true,
      ...(options.maxWaitMs !== undefined
        ? { maxWaitMs: options.maxWaitMs }
        : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
    const created: Held = { lock, refs: 0 };
    created.acquiring = lock.acquire().catch((error) => {
      held.delete(key);
      throw error instanceof LockTimeoutError
        ? new V3WriterBusyError(datastorePath, error)
        : error;
    });
    held.set(key, created);
    entry = created;
  }
  entry.refs++;
  try {
    await entry.acquiring;
  } catch (error) {
    entry.refs--;
    throw error;
  }
  const holding = entry;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holding.refs--;
    if (holding.refs > 0) return;
    if (held.get(key) === holding) held.delete(key);
    await holding.lock.release();
  };
}

/** Whether this process holds the writer lock of the datastore at `datastorePath`. */
export function holdsV3WriterLock(datastorePath: string): boolean {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0;
}

/**
 * A handle on the writer lock of the v3 datastore at `datastorePath` for
 * inspecting or force-releasing it (`swamp datastore lock status|release`).
 * It never acquires.
 */
export function v3WriterLockHandle(datastorePath: string): FileLock {
  return new FileLock(resolve(datastorePath), {
    lockKey: V3_WRITER_LOCK_KEY,
    sameHostPidCheck: true,
  });
}
