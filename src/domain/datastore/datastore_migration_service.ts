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

import { ensureDir } from "@std/fs";
import { join, relative } from "@std/path";
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
 */
export async function migrateDatastore(
  sourceDir: string,
  destDir: string,
  config: DatastoreConfig,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    filesCopied: 0,
    bytesCopied: 0,
    directoriesMigrated: [],
    errors: [],
  };

  const directories = getDatastoreDirectories(config);

  for (const subdir of directories) {
    const srcPath = join(sourceDir, subdir);
    const destPath = join(destDir, subdir);

    try {
      const stat = await Deno.stat(srcPath);
      if (!stat.isDirectory) continue;
    } catch {
      // Source directory doesn't exist, skip
      continue;
    }

    try {
      await copyDirectory(srcPath, destPath, result);
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

/**
 * Recursively copies a directory.
 */
async function copyDirectory(
  src: string,
  dest: string,
  result: MigrationResult,
): Promise<void> {
  await ensureDir(dest);

  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory) {
      await copyDirectory(srcPath, destPath, result);
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
 */
export async function verifyMigration(
  sourceDir: string,
  destDir: string,
  config: DatastoreConfig,
): Promise<{ valid: boolean; sourceCount: number; destCount: number }> {
  const directories = getDatastoreDirectories(config);
  let sourceCount = 0;
  let destCount = 0;

  for (const subdir of directories) {
    sourceCount += await countFiles(join(sourceDir, subdir));
    destCount += await countFiles(join(destDir, subdir));
  }

  return {
    valid: sourceCount === destCount,
    sourceCount,
    destCount,
  };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile || entry.isSymlink) {
        count++;
      } else if (entry.isDirectory) {
        count += await countFiles(join(dir, entry.name));
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return count;
}
