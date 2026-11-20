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

/**
 * with a host folder the host's own is at `workspaces/<name>`; with none it is
 * one a request created; any other registered repo is the operator's own
 */
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
  /** with no host folder, its folder holds another repo than the one its wanted file's create made */
  readonly replaced?: boolean;
}

/** what a folder says of the repo in it, read whole or not */
export type RepoIdentity =
  | { readonly kind: "absent" }
  | { readonly kind: "id"; readonly repoId: string }
  /** a folder with no marker, or a marker read whole that names no repoId */
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/** whose a wanted file's create makes an entry's folder; replaced only on a repoId read whole */
export type CreatedOwnership = "host" | "operator" | "replaced";

export interface CreatedOwnershipOptions {
  readonly realPath?: (path: string) => Promise<string>;
  readonly repoIdentity?: (folder: string) => Promise<RepoIdentity>;
}

// workspace code runs as the host's user and can write its marker
const MAX_REPO_MARKER_BYTES = 64 * 1024;

export interface HostedRoster {
  /** sorted by name */
  readonly workspaces: readonly HostedWorkspaceFolder[];
  /** entries for a `workspaces/<name>` folder that is gone; the host unregisters them */
  readonly gone: readonly string[];
  /** scanned folders an entry took the name or folder of */
  readonly passedOver: readonly string[];
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

/** the folder a wanted file was written for: the one it names, or `workspaces/<name>` */
export function wantedFolderOf(
  workspacesDir: string,
  workspace: HostedWorkspace,
): string {
  return workspace.folder ?? join(workspacesDir, workspace.name);
}

/**
 * on a host with no host folder, whether a request created the entry's folder:
 * its wanted file has a creator, names that folder and records a repoId, and the
 * folder is absent (a create registers before it renames) or holds that repo
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
  let text: string | null | "not a file";
  try {
    text = await readCapped(
      join(folder, REPO_MARKER_FILE),
      MAX_REPO_MARKER_BYTES,
    );
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? { kind: "none" }
      : { kind: "unreadable" };
  }
  if (text === null || text === "not a file") return { kind: "unreadable" };
  let marker: unknown;
  try {
    marker = parseYaml(text);
  } catch {
    return { kind: "unreadable" };
  }
  const repoId = typeof marker === "object" && marker !== null
    ? (marker as Record<string, unknown>).repoId
    : undefined;
  return typeof repoId === "string" && repoId.length > 0
    ? { kind: "id", repoId }
    : { kind: "none" };
}

/** another workspace whose folder is `workspaces/<name>`, which nothing done under `name` may touch */
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
 * the entry, read afresh, that holds `workspaces/<name>` under another name;
 * an unreadable registry gives none, so the caller's last good read decides
 */
export async function freshFolderClaim(input: {
  readonly store: Pick<HostedRegistryDeps, "registry">;
  readonly workspacesDir: string;
  readonly name: string;
  readonly realPath?: (path: string) => Promise<string>;
}): Promise<string | null> {
  const read = await readHostedRegistry(input.store);
  if (read.kind === "unreadable") return null;
  const realPath = input.realPath ?? realPathOrSelf;
  const own = await realPath(resolve(join(input.workspacesDir, input.name)));
  for (const entry of read.registry?.list() ?? []) {
    if (entry.name === input.name) continue;
    if (await realPath(resolve(entry.path)) === own) {
      return `it is registered as ${entry.name}`;
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

// an entry claims its folder and its name, so no scanned folder becomes a second serve of one repo
export async function hostedWorkspaceFolders(input: {
  readonly workspacesDir: string;
  /** false for a host with no host folder, whose own are the ones a request created; true by default */
  readonly hostFolder?: boolean;
  readonly scanned: readonly string[];
  readonly registry: WorkspaceRegistry | null;
  readonly rootRepo: string | null;
  /** the wanted files read whole; with a host folder used only while `registry` is null */
  readonly wanted?: ReadonlyMap<string, HostedWorkspace>;
  readonly realPath?: (path: string) => Promise<string>;
  readonly isRepo?: (path: string) => Promise<boolean>;
  readonly repoIdentity?: (folder: string) => Promise<RepoIdentity>;
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
  const passedOver: string[] = [];

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
      if (input.hostFolder === false) {
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
          shadows: false,
          ...(ownership === "replaced" ? { replaced: true } : {}),
        });
        continue;
      }
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
    if (real === rootReal) continue;
    const listed = workspaces.get(name);
    if (listed !== undefined || claimed.has(real)) {
      if (listed?.owner !== "host") passedOver.push(name);
      continue;
    }
    claimed.add(real);
    // the scanned spelling, so a folder that could not be registered keeps its path
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
    const wanted = [...(input.wanted ?? [])].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const [name, record] of wanted) {
      if (workspaces.has(name) || record.wanted !== "active") continue;
      if (record.folder === null) continue;
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
        shadows: false,
      });
    }
  }

  return {
    workspaces: [...workspaces.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
    gone: gone.sort(),
    passedOver,
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

// any error but NotFound may be a folder still there, so its entry is kept
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}
