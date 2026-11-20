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
import type { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import type { HostedRegistryDeps } from "./hosted_registration.ts";
import { realPathOrSelf } from "./workspace_store.ts";

export type HostedRegistryRead =
  | { readonly kind: "read"; readonly registry: WorkspaceRegistry | null }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface HostedWorkspaceFolder {
  readonly name: string;
  readonly folder: string;
}

/**
 * reads without adopting and without the registry's lock; any failure is
 * unreadable, so a registry that cannot be read never fails its caller
 */
export async function readHostedRegistry(
  deps: Pick<HostedRegistryDeps, "registry">,
): Promise<HostedRegistryRead> {
  try {
    return { kind: "read", registry: await deps.registry.load() };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * the workspaces of a host: an entry whose folder is the scanned
 * `workspacesDir/<name>` of its own name, and each scanned folder no entry
 * claims; every other entry is passed over
 */
export async function hostedWorkspaceFolders(input: {
  readonly workspacesDir: string;
  readonly scanned: readonly string[];
  readonly registry: WorkspaceRegistry | null;
  readonly realPath?: (path: string) => Promise<string>;
}): Promise<HostedWorkspaceFolder[]> {
  const realPath = input.realPath ?? realPathOrSelf;
  const folders: HostedWorkspaceFolder[] = [];
  for (const name of [...new Set(input.scanned)].sort()) {
    const scanned = join(input.workspacesDir, name);
    const entry = input.registry?.get(name);
    if (entry !== undefined) {
      const [real, registered] = await Promise.all([
        realPath(scanned),
        realPath(entry.path),
      ]);
      // the real path, so the folder checked is the folder a serve starts in
      if (real === registered) {
        folders.push({ name, folder: real });
        continue;
      }
    }
    folders.push({ name, folder: scanned });
  }
  return folders;
}
