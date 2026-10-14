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

import { join } from "@std/path";

/**
 * Minimum age before a temp file is considered abandoned. A live writer keeps
 * advancing the file's mtime until its write finishes, and the steps after the
 * write (chmod, xattr clear, rename) take milliseconds, so anything this old
 * cannot belong to a process that is still running.
 */
export const ABANDONED_TEMP_FILE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Minimum age before a temp directory is considered abandoned. Much longer
 * than the file threshold: a directory can belong to a process that is
 * paused rather than dead — a laptop asleep mid-download, or a job stopped
 * with Ctrl+Z — and removing it makes that process fail when it wakes.
 */
export const ABANDONED_TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort removal of temp files left behind by a crashed process.
 *
 * Removes regular files in `dir` whose name starts with `prefix` and whose
 * mtime is older than {@link ABANDONED_TEMP_FILE_MAX_AGE_MS}. Younger files
 * are kept: they may belong to a concurrent process that is still writing
 * them, and deleting one makes that process fail with ENOENT. Entries with no
 * mtime, a future mtime, or that are not regular files are also kept. All
 * errors are swallowed.
 */
export async function removeAbandonedTempFiles(
  dir: string,
  prefix: string,
): Promise<void> {
  const now = Date.now();
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      const path = join(dir, entry.name);
      try {
        const info = await Deno.lstat(path);
        if (!info.isFile || info.mtime === null) {
          continue;
        }
        if (now - info.mtime.getTime() > ABANDONED_TEMP_FILE_MAX_AGE_MS) {
          await Deno.remove(path);
        }
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // readDir may fail if the directory is missing or unreadable — not fatal
  }
}

/**
 * Best-effort removal of temp directories left behind by a killed process.
 *
 * Removes directories in `dir` whose name starts with `prefix` and whose
 * newest timestamp — the directory's own mtime, or that of anything directly
 * inside it — is older than {@link ABANDONED_TEMP_DIR_MAX_AGE_MS}. A live
 * writer keeps touching its directory, and a paused one may wake, so anything
 * younger is kept.
 *
 * `dir` may be a shared location such as the OS temp directory, so only real
 * directories are considered: symlinks and files are skipped, entries are
 * read with lstat so no link is followed, and the recursive remove unlinks
 * any symlink inside rather than following it. Entries with no mtime or a
 * future mtime are kept, and all errors (another user's directory in a shared
 * /tmp, a concurrent removal) are swallowed.
 */
export async function removeAbandonedTempDirs(
  dir: string,
  prefix: string,
): Promise<void> {
  const now = Date.now();
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      const path = join(dir, entry.name);
      try {
        const info = await Deno.lstat(path);
        if (!info.isDirectory || info.isSymlink) {
          continue;
        }
        const newest = await newestMtime(path, info);
        if (newest !== null && now - newest > ABANDONED_TEMP_DIR_MAX_AGE_MS) {
          await Deno.remove(path, { recursive: true });
        }
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // readDir may fail if the directory is missing or unreadable — not fatal
  }
}

/**
 * The newest mtime of a directory and its direct entries, read with lstat.
 * Null when any of them has no mtime, so the caller keeps the directory.
 */
async function newestMtime(
  path: string,
  info: Deno.FileInfo,
): Promise<number | null> {
  if (info.mtime === null) return null;
  let newest = info.mtime.getTime();
  for await (const child of Deno.readDir(path)) {
    const childInfo = await Deno.lstat(join(path, child.name));
    if (childInfo.mtime === null) return null;
    newest = Math.max(newest, childInfo.mtime.getTime());
  }
  return newest;
}
