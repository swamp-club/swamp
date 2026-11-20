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

import type { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import type { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import type { WorkspaceScan } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import {
  type HostedWorkspaceFolder,
  hostedWorkspaceFolders,
  hostFolderClaimedBy,
  readHostedRegistry,
  registryOfRead,
  wantedFolderMatches,
} from "../../libswamp/workspace/hosted_roster.ts";
import type { RegistryProblemLog } from "./workspace_registration.ts";
import type { WantedReads } from "./workspace_reconciler.ts";

export interface WorkspaceFolders {
  readonly workspaces: ReadonlyMap<string, HostedWorkspaceFolder>;
  /**
   * for each wanted file read whole, whether it was written for the folder it
   * would act on: its workspace's folder, or `workspaces/<name>` for a name not listed
   */
  readonly wantedMatches: ReadonlyMap<string, boolean>;
  /** entries of the host's own whose folder is gone; the host unregisters them */
  readonly gone: readonly string[];
  readonly passedOver: readonly string[];
  /** every name the registry read holds, listed or not */
  readonly registered: ReadonlySet<string>;
}

export interface WorkspaceRoster {
  read(scan: WorkspaceScan, reads: WantedReads): Promise<WorkspaceFolders>;
}

export function createWorkspaceRoster(options: {
  readonly workspacesDir: string;
  /** false for a host with no host folder; true by default */
  readonly hostFolder?: boolean;
  readonly rootRepo: string | null;
  readonly store: Pick<HostedRegistryDeps, "registry">;
  readonly problems: RegistryProblemLog;
  readonly realPath?: (path: string) => Promise<string>;
  readonly isRepo?: (path: string) => Promise<boolean>;
}): WorkspaceRoster {
  const { workspacesDir, store, problems } = options;
  // null until a read succeeds, so a host started on a bad registry serves what its files name
  let lastRead: WorkspaceRegistry | null = null;
  let fileSeen = false;
  return {
    async read(scan, reads) {
      const read = await readHostedRegistry(store);
      // no command removes the file, so one gone while the host runs is kept as last read
      if (read.kind === "read" && read.registry === null && fileSeen) {
        problems.fileGone = true;
        problems.unreadable(
          "the registry file is gone; the host keeps the entries it last read until it is back",
        );
      } else if (read.kind === "read") {
        fileSeen = read.registry !== null;
        problems.fileGone = false;
        lastRead = registryOfRead(read);
        problems.readable();
      } else {
        problems.unreadable(read.reason);
      }
      const wanted = new Map<string, HostedWorkspace>();
      for (const [name, wantedRead] of reads) {
        if (wantedRead.kind === "found") wanted.set(name, wantedRead.workspace);
      }
      const roster = await hostedWorkspaceFolders({
        workspacesDir,
        hostFolder: options.hostFolder,
        scanned: scan.workspaces,
        registry: lastRead,
        rootRepo: options.rootRepo,
        wanted,
        realPath: options.realPath,
        isRepo: options.isRepo,
      });
      const workspaces = new Map(roster.workspaces.map((w) => [w.name, w]));
      const wantedMatches = new Map<string, boolean>();
      for (const [name, workspace] of wanted) {
        const listed = workspaces.get(name)?.folder ?? null;
        // a folder another workspace has is never one this name acts on
        const claimed = listed === null &&
          await hostFolderClaimedBy({
              workspacesDir,
              name,
              workspaces: workspaces.values(),
              realPath: options.realPath,
            }) !== null;
        // with no host folder a wanted file that names none stands for no folder at all
        const unnamed = options.hostFolder === false &&
          workspace.folder === null;
        wantedMatches.set(
          name,
          !claimed && !unnamed && await wantedFolderMatches({
            workspacesDir,
            workspace,
            listed,
            realPath: options.realPath,
          }),
        );
      }
      return {
        workspaces,
        wantedMatches,
        gone: roster.gone,
        passedOver: roster.passedOver,
        registered: roster.registered,
      };
    },
  };
}
