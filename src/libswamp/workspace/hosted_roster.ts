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
import { parse as parseYaml } from "@std/yaml";
import type { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import { isWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { WorkspaceRegistry } from "../../domain/workspace/workspace_registry.ts";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { readCapped } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import type { HostedRegistryDeps } from "./hosted_registration.ts";
import { realPathOrSelf } from "./workspace_store.ts";

export type HostedRegistryRead =
  | { readonly kind: "read"; readonly registry: WorkspaceRegistry | null }
  | { readonly kind: "unreadable"; readonly reason: string };

/** the host's own is one a request created; any other registered repo is the operator's own */
export type HostedWorkspaceOwner = "host" | "operator";

export interface HostedWorkspaceFolder {
  readonly name: string;
  readonly folder: string;
  readonly owner: HostedWorkspaceOwner;
  /** false for an operator's folder that is gone or holds no repo marker */
  readonly isRepo: boolean;
  /** listed from its wanted file, while the registry has never been read */
  readonly fromWantedFile: boolean;
  /** its folder holds another repo than the one its wanted file's create made */
  readonly replaced?: boolean;
}

/** what a folder says of the repo in it, read whole or not */
export type RepoIdentity =
  | { readonly kind: "absent" }
  | { readonly kind: "id"; readonly repoId: string }
  /** a folder with no marker, or a marker read whole that names no repoId */
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/**
 * whose a wanted file's create makes an entry's folder; replaced only on a repoId
 * read whole, unknown while the folder's marker cannot be read
 */
export type CreatedOwnership = "host" | "operator" | "replaced" | "unknown";

export interface CreatedOwnershipOptions {
  readonly realPath?: (path: string) => Promise<string>;
  readonly repoIdentity?: (folder: string) => Promise<RepoIdentity>;
}

// workspace code runs as the host's user and can write its marker
const MAX_REPO_MARKER_BYTES = 64 * 1024;

export interface HostedRoster {
  /** sorted by name */
  readonly workspaces: readonly HostedWorkspaceFolder[];
  /** every name the registry holds, listed or not */
  readonly registered: ReadonlySet<string>;
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

/**
 * whether a request created the entry's folder: its wanted file has a creator,
 * names that folder and records a repoId, and the folder is absent (a create
 * registers before it renames) or holds that repo
 */
export async function hostCreated(
  workspace: HostedWorkspace,
  entryFolder: string,
  options: CreatedOwnershipOptions = {},
): Promise<boolean> {
  return await createdOwnership(workspace, entryFolder, options) === "host";
}

export async function createdOwnership(
  workspace: HostedWorkspace,
  entryFolder: string,
  options: CreatedOwnershipOptions = {},
): Promise<CreatedOwnership> {
  const realPath = options.realPath ?? realPathOrSelf;
  const repoIdentity = options.repoIdentity ?? folderRepoIdentity;
  if (
    workspace.creator === null || workspace.folder === null ||
    workspace.repoId === null
  ) {
    return "operator";
  }
  const [written, entry] = await Promise.all([
    realPath(resolve(workspace.folder)),
    realPath(resolve(entryFolder)),
  ]);
  if (written !== entry) return "operator";
  const identity = await repoIdentity(entryFolder);
  if (identity.kind === "absent") return "host";
  if (identity.kind === "unreadable") return "unknown";
  if (identity.kind !== "id") return "operator";
  return identity.repoId === workspace.repoId ? "host" : "replaced";
}

/** a link counts as present, so a dangling one is never taken for a folder not made yet */
export async function folderRepoIdentity(
  folder: string,
): Promise<RepoIdentity> {
  try {
    await Deno.lstat(folder);
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
  const marker = join(folder, REPO_MARKER_FILE);
  let text: string | null | "not a file";
  try {
    // opening a pipe blocks until a writer appears, which would stall every rescan
    if (!(await Deno.stat(marker)).isFile) return { kind: "unreadable" };
    text = await readCapped(marker, MAX_REPO_MARKER_BYTES);
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? { kind: "none" }
      : { kind: "unreadable" };
  }
  if (text === null || text === "not a file") return { kind: "unreadable" };
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { kind: "unreadable" };
  }
  const repoId = typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>).repoId
    : undefined;
  return typeof repoId === "string" && repoId.length > 0
    ? { kind: "id", repoId }
    : { kind: "none" };
}

/** whether a wanted file was written for its workspace's listed folder; never for one that names none */
export async function wantedFolderMatches(input: {
  readonly workspace: HostedWorkspace;
  readonly listed: string | null;
  readonly realPath?: (path: string) => Promise<string>;
}): Promise<boolean> {
  const { workspace, listed } = input;
  if (workspace.folder === null || listed === null) return false;
  const realPath = input.realPath ?? realPathOrSelf;
  const [written, target] = await Promise.all([
    realPath(resolve(workspace.folder)),
    realPath(resolve(listed)),
  ]);
  return written === target;
}

// an entry claims its folder, so no repo has two serves
export async function hostedWorkspaceFolders(input: {
  readonly registry: WorkspaceRegistry | null;
  readonly rootRepo: string | null;
  /** the wanted files read whole */
  readonly wanted?: ReadonlyMap<string, HostedWorkspace>;
  readonly realPath?: (path: string) => Promise<string>;
  readonly isRepo?: (path: string) => Promise<boolean>;
  readonly repoIdentity?: (folder: string) => Promise<RepoIdentity>;
}): Promise<HostedRoster> {
  const realPath = input.realPath ?? realPathOrSelf;
  const isRepo = input.isRepo ?? hasRepoMarker;
  const rootReal = input.rootRepo === null
    ? null
    : await realPath(resolve(input.rootRepo));
  const workspaces = new Map<string, HostedWorkspaceFolder>();
  const claimed = new Set<string>();

  if (input.registry !== null) {
    for (const entry of input.registry.list()) {
      if (!isWorkspaceName(entry.name)) continue;
      const real = await realPath(resolve(entry.path));
      if (real === rootReal || claimed.has(real)) continue;
      claimed.add(real);
      const record = input.wanted?.get(entry.name);
      const ownership = record === undefined
        ? "operator"
        : await createdOwnership(record, real, {
          realPath,
          repoIdentity: input.repoIdentity,
        });
      workspaces.set(entry.name, {
        name: entry.name,
        folder: real,
        owner: ownership === "host" ? "host" : "operator",
        isRepo: await isRepo(real),
        fromWantedFile: false,
        ...(ownership === "replaced" ? { replaced: true } : {}),
      });
    }
  } else {
    const wanted = [...(input.wanted ?? [])].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const [name, record] of wanted) {
      if (record.wanted !== "active" || record.folder === null) continue;
      const real = await realPath(resolve(record.folder));
      if (real === rootReal || claimed.has(real) || !(await isRepo(real))) {
        continue;
      }
      claimed.add(real);
      workspaces.set(name, {
        name,
        folder: real,
        owner: "operator",
        isRepo: true,
        fromWantedFile: true,
      });
    }
  }

  return {
    workspaces: [...workspaces.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
    registered: new Set(
      input.registry?.list().map((entry) => entry.name) ?? [],
    ),
  };
}

async function hasRepoMarker(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(path, REPO_MARKER_FILE))).isFile;
  } catch {
    return false;
  }
}
