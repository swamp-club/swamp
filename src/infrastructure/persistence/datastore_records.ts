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
 * Whether a directory holds datastore records: the one test v3 setup and the
 * first v3 open of a checkout share (swamp-club#3690), so "holds records"
 * means the same in both places.
 *
 * @module
 */

import { walk } from "@std/fs";
import { join, resolve, SEPARATOR } from "@std/path";
import {
  getDatastoreDirectories,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";

/**
 * The subdirectories of a checkout's `.swamp/` whose files are records a v3
 * datastore would materialise: the default datastore subdirectories, less
 * the always-local ones and the repo-local streams (logs, telemetry, audit,
 * files), which a v3 checkout keeps as they are.
 */
export function checkoutRecordSubdirs(): readonly string[] {
  // No `directories`: the defaults, which setup checks too.
  return getDatastoreDirectories({ type: "filesystem", path: "" }).filter((
    subdir,
  ) => !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir));
}

/**
 * Whether `sourceDir` holds a file under any of `subdirs`, other than the
 * `skip` paths (relative to `sourceDir`) and the files under a skipped
 * directory. Stops at the first one.
 */
export async function hasDatastoreRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
): Promise<boolean> {
  return (await subdirsWithRecords(sourceDir, subdirs, skip, true)).length > 0;
}

/**
 * The `subdirs` of `sourceDir` that hold a file, other than the `skip` paths
 * (relative to `sourceDir`) and the files under a skipped directory.
 */
export function subdirsHoldingRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
): Promise<string[]> {
  return subdirsWithRecords(sourceDir, subdirs, skip, false);
}

async function subdirsWithRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
  firstOnly: boolean,
): Promise<string[]> {
  const skipped = skip.map((path) => resolve(sourceDir, path));
  const isSkipped = (path: string) =>
    skipped.some((skip) => path === skip || path.startsWith(skip + SEPARATOR));
  const found: string[] = [];
  for (const subdir of subdirs) {
    const root = join(sourceDir, subdir);
    try {
      for await (
        const entry of walk(root, { includeDirs: false, followSymlinks: false })
      ) {
        if (!isSkipped(resolve(entry.path))) {
          found.push(subdir);
          break;
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (firstOnly && found.length > 0) break;
  }
  return found;
}
