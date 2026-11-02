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
 * the read model writes a record only where its real path stays inside the
 * cache root; a first-level subdirectory symlinked outside would fail every
 * catch-up under it, so the checkout refuses to open until fixed
 */

import { join, SEPARATOR } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { MATERIALISED_SUBDIRS } from "./record_path_guard.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";

export const V3_CACHE_ROOT_ESCAPE_CODE = "datastore_v3_cache_root_escape";

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + SEPARATOR);
}

async function realPathOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function assertV3CacheSubdirsContained(
  repoDir: string,
  namespace: string,
  directories: readonly string[] | undefined,
): Promise<void> {
  // The subdirectory alone decides: an exclude pattern never leaves out a
  // whole subdirectory's links.
  const admits = datastoreKeyFilter(directories, undefined);
  const roots: { root: string; subdirs: string[] }[] = [{
    root: v3CacheRoot(repoDir, ""),
    subdirs: [...MATERIALISED_SUBDIRS].filter((subdir) =>
      admits(`${subdir}/_`)
    ),
  }];
  if (namespace !== "") {
    roots.push({
      root: v3CacheRoot(repoDir, namespace),
      subdirs: [...MATERIALISED_SUBDIRS],
    });
  }
  for (const { root, subdirs } of roots) {
    const realRoot = await realPathOrAbsent(root);
    if (realRoot === undefined) continue;
    for (const subdir of subdirs) {
      const dir = join(root, subdir);
      if (!await exists(dir)) continue;
      const real = await realPathOrAbsent(dir);
      if (real !== undefined && within(real, realRoot)) continue;
      throw markErrorPaths(
        new UserError(
          `${dir} ${
            real === undefined
              ? "is a link to nothing"
              : `resolves to ${real}, outside ${root}`
          }. A v3 checkout writes the records it reads from the datastore ` +
            `under ${root} and never through a link that leads out of it, so ` +
            `it does not use this checkout while the link is there. Nothing ` +
            `was changed. Replace ${dir} with a real directory (move what the ` +
            `link points at into it), then run the command again.`,
          V3_CACHE_ROOT_ESCAPE_CODE,
        ),
        [dir, real, root],
      );
    }
  }
}
