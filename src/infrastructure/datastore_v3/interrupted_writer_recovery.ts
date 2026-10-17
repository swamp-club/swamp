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
 * Recovers a checkout whose v3 writer ended without tearing down
 * (swamp-club#3299): the Phase 3 answer to an interrupted run.
 *
 * A writer's repositories write the checkout's files before the unit that
 * stages them commits. A SIGKILL, a crash or a second signal's forced exit
 * ends the process with units that never commit, so the checkout keeps files
 * and catalog rows no commit names, and no other checkout ever sees them.
 *
 * - **Marker.** The first writing context of a process writes `writer.json`
 *   in the checkout's read-model state directory; teardown removes it once
 *   every unit has ended. A marker that outlives its process means the
 *   process ended without teardown.
 * - **Liveness.** A marker names its process by a token, its pid and its
 *   process identity (swamp-club#3564), since a restarted container reuses
 *   both hostname and pid, and a container sharing the hostname has pids of
 *   its own. A marker written on this kernel is interrupted once its process
 *   is gone (absent, a zombie, or started at another time), or is this
 *   process's pid under another token, whatever the writer lock's TTL says,
 *   so a live writer whose heartbeat stalled is never mistaken for a dead
 *   one. A marker this process cannot judge (another host, namespace or
 *   boot, or a swamp from before identities) is left to the lease: its
 *   writer writes only while it holds the lease, so it is interrupted once
 *   the lease is free, expired by its TTL and skew, or held by this process.
 * - **Recovery** holds the writer lock: a writing command recovers under the
 *   lock it has just taken, a read-only command only when it can take the
 *   lock without waiting. The read model then empties the catalog, replays
 *   every commit and removes the files no commit owns that the dead writer
 *   may have written. The marker is removed last, so a recovery that fails
 *   midway runs again in full on the next command.
 *
 * The commit outbox (swamp-club#3490, `commit_outbox_recovery.ts`) lands a
 * commit that was being appended when the writer died before this runs, so
 * its files are kept; this recovery removes what is left.
 *
 * @module
 */

import { dirname, join } from "@std/path";
import { getSwampLogger } from "../logging/logger.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import {
  judgeRecordedProcess,
  type LocalProcess,
  parseProcessIdentity,
  type ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import type { V3Datastore } from "./v3_datastore.ts";
import {
  tryAcquireV3WriterLock,
  v3WriterLeaseHolder,
} from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/** The marker's file in the checkout's read-model state directory. */
export const WRITER_MARKER_FILE = "writer.json";

/**
 * Slack taken off a marker's start, so a filesystem that keeps
 * coarse mtimes, or a server clock behind this host's, cannot date a file
 * the writer wrote before the writer started.
 */
const MARKER_SLACK_MS = 2_000;

/**
 * The time a recovery sweeps from for writes made at or after `at` (epoch
 * milliseconds): the second it falls in, less {@link MARKER_SLACK_MS}.
 */
export function recoverySince(at: number): number {
  return Math.floor(at / 1000) * 1000 - MARKER_SLACK_MS;
}

/** Which process last wrote a checkout, and since when. */
export interface WriterMarker {
  readonly hostname: string;
  readonly pid: number;
  /**
   * This process's own token. A restarted container reuses its hostname and
   * often its pid, so only the token tells a process from its predecessor.
   * Undefined in a marker that names none, which is never this process's.
   */
  readonly instance?: string;
  /**
   * The writer's process identity. Undefined in a marker from a swamp before
   * swamp-club#3564, which is left to the lease.
   */
  readonly process?: ProcessIdentity;
  /** Epoch milliseconds, floored to the second less a slack. */
  readonly since: number;
}

/** This process's token in the markers it writes. */
const PROCESS_INSTANCE = crypto.randomUUID();

/** The marker's path for the checkout at `repoDir`. */
export function writerMarkerPath(repoDir: string): string {
  return join(readModelStateDir(repoDir), WRITER_MARKER_FILE);
}

/** Records that this process writes the checkout at `repoDir` from now on. */
export async function writeWriterMarker(repoDir: string): Promise<void> {
  const local = await localProcess();
  const marker: WriterMarker = {
    hostname: Deno.hostname(),
    pid: local.pid,
    instance: PROCESS_INSTANCE,
    process: local.identity,
    since: recoverySince(Date.now()),
  };
  const path = writerMarkerPath(repoDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(marker));
}

/** Removes the checkout's marker when this process wrote it. */
export async function removeOwnWriterMarker(repoDir: string): Promise<void> {
  const marker = await readWriterMarker(repoDir);
  if (marker === undefined || !isOwn(marker)) return;
  try {
    await Deno.remove(writerMarkerPath(repoDir));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * The checkout's marker, or undefined when there is none. A marker that is
 * not a marker (hand-edited, truncated) is logged and read as none: it names
 * no process to judge.
 */
export async function readWriterMarker(
  repoDir: string,
): Promise<WriterMarker | undefined> {
  const path = writerMarkerPath(repoDir);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (
      typeof value?.hostname === "string" &&
      Number.isSafeInteger(value?.pid) && value.pid > 0 &&
      Number.isSafeInteger(value?.since) &&
      (value.instance === undefined || typeof value.instance === "string")
    ) {
      const process = parseProcessIdentity(value.process);
      return {
        hostname: value.hostname,
        pid: value.pid,
        ...(value.instance !== undefined ? { instance: value.instance } : {}),
        ...(process !== undefined ? { process } : {}),
        since: value.since,
      };
    }
  } catch {
    // Not JSON: reported below.
  }
  logger.warn`Ignoring the unreadable v3 writer marker at ${path}`;
  return undefined;
}

/**
 * What a marker says about its writer: this process (`own`), a live process
 * on this kernel (`live`), one on this kernel that is gone (`interrupted`),
 * or one this process cannot judge (`unknown`), which the lease decides.
 */
export function writerMarkerState(
  marker: WriterMarker,
  local: LocalProcess,
): "own" | "live" | "interrupted" | "unknown" {
  if (isOwn(marker)) return "own";
  // Not this process's token: a marker with this pid is a predecessor's.
  const verdict = judgeRecordedProcess(
    {
      pid: marker.pid,
      ...(marker.process !== undefined ? { process: marker.process } : {}),
      notThisProcess: true,
    },
    local,
  );
  return verdict === "gone"
    ? "interrupted"
    : verdict === "alive"
    ? "live"
    : "unknown";
}

/** Options for {@link recoverInterruptedWriter}. */
export interface RecoverInterruptedWriterOptions {
  /**
   * This process holds the datastore's writer lock (a writing command).
   * Otherwise the recovery takes the lock without waiting, and skips when
   * it cannot.
   */
  readonly holdsWriterLock: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Recovers the checkout at `repoDir` when its marker names a writer that is
 * gone, or one this process cannot judge whose lease no live process holds.
 * Resolves with the record keys of the files removed, or undefined when
 * nothing was recovered.
 */
export async function recoverInterruptedWriter(
  handle: V3Datastore,
  repoDir: string,
  options: RecoverInterruptedWriterOptions,
): Promise<string[] | undefined> {
  const marker = await readWriterMarker(repoDir);
  if (marker === undefined) return undefined;
  const state = writerMarkerState(marker, await localProcess());
  if (state === "own" || state === "live") return undefined;
  // A writer writes only while it holds the lease: one this process holds
  // now has no other writer.
  if (options.holdsWriterLock) {
    return await recover(handle, repoDir, marker, state, options.signal);
  }
  if (await lockHeldByLiveProcess(handle.datastorePath)) {
    if (state === "unknown") {
      logger
        .debug`Not recovering ${repoDir} yet: its v3 writer marker names ${marker.hostname} (pid ${marker.pid}), which this process cannot judge, and the writer lease is held`;
    }
    return undefined;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    // Through the handle, which records the fence in the outbox's chain too
    // (swamp-club#3490).
    release = await tryAcquireV3WriterLock(handle.datastorePath, {
      fenceStore: handle,
    });
  } catch (error) {
    logger
      .debug`Not recovering ${repoDir}: the v3 writer lock could not be taken: ${error}`;
    return undefined;
  }
  if (release === undefined) return undefined;
  try {
    // Another command may have recovered while this one waited for nothing.
    const current = await readWriterMarker(repoDir);
    if (
      current === undefined || current.pid !== marker.pid ||
      current.since !== marker.since
    ) {
      return undefined;
    }
    return await recover(handle, repoDir, marker, state, options.signal);
  } finally {
    await release();
  }
}

async function recover(
  handle: V3Datastore,
  repoDir: string,
  marker: WriterMarker,
  state: "interrupted" | "unknown",
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (state === "unknown") {
    // Its process could not be judged from here (another host, pid
    // namespace or boot): the lease alone says it no longer writes.
    logger
      .info`Recovering ${repoDir}: its v3 writer marker names ${marker.hostname} (pid ${marker.pid}), which this process cannot judge, and the writer lease is no longer that writer's`;
  }
  const removed = await handle.recoverInterruptedWriter(marker.since, signal);
  if (removed.length > 0) {
    const files = removed.length === 1 ? "file" : "files";
    logger
      .warn`Recovered ${repoDir} after swamp process ${marker.pid} ended without finishing its v3 datastore writes: removed ${removed.length} uncommitted ${files}`;
  } else {
    logger
      .debug`Recovered ${repoDir} after swamp process ${marker.pid} ended without tearing down; nothing was uncommitted`;
  }
  await Deno.remove(writerMarkerPath(repoDir));
  return removed;
}

/**
 * Whether the writer lock is held by a process that may still be writing:
 * one judged alive, whatever its TTL, so the try-acquire, which would take
 * over a stale-looking lease, never runs against it; otherwise while the
 * lease keeps writers out by its TTL and skew (swamp-club#3564).
 */
async function lockHeldByLiveProcess(datastorePath: string): Promise<boolean> {
  const holder = await v3WriterLeaseHolder(datastorePath);
  if (holder === null || holder.state === "released") return false;
  return holder.process === "alive" || holder.state === "held";
}

function isOwn(marker: WriterMarker): boolean {
  return marker.instance === PROCESS_INSTANCE;
}
