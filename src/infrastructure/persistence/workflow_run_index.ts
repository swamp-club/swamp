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

import { join } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

export const RUNS_INDEX_FILENAME = ".runs-index.json";

// Bump when WorkflowRunIndexEntry gains or removes fields so that
// old on-disk indices are rebuilt instead of serving stale data.
export const INDEX_SCHEMA_VERSION = 4;

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
  // Nested workflow links (swamp-club#2736). Read back leniently: the index
  // file is not trusted, so a malformed value is dropped.
  parentRun?: unknown;
  waitingOnRun?: unknown;
  waitsOnlyOnNestedRuns?: boolean;
  /**
   * The stat of the run record file this entry was built from, so a record
   * replaced since can be told apart without reading it (swamp-club#3051).
   * Optional and read back leniently: an entry without a valid one is
   * checked by reading its record.
   */
  record?: RecordFingerprint;
}

/**
 * What a stat of a run record file says about its version. An atomic write
 * replaces the inode, and `utime` can set mtime back but not ctime; a
 * platform that reports neither (Windows) is left with mtime and size.
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
 * Removes the run index of every workflow under `workflowRunsRoot`, the
 * checkout's `workflow-runs` directory, so the next read rebuilds each from
 * its run records (swamp-club#3802). A v3 recovery that puts back the
 * committed version of a run record leaves the index entry the dropped save
 * wrote, and the index only repairs itself when its count of runs differs,
 * so without this a search would keep reporting the dropped status.
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
 * Removes the run indexes of the checkout at `repoDir` (swamp-club#3802)
 * when its run records no longer match what an index says: a v3 recovery
 * ran, finished or not, whose replay puts back the committed version of each
 * run record, or a workflow run's final save was dropped after its index
 * entry was written. Each index is rebuilt from the records on its next read;
 * one that cannot be removed is warned about, never failing the caller.
 */
export async function removeStaleRunIndexes(repoDir: string): Promise<void> {
  try {
    await removeRunIndexes(swampPath(repoDir, SWAMP_SUBDIRS.workflowRuns));
  } catch (error) {
    getSwampLogger(["workflow-runs", "index"])
      .warn`Removing the workflow run indexes of ${repoDir} failed; history search may show a run's dropped status until its index is rebuilt: ${error}`;
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

/** Whether a directory entry is a workflow run record. */
export function isYamlRunFile(entry: Deno.DirEntry): boolean {
  return entry.isFile && entry.name.startsWith("workflow-run-") &&
    entry.name.endsWith(".yaml");
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

/** Index updates in flight, one chain per index file. */
const indexQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every index operation already queued for the same index
 * directory in this process, so one read-modify-write of the index file
 * never interleaves with another. A failed `fn` does not hold up the ones
 * queued behind it. `fn` must not queue on the same directory itself.
 */
export async function withIndexQueue<T>(
  workflowRunsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getIndexPath(workflowRunsDir);
  // A queued tail never rejects, so `fn` runs whatever happened before it.
  const run = (indexQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  indexQueues.set(key, tail);
  try {
    return await run;
  } finally {
    // Drop the chain once nothing is queued behind it.
    if (indexQueues.get(key) === tail) indexQueues.delete(key);
  }
}

/**
 * Stats a run record file. Returns null when it does not exist, and
 * undefined when the platform gives no mtime to fingerprint it by.
 */
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
  if (!info.mtime) return undefined;
  return {
    mtimeMs: info.mtime.getTime(),
    size: info.size,
    ...(info.ctime ? { ctimeMs: info.ctime.getTime() } : {}),
    ...(typeof info.ino === "number" ? { ino: info.ino } : {}),
  };
}

/**
 * Whether `stored`, an entry's fingerprint as read from the index file,
 * names the same version of the record as `current`. The index is not
 * trusted, so anything that is not a fingerprint never matches.
 */
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
