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

import { join } from "@std/path";
import { DEFAULT_DATASTORE_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
import { INFRASTRUCTURE_FILES } from "./namespace_migrate.ts";

export interface UnmigratedSubdir {
  subdir: string;
  source: string;
  destination: string;
}

export interface DetectUnmigratedDeps {
  dirExists: (path: string) => Promise<boolean>;
  dirHasDataFiles: (path: string) => Promise<boolean>;
}

/**
 * Checks whether un-namespaced data directories contain files that should
 * be at namespaced paths. Returns a list of subdirs with un-migrated data.
 *
 * Returns an empty array when no namespace is set or when all data has
 * already been migrated.
 */
export async function detectUnmigratedNamespaceData(
  datastorePath: string,
  namespace: string | undefined,
  deps: DetectUnmigratedDeps,
): Promise<UnmigratedSubdir[]> {
  if (!namespace) return [];

  const unmigrated: UnmigratedSubdir[] = [];
  for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
    const source = join(datastorePath, subdir);
    const destination = join(datastorePath, namespace, subdir);

    if (!(await deps.dirExists(source))) continue;
    if (!(await deps.dirHasDataFiles(source))) continue;
    if (
      await deps.dirExists(destination) &&
      await deps.dirHasDataFiles(destination)
    ) continue;

    unmigrated.push({ subdir, source, destination });
  }

  return unmigrated;
}

export function createFilesystemDetectDeps(): DetectUnmigratedDeps {
  return {
    dirExists: async (path: string) => {
      try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
      } catch {
        return false;
      }
    },
    dirHasDataFiles: async (path: string) => {
      try {
        for await (const entry of Deno.readDir(path)) {
          if (!INFRASTRUCTURE_FILES.has(entry.name)) return true;
        }
      } catch {
        return false;
      }
      return false;
    },
  };
}

export function formatUnmigratedWarning(
  unmigrated: UnmigratedSubdir[],
): string {
  const dirs = unmigrated.map((u) => u.subdir).join(", ");
  return `Data in ${unmigrated.length} director${
    unmigrated.length === 1 ? "y" : "ies"
  } (${dirs}) ` +
    `has not been migrated to the namespaced layout. Run ` +
    `'swamp datastore namespace migrate --confirm' to move it.`;
}
