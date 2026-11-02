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

import { dirname, join } from "@std/path";
import { assertContainedPath } from "./safe_path.ts";

export async function pruneOrphanFiles(
  orphanPaths: string[],
  repoDir: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const file of orphanPaths) {
    assertContainedPath(file, repoDir);
    const absolutePath = join(repoDir, file);
    try {
      await Deno.remove(absolutePath, { recursive: true });
      removed.push(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
    await cleanupEmptyParentDirs(absolutePath, repoDir);
  }
  return removed;
}

export interface DirectoryCleanupFs {
  lstat(path: string): Promise<Deno.FileInfo>;
  remove(path: string): Promise<void>;
  readDir(path: string): AsyncIterable<Deno.DirEntry>;
}

const denoCleanupFs: DirectoryCleanupFs = {
  lstat: (path) => Deno.lstat(path),
  remove: (path) => Deno.remove(path),
  readDir: (path) => Deno.readDir(path),
};

async function hasEntries(
  fs: DirectoryCleanupFs,
  dir: string,
): Promise<boolean> {
  for await (const _entry of fs.readDir(dir)) return true;
  return false;
}

/**
 * each directory is removed without listing: a non-recursive remove fails on a
 * non-empty one, so cost does not grow with sibling count; that failure or any
 * other ends the cleanup quietly
 */
export async function cleanupEmptyParentDirs(
  filePath: string,
  stopAtDir: string,
  fs: DirectoryCleanupFs = denoCleanupFs,
): Promise<void> {
  let currentDir = dirname(filePath);

  while (currentDir !== stopAtDir && currentDir.startsWith(stopAtDir)) {
    try {
      // A remove unlinks a symlink whatever its target holds, so a linked
      // directory goes only once its target is empty.
      const info = await fs.lstat(currentDir);
      if (info.isSymlink && await hasEntries(fs, currentDir)) break;

      await fs.remove(currentDir);
      currentDir = dirname(currentDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        currentDir = dirname(currentDir);
      } else {
        // Not empty (each OS words it differently), or another error: stop
        break;
      }
    }
  }
}
