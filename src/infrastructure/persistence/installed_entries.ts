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

import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { getLogger } from "@logtape/logtape";
import {
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
} from "./upstream_extensions.ts";
import {
  isBundleArtifactPath,
  managedConfigLockfilePath,
  pulledSkillDir,
  resolvePulledExtensionsRoot,
} from "./paths.ts";
import { assertContainedPath } from "./safe_path.ts";
import {
  findClaimants,
  type PathClaimEntry,
} from "../../domain/extensions/extension_path_claims.ts";
import {
  type DatastoreEnvReader,
  isExtensionBackedDatastore,
} from "./managed_config_lockfile.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";

const logger = getLogger(["swamp", "extensions", "installed-entries"]);

/**
 * The in-repo `.swamp/config/upstream_extensions.json` that the
 * auto-resolver records installs into, when it is a separate file from the
 * resolved managed lockfile. Returns undefined when the repo is not a
 * managedConfig repo on an extension-backed datastore, or when both paths
 * name the same file (a filesystem datastore at its default path).
 *
 * This is a transitional read input until swamp-club#2495 moves
 * auto-resolved installs into the managed lockfile (swamp-club#2483).
 */
export function transitionalLocalLockfilePath(
  repoDir: string,
  marker: RepoMarkerData | null,
  resolvedLockfilePath: string,
  readDatastoreEnv?: DatastoreEnvReader,
): string | undefined {
  if (!isExtensionBackedDatastore(marker, readDatastoreEnv)) return undefined;
  const localPath = managedConfigLockfilePath(repoDir);
  return resolve(localPath) === resolve(resolvedLockfilePath)
    ? undefined
    : localPath;
}

/** Merged installed entries, and which came only from the local lockfile. */
export interface InstalledEntries {
  entries: Record<string, UpstreamExtensionEntry>;
  /** Names present only in the transitional local lockfile. */
  localOnly: ReadonlySet<string>;
}

/**
 * Reads the resolved lockfile and, when given, the transitional local
 * lockfile, merged by name with the resolved entry winning. A corrupt local
 * file is skipped with a warning rather than failing the read, and so is a
 * local entry that is not an object.
 */
export async function readInstalledEntries(
  resolvedLockfilePath: string,
  localLockfilePath?: string,
): Promise<InstalledEntries> {
  const resolvedEntries = await readUpstreamExtensions(resolvedLockfilePath);
  if (!localLockfilePath) {
    return { entries: resolvedEntries, localOnly: new Set() };
  }
  let localEntries: Record<string, UpstreamExtensionEntry> = {};
  try {
    localEntries = await readUpstreamExtensions(localLockfilePath);
  } catch (error) {
    logger.warn`Ignoring unreadable lockfile ${localLockfilePath}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const localOnly = new Set<string>();
  const entries = { ...resolvedEntries };
  for (const [name, entry] of Object.entries(localEntries)) {
    if (Object.hasOwn(entries, name)) continue;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    entries[name] = entry;
    localOnly.add(name);
  }
  return { entries, localOnly };
}

/**
 * Names recorded only in the transitional in-repo auto-resolve lockfile,
 * whose catalog rows reconcile must not orphan. Empty when the repo has no
 * such lockfile (see {@link transitionalLocalLockfilePath}).
 */
export async function transitionalInstalledNames(
  repoDir: string,
  marker: RepoMarkerData | null,
  resolvedLockfilePath: string,
  readDatastoreEnv?: DatastoreEnvReader,
): Promise<string[]> {
  const localLockfilePath = transitionalLocalLockfilePath(
    repoDir,
    marker,
    resolvedLockfilePath,
    readDatastoreEnv,
  );
  if (!localLockfilePath) return [];
  const { localOnly } = await readInstalledEntries(
    resolvedLockfilePath,
    localLockfilePath,
  );
  return [...localOnly];
}

/** True when `path` names something inside `boundary`; never throws. */
function isContained(path: string, boundary: string): boolean {
  try {
    assertContainedPath(path, boundary);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string, directory = false): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return directory ? stat.isDirectory : true;
  } catch {
    return false;
  }
}

/**
 * True when a pulled extension is gone from disk: its per-extension
 * directory is absent and none of its tracked source files remain (bundle
 * output is regenerable and does not count). This mirrors the auto-resolver's
 * `missing` inspection, the state in which it reinstalls the extension, at
 * its recorded version, the next time one of its types is needed. An entry
 * with a name or path outside the repo is never reported as gone.
 */
export async function isAbsentFromDisk(
  repoDir: string,
  name: string,
  entry: UpstreamExtensionEntry,
): Promise<boolean> {
  const pulledRoot = resolvePulledExtensionsRoot(repoDir);
  if (!isContained(name, pulledRoot)) return false;
  if (await pathExists(join(pulledRoot, name), true)) return false;
  const files: unknown = entry.files;
  if (!Array.isArray(files)) return true;
  for (const file of files) {
    if (typeof file !== "string" || isBundleArtifactPath(file)) continue;
    if (!isContained(file, repoDir)) return false;
    if (await pathExists(join(repoDir, file))) return false;
  }
  return true;
}

/** A lockfile entry's string `files`, read defensively. */
function trackedFiles(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { files } = entry as { files?: unknown };
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string")
    : [];
}

/**
 * The paths, relative to the repo, to delete so that an extension is gone
 * from disk ({@link isAbsentFromDisk}) and the auto-resolver reinstalls it:
 * its per-extension directory, then the skill dir of each pulled skill it
 * tracks and any other tracked source file outside that directory. A skill
 * dir another entry in `installed` also claims is shared, so only this
 * extension's own files in it are listed. Bundle output is regenerable and
 * not listed. Empty when the name would lead outside the pulled root; paths
 * outside the repo are left out.
 */
export function pathsToRemoveForReinstall(
  repoDir: string,
  name: string,
  installed: Readonly<Record<string, unknown>>,
): string[] {
  const pulledRoot = resolvePulledExtensionsRoot(repoDir);
  if (!isContained(name, pulledRoot)) return [];
  const extensionDir = join(pulledRoot, name);
  const paths = [relative(repoDir, extensionDir)];
  const claims: Record<string, PathClaimEntry> = {};
  for (const [other, entry] of Object.entries(installed)) {
    claims[other] = { files: trackedFiles(entry) };
  }
  for (const file of claims[name]?.files ?? []) {
    if (isBundleArtifactPath(file) || !isContained(file, repoDir)) continue;
    const absolute = join(repoDir, file);
    const inside = relative(extensionDir, absolute);
    if (
      inside !== ".." && !inside.startsWith(`..${SEPARATOR}`) &&
      !isAbsolute(inside)
    ) {
      continue;
    }
    const skillDir = pulledSkillDir(file);
    const ownsSkillDir = skillDir !== undefined &&
      findClaimants(skillDir, name, claims).length === 0;
    const path = relative(
      repoDir,
      ownsSkillDir ? join(repoDir, skillDir) : absolute,
    );
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}
