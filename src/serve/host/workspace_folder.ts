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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  scanWorkspaces,
  type WorkspaceScan,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

export const DEFAULT_RESCAN_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 250;

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
  /** after onRescan, the workspaces changes are reported against */
  readonly served: (scan: WorkspaceScan) => readonly string[];
  readonly rescanMs?: number;
  readonly debounceMs?: number;
}

export interface WorkspaceWatcher {
  /** stops watching and waits for a rescan in flight; reports nothing after */
  stop(): Promise<void>;
}

/** the periodic rescan catches a registry change, which the state folder's watch never sees */
export function watchWorkspaces(
  options: WorkspaceWatcherOptions,
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
    await options.onRescan?.(scan);
    if (stopped) return;
    const listed = options.served(scan);
    const current = new Set(listed);
    const added = listed.filter((name) => !known.has(name));
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
          logger.error("Rescanning the state folder failed: {error}", {
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
      "Cannot watch the state folder, so changes are seen only by the rescan every {seconds} s: {error}",
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
        logger.warn("Watching the state folder stopped: {error}", {
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
