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
import {
  getDatastoreDirectories,
  isRepoLocalStreamSubdir,
  isRunLogFile,
} from "./datastore_config.ts";
import type { DatastoreConfig } from "./datastore_config.ts";

export interface MigrationResult {
  filesCopied: number;
  bytesCopied: number;
  directoriesMigrated: string[];
  errors: string[];
}

/**
 * repo-local stream directories and run logs are left behind: their writers and
 * readers only use the checkout's own .swamp
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
    if (isRepoLocalStreamSubdir(subdir)) continue;

    try {
      const stat = await Deno.stat(srcPath);
      if (!stat.isDirectory) continue;
    } catch {
      continue;
    }

    try {
      await copyDirectory(subdir, srcPath, destPath, result, skipped);
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

function skipSet(root: string, skip: readonly string[]): Set<string> {
  return new Set(skip.map((p) => resolve(root, p)));
}

async function copyDirectory(
  subdir: string,
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
      await copyDirectory(subdir, srcPath, destPath, result, skipped);
    } else if (entry.isFile) {
      if (isRunLogFile(subdir, entry.name)) continue;
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
      try {
        const target = await Deno.readLink(srcPath);
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
 * a symlink only has to exist, since numeric symlinks are rewritten as text;
 * files only the destination holds are ignored, as a .swamp destination keeps
 * local files such as method-run logs
 */
export async function verifyMigration(
  sourceDir: string,
  destDir: string,
  config: DatastoreConfig,
  skip: readonly string[] = [],
): Promise<{ valid: boolean; sourceCount: number; destCount: number }> {
  const directories = getDatastoreDirectories(config);
  const skipped = skipSet(sourceDir, skip);
  const tally = { sourceCount: 0, destCount: 0 };

  for (const subdir of directories) {
    if (isRepoLocalStreamSubdir(subdir)) continue;
    await countArrived(
      subdir,
      join(sourceDir, subdir),
      join(destDir, subdir),
      skipped,
      tally,
    );
  }

  return {
    valid: tally.sourceCount === tally.destCount,
    ...tally,
  };
}

async function countArrived(
  subdir: string,
  src: string,
  dest: string,
  skipped: ReadonlySet<string>,
  tally: { sourceCount: number; destCount: number },
): Promise<void> {
  if (skipped.has(resolve(src))) return;
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(src));
  } catch {
    return;
  }
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (skipped.has(resolve(srcPath))) continue;
    if (entry.isDirectory) {
      await countArrived(subdir, srcPath, destPath, skipped, tally);
    } else if (entry.isFile || entry.isSymlink) {
      if (entry.isFile && isRunLogFile(subdir, entry.name)) continue;
      tally.sourceCount++;
      if (await arrived(srcPath, destPath, entry.isSymlink)) {
        tally.destCount++;
      }
    }
  }
}

async function arrived(
  srcPath: string,
  destPath: string,
  isSymlink: boolean,
): Promise<boolean> {
  try {
    const destStat = await Deno.lstat(destPath);
    if (isSymlink) return true;
    return destStat.isFile && destStat.size === (await Deno.stat(srcPath)).size;
  } catch {
    return false;
  }
}
