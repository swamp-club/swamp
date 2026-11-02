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

import { basename, isAbsolute, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import {
  type WorkspaceOrigin,
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";

export interface WorkspaceStoreDeps {
  readonly dataDir: string;
  readonly os: string;
  readonly registry: WorkspaceRegistryRepository;
  readonly repo: {
    isRepo(path: string): Promise<boolean>;
    init(path: string): Promise<void>;
  };
  readonly now: () => Date;
  readonly homeDir?: string;
  readonly configuredParent?: () => Promise<string | undefined>;
}

export function workspacesRoot(dataDir: string): string {
  return join(dataDir, "workspaces");
}

/**
 * True when the workspace is an existing repo imported where it was, not
 * one Swamp created. Entries registered before the origin was recorded are
 * told apart by where they are: only created ones were under the data dir.
 */
export function isImportedWorkspace(
  dataDir: string,
  entry: { readonly path: string; readonly origin?: WorkspaceOrigin },
): boolean {
  if (entry.origin !== undefined) return entry.origin === "imported";
  return !isUnder(entry.path, workspacesRoot(dataDir));
}

export function defaultWorkspacePath(dataDir: string, name: string): string {
  return join(workspacesRoot(dataDir), parseWorkspaceName(name));
}

/**
 * adopts the workspaces already under the data dir the first time the registry
 * is read
 */
export async function loadWorkspaceRegistry(
  deps: WorkspaceStoreDeps,
  options: { readOnly?: boolean } = {},
): Promise<WorkspaceRegistry> {
  const existing = await deps.registry.load();
  if (existing) return existing;
  const root = workspacesRoot(deps.dataDir);
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && await deps.repo.isRepo(join(root, entry.name))) {
        found.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const createdAt = deps.now().toISOString();
  if (options.readOnly) {
    return WorkspaceRegistry.fromEntries(
      found.map((name) => ({
        name,
        path: join(root, name),
        createdAt,
        origin: "created" as const,
      })),
    );
  }
  return await deps.registry.update((registry) => {
    for (const name of found) {
      try {
        registry.register({
          name,
          path: join(root, name),
          createdAt,
          origin: "created",
        });
      } catch {
        // A name or folder already registered by another process meanwhile.
      }
    }
    return registry;
  });
}

export async function resolveWorkspacePath(
  deps: WorkspaceStoreDeps,
  name: string,
): Promise<string> {
  const parsed = parseWorkspaceName(name);
  // Only a lookup: opening the workspace registers it.
  const registry = await loadWorkspaceRegistry(deps, { readOnly: true });
  return registry.get(parsed)?.path ??
    defaultWorkspacePath(deps.dataDir, parsed);
}

export async function ensureRegistered(
  deps: WorkspaceStoreDeps,
  name: string,
  path: string,
): Promise<void> {
  await deps.registry.update((registry) => {
    if (!registry.get(name)) {
      registry.register({
        name,
        path,
        createdAt: deps.now().toISOString(),
        origin: "created",
      });
    }
  });
}

export interface NewWorkspaceLocation {
  readonly name: string;
  readonly parent: string;
  readonly path: string;
  readonly inDataDir: boolean;
}

export const MAX_WORKSPACE_PARENT_LENGTH = 4096;

export async function defaultWorkspaceParent(
  deps: Pick<WorkspaceStoreDeps, "dataDir" | "configuredParent">,
): Promise<string> {
  return (await deps.configuredParent?.()) ?? workspacesRoot(deps.dataDir);
}

/**
 * a chosen or configured folder must already exist and is used by its real path
 * (symlinks resolved), so one folder is only ever registered one way; a
 * relative `parent` needs `relativeTo`
 */
export async function newWorkspaceLocation(
  deps: Pick<
    WorkspaceStoreDeps,
    "dataDir" | "homeDir" | "os" | "configuredParent"
  >,
  input: { name: string; parent?: string; relativeTo?: string },
): Promise<NewWorkspaceLocation> {
  const name = parseWorkspaceNameWithCode(input.name);
  const root = workspacesRoot(deps.dataDir);
  const inDataDir = {
    name,
    parent: root,
    path: defaultWorkspacePath(deps.dataDir, name),
    inDataDir: true,
  };
  const typed = input.parent?.trim() ?? "";
  let real: string;
  if (typed !== "") {
    real = await resolveChosenFolder(deps, typed, input.relativeTo);
  } else {
    const fromConfig = await deps.configuredParent?.();
    if (fromConfig === undefined) return inDataDir;
    real = await existingFolder(
      fromConfig,
      `The workspaces folder ${fromConfig} doesn't exist. Create it, or go back to the default with: swamp config set workspaces.dir default`,
    );
  }
  // The data dir's own folder, however it was spelled, is the default.
  if (real === await realPathOrSelf(root)) return inDataDir;
  return { name, parent: real, path: join(real, name), inDataDir: false };
}

export async function resolveChosenFolder(
  deps: Pick<WorkspaceStoreDeps, "homeDir" | "os">,
  typed: string,
  relativeTo?: string,
): Promise<string> {
  const raw = typed.trim();
  if (raw.length > MAX_WORKSPACE_PARENT_LENGTH) {
    throw new UserError("That folder path is too long.", "parent_too_long");
  }
  let expanded: string;
  try {
    expanded = expandHome(raw, deps.homeDir, deps.os);
  } catch (error) {
    if (error instanceof UserError) {
      throw new UserError(error.message, "parent_not_found");
    }
    throw error;
  }
  if (!isAbsolute(expanded)) {
    if (relativeTo === undefined) {
      throw new UserError(
        "Enter the folder's full path, or start it with ~.",
        "parent_not_absolute",
      );
    }
    expanded = resolve(relativeTo, expanded);
  }
  const chosen = resolve(expanded);
  return await existingFolder(
    chosen,
    `There's no folder at ${chosen}. Create it first, or choose another.`,
  );
}

async function existingFolder(path: string, missing: string): Promise<string> {
  try {
    if (!(await Deno.stat(path)).isDirectory) {
      throw markErrorPaths(
        new UserError(`${path} isn't a folder.`, "parent_not_a_folder"),
        [path],
      );
    }
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw markErrorPaths(new UserError(missing, "parent_not_found"), [path]);
    }
    if (
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotADirectory
    ) {
      throw markErrorPaths(
        new UserError(
          `Swamp can't open ${path}. Check its permissions, or choose another folder.`,
          "parent_unreadable",
        ),
        [path],
      );
    }
    throw error;
  }
}

/**
 * with `reuseRepo`, a repo that isn't registered is accepted, as swamp start
 * reuses one under the data dir. Reads only.
 */
export async function checkNewWorkspaceFolder(
  deps: WorkspaceStoreDeps,
  registry: WorkspaceRegistry,
  location: NewWorkspaceLocation,
  options: { reuseRepo?: boolean } = {},
): Promise<void> {
  const { name, path } = location;
  const registered = registry.get(name);
  if (registered) {
    throw markErrorPaths(
      new UserError(
        `A workspace named "${name}" already exists at ${registered.path}. Choose another name.`,
        "name_taken",
      ),
      [registered.path],
    );
  }
  // Imports are registered by their real path (/tmp vs /private/tmp).
  const real = await realPathOrSelf(path);
  let sameFolder;
  for (const entry of registry.list()) {
    if (await realPathOrSelf(entry.path) === real) sameFolder = entry;
  }
  if (sameFolder) {
    throw markErrorPaths(
      new UserError(
        `${path} is already registered as the workspace "${sameFolder.name}".`,
        "folder_exists",
      ),
      [path],
    );
  }
  // A link where the folder would go is never followed or removed: a
  // failed create would otherwise take away the user's link.
  if (await isSymlink(path)) {
    throw markErrorPaths(
      new UserError(
        `${path} is a link. Move it aside, or choose another name or folder.`,
        "not_a_workspace",
      ),
      [path],
    );
  }
  if (await deps.repo.isRepo(path)) {
    if (options.reuseRepo) return;
    throw markErrorPaths(
      new UserError(
        `A workspace folder is already at ${path}, but it isn't registered. Bring it back with: swamp workspace import "${path}". Or delete the folder first.`,
        "folder_exists",
      ),
      [path],
    );
  }
  if (await folderState(path) === "not_empty") {
    throw markErrorPaths(
      new UserError(
        `${path} exists but isn't a Swamp workspace. Move it aside, or choose another name.`,
        "not_a_workspace",
      ),
      [path],
    );
  }
}

/**
 * the caller holds the name's create lock. Registration is strict: a name or
 * folder registered meanwhile (an import does not take the lock) fails, and
 * what was made is taken away again.
 */
export async function createNewWorkspace(
  deps: WorkspaceStoreDeps,
  location: NewWorkspaceLocation,
): Promise<void> {
  await checkNewWorkspaceFolder(
    deps,
    await loadWorkspaceRegistry(deps),
    location,
  );
  const { name, path } = location;
  const before = await folderState(path);
  try {
    await ensureDir(path);
    await deps.repo.init(path);
    await deps.registry.update((registry) => {
      registry.register({
        name,
        path,
        createdAt: deps.now().toISOString(),
        origin: "created",
      });
    });
  } catch (error) {
    await undoCreate(path, before).catch(() => {});
    throw error;
  }
}

/**
 * Puts a folder back as it was before a create: removed when the create
 * made it, else emptied again (it was empty, and may be the user's own).
 */
async function undoCreate(
  path: string,
  before: "missing" | "empty" | "not_empty",
): Promise<void> {
  if (before === "missing") {
    await Deno.remove(path, { recursive: true });
  } else if (before === "empty") {
    for await (const entry of Deno.readDir(path)) {
      await Deno.remove(join(path, entry.name), { recursive: true });
    }
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function folderState(
  path: string,
): Promise<"missing" | "empty" | "not_empty"> {
  try {
    for await (const _entry of Deno.readDir(path)) return "not_empty";
    return "empty";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

export async function ensureWorkspace(
  deps: WorkspaceStoreDeps,
  name: string,
  workspacePath: string,
): Promise<boolean> {
  if (await deps.repo.isRepo(workspacePath)) return false;
  // Reopening only ever recreates the default folder under the data dir. A
  // workspace registered elsewhere (imported, or created in a chosen
  // folder) that is gone is not recreated empty in its place.
  if (
    resolve(workspacePath) !==
      resolve(defaultWorkspacePath(deps.dataDir, name))
  ) {
    throw markErrorPaths(
      new UserError(
        `The workspace "${name}" is registered at ${workspacePath}, but there's no Swamp workspace there any more. Put the folder back, or import it again from where it is now.`,
        "workspace_missing",
      ),
      [workspacePath],
    );
  }
  const state = await folderState(workspacePath);
  if (state === "not_empty") {
    throw markErrorPaths(
      new UserError(
        `${workspacePath} exists but isn't a Swamp workspace. Move it aside, or choose another name.`,
        "not_a_workspace",
      ),
      [workspacePath],
    );
  }
  await ensureDir(workspacePath);
  await deps.repo.init(workspacePath);
  return true;
}

export async function importableFolder(
  deps: Pick<WorkspaceStoreDeps, "repo" | "homeDir" | "os">,
  typed: string,
): Promise<string> {
  const raw = typed.trim();
  if (raw === "") {
    throw new UserError("Enter the folder to import.", "not_found");
  }
  const path = resolve(expandHome(raw, deps.homeDir, deps.os));
  let isDirectory = false;
  try {
    isDirectory = (await Deno.stat(path)).isDirectory;
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw markErrorPaths(
      new UserError(`There's no folder at ${path}.`, "not_found"),
      [path],
    );
  }
  if (!await deps.repo.isRepo(path)) {
    throw markErrorPaths(
      new UserError(
        `${path} isn't a swamp folder.`,
        "not_a_repo",
      ),
      [path],
    );
  }
  return path;
}

export async function importWorkspace(
  deps: WorkspaceStoreDeps,
  input: { path: string; name?: string },
): Promise<{ name: string; path: string; alreadyRegistered: boolean }> {
  const path = await importableFolder(deps, input.path);
  // The folder as it really is (symlinks and /tmp vs /private/tmp
  // resolved), so one folder is only ever registered once.
  const real = await Deno.realPath(path);
  const wanted = input.name?.trim()
    ? parseWorkspaceNameWithCode(input.name.trim())
    : null;
  const known = await loadWorkspaceRegistry(deps);
  const realRoot = await realPathOrSelf(workspacesRoot(deps.dataDir));
  const sameFolder = new Set<string>([real]);
  await Promise.all(
    known.list().map(async (entry) => {
      if (await realPathOrSelf(entry.path) === real) sameFolder.add(entry.path);
    }),
  );
  return await deps.registry.update((registry) => {
    const existing = registry.list().find((e) => sameFolder.has(e.path));
    if (existing) {
      return {
        name: existing.name,
        path: existing.path,
        alreadyRegistered: true,
      };
    }
    let name = wanted ?? nameFromFolder(basename(real));
    if (registry.get(name)) {
      if (wanted) {
        throw new UserError(
          `A workspace named "${name}" already exists. Choose another name.`,
          "name_taken",
        );
      }
      const base = name;
      for (let n = 2; registry.get(name); n++) {
        const suffix = `-${n}`;
        // Names are at most 63 characters, suffix included.
        name = `${base.slice(0, 63 - suffix.length)}${suffix}`;
      }
    }
    registry.register({
      name,
      path: real,
      createdAt: deps.now().toISOString(),
      // A folder under the data dir's own folder is one Swamp made and
      // `workspace remove` left behind: bringing it back keeps it created.
      origin: isUnder(real, workspacesRoot(deps.dataDir)) ||
          isUnder(real, realRoot)
        ? "created"
        : "imported",
    });
    return { name, path: real, alreadyRegistered: false };
  });
}

export function expandHome(
  raw: string,
  homeDir: string | undefined,
  os: string,
): string {
  const tilde = raw === "~" || raw.startsWith("~/") ||
    (os === "windows" && raw.startsWith("~\\"));
  if (!tilde) return raw;
  if (!homeDir) {
    throw new UserError(
      "Swamp can't tell where your home folder is. Enter the folder's full path.",
      "not_found",
    );
  }
  return raw === "~" ? homeDir : join(homeDir, raw.slice(2));
}

export async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

export function parseWorkspaceNameWithCode(name: string): string {
  try {
    return parseWorkspaceName(name);
  } catch (error) {
    if (error instanceof UserError) {
      throw new UserError(error.message, "invalid_name");
    }
    throw error;
  }
}

function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function nameFromFolder(folder: string): string {
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 63).replace(/-+$/, "");
  return slug || "workspace";
}
