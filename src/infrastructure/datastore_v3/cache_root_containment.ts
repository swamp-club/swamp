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
 * Refuses a v3 checkout whose materialised subdirectories lead out of their
 * cache root (swamp-club#3691).
 *
 * The read model writes a record only where its real path stays inside its
 * namespace's cache root, and throws a `PathTraversalError` otherwise. A
 * first-level subdirectory such as `.swamp/data` that is a symlink (or a
 * Windows junction) to somewhere outside `.swamp` would make every catch-up
 * of a commit under it fail, and the writer would go on committing what the
 * read model cannot apply. So a v3 checkout refuses to open, and v3 setup
 * refuses to start, while one does, with a message that says how to fix it.
 * A link that stays inside the cache root is harmless and allowed.
 *
 * @module
 */

import { join, SEPARATOR } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { MATERIALISED_SUBDIRS } from "./record_path_guard.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";

/** Error code for a materialised subdirectory that links out of its cache root. */
export const V3_CACHE_ROOT_ESCAPE_CODE = "datastore_v3_cache_root_escape";

/** True when the real path `path` lies in or at the real path `dir`. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + SEPARATOR);
}

/** `Deno.realPath`, or undefined for a path that does not exist. */
async function realPathOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Whether anything, even a dangling link, is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Throws a {@link UserError} when a first-level materialised subdirectory
 * the read model would write for this checkout resolves outside its cache
 * root: under the checkout's own namespace's cache root every one, and
 * under the solo root (`.swamp` itself) those the checkout's `directories`
 * admit, since the solo namespace's records in any other subdirectory are
 * never materialised here.
 *
 * @param repoDir the checkout
 * @param namespace the checkout's namespace; empty for a solo datastore
 * @param directories the datastore's configured `directories`, if any
 */
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
