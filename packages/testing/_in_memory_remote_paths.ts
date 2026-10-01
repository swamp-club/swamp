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
 * Path and file helpers for the in-memory remote. Internal to this package.
 *
 * @module
 */

import { walk } from "@std/fs/walk";
import { isAbsolute, relative, SEPARATOR } from "@std/path";

/**
 * Files that live in the cache but never cross the sync boundary, in
 * either direction. Mirrors `isInternalCacheFile` in swamp-extensions'
 * datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts (the GCS
 * datastore uses the same list); this package cannot import it.
 */
export function isInternalCacheFile(rel: string): boolean {
  if (
    rel === ".datastore-index.json" || rel === ".push-queue.json" ||
    rel === ".datastore.lock" || rel === ".datastore-sync-state.json"
  ) {
    return true;
  }
  if (isAtOrUnder(rel, "_index") || isAtOrUnder(rel, "_control")) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === ".lock" || base === ".namespace.json") return true;
  return base === "_catalog.db" || base.startsWith("_catalog.db-");
}

/** Contract rule 5: relPaths are cache-relative and forward-slash. */
export function isCacheRelative(relPath: string): boolean {
  if (relPath === "" || relPath.includes("\\")) return false;
  if (relPath.startsWith("/") || isAbsolute(relPath)) return false;
  return !relPath.split("/").some((segment) => segment === "..");
}

/** `prefix === ""` matches every path. */
export function isAtOrUnder(rel: string, prefix: string): boolean {
  return prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`);
}

export function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function pathKind(
  absPath: string,
): Promise<"file" | "dir" | "missing"> {
  try {
    const info = await Deno.stat(absPath);
    return info.isDirectory ? "dir" : "file";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

export async function readIfFile(
  absPath: string,
): Promise<Uint8Array | undefined> {
  return await pathKind(absPath) === "file"
    ? await Deno.readFile(absPath)
    : undefined;
}

/** Cache-relative forward-slash paths of the syncable files under `root`. */
export async function listCacheFiles(
  cacheDir: string,
  root: string,
): Promise<string[]> {
  if (await pathKind(root) !== "dir") return [];
  const files: string[] = [];
  for await (const entry of walk(root, { includeDirs: false })) {
    const rel = relative(cacheDir, entry.path);
    const relPath = SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
    if (!isInternalCacheFile(relPath)) files.push(relPath);
  }
  return files.sort();
}
