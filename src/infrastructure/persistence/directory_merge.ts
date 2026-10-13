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

import { join, resolve } from "@std/path";
import { isCatalogFileName } from "../../domain/datastore/datastore_config.ts";
import { isStagingEntryName } from "../../domain/extensions/install_journal.ts";
import type {
  DirContents,
  MergeDirResult,
} from "../../libswamp/datastores/namespace_migrate.ts";

export async function findFileCollisions(
  source: string,
  destination: string,
): Promise<string[]> {
  const collisions: string[] = [];
  const walkRecursive = async (
    src: string,
    dst: string,
    relPrefix: string,
  ): Promise<void> => {
    for await (const entry of Deno.readDir(src)) {
      if (isStagingEntryName(entry.name)) continue;
      // The catalog is repo-local, never merged (swamp-club#3316).
      if (!relPrefix && isCatalogFileName(entry.name)) continue;
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory && !entry.isSymlink) {
        try {
          const dstStat = await Deno.stat(dstPath);
          if (dstStat.isDirectory) {
            await walkRecursive(srcPath, dstPath, relPath);
          } else {
            collisions.push(relPath);
          }
        } catch {
          // Destination doesn't exist — no collision
        }
      } else {
        try {
          await Deno.stat(dstPath);
          collisions.push(relPath);
        } catch {
          // Destination doesn't exist — no collision
        }
      }
    }
  };
  await walkRecursive(source, destination, "");
  return collisions;
}

export async function mergeDirInto(
  source: string,
  destination: string,
): Promise<MergeDirResult> {
  const skippedPaths: string[] = [];
  const mergeRecursive = async (
    src: string,
    dst: string,
    relPrefix: string,
  ): Promise<number> => {
    let moved = 0;
    for await (const entry of Deno.readDir(src)) {
      // Install staging stays where its journal says it is, for crash
      // recovery (swamp-club#2723).
      if (isStagingEntryName(entry.name)) continue;
      // The catalog is repo-local and stays where it is (swamp-club#3316).
      if (!relPrefix && isCatalogFileName(entry.name)) continue;
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      let dstExists = false;
      try {
        await Deno.stat(dstPath);
        dstExists = true;
      } catch {
        // doesn't exist
      }
      if (!dstExists) {
        try {
          await Deno.rename(srcPath, dstPath);
        } catch {
          try {
            await Deno.copyFile(srcPath, dstPath);
          } catch (copyError) {
            if (copyError instanceof Deno.errors.NotFound) continue;
            throw copyError;
          }
          try {
            await Deno.remove(srcPath);
          } catch (removeError) {
            if (!(removeError instanceof Deno.errors.NotFound)) {
              throw removeError;
            }
          }
        }
        moved++;
      } else if (entry.isDirectory && !entry.isSymlink) {
        moved += await mergeRecursive(srcPath, dstPath, relPath);
      } else {
        skippedPaths.push(relPath);
      }
    }
    return moved;
  };
  const moved = await mergeRecursive(source, destination, "");
  try {
    await removeEmptyDirs(source);
  } catch {
    // Best-effort cleanup
  }
  return { moved, skipped: skippedPaths.length, skippedPaths };
}

/** Counts a directory's top-level catalog files and its other entries. */
export async function dirContents(dir: string): Promise<DirContents> {
  let catalogFiles = 0;
  let otherEntries = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (isCatalogFileName(entry.name)) catalogFiles++;
      else otherEntries++;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return { catalogFiles, otherEntries };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Deletes the catalog files at the top level of `dir`, then `dir` itself if
 * that leaves it empty, and returns the number of files deleted. Does nothing
 * when `dir` is `liveCatalogDir`, the directory holding the catalog in use.
 */
export async function removeCatalogFiles(
  dir: string,
  liveCatalogDir: string,
): Promise<number> {
  if (await canonicalPath(dir) === await canonicalPath(liveCatalogDir)) {
    return 0;
  }
  let removed = 0;
  let remaining = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (isCatalogFileName(entry.name) && !entry.isDirectory) {
        await Deno.remove(join(dir, entry.name));
        removed++;
      } else {
        remaining++;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return removed;
    throw error;
  }
  if (removed > 0 && remaining === 0) await Deno.remove(dir);
  return removed;
}

export async function dirHasFiles(dir: string): Promise<boolean> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile || entry.isSymlink) return true;
    if (entry.isDirectory && await dirHasFiles(join(dir, entry.name))) {
      return true;
    }
  }
  return false;
}

export async function compareFiles(a: string, b: string): Promise<boolean> {
  try {
    const [aBytes, bBytes] = await Promise.all([
      Deno.readFile(a),
      Deno.readFile(b),
    ]);
    if (aBytes.length !== bBytes.length) return false;
    for (let i = 0; i < aBytes.length; i++) {
      if (aBytes[i] !== bBytes[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeEmptyDirs(dir: string): Promise<boolean> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) {
    entries.push(entry);
  }
  let allRemoved = true;
  for (const entry of entries) {
    if (entry.isDirectory && !entry.isSymlink) {
      const childRemoved = await removeEmptyDirs(join(dir, entry.name));
      if (!childRemoved) allRemoved = false;
    } else {
      allRemoved = false;
    }
  }
  if (allRemoved) {
    try {
      await Deno.remove(dir);
    } catch {
      return false;
    }
    return true;
  }
  return false;
}
