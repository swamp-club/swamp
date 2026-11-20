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

import { basename, dirname, join, resolve } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import type {
  WorkspaceOrigin,
  WorkspaceRegistry,
} from "../../domain/workspace/workspace_registry.ts";
import { readHostedRegistry } from "./hosted_roster.ts";
import {
  importOrigin,
  loadWorkspaceRegistry,
  realPathOrSelf,
  type WorkspaceRegistryAccess,
} from "./workspace_store.ts";

export type HostedRegistryDeps = WorkspaceRegistryAccess;

export type HostedRegistration =
  | {
    readonly kind: "registered" | "present";
    readonly name: string;
    readonly folder: string;
  }
  | {
    readonly kind: "name_elsewhere";
    readonly name: string;
    readonly folder: string;
    readonly registeredFolder: string;
  }
  | {
    readonly kind: "folder_elsewhere";
    readonly name: string;
    readonly folder: string;
    readonly registeredName: string;
  };

export type HostedRegistrationResult =
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
    readonly kind: "done";
    readonly workspaces: readonly HostedRegistration[];
  };

export type HostedUnregistration =
  | { readonly kind: "removed" | "absent" | "not_ours" }
  | { readonly kind: "unreadable"; readonly reason: string };

interface Lacking {
  readonly name: string;
  readonly folder: string;
  readonly origin: WorkspaceOrigin;
}

/**
 * registers each folder `workspacesDir/<name>` the registry lacks, by its real
 * path and named as the folder; a name or folder registered otherwise is
 * reported, never changed
 */
export async function registerHostedWorkspaces(
  deps: HostedRegistryDeps,
  input: { workspacesDir: string; names: readonly string[] },
): Promise<HostedRegistrationResult> {
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  const registry = read.registry;
  const realOf = memoRealPaths();
  const results: HostedRegistration[] = [];
  const lacking: Lacking[] = [];
  for (const name of [...input.names].sort()) {
    const folder = await realFolder(join(input.workspacesDir, name));
    if (folder === null) continue;
    const found = registry === null
      ? null
      : await matchEntry(registry, name, folder, realOf);
    if (found !== null) results.push(found);
    else {
      lacking.push({
        name,
        folder,
        origin: await importOrigin(deps.dataDir, folder),
      });
    }
  }
  if (lacking.length === 0) return { kind: "done", workspaces: results };

  try {
    // a registry the host creates adopts the repos under the data dir first
    const known = registry ?? await loadWorkspaceRegistry(deps);
    // the update runs synchronously, so it compares by the real paths read here
    const resolved = new Map<string, string>();
    for (const entry of known.list()) {
      resolved.set(entry.path, await realOf(entry.path));
    }
    const resolvedOf = (path: string) => resolved.get(path) ?? path;
    const written = await deps.registry.update((current) =>
      lacking.map((want) => registerUnderLock(deps, current, want, resolvedOf))
    );
    for (const workspace of written) {
      // an entry added meanwhile under another spelling of this folder is not a clash
      const sameFolder = workspace.kind === "name_elsewhere" &&
        await realOf(workspace.registeredFolder) === workspace.folder;
      results.push(
        sameFolder
          ? { kind: "present", name: workspace.name, folder: workspace.folder }
          : workspace,
      );
    }
  } catch (error) {
    if (isUnreadable(error)) {
      return { kind: "unreadable", reason: error.message };
    }
    throw error;
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return { kind: "done", workspaces: results };
}

/**
 * removes the entry for `name` only when its folder is `workspacesDir/<name>`;
 * writes nothing when there is nothing of the host's to remove
 */
export async function unregisterHostedWorkspace(
  deps: HostedRegistryDeps,
  input: { workspacesDir: string; name: string },
): Promise<HostedUnregistration> {
  const { name } = input;
  const dirs = new Set([
    resolve(input.workspacesDir),
    await realPathOrSelf(input.workspacesDir),
  ]);
  const ours = (registry: WorkspaceRegistry): HostedUnregistration | null => {
    const entry = registry.get(name);
    if (entry === undefined) return { kind: "absent" };
    const path = resolve(entry.path);
    if (basename(path) !== name || !dirs.has(dirname(path))) {
      return { kind: "not_ours" };
    }
    return null;
  };
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  if (read.registry === null) return { kind: "absent" };
  const before = ours(read.registry);
  if (before !== null) return before;
  try {
    return await deps.registry.update((current) => {
      const now = ours(current);
      if (now !== null) return now;
      current.remove(name);
      return { kind: "removed" } as const;
    });
  } catch (error) {
    if (isUnreadable(error)) {
      return { kind: "unreadable", reason: error.message };
    }
    throw error;
  }
}

/** removes the entry for `name` only while it names `folder`, a folder a request created */
export async function unregisterCreatedWorkspace(
  deps: HostedRegistryDeps,
  input: { name: string; folder: string },
): Promise<HostedUnregistration> {
  const { name } = input;
  const target = await realPathOrSelf(resolve(input.folder));
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  const before = read.registry?.get(name);
  if (before === undefined) return { kind: "absent" };
  // the update runs synchronously, so the entry's real path is resolved here
  const beforeReal = await realPathOrSelf(resolve(before.path));
  if (beforeReal !== target) return { kind: "not_ours" };
  try {
    return await deps.registry.update((current): HostedUnregistration => {
      const now = current.get(name);
      if (now === undefined) return { kind: "absent" };
      if (now.path !== before.path) return { kind: "not_ours" };
      current.remove(name);
      return { kind: "removed" };
    });
  } catch (error) {
    if (isUnreadable(error)) {
      return { kind: "unreadable", reason: error.message };
    }
    throw error;
  }
}

/** the real folder the registry, read afresh, names for `name`; null for no entry */
export async function registeredFolderOf(
  deps: Pick<HostedRegistryDeps, "registry">,
  name: string,
): Promise<
  { kind: "read"; folder: string | null } | {
    kind: "unreadable";
    reason: string;
  }
> {
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  const entry = read.registry?.get(name);
  if (entry === undefined) return { kind: "read", folder: null };
  return { kind: "read", folder: await realPathOrSelf(resolve(entry.path)) };
}

function registerUnderLock(
  deps: HostedRegistryDeps,
  registry: WorkspaceRegistry,
  want: Lacking,
  resolvedOf: (path: string) => string,
): HostedRegistration {
  const { name, folder } = want;
  const byName = registry.get(name);
  // the root registers a workspace it creates, maybe since the read above
  if (byName !== undefined && resolvedOf(byName.path) === folder) {
    return { kind: "present", name, folder };
  }
  if (byName !== undefined) {
    return {
      kind: "name_elsewhere",
      name,
      folder,
      registeredFolder: byName.path,
    };
  }
  const byFolder = registry.list().find((entry) =>
    resolvedOf(entry.path) === folder
  );
  if (byFolder !== undefined) {
    return {
      kind: "folder_elsewhere",
      name,
      folder,
      registeredName: byFolder.name,
    };
  }
  registry.register({
    name,
    path: folder,
    createdAt: deps.now().toISOString(),
    origin: want.origin,
  });
  return { kind: "registered", name, folder };
}

async function matchEntry(
  registry: WorkspaceRegistry,
  name: string,
  folder: string,
  realOf: (path: string) => Promise<string>,
): Promise<HostedRegistration | null> {
  const byName = registry.get(name);
  if (byName?.path === folder) return { kind: "present", name, folder };
  // only a folder that does not match its entry exactly pays for resolving others
  if (byName !== undefined) {
    if (await realOf(byName.path) === folder) {
      return { kind: "present", name, folder };
    }
    return {
      kind: "name_elsewhere",
      name,
      folder,
      registeredFolder: byName.path,
    };
  }
  for (const entry of registry.list()) {
    if (await realOf(entry.path) === folder) {
      return {
        kind: "folder_elsewhere",
        name,
        folder,
        registeredName: entry.name,
      };
    }
  }
  return null;
}

function memoRealPaths(): (path: string) => Promise<string> {
  const seen = new Map<string, Promise<string>>();
  return (path) => {
    let real = seen.get(path);
    if (real === undefined) {
      real = realPathOrSelf(path);
      seen.set(path, real);
    }
    return real;
  };
}

async function realFolder(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function isUnreadable(error: unknown): error is UserError {
  return error instanceof UserError && error.code === "registry_unreadable";
}
