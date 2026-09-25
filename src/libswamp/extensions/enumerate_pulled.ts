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

import { getLogger } from "@logtape/logtape";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  resolvePulledExtensionsRoot,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { readManifestIdentityAt } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { CATALOG_FAILURE_STATES } from "../../domain/extensions/bundle_freshness.ts";
import { PER_EXTENSION_SCAFFOLD_DIRS } from "./layout.ts";

/** Types that can appear under a per-extension subtree. */
export type PulledExtensionType =
  | "models"
  | "workflows"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks"
  | "files";

/**
 * Enumerates the per-extension type dirs for every installed pulled
 * extension that has a per-extension on-disk subtree present.
 *
 * Reads upstream_extensions.json, filters to entries whose per-extension
 * dir exists on disk (skipping extensions still in a legacy flat layout
 * or missing altogether), and returns absolute paths sorted for
 * deterministic output — required for sourceDirsFingerprint stability
 * across repeat loads.
 *
 * Callers pass each returned path as a separate element of
 * `additionalDirs` when invoking `UserModelLoader.loadModels` /
 * `buildIndex`, so the loader walks each extension's subtree in
 * isolation.
 */
export async function enumeratePulledExtensionDirs(
  lockfilePath: string,
  repoDir: string,
  type: PulledExtensionType,
  pulledExtensionsRoot?: string,
): Promise<string[]> {
  const repo = await LockfileRepository.create(lockfilePath);
  const upstream = repo.getAllEntries();
  const pulledRoot = pulledExtensionsRoot ??
    resolvePulledExtensionsRoot(repoDir);
  const dirs: string[] = [];

  for (const name of Object.keys(upstream)) {
    const candidate = join(pulledRoot, name, type);
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isDirectory) {
        dirs.push(candidate);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  dirs.sort();
  return dirs;
}

/** A pulled extension found on disk that ships datastore sources. */
export interface OnDiskDatastoreExtension {
  /** Extension name, e.g. `@swamp/s3-datastore`. */
  name: string;
  /** The pulled root the extension was found under. */
  pulledRoot: string;
  /** `<pulledRoot>/<name>/datastores`. */
  datastoresDir: string;
}

/** Deepest extension name to look for (`@scope/a/b/c/d/e`). */
const MAX_EXTENSION_NAME_DEPTH = 6;

/**
 * Finds pulled datastore extensions by scanning the in-repo pulled roots on
 * disk, without reading any lockfile (swamp-club#2483).
 *
 * In a managedConfig repo on an extension-backed datastore, the datastore
 * extension must load before the managed config base, and so the lockfile,
 * can be located. Both in-repo roots are scanned:
 * `.swamp/config/pulled-extensions` (managed) and `.swamp/pulled-extensions`
 * (where `datastore config migrate` leaves pre-migrate pulls, because it
 * copies the tree to the cache rather than to the managed in-repo root).
 *
 * An extension root is a directory under an `@`-prefixed path holding a
 * `manifest.yaml` whose `name` equals its path relative to the root. It is
 * returned only when its `datastores/` holds at least one `.ts` file (pull
 * always creates an empty `datastores/`). Scaffold kind dirs are not
 * descended into, but manifest-bearing dirs are, so nested names such as
 * `@a/b` and `@a/b/c` are both found.
 *
 * A name found under both roots is returned once, from the preferred root:
 * the managed root in managed repos, which is where auto-resolve and
 * explicit pulls write, otherwise the legacy root.
 *
 * @param options.onUnreadable Called for each directory the scan skipped
 *   because it could not read it, so a caller can tell an incomplete scan
 *   from an extension that is not on disk.
 * @returns Chosen extensions sorted by `datastoresDir`, for a stable
 *   source-dirs fingerprint.
 */
export async function enumeratePulledDatastoreExtensionsOnDisk(
  repoDir: string,
  preferManagedRoot: boolean,
  options?: { onUnreadable?: (dir: string) => void },
): Promise<OnDiskDatastoreExtension[]> {
  const managedRoot = swampPath(repoDir, "config", "pulled-extensions");
  const legacyRoot = swampPath(repoDir, "pulled-extensions");
  const roots = preferManagedRoot
    ? [managedRoot, legacyRoot]
    : [legacyRoot, managedRoot];

  const chosen = new Map<string, OnDiskDatastoreExtension>();
  for (const root of roots) {
    for (const found of await scanPulledRoot(root, options?.onUnreadable)) {
      if (!chosen.has(found.name)) chosen.set(found.name, found);
    }
  }
  return [...chosen.values()].sort((a, b) =>
    a.datastoresDir < b.datastoresDir
      ? -1
      : a.datastoresDir > b.datastoresDir
      ? 1
      : 0
  );
}

const logger = getLogger(["swamp", "extensions", "enumerate-pulled"]);

/**
 * Skips a directory the scan cannot read, so one unreadable subtree does
 * not hide every other datastore extension. A missing one is skipped
 * silently.
 */
function skipUnreadable(
  dir: string,
  error: unknown,
  onUnreadable?: (dir: string) => void,
): void {
  if (error instanceof Deno.errors.NotFound) return;
  onUnreadable?.(dir);
  logger
    .warn`Skipping unreadable directory ${dir} while scanning for datastore extensions: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

async function scanPulledRoot(
  root: string,
  onUnreadable?: (dir: string) => void,
): Promise<OnDiskDatastoreExtension[]> {
  const found: OnDiskDatastoreExtension[] = [];

  const visit = async (dir: string, segments: string[]): Promise<void> => {
    let isExtensionRoot = false;
    if (segments.length >= 2) {
      const identity = readManifestIdentityAt(join(dir, "manifest.yaml"));
      const name = segments.join("/");
      if (identity && identity.name === name) {
        isExtensionRoot = true;
        const datastoresDir = join(dir, "datastores");
        if (await containsTypeScriptFile(datastoresDir, onUnreadable)) {
          found.push({ name, pulledRoot: root, datastoresDir });
        }
      }
    }
    if (segments.length >= MAX_EXTENSION_NAME_DEPTH) return;

    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (error) {
      skipUnreadable(dir, error, onUnreadable);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (segments.length === 0 && !entry.name.startsWith("@")) continue;
      if (isExtensionRoot && PER_EXTENSION_SCAFFOLD_DIRS.includes(entry.name)) {
        continue;
      }
      await visit(join(dir, entry.name), [...segments, entry.name]);
    }
  };

  await visit(root, []);
  return found;
}

async function containsTypeScriptFile(
  dir: string,
  onUnreadable?: (dir: string) => void,
): Promise<boolean> {
  try {
    for await (
      const _entry of walk(dir, {
        includeDirs: false,
        exts: [".ts"],
        followSymlinks: false,
      })
    ) {
      return true;
    }
  } catch (error) {
    skipUnreadable(dir, error, onUnreadable);
    return false;
  }
  return false;
}

/** The catalog operations {@link purgeUnchosenPulledDatastoreRows} needs. */
export interface DatastoreRowCatalog {
  findByKind(kind: "datastore"): Array<{
    source_path: string;
    state?: string | null;
  }>;
  removeByRawSourcePath(rawSourcePath: string): void;
}

/**
 * Removes datastore catalog rows that sit under either in-repo pulled root
 * but outside every chosen `datastores/` dir, such as the copy of a
 * datastore extension that lost the on-disk dedupe. Failure-state rows are
 * kept, as the warm-path freshness check keeps them. Without this, a cold
 * rebuild would leave the losing copy's rows registered alongside the
 * chosen ones.
 *
 * `chosen` must come from a scan that skipped no unreadable directory;
 * otherwise the rows of an extension the scan could not read are purged
 * too.
 */
export function purgeUnchosenPulledDatastoreRows(
  catalog: DatastoreRowCatalog,
  repoDir: string,
  chosen: readonly OnDiskDatastoreExtension[],
): void {
  const withSlash = (p: string) => {
    const c = canonicalizePath(p);
    return c.endsWith("/") ? c : `${c}/`;
  };
  const pulledRoots = [
    swampPath(repoDir, "config", "pulled-extensions"),
    swampPath(repoDir, "pulled-extensions"),
  ].map(withSlash);
  const chosenDirs = chosen.map((c) => withSlash(c.datastoresDir));

  for (const row of catalog.findByKind("datastore")) {
    const source = canonicalizePath(row.source_path);
    if (!pulledRoots.some((root) => source.startsWith(root))) continue;
    if (chosenDirs.some((dir) => source.startsWith(dir))) continue;
    if (CATALOG_FAILURE_STATES.has(row.state ?? "Indexed")) continue;
    catalog.removeByRawSourcePath(row.source_path);
  }
}

/**
 * The pulled `datastores/` dirs the startup datastore loader reads in a
 * managedConfig repo on an extension-backed datastore: those chosen by
 * {@link enumeratePulledDatastoreExtensionsOnDisk}. After a complete scan
 * it also purges the catalog rows of copies that lost the dedupe. After a
 * scan that skipped an unreadable directory it purges nothing, because an
 * extension it could not read would look like a copy that lost.
 */
export async function choosePulledDatastoreDirsOnDisk(
  catalog: DatastoreRowCatalog,
  repoDir: string,
): Promise<string[]> {
  let complete = true;
  const chosen = await enumeratePulledDatastoreExtensionsOnDisk(repoDir, true, {
    onUnreadable: () => complete = false,
  });
  if (complete) purgeUnchosenPulledDatastoreRows(catalog, repoDir, chosen);
  return chosen.map((c) => c.datastoresDir);
}
