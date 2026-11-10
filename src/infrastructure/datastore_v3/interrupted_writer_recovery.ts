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
 * writer.json is written before the first file and removed at teardown; one
 * outliving its process triggers a replay and removal of files no commit owns;
 * it goes last, so a failed recovery reruns
 */

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { getSwampLogger } from "../logging/logger.ts";
import { removeStaleOutputSummaries } from "../persistence/output_summary_index.ts";
import { removeStaleRunIndexes } from "../persistence/workflow_run_index.ts";
import {
  type DurableWriteBatchOptions,
  writeFileDurably,
} from "./atomic_stream_write.ts";
import {
  judgeRecordedProcess,
  type LocalProcess,
  parseProcessIdentity,
  type ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { v3CacheRoot, type V3Datastore } from "./v3_datastore.ts";
import {
  tryAcquireV3WriterLock,
  v3WriterLeaseHolder,
} from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3"]);

let recoveryProgress: ((message: string) => void) | undefined;

/**
 * says a recovery is running as it starts: on a populated checkout it takes
 * seconds and a silent command looks hung; the CLI writes to stderr so --json
 * stdout stays clean
 */
export function setV3RecoveryProgress(
  write: ((message: string) => void) | undefined,
): void {
  recoveryProgress = write;
}

export const WRITER_MARKER_FILE = "writer.json";

/**
 * Slack taken off a marker's start, so a filesystem that keeps
 * coarse mtimes, or a server clock behind this host's, cannot date a file
 * the writer wrote before the writer started.
 */
const MARKER_SLACK_MS = 2_000;

export function recoverySince(at: number): number {
  return Math.floor(at / 1000) * 1000 - MARKER_SLACK_MS;
}

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
   * the writer's process identity; undefined in a marker from an older swamp,
   * which is left to the lease
   */
  readonly process?: ProcessIdentity;
  readonly since: number;
}

const PROCESS_INSTANCE = crypto.randomUUID();

export function writerMarkerPath(repoDir: string): string {
  return join(readModelStateDir(repoDir), WRITER_MARKER_FILE);
}

export interface WriteWriterMarkerOptions
  extends Pick<DurableWriteBatchOptions, "syncFile" | "syncDirectory"> {
  readonly signal?: AbortSignal;
}

/**
 * the marker is durable when this returns: a power cut after the writer's first
 * file must not leave it empty, or missing with its directory
 */
export async function writeWriterMarker(
  repoDir: string,
  options: WriteWriterMarkerOptions = {},
): Promise<void> {
  const local = await localProcess();
  const marker: WriterMarker = {
    hostname: Deno.hostname(),
    pid: local.pid,
    instance: PROCESS_INSTANCE,
    process: local.identity,
    since: recoverySince(Date.now()),
  };
  await writeFileDurably(
    writerMarkerPath(repoDir),
    new TextEncoder().encode(JSON.stringify(marker)),
    options.signal ?? new AbortController().signal,
    options,
  );
}

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
 * an unreadable file (empty, truncated, hand-edited, wrong shape) names no
 * process and is dated by its modification time, or 0 when the filesystem keeps
 * none
 */
export type WriterMarkerFile =
  | { readonly kind: "absent" }
  | { readonly kind: "marker"; readonly marker: WriterMarker }
  | { readonly kind: "unreadable"; readonly since: number };

export async function readWriterMarkerFile(
  repoDir: string,
): Promise<WriterMarkerFile> {
  const path = writerMarkerPath(repoDir);
  let text: string;
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    throw error;
  }
  const marker = parseWriterMarker(text);
  if (marker !== undefined) return { kind: "marker", marker };
  return {
    kind: "unreadable",
    since: info.mtime === null ? 0 : recoverySince(info.mtime.getTime()),
  };
}

/**
 * a marker that is not a marker is logged and read as none: it names no process
 * to judge
 */
export async function readWriterMarker(
  repoDir: string,
): Promise<WriterMarker | undefined> {
  const file = await readWriterMarkerFile(repoDir);
  if (file.kind === "unreadable") {
    logger
      .warn`Ignoring the unreadable v3 writer marker at ${
      writerMarkerPath(repoDir)
    }`;
  }
  return file.kind === "marker" ? file.marker : undefined;
}

function parseWriterMarker(text: string): WriterMarker | undefined {
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
    // Not JSON.
  }
  return undefined;
}

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
 * recovers when the marker names a gone writer, or one this process cannot
 * judge whose lease no live process holds; an unreadable marker is unjudgeable,
 * dated by its file's modification time
 */
export async function recoverInterruptedWriter(
  handle: V3Datastore,
  repoDir: string,
  options: RecoverInterruptedWriterOptions,
): Promise<string[] | undefined> {
  const file = await readWriterMarkerFile(repoDir);
  if (file.kind === "absent") return undefined;
  const state = file.kind === "marker"
    ? writerMarkerState(file.marker, await localProcess())
    : "unknown";
  if (state === "own" || state === "live") return undefined;
  // A writer writes only while it holds the lease: one this process holds
  // now has no other writer.
  if (options.holdsWriterLock) {
    return await recover(handle, repoDir, file, state, options.signal);
  }
  if (await lockHeldByLiveProcess(handle.datastorePath)) {
    if (state === "unknown") {
      logger
        .debug`Not recovering ${repoDir} yet: ${
        describeMarker(file)
      }, which this process cannot judge, and the writer lease is held`;
    }
    return undefined;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    // through the handle, which records the fence in the outbox's chain too
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
    if (!sameMarkerFile(await readWriterMarkerFile(repoDir), file)) {
      return undefined;
    }
    return await recover(handle, repoDir, file, state, options.signal);
  } finally {
    await release();
  }
}

/**
 * a follower's own predecessor, judged gone on this host, needs no lease: only
 * serve writes a claimed checkout and that writer cannot return
 */
export async function recoverOwnPredecessor(
  handle: V3Datastore,
  repoDir: string,
  options: { readonly local?: LocalProcess; readonly signal?: AbortSignal } =
    {},
): Promise<string[] | undefined> {
  const file = await readWriterMarkerFile(repoDir);
  if (file.kind !== "marker") return undefined;
  const local = options.local ?? await localProcess();
  if (writerMarkerState(file.marker, local) !== "interrupted") {
    return undefined;
  }
  return await recover(handle, repoDir, file, "interrupted", options.signal);
}

function sameMarkerFile(
  current: WriterMarkerFile,
  read: WriterMarkerFile & { readonly kind: "marker" | "unreadable" },
): boolean {
  if (current.kind !== read.kind) return false;
  if (current.kind === "marker" && read.kind === "marker") {
    // A restarted container reuses hostname and pid, and a second's
    // `since`: only the token tells its writer from the one read.
    return current.marker.hostname === read.marker.hostname &&
      current.marker.pid === read.marker.pid &&
      current.marker.instance === read.marker.instance &&
      current.marker.since === read.marker.since;
  }
  return current.kind === "unreadable" && read.kind === "unreadable" &&
    current.since === read.since;
}

function describeMarker(
  file: WriterMarkerFile & { readonly kind: "marker" | "unreadable" },
): string {
  return file.kind === "marker"
    ? `its v3 writer marker names ${file.marker.hostname} (pid ${file.marker.pid})`
    : "its v3 writer marker is unreadable and names no process";
}

export const RECOVERY_LOCK_FILE = "recovery.lock";

/**
 * one recovery of a checkout at a time, whatever lease its process holds: a
 * follower's boot recovery holds none; taken before the read model's lock
 */
async function withCheckoutRecoveryLock<T>(
  repoDir: string,
  body: () => Promise<T>,
): Promise<T> {
  const dir = readModelStateDir(repoDir);
  await ensureDir(dir);
  const lock = await Deno.open(join(dir, RECOVERY_LOCK_FILE), {
    read: true,
    write: true,
    create: true,
  });
  try {
    await lock.lock(true);
    return await body();
  } finally {
    lock.close();
  }
}

async function recover(
  handle: V3Datastore,
  repoDir: string,
  file: WriterMarkerFile & { readonly kind: "marker" | "unreadable" },
  state: "interrupted" | "unknown",
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  return await withCheckoutRecoveryLock(repoDir, async () => {
    // another process may have recovered it while this one waited
    if (!sameMarkerFile(await readWriterMarkerFile(repoDir), file)) {
      return undefined;
    }
    return await recoverLocked(handle, repoDir, file, state, signal);
  });
}

async function recoverLocked(
  handle: V3Datastore,
  repoDir: string,
  file: WriterMarkerFile & { readonly kind: "marker" | "unreadable" },
  state: "interrupted" | "unknown",
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (state === "unknown") {
    // Its process could not be judged from here (another host, pid
    // namespace or boot, or no process named): the lease alone says it no
    // longer writes.
    logger
      .info`Recovering ${repoDir}: ${
      describeMarker(file)
    }, which this process cannot judge, and the writer lease is no longer that writer's`;
  }
  const since = file.kind === "marker" ? file.marker.since : file.since;
  recoveryProgress?.(
    "Recovering work an interrupted command left in this checkout…",
  );
  let removed: string[];
  try {
    removed = await handle.recoverInterruptedWriter(since, signal, {
      entry: "interrupted_writer",
    });
    await restoreQueuedStepStarts(handle, repoDir);
  } finally {
    // The replay may have rewritten run records before any failure.
    await removeStaleRunIndexes(repoDir);
    await removeStaleOutputSummaries(repoDir);
  }
  // the writer is named in the template's text, where an interpolated string
  // would be quoted
  const pid = file.kind === "marker" ? file.marker.pid : undefined;
  if (removed.length > 0 && pid !== undefined) {
    logger
      .warn`Recovered ${repoDir} after swamp process ${pid} ended without finishing its v3 datastore writes; uncommitted files removed: ${removed.length}`;
  } else if (removed.length > 0) {
    logger
      .warn`Recovered ${repoDir} after a swamp process ended without finishing its v3 datastore writes; uncommitted files removed: ${removed.length}`;
  } else if (pid !== undefined) {
    logger
      .debug`Recovered ${repoDir} after swamp process ${pid} ended without tearing down; nothing was uncommitted`;
  } else {
    logger
      .debug`Recovered ${repoDir} after a swamp process ended without tearing down; nothing was uncommitted`;
  }
  await Deno.remove(writerMarkerPath(repoDir));
  return removed;
}

/** the replay swept starts still queued offline; put back, never one given up */
async function restoreQueuedStepStarts(
  handle: Partial<Pick<V3Datastore, "outbox">>,
  repoDir: string,
): Promise<void> {
  if (handle.outbox === undefined) return;
  const { entries } = await handle.outbox.entries();
  for (const entry of entries) {
    if (entry.state !== "offline" || entry.abandonedAt !== undefined) continue;
    for (const op of entry.commit.ops) {
      if (op.kind !== "put" || op.intent.kind !== "run-start.save") continue;
      if (!("inline" in op.content)) continue;
      const path = join(
        v3CacheRoot(repoDir, entry.commit.namespace),
        ...op.key.toString().split("/"),
      );
      try {
        await Deno.lstat(path);
        continue;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await ensureDir(dirname(path));
      const binary = atob(op.content.inline);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await Deno.writeFile(path, bytes);
    }
  }
}

/**
 * true for a holder judged alive whatever its TTL, so the try-acquire that
 * would take over a stale-looking lease never runs against it; otherwise true
 * while the lease keeps writers out by TTL and skew
 */
async function lockHeldByLiveProcess(datastorePath: string): Promise<boolean> {
  const holder = await v3WriterLeaseHolder(datastorePath);
  if (holder === null || holder.state === "released") return false;
  return holder.process === "alive" || holder.state === "held";
}

function isOwn(marker: WriterMarker): boolean {
  return marker.instance === PROCESS_INSTANCE;
}
