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
 * a row of another namespace is read from that namespace's cache root, never
 * from the reader's own layout
 */

import { isAbsolute, join, relative, SEPARATOR } from "@std/path";
import type { ForeignContentFetcher } from "../../domain/data/repositories.ts";
import { isReservedNamespaceName } from "../../domain/data/namespace.ts";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";
import { readModelStateDir, refusedKeyReason } from "./record_path_guard.ts";

export interface V3ForeignContentLayout {
  readonly namespace?: string;
  readonly directories?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
 * null for a reserved namespace, a key the read model never materialises or
 * this checkout's filter leaves out (its cache root shares .swamp/ with local
 * files), or a path outside the cache root
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

function isSafePathSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." &&
    !/[/\\\0]/.test(segment);
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) &&
    !isAbsolute(rel);
}
