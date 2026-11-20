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
import type { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import { isWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import type { HostedRegistryDeps } from "./hosted_registration.ts";
import { realPathOrSelf } from "./workspace_store.ts";

export type HostedRegistryRead =
  | { readonly kind: "read"; readonly registry: WorkspaceRegistry | null }
  | { readonly kind: "unreadable"; readonly reason: string };

/** the host's own is at `workspaces/<name>`; any other registered repo is the operator's own */
export type HostedWorkspaceOwner = "host" | "operator";

export interface HostedWorkspaceFolder {
  readonly name: string;
  readonly folder: string;
  readonly owner: HostedWorkspaceOwner;
  /** false for an operator's folder that is gone or holds no repo marker */
  readonly isRepo: boolean;
  /** listed from its wanted file, while the registry has never been read */
  readonly fromWantedFile: boolean;
  /** a folder of its name in `workspaces/` is passed over for it, so neither is started */
  readonly shadows: boolean;
}

export interface HostedRoster {
  /** sorted by name */
  readonly workspaces: readonly HostedWorkspaceFolder[];
  /** entries for a `workspaces/<name>` folder that is gone; the host unregisters them */
  readonly gone: readonly string[];
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

/** a missing file is an empty registry; null only for one that cannot be read */
export function registryOfRead(
  read: HostedRegistryRead,
): WorkspaceRegistry | null {
  if (read.kind === "unreadable") return null;
  return read.registry ?? WorkspaceRegistry.empty();
}

/** the folder a wanted file was written for: the one it names, or `workspaces/<name>` */
export function wantedFolderOf(
  workspacesDir: string,
  workspace: HostedWorkspace,
): string {
  return workspace.folder ?? join(workspacesDir, workspace.name);
}

/**
 * another workspace whose folder is `workspaces/<name>`, as when that folder
 * is registered under another name; nothing done under `name` may touch it
 */
export async function hostFolderClaimedBy(input: {
  readonly workspacesDir: string;
  readonly name: string;
  readonly workspaces: Iterable<HostedWorkspaceFolder>;
  readonly realPath?: (path: string) => Promise<string>;
}): Promise<string | null> {
  const realPath = input.realPath ?? realPathOrSelf;
  const own = await realPath(resolve(join(input.workspacesDir, input.name)));
  for (const workspace of input.workspaces) {
    if (workspace.name === input.name) continue;
    if (await realPath(resolve(workspace.folder)) === own) {
      return workspace.name;
    }
  }
  return null;
}

/**
 * whether a wanted file was written for the folder it would act on: its
 * workspace's folder, or `workspaces/<name>` for a name not listed
 */
export async function wantedFolderMatches(input: {
  readonly workspacesDir: string;
  readonly workspace: HostedWorkspace;
  readonly listed: string | null;
  readonly realPath?: (path: string) => Promise<string>;
}): Promise<boolean> {
  const realPath = input.realPath ?? realPathOrSelf;
  const actsOn = input.listed ??
    join(input.workspacesDir, input.workspace.name);
  const [written, target] = await Promise.all([
    realPath(resolve(wantedFolderOf(input.workspacesDir, input.workspace))),
    realPath(resolve(actsOn)),
  ]);
  return written === target;
}

/**
 * the workspaces of a host. Every registry entry is one, at its own folder,
 * except the root's repo; a scanned folder is one only when no entry claims
 * its name or its folder. With no registry read yet (`registry` null), the
 * scanned folders and each active wanted file that names a repo folder.
 */
export async function hostedWorkspaceFolders(input: {
  readonly workspacesDir: string;
  readonly scanned: readonly string[];
  readonly registry: WorkspaceRegistry | null;
  readonly rootRepo: string | null;
  /** the wanted files read whole; used only while `registry` is null */
  readonly wanted?: ReadonlyMap<string, HostedWorkspace>;
  readonly realPath?: (path: string) => Promise<string>;
  readonly isRepo?: (path: string) => Promise<boolean>;
}): Promise<HostedRoster> {
  const realPath = input.realPath ?? realPathOrSelf;
  const isRepo = input.isRepo ?? hasRepoMarker;
  const { workspacesDir } = input;
  const scanned = [...new Set(input.scanned)].sort();
  const rootReal = input.rootRepo === null
    ? null
    : await realPath(resolve(input.rootRepo));
  const workspaces = new Map<string, HostedWorkspaceFolder>();
  // a folder belongs to one workspace, so no repo has two serves
  const claimed = new Set<string>();
  const gone: string[] = [];

  const scannedReal = new Map<string, string>();
  for (const name of scanned) {
    scannedReal.set(name, await realPath(join(workspacesDir, name)));
  }

  if (input.registry !== null) {
    const insideBase = await realPath(resolve(workspacesDir));
    for (const entry of input.registry.list()) {
      if (!isWorkspaceName(entry.name)) continue;
      const real = await realPath(resolve(entry.path));
      if (real === rootReal || claimed.has(real)) continue;
      const inside = join(insideBase, entry.name);
      const insideReal = scannedReal.get(entry.name) ??
        await realPath(inside);
      if (real === insideReal || real === inside) {
        // the scan decides when a folder of the host's own is whole
        if (scannedReal.has(entry.name)) {
          claimed.add(real);
          workspaces.set(entry.name, {
            name: entry.name,
            folder: real,
            owner: "host",
            isRepo: true,
            fromWantedFile: false,
            shadows: false,
          });
        } else if (!(await exists(join(workspacesDir, entry.name)))) {
          gone.push(entry.name);
        }
        continue;
      }
      claimed.add(real);
      workspaces.set(entry.name, {
        name: entry.name,
        folder: real,
        owner: "operator",
        isRepo: await isRepo(real),
        fromWantedFile: false,
        shadows: scannedReal.has(entry.name),
      });
    }
    // with every folder gone at once, the folder is more likely unmounted than emptied
    if (scanned.length === 0) gone.length = 0;
  }

  for (const name of scanned) {
    const real = scannedReal.get(name) ?? join(workspacesDir, name);
    if (workspaces.has(name) || claimed.has(real) || real === rootReal) {
      continue;
    }
    // the scanned spelling, so a folder that could not be registered starts where it always has
    workspaces.set(name, {
      name,
      folder: join(workspacesDir, name),
      owner: "host",
      isRepo: true,
      fromWantedFile: false,
      shadows: false,
    });
  }

  if (input.registry === null) {
    for (const [name, record] of input.wanted ?? []) {
      if (workspaces.has(name) || record.wanted !== "active") continue;
      if (record.folder === null) continue;
      const real = await realPath(resolve(record.folder));
      if (real === rootReal || !(await isRepo(real))) continue;
      workspaces.set(name, {
        name,
        folder: real,
        owner: "operator",
        isRepo: true,
        fromWantedFile: true,
        shadows: false,
      });
    }
  }

  return {
    workspaces: [...workspaces.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
    gone: gone.sort(),
  };
}

async function hasRepoMarker(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(path, REPO_MARKER_FILE))).isFile;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
