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

import type { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import type { WorkspaceScan } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import {
  hostedWorkspaceFolders,
  readHostedRegistry,
} from "../../libswamp/workspace/hosted_roster.ts";
import type { RegistryProblemLog } from "./workspace_registration.ts";

/** each workspace's name and the folder its serve runs in */
export type WorkspaceFolders = ReadonlyMap<string, string>;

export interface WorkspaceRoster {
  read(scan: WorkspaceScan): Promise<WorkspaceFolders>;
}

export function createWorkspaceRoster(options: {
  readonly workspacesDir: string;
  readonly store: Pick<HostedRegistryDeps, "registry">;
  readonly problems: RegistryProblemLog;
  readonly realPath?: (path: string) => Promise<string>;
}): WorkspaceRoster {
  const { workspacesDir, store, problems } = options;
  // null until a read succeeds, so a host started on a bad registry serves its folders
  let lastRead: WorkspaceRegistry | null = null;
  return {
    async read(scan) {
      const read = await readHostedRegistry(store);
      if (read.kind === "read") {
        lastRead = read.registry;
        problems.readable();
      } else {
        problems.unreadable(read.reason);
      }
      const folders = await hostedWorkspaceFolders({
        workspacesDir,
        scanned: scan.workspaces,
        registry: lastRead,
        realPath: options.realPath,
      });
      return new Map(folders.map(({ name, folder }) => [name, folder]));
    },
  };
}
