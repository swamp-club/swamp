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
import { getSwampLogger } from "../logging/logger.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

export const RUNS_INDEX_FILENAME = ".runs-index.json";

// Bump when WorkflowRunIndexEntry gains or removes fields so that
// old on-disk indices are rebuilt instead of serving stale data.
export const INDEX_SCHEMA_VERSION = 4;

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
    await withIndexQueue(indexDir, async () => {
      const result = await readRunIndex(indexDir);
      if (!result || result.version !== INDEX_SCHEMA_VERSION) return;
      let dropped = false;
      for (const runId of runIds) {
        if (Object.hasOwn(result.entries, runId)) {
          delete result.entries[runId];
          dropped = true;
        }
      }
      if (dropped) await writeRunIndex(indexDir, result.entries);
    });
  }
}

export async function readRunIndex(
  workflowRunsDir: string,
): Promise<ReadIndexResult | null> {
  const path = getIndexPath(workflowRunsDir);
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return null;
    }
    if (
      typeof parsed.version === "number" &&
      parsed.entries !== undefined &&
      typeof parsed.entries === "object" &&
      !Array.isArray(parsed.entries)
    ) {
      return {
        entries: parsed.entries as WorkflowRunIndex,
        version: parsed.version,
      };
    }
    // Unversioned legacy format — return entries with version 0
    return { entries: parsed as WorkflowRunIndex, version: 0 };
  } catch {
    return null;
  }
}

export async function writeRunIndex(
  workflowRunsDir: string,
  index: WorkflowRunIndex,
): Promise<void> {
  const path = getIndexPath(workflowRunsDir);
  await atomicWriteTextFile(
    path,
    JSON.stringify({ version: INDEX_SCHEMA_VERSION, entries: index }),
  );
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
 * serializes read-modify-write of an index per directory in this process; a
 * failed fn does not hold up later ones, and fn must not queue on the same
 * directory
 */
export async function withIndexQueue<T>(
  workflowRunsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getIndexPath(resolve(workflowRunsDir));
  // A queued tail never rejects, so `fn` runs whatever happened before it.
  const run = (indexQueues.get(key) ?? Promise.resolve()).then(fn);
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
