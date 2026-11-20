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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  PREFERENCES_FILE_NAME,
  WorkspacePreferencesFileRepository,
} from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
import {
  WorkspaceRegistryFileRepository,
  type WorkspaceRegistryLockWait,
} from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import { ReasonMemo } from "./workspace_reconciler.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

// passes a workspace command's one read-modify-write, and ends before the next rescan
export const HOST_REGISTRY_LOCK_WAIT: WorkspaceRegistryLockWait = {
  maxWaitMs: 2_000,
  retryIntervalMs: 100,
  contentionLogLevel: "debug",
};

export function hostWorkspaceStore(dirs: {
  readonly dataDir: string;
  readonly configDir: string;
}): HostedRegistryDeps {
  return {
    dataDir: dirs.dataDir,
    registry: new WorkspaceRegistryFileRepository(
      dirs.configDir,
      HOST_REGISTRY_LOCK_WAIT,
    ),
    now: () => new Date(),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, REPO_MARKER_FILE))).isFile;
        } catch {
          return false;
        }
      },
    },
  };
}

/** workspaces.dir as the host's config dir holds it; undefined for the data dir's own folder */
export function hostConfiguredParent(
  configDir: string,
): () => Promise<string | undefined> {
  const preferences = new WorkspacePreferencesFileRepository(
    join(configDir, PREFERENCES_FILE_NAME),
  );
  return async () => (await preferences.read()).dir;
}

/** one line per reason for a registry the host cannot read, whichever part of the host met it */
export class RegistryProblemLog {
  readonly #reported = new ReasonMemo();
  /** the file the host read is gone; a write would create one without the entries it held */
  fileGone = false;

  unreadable(reason: string): void {
    if (!this.#reported.changed("unreadable", reason)) return;
    logger.warn(
      "The workspace registry cannot be read, so the host leaves it unchanged until it can: {reason}",
      { reason },
    );
  }

  readable(): void {
    this.#reported.clear("unreadable");
  }
}
