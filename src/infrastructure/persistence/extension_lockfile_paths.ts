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

import { isAbsolute, join, resolve } from "@std/path";
import { getManagedConfigBase, managedConfigLockfilePath } from "./paths.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";

export const LOCKFILE_NAME = "upstream_extensions.json";

/**
 * crash recovery accepts a journal only when its lockfile path is one of these,
 * so a planted journal cannot steer recovery's lockfile read elsewhere
 */
export function resolveExtensionLockfilePaths(
  repoDir: string,
  marker: RepoMarkerData | null,
): string[] {
  const paths = new Set<string>();
  const managedBase = getManagedConfigBase(repoDir);
  if (managedBase) paths.add(resolve(managedBase, LOCKFILE_NAME));
  paths.add(resolve(managedConfigLockfilePath(repoDir)));
  const modelsDir = resolveModelsDir(marker);
  paths.add(
    resolve(
      isAbsolute(modelsDir) ? modelsDir : join(repoDir, modelsDir),
      LOCKFILE_NAME,
    ),
  );
  paths.add(resolve(repoDir, "extensions", "models", LOCKFILE_NAME));
  return [...paths];
}
