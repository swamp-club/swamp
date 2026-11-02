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

import { join, resolve } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { chunkEnd } from "./ndjson_chunks.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { inTimeSlices } from "./scan_permits.ts";

export const RUNS_INDEX_FILENAME = ".runs-index.json";
export const RUNS_INDEX_LOCK_FILENAME = ".runs-index.lock";

// Bump when WorkflowRunIndexEntry gains or removes fields so that
// old on-disk indices are rebuilt instead of serving stale data.
export const INDEX_SCHEMA_VERSION = 5;

/** the current header is the first line; a legacy index is one line of any length */
const HEADER_MAX_BYTES = 4096;

/** below this an index is not worth compacting, whatever it last compacted to */
export const INDEX_COMPACTION_FLOOR_BYTES = 256 * 1024;

const RUN_FILE_PREFIX = "workflow-run-";
const RUN_FILE_SUFFIX = ".yaml";

export interface WorkflowRunIndexEntry {
  status: string;
  workflowId: string;
  workflowName: string;
  startedAt?: string;
  completedAt?: string;
  tags: Record<string, string>;
  inputs: Record<string, unknown>;
  instanceId?: string;
  triggerSource?: string;
  failedStep?: string;
  failureReason?: string;
  stepProgress?: { completed: number; total: number };
  awaitingResume?: boolean;
  // read back leniently: the index file is not trusted, so a malformed value is
  // dropped
  parentRun?: unknown;
  waitingOnRun?: unknown;
  waitsOnlyOnNestedRuns?: boolean;
  inputsOmitted?: unknown;
  /**
   * stat of the record file the entry was built from, so a replaced record is
   * told apart without reading it; an entry without a valid one is checked by
   * reading its record
   */
  record?: RecordFingerprint;
}

/**
 * an atomic write replaces the inode, and utime can set mtime back but not
 * ctime; a platform that reports neither (Windows) is left with mtime and size
 */
export interface RecordFingerprint {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  ino?: number;
}

export type WorkflowRunIndex = Record<string, WorkflowRunIndexEntry>;

export function getIndexPath(workflowRunsDir: string): string {
  return join(workflowRunsDir, RUNS_INDEX_FILENAME);
}

export interface ReadIndexResult {
  entries: WorkflowRunIndex;
  version: number;
  /**
   * a line did not parse, so an append was torn and an entry may be older than
   * its record
   */
  damaged?: boolean;
}

/**
 * the index is a header line then one line per change, the last line for a run
 * winning; a removal line drops the run
 */
export type RunIndexLine =
  | { id: string; entry: WorkflowRunIndexEntry }
  | { id: string; removed: true };

export interface RunIndexHeader {
  version: number;
  /** bytes of entry lines the last compacted write produced */
  compactedBytes: number;
}

/**
 * a v3 recovery that restores a committed run record leaves the index entry the
 * dropped save wrote, and the index repairs itself only when its run count
 * differs, so remove it
 */
export async function removeRunIndexes(
  workflowRunsRoot: string,
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(workflowRunsRoot));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory) {
      await deleteRunIndex(join(workflowRunsRoot, entry.name));
    }
  }
}

/**
 * each index is rebuilt from the records on its next read; one that cannot be
 * removed is warned about, never failing the caller
 */
export async function removeStaleRunIndexes(repoDir: string): Promise<void> {
  try {
    await removeRunIndexes(swampPath(repoDir, SWAMP_SUBDIRS.workflowRuns));
  } catch (error) {
    getSwampLogger(["workflow-runs", "index"])
      .warn`Removing the workflow run indexes of ${repoDir} failed; history search may show a run's dropped status until its index is rebuilt: ${error}`;
  }
}

/**
 * the index is trusted while its run count matches the records, so a run
 * another writer changed would keep its indexed status; dropping its entry
 * makes the counts differ and the next read repairs it
 */
export async function dropRunIndexEntries(
  repoDir: string,
  keys: readonly string[],
): Promise<void> {
  const runsByWorkflow = new Map<string, Set<string>>();
  for (const key of keys) {
    const segments = key.split("/");
    if (segments.length !== 3 || segments[0] !== SWAMP_SUBDIRS.workflowRuns) {
      continue;
    }
    const [, workflowId, name] = segments;
    if (
      workflowId === "" || workflowId === "." || workflowId === ".." ||
      !name.startsWith(RUN_FILE_PREFIX) || !name.endsWith(RUN_FILE_SUFFIX)
    ) continue;
    const runId = name.slice(
      RUN_FILE_PREFIX.length,
      name.length - RUN_FILE_SUFFIX.length,
    );
    let runIds = runsByWorkflow.get(workflowId);
    if (runIds === undefined) {
      runsByWorkflow.set(workflowId, runIds = new Set());
    }
    runIds.add(runId);
  }
  const root = swampPath(repoDir, SWAMP_SUBDIRS.workflowRuns);
  for (const [workflowId, runIds] of runsByWorkflow) {
    const indexDir = join(root, workflowId);
    // queuing would make the directory and lock file of a workflow with no index
    if (await readRunIndexHeader(indexDir) === null) continue;
    await withIndexQueue(indexDir, async () => {
      const appended = await appendRunIndexLines(
        indexDir,
        [...runIds].map((id) => ({ id, removed: true })),
        { create: false },
      );
      if (appended.kind === "appended" && needsCompaction(appended)) {
        await compactRunIndex(indexDir);
      }
    });
  }
}

const utf8 = new TextEncoder();

function headerOf(line: string): RunIndexHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { version: 0, compactedBytes: 0 };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { version: 0, compactedBytes: 0 };
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.version !== INDEX_SCHEMA_VERSION) {
    return { version: 0, compactedBytes: 0 };
  }
  const compacted = fields.compactedBytes;
  return {
    version: INDEX_SCHEMA_VERSION,
    compactedBytes: typeof compacted === "number" && compacted >= 0
      ? compacted
      : 0,
  };
}

function headerInBytes(content: Uint8Array): {
  header: RunIndexHeader;
  bodyStart: number;
} {
  const newline = content.subarray(0, HEADER_MAX_BYTES).indexOf(10);
  if (newline === -1) {
    return { header: { version: 0, compactedBytes: 0 }, bodyStart: 0 };
  }
  const line = new TextDecoder().decode(content.subarray(0, newline));
  return { header: headerOf(line), bodyStart: newline + 1 };
}

/**
 * anything but a v5 header reads as version 0 without reading further, so a
 * legacy index of any size is never decoded
 */
export async function readRunIndexHeader(
  workflowRunsDir: string,
): Promise<RunIndexHeader | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(getIndexPath(workflowRunsDir), { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  try {
    const buffer = new Uint8Array(HEADER_MAX_BYTES);
    let filled = 0;
    while (filled < buffer.length) {
      const read = await file.read(buffer.subarray(filled));
      if (read === null) break;
      filled += read;
    }
    return headerInBytes(buffer.subarray(0, filled)).header;
  } finally {
    file.close();
  }
}

function setEntry(
  entries: WorkflowRunIndex,
  id: string,
  entry: WorkflowRunIndexEntry,
): void {
  // a run id is read from an untrusted file, so __proto__ stays an own key
  Object.defineProperty(entries, id, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** the index is not trusted: a line that is not a change marks it damaged */
function applyLine(entries: WorkflowRunIndex, line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const { id, entry, removed } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return false;
  if (removed === true) {
    delete entries[id];
    return true;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  setEntry(entries, id, entry as WorkflowRunIndexEntry);
  return true;
}

/**
 * decoded a chunk at a time and parsed in slices of the event loop, so a large
 * index neither holds up other requests nor hits V8's string limit
 */
export async function readRunIndex(
  workflowRunsDir: string,
  signal?: AbortSignal,
): Promise<ReadIndexResult | null> {
  let content: Uint8Array;
  try {
    const peeked = await readRunIndexHeader(workflowRunsDir);
    if (peeked && peeked.version !== INDEX_SCHEMA_VERSION) {
      return { entries: {}, version: peeked.version };
    }
    content = await Deno.readFile(getIndexPath(workflowRunsDir));
  } catch {
    return null;
  }
  // The file may have been replaced since its header was read.
  const { header, bodyStart } = headerInBytes(content);
  if (header.version !== INDEX_SCHEMA_VERSION) {
    return { entries: {}, version: header.version };
  }
  const entries: WorkflowRunIndex = {};
  const decoder = new TextDecoder();
  let damaged = false;
  let decodedTo = bodyStart;
  let chunk: string[] = [];
  let next = 0;
  const more = () => next < chunk.length || decodedTo < content.length;
  const parseNext = () => {
    if (next === chunk.length) {
      const end = chunkEnd(content, decodedTo);
      try {
        chunk = decoder.decode(content.subarray(decodedTo, end)).split("\n");
      } catch {
        chunk = [];
        damaged = true;
      }
      next = 0;
      decodedTo = end;
      return;
    }
    const line = chunk[next++];
    if (line.length === 0) return;
    if (!applyLine(entries, line)) damaged = true;
  };
  await inTimeSlices(
    more,
    (until) => {
      do {
        parseNext();
      } while (more() && performance.now() < until);
    },
    signal,
  );
  return damaged
    ? { entries, version: INDEX_SCHEMA_VERSION, damaged }
    : { entries, version: INDEX_SCHEMA_VERSION };
}

function headerLine(compactedBytes: number): string {
  return `${
    JSON.stringify({ version: INDEX_SCHEMA_VERSION, compactedBytes })
  }\n`;
}

async function linesText(lines: readonly RunIndexLine[]): Promise<string> {
  let text = "";
  let next = 0;
  await inTimeSlices(
    () => next < lines.length,
    (until) => {
      do {
        text += `${JSON.stringify(lines[next++])}\n`;
      } while (next < lines.length && performance.now() < until);
    },
  );
  return text;
}

/** the compacted form: one line per run, replacing the file whole */
export async function writeRunIndex(
  workflowRunsDir: string,
  index: WorkflowRunIndex,
): Promise<void> {
  const body = await linesText(
    Object.entries(index).map(([id, entry]) => ({ id, entry })),
  );
  await atomicWriteTextFile(
    getIndexPath(workflowRunsDir),
    headerLine(utf8.encode(body).length) + body,
  );
}

async function endsWithNewline(path: string): Promise<boolean> {
  const file = await Deno.open(path, { read: true });
  try {
    if ((await file.stat()).size === 0) return true;
    await file.seek(-1, Deno.SeekMode.End);
    const last = new Uint8Array(1);
    await file.read(last);
    return last[0] === 10;
  } finally {
    file.close();
  }
}

export type AppendResult =
  | { kind: "appended"; size: number; compactedBytes: number }
  | { kind: "absent" }
  | { kind: "stale" };

/**
 * one write per call, so a run's change costs its own line whatever the
 * history; an index of another version is left for the caller to remove
 */
export async function appendRunIndexLines(
  workflowRunsDir: string,
  lines: readonly RunIndexLine[],
  options: { create: boolean },
): Promise<AppendResult> {
  const path = getIndexPath(workflowRunsDir);
  const header = await readRunIndexHeader(workflowRunsDir);
  if (header === null) {
    if (!options.create) return { kind: "absent" };
    const body = await linesText(lines);
    const bytes = utf8.encode(body).length;
    await atomicWriteTextFile(path, headerLine(bytes) + body);
    return {
      kind: "appended",
      size: (await Deno.stat(path)).size,
      compactedBytes: bytes,
    };
  }
  if (header.version !== INDEX_SCHEMA_VERSION) return { kind: "stale" };
  // a torn tail would otherwise swallow this run's line along with it
  const lead = await endsWithNewline(path) ? "" : "\n";
  await Deno.writeTextFile(path, lead + await linesText(lines), {
    append: true,
  });
  return {
    kind: "appended",
    size: (await Deno.stat(path)).size,
    compactedBytes: header.compactedBytes,
  };
}

export function needsCompaction(
  result: { size: number; compactedBytes: number },
): boolean {
  return result.size >
    Math.max(INDEX_COMPACTION_FLOOR_BYTES, 2 * result.compactedBytes);
}

/**
 * runs inside the index queue; a damaged index is left for the repair pass,
 * which checks its entries against their records before writing
 */
export async function compactRunIndex(workflowRunsDir: string): Promise<void> {
  const result = await readRunIndex(workflowRunsDir);
  if (!result || result.version !== INDEX_SCHEMA_VERSION || result.damaged) {
    return;
  }
  await writeRunIndex(workflowRunsDir, result.entries);
}

export async function deleteRunIndex(
  workflowRunsDir: string,
): Promise<void> {
  const path = getIndexPath(workflowRunsDir);
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export function isYamlRunFile(entry: Deno.DirEntry): boolean {
  return entry.isFile && entry.name.startsWith(RUN_FILE_PREFIX) &&
    entry.name.endsWith(RUN_FILE_SUFFIX);
}

export function countYamlRunFiles(entries: Deno.DirEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (isYamlRunFile(entry)) count++;
  }
  return count;
}

export async function listDirEntries(
  dir: string,
): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return entries;
}

export function isIndexStale(
  result: ReadIndexResult,
  yamlFileCount: number,
): boolean {
  return result.version !== INDEX_SCHEMA_VERSION ||
    result.damaged === true ||
    Object.keys(result.entries).length !== yamlFileCount;
}

const indexQueues = new Map<string, Promise<unknown>>();

/**
 * a pending repair may gain a reader only while it is still the tail: a writer
 * queued since must precede that reader's validation, even if its write
 * restores the record count
 */
export function indexQueueGeneration(
  workflowRunsDir: string,
): Promise<unknown> | undefined {
  return indexQueues.get(getIndexPath(resolve(workflowRunsDir)));
}

/**
 * the index is replaced by rename, so other processes are held off by a lock
 * on a file that never is; where the lock file cannot be made the index cannot
 * be replaced either, since its atomic write stages a file beside it
 */
async function withIndexFileLock<T>(
  workflowRunsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lock: Deno.FsFile | undefined;
  try {
    lock = await acquireIndexFileLock(workflowRunsDir);
  } catch (error) {
    const logger = getSwampLogger(["workflow-runs", "index"]);
    if (cannotWriteHere(error)) {
      logger
        .debug`Changing the run index of ${workflowRunsDir} without its lock: ${error}`;
    } else {
      logger
        .warn`Changing the run index of ${workflowRunsDir} without its lock, so a change another process makes to it meanwhile may be lost until the index is next repaired: ${error}`;
    }
  }
  try {
    return await fn();
  } finally {
    lock?.close();
  }
}

function cannotWriteHere(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    error instanceof Deno.errors.NotADirectory ||
    error instanceof Deno.errors.NotCapable ||
    (typeof error === "object" && error !== null && "code" in error &&
      error.code === "EROFS");
}

const LOCK_ATTEMPTS = 5;

/**
 * its holder may remove the lock file, so a lock is held only once its path
 * still names the file locked; a waiter on a removed file tries a new one
 */
async function acquireIndexFileLock(
  workflowRunsDir: string,
): Promise<Deno.FsFile> {
  const path = join(workflowRunsDir, RUNS_INDEX_LOCK_FILENAME);
  for (let attempt = 1;; attempt++) {
    const lock = await openLockFile(workflowRunsDir, path);
    if (lock !== null) {
      try {
        await lock.lock(true);
        if (await namesFile(path, lock)) return lock;
      } catch (error) {
        lock.close();
        throw error;
      }
      lock.close();
    }
    if (attempt === LOCK_ATTEMPTS) {
      throw markErrorPaths(
        new Error(`the lock file ${path} kept being removed or replaced`),
        [path],
      );
    }
  }
}

/** null when the directory went between its creation and the open */
async function openLockFile(
  workflowRunsDir: string,
  path: string,
): Promise<Deno.FsFile | null> {
  try {
    await Deno.mkdir(workflowRunsDir, { recursive: true });
    return await Deno.open(path, { read: true, write: true, create: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
    // a lock file another user made can still be locked through a read handle
    try {
      return await Deno.open(path, { read: true });
    } catch {
      throw error;
    }
  }
}

async function namesFile(path: string, file: Deno.FsFile): Promise<boolean> {
  const held = await file.stat();
  let named: Deno.FileInfo;
  try {
    named = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  return held.ino === null || named.ino === held.ino;
}

/**
 * runs inside the index queue, for a directory left with no runs: the lock file
 * goes with the index, removed by its holder
 */
export async function removeRunIndexFiles(
  workflowRunsDir: string,
): Promise<void> {
  await deleteRunIndex(workflowRunsDir);
  try {
    await Deno.remove(join(workflowRunsDir, RUNS_INDEX_LOCK_FILENAME));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * serializes read-modify-write of an index per directory, in this process by
 * queue and across processes by file lock; a failed fn does not hold up later
 * ones, and fn must not queue on the same directory
 */
export async function withIndexQueue<T>(
  workflowRunsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getIndexPath(resolve(workflowRunsDir));
  // A queued tail never rejects, so `fn` runs whatever happened before it.
  const run = (indexQueues.get(key) ?? Promise.resolve()).then(() =>
    withIndexFileLock(workflowRunsDir, fn)
  );
  const tail = run.then(() => {}, () => {});
  indexQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (indexQueues.get(key) === tail) indexQueues.delete(key);
  }
}

export function fingerprintOf(
  info: Deno.FileInfo,
): RecordFingerprint | undefined {
  if (!info.mtime) return undefined;
  return {
    mtimeMs: info.mtime.getTime(),
    size: info.size,
    ...(info.ctime ? { ctimeMs: info.ctime.getTime() } : {}),
    ...(typeof info.ino === "number" ? { ino: info.ino } : {}),
  };
}

export async function statRecord(
  path: string,
): Promise<RecordFingerprint | undefined | null> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  return fingerprintOf(info);
}

/** the index is not trusted, so anything that is not a fingerprint never matches */
export function fingerprintMatches(
  stored: unknown,
  current: RecordFingerprint,
): boolean {
  if (typeof stored !== "object" || stored === null) return false;
  const fields = stored as Record<string, unknown>;
  return fields.mtimeMs === current.mtimeMs &&
    fields.size === current.size &&
    fields.ctimeMs === current.ctimeMs &&
    fields.ino === current.ino;
}
