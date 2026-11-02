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
 * a live writer keeps advancing mtime and the steps after the write are quick,
 * so a file this old cannot belong to a running process
 */
export const ABANDONED_TEMP_FILE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * much longer than the file threshold: a directory can belong to a paused
 * process (laptop asleep, job stopped), and removing it makes that process fail
 * on waking
 */
export const ABANDONED_TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * younger files are kept since a concurrent writer would fail with ENOENT;
 * entries with no or future mtime, or not regular files, are kept; all errors
 * are swallowed
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
 * dir may be shared like the OS temp dir, so only real directories count: lstat
 * avoids following links, the recursive remove unlinks symlinks, and errors
 * from others' directories are swallowed
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
