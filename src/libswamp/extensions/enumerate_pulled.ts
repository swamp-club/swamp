// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { join } from "@std/path";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

/** Types that can appear under a per-extension subtree. */
export type PulledExtensionType =
  | "models"
  | "workflows"
  | "vaults"
  | "drivers"
  | "datastores"
  | "reports"
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
): Promise<string[]> {
  const upstream = await readUpstreamExtensions(lockfilePath);
  const pulledRoot = swampPath(repoDir, "pulled-extensions");
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
