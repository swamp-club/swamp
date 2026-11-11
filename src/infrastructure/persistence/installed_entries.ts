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
 * undefined when the repo is not a managedConfig repo on an extension-backed
 * datastore, or both paths name the same file; a transitional read input until
 * installs move to the managed lockfile
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

export interface InstalledEntries {
  entries: Record<string, UpstreamExtensionEntry>;
  localOnly: ReadonlySet<string>;
}

/**
 * merged by name with the resolved entry winning; a corrupt local file or
 * non-object local entry is skipped with a warning rather than failing the read
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
 * names recorded only in the transitional lockfile, whose catalog rows
 * reconcile must not orphan
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
 * mirrors the auto-resolver's missing inspection (it then reinstalls at the
 * recorded version); bundle output is regenerable and ignored; entries outside
 * the repo are never reported gone
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

const LOCKFILE_RETRY_DELAY_MS = 75;

const waitBeforeRetryDefault = () =>
  new Promise<void>((r) => setTimeout(r, LOCKFILE_RETRY_DELAY_MS));

export async function readInstalledEntriesWithRetry(
  resolvedLockfilePath: string,
  localLockfilePath?: string,
  waitBeforeRetry: () => Promise<void> = waitBeforeRetryDefault,
): Promise<InstalledEntries> {
  try {
    return await readInstalledEntries(resolvedLockfilePath, localLockfilePath);
  } catch (error) {
    // The managed lockfile is a datastore cache file that a sync pull can
    // rewrite non-atomically; one short retry rides that out.
    if (!(error instanceof SyntaxError)) throw error;
    await waitBeforeRetry();
    return await readInstalledEntries(resolvedLockfilePath, localLockfilePath);
  }
}

export const MISSING_FILES_SAMPLE_SIZE = 3;

export type MissingPulledExtensionState = "absent" | "truncated";

export interface MissingPulledExtension {
  name: string;
  state: MissingPulledExtensionState;
  /** repo-relative, forward slashes */
  expectedPath: string;
  /** the first MISSING_FILES_SAMPLE_SIZE missing files, forward slashes */
  missingFiles: string[];
  missingFileCount: number;
  autoResolved: boolean;
  /** the auto-resolver reinstalls it the next time one of its types is needed */
  installsOnNextUse: boolean;
}

function toForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

async function isMissing(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

/**
 * entries with a missing tracked source file, in lockfile order. Lockfiles are
 * repo-controlled: a name outside the pulled root is skipped and a path outside
 * the repo is never statted. Bundle output is regenerable and ignored.
 */
export async function findMissingPulledExtensions(
  repoDir: string,
  installed: InstalledEntries,
  localLockfilePath: string | undefined,
): Promise<MissingPulledExtension[]> {
  const pulledRoot = resolvePulledExtensionsRoot(repoDir);
  const found: MissingPulledExtension[] = [];
  for (const [name, entry] of Object.entries(installed.entries)) {
    if (!isContained(name, pulledRoot)) continue;
    const missing: string[] = [];
    for (const file of trackedFiles(entry)) {
      if (isBundleArtifactPath(file) || !isContained(file, repoDir)) continue;
      if (await isMissing(join(repoDir, file))) {
        missing.push(toForwardSlashes(file));
      }
    }
    if (missing.length === 0) continue;
    const autoResolved = installed.localOnly.has(name);
    const absent = await isAbsentFromDisk(repoDir, name, entry);
    found.push({
      name,
      state: absent ? "absent" : "truncated",
      expectedPath: toForwardSlashes(
        relative(repoDir, join(pulledRoot, name)),
      ),
      missingFiles: missing.slice(0, MISSING_FILES_SAMPLE_SIZE),
      missingFileCount: missing.length,
      autoResolved,
      // a team checkout's shared lockfile lists every extension the team
      // pulled; one this checkout never installed awaits the auto-resolver
      installsOnNextUse: absent &&
        (autoResolved || localLockfilePath !== undefined),
    });
  }
  return found;
}

function trackedFiles(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { files } = entry as { files?: unknown };
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string")
    : [];
}

/**
 * a skill dir another installed entry also claims is shared, so only this
 * extension's files in it are listed; bundle output, paths outside the repo and
 * names leading outside the pulled root are left out
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
