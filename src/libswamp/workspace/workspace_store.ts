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

/**
 * Where workspaces live and how they are registered, shared by
 * `swamp start` and the `swamp workspace` commands so both create, adopt
 * and import workspaces the same way.
 */

import { basename, isAbsolute, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import {
  type WorkspaceOrigin,
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";

/** What the workspace store needs from its caller. */
export interface WorkspaceStoreDeps {
  /** The swamp data dir new workspaces are created under. */
  readonly dataDir: string;
  readonly os: string;
  readonly registry: WorkspaceRegistryRepository;
  readonly repo: {
    /** True when the folder holds a `.swamp.yaml`. */
    isRepo(path: string): Promise<boolean>;
    /** Initialises the folder as a repo with no tools. */
    init(path: string): Promise<void>;
  };
  readonly now: () => Date;
  /** The user's home folder, for `~` in an imported path; unset when unknown. */
  readonly homeDir?: string;
  /**
   * The folder new workspaces go in when none is chosen
   * (`swamp config set workspaces.dir`); unset means under the data dir.
   */
  readonly configuredParent?: () => Promise<string | undefined>;
}

/** The folder new workspaces are created in. */
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

/**
 * The folder a new workspace of that name gets: under the data dir. A
 * registered workspace may live anywhere; see {@link resolveWorkspacePath}.
 */
export function defaultWorkspacePath(dataDir: string, name: string): string {
  return join(workspacesRoot(dataDir), parseWorkspaceName(name));
}

/**
 * The registry, adopting the workspaces already under the data dir the
 * first time it is read (before the registry existed, `swamp start` only
 * created folders there).
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
    // Report what adoption would register, without writing anything.
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

/** The folder of a workspace: where it is registered, else the default. */
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

/**
 * Registers the workspace Swamp created at `path` unless its name is
 * registered already.
 */
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

/** Where a new workspace would be created. */
export interface NewWorkspaceLocation {
  readonly name: string;
  /** The folder it is created in. */
  readonly parent: string;
  /** The workspace folder, `<parent>/<name>`. */
  readonly path: string;
  /** True when it goes in the default folder under the data dir. */
  readonly inDataDir: boolean;
}

/** The longest folder path accepted for a new workspace's location. */
export const MAX_WORKSPACE_PARENT_LENGTH = 4096;

/**
 * The folder new workspaces go in when none is chosen: the one set with
 * `swamp config set workspaces.dir`, else `<data dir>/workspaces`.
 */
export async function defaultWorkspaceParent(
  deps: Pick<WorkspaceStoreDeps, "dataDir" | "configuredParent">,
): Promise<string> {
  return (await deps.configuredParent?.()) ?? workspacesRoot(deps.dataDir);
}

/**
 * Where a new workspace of that name goes: in `parent` when one is given,
 * else in the configured folder, else under the data dir. A chosen or
 * configured folder must already exist; it is used by its real path
 * (symlinks resolved), so one folder is only ever registered one way. A
 * relative `parent` is resolved against `relativeTo` (the CLI's working
 * folder) and refused without it.
 *
 * @throws {UserError} code `invalid_name`, `parent_not_absolute`,
 *   `parent_not_found` or `parent_not_a_folder`
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
  let chosen: string;
  let configured = false;
  if (typed !== "") {
    if (typed.length > MAX_WORKSPACE_PARENT_LENGTH) {
      throw new UserError(
        "That folder path is too long.",
        "parent_not_found",
      );
    }
    let expanded: string;
    try {
      expanded = expandHome(typed, deps.homeDir, deps.os);
    } catch (error) {
      if (error instanceof UserError) {
        throw new UserError(error.message, "parent_not_found");
      }
      throw error;
    }
    if (!isAbsolute(expanded)) {
      if (input.relativeTo === undefined) {
        throw new UserError(
          "Enter the folder's full path, or start it with ~.",
          "parent_not_absolute",
        );
      }
      expanded = resolve(input.relativeTo, expanded);
    }
    chosen = resolve(expanded);
  } else {
    const fromConfig = await deps.configuredParent?.();
    if (fromConfig === undefined) return inDataDir;
    chosen = fromConfig;
    configured = true;
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await Deno.stat(chosen)).isDirectory;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw markErrorPaths(
      new UserError(
        configured
          ? `The workspaces folder ${chosen} doesn't exist. Create it, or go back to the default with: swamp config set workspaces.dir default`
          : `There's no folder at ${chosen}. Create it first, or choose another.`,
        "parent_not_found",
      ),
      [chosen],
    );
  }
  if (!isDirectory) {
    throw markErrorPaths(
      new UserError(`${chosen} isn't a folder.`, "parent_not_a_folder"),
      [chosen],
    );
  }
  const real = await Deno.realPath(chosen);
  // The data dir's own folder, however it was spelled, is the default.
  if (real === await realPathOrSelf(root)) return inDataDir;
  return { name, parent: real, path: join(real, name), inDataDir: false };
}

/**
 * Refuses a new workspace whose name or folder is taken: a registered
 * name (`name_taken`), a folder registered under another name or a repo
 * that isn't registered (`folder_exists`), or a folder holding something
 * else (`not_a_workspace`). With `reuseRepo`, a repo that isn't registered
 * is accepted, as `swamp start` reuses one under the data dir. Reads only.
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
 * Creates a new workspace at its location and registers it, after
 * {@link checkNewWorkspaceFolder}. The caller holds the name's create lock.
 * Registration is strict: a name or folder registered meanwhile (an import
 * does not take the create lock) fails rather than being reported as
 * created, and what was made is taken away again.
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

/** Whether a folder is missing, empty, or holds something. */
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

/**
 * Creates the workspace folder and initialises it as a repo with no tools,
 * or reuses it. Refuses a folder that holds something other than a
 * workspace. Returns true when it created the workspace.
 */
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

/**
 * The folder a typed path names, checked the way an import checks it: it
 * exists and holds a `.swamp.yaml`.
 *
 * @throws {UserError} code `not_found` or `not_a_repo`
 */
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

/**
 * Registers an existing swamp repo as a workspace where it is: nothing is
 * moved or copied. The name defaults to the folder's name; a clash gets a
 * numeric suffix. Importing a folder that is already registered answers
 * with its existing name.
 *
 * @throws {UserError} code `not_found`, `not_a_repo`, `invalid_name` or
 *   `name_taken`
 */
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

/**
 * Expands a leading `~` (`~/…`, or `~\…` on Windows) to the home folder.
 *
 * @throws {UserError} code `not_found` when there is a `~` to expand but
 *   the home folder is unknown
 */
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

/** The folder with symlinks resolved, or the path as given when it's gone. */
export async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/** Parses a workspace name, failing with code `invalid_name`. */
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

/** A workspace name made from a folder name: lowercase, dashes, ≤ 63. */
function nameFromFolder(folder: string): string {
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 63).replace(/-+$/, "");
  return slug || "workspace";
}
