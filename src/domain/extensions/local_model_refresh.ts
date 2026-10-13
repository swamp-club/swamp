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
import { modelRegistry } from "../models/model.ts";
import type {
  ExtensionLoader,
  SourceRefreshChanges,
} from "./extension_loader.ts";
import { removeAttachedExtensionsForType } from "./model_kind_adapter.ts";

const logger = getLogger(["swamp", "model", "refresh"]);

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
    if (isLocal(row.sourcePath) && row.kind !== "extension" && row.type) {
      affected.add(row.type);
    }
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
      logger.warn`Edited model ${type} failed to load: ${error}`;
    }
  }
}
