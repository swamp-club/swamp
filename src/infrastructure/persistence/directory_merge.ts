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
import type { MergeDirResult } from "../../libswamp/mod.ts";

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
        await Deno.rename(srcPath, dstPath);
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
