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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import type { SwampError } from "../errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { WorkspacePreferencesFileRepository } from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import { isStartServing } from "../../infrastructure/process/start_instance_probe.ts";
import type { WorkspaceEntry } from "../../domain/workspace/workspace_registry.ts";
import {
  folderState,
  isImportedWorkspace,
  workspacesRoot,
  type WorkspaceStoreDeps,
} from "./workspace_store.ts";

/** Dependencies of the `swamp workspace` services, injected for testing. */
export interface WorkspaceDeps extends WorkspaceStoreDeps {
  /** Tools the repo at `path` is set up for (its `.swamp.yaml`). */
  readonly enrolledTools: (path: string) => Promise<string[]>;
  /** True when a `swamp start` has the workspace open. */
  readonly isOpenInStart: (path: string) => Promise<boolean>;
  /**
   * Runs `fn` under the workspace's create lock, the one `swamp start`
   * takes, so the two never both initialise the folder.
   */
  readonly withCreateLock: <T>(
    name: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

/** Wires real infrastructure into {@link WorkspaceDeps}. */
export function createWorkspaceDeps(options: {
  version: string;
  homeDir?: string;
}): WorkspaceDeps {
  const service = new RepoService(options.version);
  const markers = new RepoMarkerRepository();
  const dataDir = getSwampDataDir();
  const home = options.homeDir ?? Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ?? "";
  return {
    dataDir,
    os: Deno.build.os,
    registry: new WorkspaceRegistryFileRepository(),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, ".swamp.yaml"))).isFile;
        } catch {
          return false;
        }
      },
      init: async (path) => {
        await service.init(RepoPath.create(path), { tools: [] });
      },
    },
    now: () => new Date(),
    configuredParent: async () =>
      (await new WorkspacePreferencesFileRepository().read()).dir,
    enrolledTools: async (path) =>
      (await markers.read(RepoPath.create(path)))?.tools ?? [],
    // Read-only: a workspace command never prunes `swamp start`'s records.
    isOpenInStart: (path) => isStartServing(path, false),
    withCreateLock: async (name, fn) => {
      // The lock lives under the data dir for every workspace, as
      // `swamp start` keeps it.
      const dir = workspacesRoot(dataDir);
      await ensureDir(dir);
      const lock = new FileLock(dir, { lockKey: `${name}.lock` });
      await lock.acquire();
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    },
    ...(home ? { homeDir: home } : {}),
  };
}

/** Whether a registered workspace's folder is still a swamp repo. */
export type WorkspaceFolderState = "ok" | "missing" | "not_a_repo";

/** One registered workspace, as `list` and `get` show it. */
export interface WorkspaceSummary {
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  /** True when the workspace is an existing repo imported where it was. */
  readonly imported: boolean;
  readonly folder: WorkspaceFolderState;
}

/** The summary of one registry entry, checking its folder. */
export async function summarizeWorkspace(
  deps: WorkspaceDeps,
  entry: WorkspaceEntry,
): Promise<WorkspaceSummary> {
  let folder: WorkspaceFolderState = "ok";
  if (!await deps.repo.isRepo(entry.path)) {
    folder = await folderState(entry.path).catch(() => "not_empty" as const) ===
        "missing"
      ? "missing"
      : "not_a_repo";
  }
  return {
    name: entry.name,
    path: entry.path,
    createdAt: entry.createdAt,
    imported: isImportedWorkspace(deps.dataDir, entry),
    folder,
  };
}

/** The error event for a thrown UserError; anything else is rethrown. */
export function workspaceErrorEvent(
  error: unknown,
): { kind: "error"; error: SwampError } {
  if (error instanceof UserError) {
    return {
      kind: "error",
      error: {
        code: error.code ?? "user_error",
        message: error.message,
        cause: error,
      },
    };
  }
  throw error;
}

/** The error for a name that isn't registered. */
export function workspaceNotFound(name: string): UserError {
  return new UserError(
    `No workspace named "${name}". Run 'swamp workspace list' to see them.`,
    "not_found",
  );
}
