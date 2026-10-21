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
 * Reads another namespace's content on a v3 datastore (swamp-club#3691).
 *
 * The read model materialises every namespace of the datastore into the
 * checkout, each under its own cache root (`.swamp/` for the solo namespace,
 * `.swamp/<namespace>` for any other), so a row of another namespace is read
 * from that namespace's cache root, never from the reader's own layout.
 *
 * @module
 */

import { isAbsolute, join, relative, SEPARATOR } from "@std/path";
import type { ForeignContentFetcher } from "../../domain/data/repositories.ts";
import { isReservedNamespaceName } from "../../domain/data/namespace.ts";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";
import { readModelStateDir, refusedKeyReason } from "./record_path_guard.ts";

/** The checkout's layout a {@link v3ForeignContentFetcher} reads under. */
export interface V3ForeignContentLayout {
  /** The checkout's own namespace; empty or absent for a solo checkout. */
  readonly namespace?: string;
  /** The checkout's configured `directories` and `exclude`. */
  readonly directories?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
 * The foreign content fetcher of the v3 checkout at `repoDir`: it reads
 * `relPath` under the cache root of `namespace` in the checkout. It reads
 * the solo namespace too, so it is marked `readsSoloNamespace`.
 *
 * It returns null, reading nothing, for:
 * - a reserved namespace name, whose directory is swamp's own, or a
 *   namespace that is not one path segment;
 * - a key the read model never materialises (`refusedKeyReason`), or one of
 *   the solo namespace or this checkout's own namespace that this checkout's
 *   `directories` and `exclude` leave out: its cache root shares `.swamp/`
 *   with the checkout's local files, so such a file is never the
 *   namespace's;
 * - a path that resolves, through symlinks, outside the namespace's cache
 *   root, or that does not exist.
 *
 * `unreadableContent` is consulted before the file is read, so a record the
 * read model could not materialise throws its error instead of reading as
 * absent or as a stale file.
 */
export function v3ForeignContentFetcher(
  repoDir: string,
  layout: V3ForeignContentLayout,
  unreadableContent: UnreadableContentLookup,
): ForeignContentFetcher {
  const own = layout.namespace ?? "";
  const admits = datastoreKeyFilter(layout.directories, layout.exclude);
  const stateDir = readModelStateDir(repoDir);
  const read = async (
    namespace: string,
    relPath: string,
  ): Promise<Uint8Array | null> => {
    if (
      namespace !== "" &&
      (!isSafePathSegment(namespace) || isReservedNamespaceName(namespace))
    ) {
      return null;
    }
    let key: RecordKey;
    try {
      key = RecordKey.create(relPath);
    } catch {
      return null;
    }
    if (!relPath.split("/").every(isSafePathSegment)) return null;
    if ((namespace === "" || namespace === own) && !admits(relPath)) {
      return null;
    }
    const root = v3CacheRoot(repoDir, namespace);
    if (refusedKeyReason(key, root, stateDir) !== undefined) return null;
    const path = join(root, ...relPath.split("/"));
    const unreadable = await unreadableContent(path);
    if (unreadable !== undefined) throw unreadable;
    const real = await realPathOrNull(path);
    const realRoot = await realPathOrNull(root);
    if (real === null || realRoot === null || !isInside(realRoot, real)) {
      return null;
    }
    try {
      return await Deno.readFile(real);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  return Object.assign(read, { readsSoloNamespace: true });
}

/**
 * Whether `segment` is one path component that stays where it is put: not
 * empty, not `.` or `..`, and holding no separator or NUL.
 */
function isSafePathSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." &&
    !/[/\\\0]/.test(segment);
}

/** `path` with its symlinks resolved, or null when it does not exist. */
async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Whether `path` is strictly inside `root`; both already resolved. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) &&
    !isAbsolute(rel);
}
