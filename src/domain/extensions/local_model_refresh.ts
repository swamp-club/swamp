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
 * Brings a long-lived process's model registry up to date with edited
 * repo-local model sources (swamp-club#3284). `swamp serve` loads its
 * extensions once; without this, an edit to a model under the repo's
 * models dir never reached the steps serve runs or the bundles it ships
 * to workers until serve restarted.
 *
 * Pulled extensions are left alone here: they reload through
 * `swamp serve reload` (src/serve/extension_reload.ts).
 */

import { getLogger } from "@logtape/logtape";
import { join } from "@std/path";
import { modelRegistry } from "../models/model.ts";
import type {
  ExtensionLoader,
  SourceRefreshChanges,
} from "./extension_loader.ts";
import { removeAttachedExtensionsForType } from "./model_kind_adapter.ts";

const logger = getLogger(["swamp", "model", "refresh"]);

/**
 * Returns a refresher that runs {@link refreshLocalModels} only when a file
 * under the local model dirs changed since its last pass. Checking costs a
 * directory walk and a stat per file; a pass rehashes every source, pulled
 * ones included, so serve would otherwise pay it on every run.
 *
 * A change is any file added, removed, or with a new size, mtime, ctime or
 * inode (an editor's atomic save replaces the inode). A pass that throws
 * leaves the snapshot alone, so the next call tries again; a source that
 * fails to bundle or load is not retried until it changes again.
 *
 * @param localDirs the mounted source dirs, walked with `dir`
 * @param pulledDirs the pulled extension dirs, read again for every pass
 */
export function createLocalModelRefresher(
  loader: ExtensionLoader,
  dir: string,
  localDirs: string[],
  pulledDirs: () => Promise<string[]>,
): () => Promise<void> {
  let lastSnapshot: string | undefined;
  return async () => {
    // Taken before the pass, so an edit made while it runs is seen next time.
    const snapshot = await snapshotSourceFiles([dir, ...localDirs]);
    if (snapshot === lastSnapshot) return;
    await refreshLocalModels(loader, dir, [
      ...localDirs,
      ...await pulledDirs(),
    ]);
    lastSnapshot = snapshot;
  };
}

/**
 * One line per file under `dirs`, sorted: its path, size, mtime, ctime and
 * inode. Every file counts, `_`-prefixed helper dirs included, since a
 * model's fingerprint covers the local modules it imports.
 */
async function snapshotSourceFiles(dirs: string[]): Promise<string> {
  const lines: string[] = [];
  const visit = async (path: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const child = join(path, entry.name);
      // Like the loader's file discovery, never descend through a symlink.
      if (entry.isDirectory) return visit(child);
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(child);
      } catch (error) {
        // Deleted mid-walk, or a dangling symlink: record that it is there.
        if (error instanceof Deno.errors.NotFound) {
          lines.push(`${child}\0missing`);
          return;
        }
        throw error;
      }
      lines.push(
        [
          child,
          info.size,
          info.mtime?.getTime(),
          info.ctime?.getTime(),
          info.ino,
        ].join("\0"),
      );
    }));
  };
  for (const dir of new Set(dirs)) await visit(dir);
  return lines.sort().join("\n");
}

/**
 * Re-checks the loader's source dirs and swaps every model type whose
 * repo-local source changed, so the next resolve gets the new code.
 *
 * Failures follow a fresh local process: a source that no longer imports
 * or validates leaves its type unregistered, so a run fails as
 * `swamp model method run` would, rather than running the old code. A
 * failed `deno bundle` keeps the previous bundle with a warning, as the
 * loader does everywhere.
 */
export async function refreshLocalModels(
  loader: ExtensionLoader,
  dir: string,
  additionalDirs: string[],
): Promise<void> {
  const changes = await loader.refreshStaleSources(dir, { additionalDirs });
  if (changes === null) return;
  await applyLocalModelChanges(loader, changes);
}

async function applyLocalModelChanges(
  loader: ExtensionLoader,
  changes: SourceRefreshChanges,
): Promise<void> {
  const isLocal = (path: string) => !loader.isPulledSourcePath(path);
  const affected = new Set<string>();

  for (const change of changes.rebundled) {
    if (!isLocal(change.sourcePath)) continue;
    if (change.type) affected.add(change.type);
    // A source that now claims another type no longer provides its old one.
    if (change.previousType) affected.add(change.previousType);
    // Reloading the type an edited add-on extends re-attaches all its
    // add-ons, dropping members the add-on no longer declares.
    if (change.extendsType) affected.add(change.extendsType);
  }
  for (const change of changes.failed) {
    if (!isLocal(change.sourcePath)) continue;
    if (change.previousType) {
      affected.add(change.previousType);
      logger
        .warn`Edited model ${change.sourcePath} no longer loads, so ${change.previousType} is unavailable until it is fixed: ${change.error}`;
    }
    if (change.extendsType) affected.add(change.extendsType);
  }
  for (const row of changes.removed) {
    // A deleted model's type goes; a deleted add-on's row names the type it
    // extended, which reloads without the add-on's members.
    if (isLocal(row.sourcePath) && row.type) affected.add(row.type);
  }

  for (const type of affected) {
    // A local source never replaces a built-in of the same type.
    if (modelRegistry.isBuiltIn(type)) {
      affected.delete(type);
      continue;
    }
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
  }
  if (affected.size === 0) return;

  // Every type the catalog still holds a loadable row for comes back as
  // lazy; a type whose source failed or was deleted has none, so it stays
  // unregistered.
  loader.registerFromCatalog();
  for (const type of affected) {
    if (!modelRegistry.has(type)) continue;
    try {
      await modelRegistry.ensureTypeLoaded(type);
      logger.info`Reloaded edited model ${type}`;
    } catch (error) {
      logger.warn`Edited model ${type} failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}
