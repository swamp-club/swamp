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
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { hostedWorkspaceFileOf } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

export const REPO_MARKER_FILE = ".swamp.yaml";
export const DEFAULT_RESCAN_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 250;

// hidden, so a scan passes over a folder while it is being removed
const DELETING_FOLDER_PATTERN =
  /^\.([a-z0-9][a-z0-9-]{0,62})\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deletingFolderName(name: string): string {
  return `.${parseWorkspaceName(name)}.deleting-${crypto.randomUUID()}`;
}

export function isDeletingFolderName(entry: string): boolean {
  return DELETING_FOLDER_PATTERN.test(entry);
}

export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface WorkspaceScan {
  /** sorted */
  readonly workspaces: readonly string[];
  readonly skipped: readonly SkippedEntry[];
  /** the workspaces with a wanted file, with or without a folder; sorted */
  readonly wantedFiles: readonly string[];
  /** folders an interrupted removal left under their hidden name */
  readonly leftovers: readonly string[];
  /** performance.now() before the folder was listed */
  readonly startedAt: number;
}

/** a missing folder holds no workspaces; hidden entries are passed over silently */
export async function scanWorkspaces(dir: string): Promise<WorkspaceScan> {
  const startedAt = performance.now();
  const workspaces: string[] = [];
  const skipped: SkippedEntry[] = [];
  const wantedFiles: string[] = [];
  const leftovers: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { workspaces, skipped, wantedFiles, leftovers, startedAt };
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      // a removal renames whatever is there, a link or a file included
      if (isDeletingFolderName(entry.name)) leftovers.push(entry.name);
      continue;
    }
    const file = hostedWorkspaceFileOf(entry.name);
    if (file !== null) {
      if (file.kind === "wanted") wantedFiles.push(file.name);
      continue;
    }
    const reason = await skipReason(dir, entry.name);
    if (reason === null) workspaces.push(entry.name);
    else skipped.push({ name: entry.name, reason });
  }
  workspaces.sort();
  wantedFiles.sort();
  leftovers.sort();
  return { workspaces, skipped, wantedFiles, leftovers, startedAt };
}

async function skipReason(dir: string, name: string): Promise<string | null> {
  try {
    parseWorkspaceName(name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const path = join(dir, name);
  if (!(await isDirectory(path))) return "it is not a folder";
  if (!(await isFile(join(path, REPO_MARKER_FILE)))) {
    return `it has no ${REPO_MARKER_FILE}, so it is not a swamp repo yet`;
  }
  return null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export interface WorkspaceChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface WorkspaceWatcherOptions {
  readonly dir: string;
  /** the workspaces the caller already runs; changes are reported against it */
  readonly initial: readonly string[];
  readonly onChange: (change: WorkspaceChange) => void | Promise<void>;
  /** every rescan, changed or not, before onChange */
  readonly onRescan?: (scan: WorkspaceScan) => void | Promise<void>;
  readonly rescanMs?: number;
  readonly debounceMs?: number;
}

export interface WorkspaceWatcher {
  /** stops watching and waits for a rescan in flight; reports nothing after */
  stop(): Promise<void>;
}

/** logs each skipped entry once, and again only when its reason changes */
export class SkipLog {
  readonly #reasons = new Map<string, string>();

  report(skipped: readonly SkippedEntry[], rescanMs: number): void {
    const seen = new Set<string>();
    for (const { name, reason } of skipped) {
      seen.add(name);
      if (this.#reasons.get(name) === reason) continue;
      this.#reasons.set(name, reason);
      logger.warn(
        "Skipping {name} in the workspaces folder: {reason}; the folder is rescanned every {seconds} s",
        { name, reason, seconds: rescanMs / 1000 },
      );
    }
    for (const name of [...this.#reasons.keys()]) {
      if (!seen.has(name)) this.#reasons.delete(name);
    }
  }
}

/**
 * the watch is not recursive, so writes a child makes inside its own repo
 * never reach it; the periodic rescan catches a marker written after its folder
 */
export function watchWorkspaces(
  options: WorkspaceWatcherOptions,
  skipLog: SkipLog = new SkipLog(),
): WorkspaceWatcher {
  const { dir, onChange } = options;
  const rescanMs = options.rescanMs ?? DEFAULT_RESCAN_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let known = new Set(options.initial);
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const rescanOnce = async () => {
    const scan = await scanWorkspaces(dir);
    if (stopped) return;
    skipLog.report(scan.skipped, rescanMs);
    await options.onRescan?.(scan);
    if (stopped) return;
    const current = new Set(scan.workspaces);
    const added = scan.workspaces.filter((name) => !known.has(name));
    const removed = [...known].filter((name) => !current.has(name)).sort();
    if (added.length === 0 && removed.length === 0) return;
    await onChange({ added, removed });
    // only after onChange succeeds, so a change that failed is reported again
    known = current;
  };

  // rescans never overlap: a request during one runs once more after it
  const rescan = () => {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await rescanOnce();
        } catch (error) {
          logger.error("Rescanning the workspaces folder failed: {error}", {
            error,
          });
        }
      } while (again && !stopped);
    })().finally(() => running = null);
  };

  const interval = setInterval(rescan, rescanMs);

  let fsWatcher: Deno.FsWatcher | null = null;
  try {
    fsWatcher = Deno.watchFs(dir, { recursive: false });
  } catch (error) {
    logger.warn(
      "Cannot watch the workspaces folder, so changes are seen only by the rescan every {seconds} s: {error}",
      { seconds: rescanMs / 1000, error },
    );
  }
  const watching = fsWatcher === null ? Promise.resolve() : (async () => {
    try {
      for await (const _event of fsWatcher) {
        clearTimeout(debounce);
        debounce = setTimeout(rescan, debounceMs);
      }
    } catch (error) {
      if (!stopped) {
        logger.warn("Watching the workspaces folder stopped: {error}", {
          error,
        });
      }
    }
  })();

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        stopped = true;
        clearInterval(interval);
        clearTimeout(debounce);
        try {
          fsWatcher?.close();
        } catch {
          // already closed
        }
        await watching;
        clearTimeout(debounce);
        await running;
      })();
      return stopping;
    },
  };
}
