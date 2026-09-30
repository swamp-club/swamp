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

import { ensureDir } from "@std/fs";
import { join, relative, resolve } from "@std/path";
import { getDatastoreDirectories } from "./datastore_config.ts";
import type { DatastoreConfig } from "./datastore_config.ts";

/**
 * Result of a datastore migration.
 */
export interface MigrationResult {
  /** Number of files copied */
  filesCopied: number;
  /** Total bytes copied */
  bytesCopied: number;
  /** Directories migrated */
  directoriesMigrated: string[];
  /** Any errors encountered (non-fatal) */
  errors: string[];
}

/**
 * Migrates datastore-tier files from source to destination.
 *
 * Copies all files from the source directories (based on the
 * datastore config's directory list) to the destination path.
 *
 * @param skip Paths relative to `sourceDir` that are left behind: a
 *   skipped top-level subdir is not copied or reported as migrated, and a
 *   skipped nested path is left out of its subdir's copy.
 */
export async function migrateDatastore(
  sourceDir: string,
  destDir: string,
  config: DatastoreConfig,
  skip: readonly string[] = [],
): Promise<MigrationResult> {
  const result: MigrationResult = {
    filesCopied: 0,
    bytesCopied: 0,
    directoriesMigrated: [],
    errors: [],
  };

  const directories = getDatastoreDirectories(config);
  const skipped = skipSet(sourceDir, skip);

  for (const subdir of directories) {
    const srcPath = join(sourceDir, subdir);
    const destPath = join(destDir, subdir);
    if (skipped.has(resolve(srcPath))) continue;

    try {
      const stat = await Deno.stat(srcPath);
      if (!stat.isDirectory) continue;
    } catch {
      // Source directory doesn't exist, skip
      continue;
    }

    try {
      await copyDirectory(srcPath, destPath, result, skipped);
      result.directoriesMigrated.push(subdir);
    } catch (error) {
      result.errors.push(
        `Failed to migrate ${subdir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

/** Resolves paths relative to `root` into a set of absolute paths. */
function skipSet(root: string, skip: readonly string[]): Set<string> {
  return new Set(skip.map((p) => resolve(root, p)));
}

/**
 * Recursively copies a directory.
 */
async function copyDirectory(
  src: string,
  dest: string,
  result: MigrationResult,
  skipped: ReadonlySet<string>,
): Promise<void> {
  await ensureDir(dest);

  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (skipped.has(resolve(srcPath))) continue;

    if (entry.isDirectory) {
      await copyDirectory(srcPath, destPath, result, skipped);
    } else if (entry.isFile) {
      try {
        await Deno.copyFile(srcPath, destPath);
        const stat = await Deno.stat(srcPath);
        result.filesCopied++;
        result.bytesCopied += stat.size;
      } catch (error) {
        result.errors.push(
          `Failed to copy ${relative(src, srcPath)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else if (entry.isSymlink) {
      // Convert symlinks to text files during migration
      try {
        const target = await Deno.readLink(srcPath);
        // If it looks like a latest symlink (numeric target), write as text
        const numeric = parseInt(target.replace(/\/$/, ""), 10);
        if (!isNaN(numeric)) {
          await Deno.writeTextFile(destPath, numeric.toString());
        } else {
          // Copy the symlink as-is. Resolve the link type from the
          // source side (where it exists) so Deno.symlink works on
          // Windows; the type argument is ignored on POSIX.
          let linkType: "file" | "dir" = "file";
          try {
            const stat = await Deno.stat(srcPath);
            if (stat.isDirectory) linkType = "dir";
          } catch {
            // Broken symlink in source — keep default
          }
          await Deno.symlink(target, destPath, { type: linkType });
        }
        result.filesCopied++;
        result.bytesCopied += target.length;
      } catch (error) {
        result.errors.push(
          `Failed to migrate symlink ${entry.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

/**
 * Verifies a migration by comparing file counts between source and destination.
 *
 * @param skip The same relative paths passed to {@link migrateDatastore};
 *   they are left out of both counts.
 */
export async function verifyMigration(
  sourceDir: string,
  destDir: string,
  config: DatastoreConfig,
  skip: readonly string[] = [],
): Promise<{ valid: boolean; sourceCount: number; destCount: number }> {
  const directories = getDatastoreDirectories(config);
  const sourceSkipped = skipSet(sourceDir, skip);
  const destSkipped = skipSet(destDir, skip);
  let sourceCount = 0;
  let destCount = 0;

  for (const subdir of directories) {
    sourceCount += await countFiles(join(sourceDir, subdir), sourceSkipped);
    destCount += await countFiles(join(destDir, subdir), destSkipped);
  }

  return {
    valid: sourceCount === destCount,
    sourceCount,
    destCount,
  };
}

async function countFiles(
  dir: string,
  skipped: ReadonlySet<string>,
): Promise<number> {
  if (skipped.has(resolve(dir))) return 0;
  let count = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (skipped.has(resolve(dir, entry.name))) continue;
      if (entry.isFile || entry.isSymlink) {
        count++;
      } else if (entry.isDirectory) {
        count += await countFiles(join(dir, entry.name), skipped);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return count;
}
