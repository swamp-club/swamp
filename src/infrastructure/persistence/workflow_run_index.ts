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

export const RUNS_INDEX_FILENAME = ".runs-index.json";

// Bump when WorkflowRunIndexEntry gains or removes fields so that
// old on-disk indices are rebuilt instead of serving stale data.
export const INDEX_SCHEMA_VERSION = 2;

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
}

export type WorkflowRunIndex = Record<string, WorkflowRunIndexEntry>;

export function getIndexPath(workflowRunsDir: string): string {
  return join(workflowRunsDir, RUNS_INDEX_FILENAME);
}

export interface ReadIndexResult {
  entries: WorkflowRunIndex;
  version: number;
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

export function countYamlRunFiles(entries: Deno.DirEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (
      entry.isFile && entry.name.startsWith("workflow-run-") &&
      entry.name.endsWith(".yaml")
    ) {
      count++;
    }
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
