// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Removes a list of repo-relative paths and reports which were actually
 * removed. Used by `installExtension` to prune source files, bundle
 * files, and skill directories declared in a prior version's lockfile
 * entry but absent in the current version's `extractedFiles`.
 *
 * Behavior:
 * - Each path is resolved against `repoDir` and removed with
 *   `{ recursive: true }` so non-empty entries (skill directory roots
 *   tracked as a single path) are handled correctly.
 * - `Deno.errors.NotFound` is tolerated — the path is already gone, so
 *   it is NOT included in the returned list (the caller should report
 *   ground truth, not intent).
 * - Empty parent directories up to `repoDir` are pruned after each
 *   removal via `cleanupEmptyParentDirs`.
 * - Any other error propagates immediately.
 *
 * @returns the repo-relative paths that were actually removed
 */
export async function pruneOrphanFiles(
  orphanPaths: string[],
  repoDir: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const file of orphanPaths) {
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

/**
 * Removes empty parent directories up to but not including the stopAt directory.
 *
 * This is useful when deleting files from nested directory structures
 * (e.g., data/inputs/aws/ec2/vpc/uuid.yaml) to clean up empty folders.
 *
 * @param filePath The path of the file that was deleted
 * @param stopAtDir The directory to stop at (will not be deleted)
 */
export async function cleanupEmptyParentDirs(
  filePath: string,
  stopAtDir: string,
): Promise<void> {
  let currentDir = dirname(filePath);

  while (currentDir !== stopAtDir && currentDir.startsWith(stopAtDir)) {
    try {
      // Check if directory is empty
      const entries = [];
      for await (const entry of Deno.readDir(currentDir)) {
        entries.push(entry);
      }

      if (entries.length === 0) {
        await Deno.remove(currentDir);
        currentDir = dirname(currentDir);
      } else {
        // Directory not empty, stop cleaning
        break;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory already gone, try parent
        currentDir = dirname(currentDir);
      } else {
        // Other error, stop cleaning
        break;
      }
    }
  }
}
