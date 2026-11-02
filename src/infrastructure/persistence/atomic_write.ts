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
import { syncDirectoryStrict, SyncFailedError } from "./sync_directory.ts";

/** each hook is injectable so tests can observe the order; production passes {} */
export interface AtomicWriteSync {
  readonly syncFile?: (
    file: Deno.FsFile,
    paths: { readonly temp: string; readonly target: string },
  ) => Promise<void>;
  readonly syncDirectory?: (dir: string) => Promise<void>;
  /**
   * Whether the parent directory is synced after the rename; true by
   * default. A caller writing several files into one directory passes
   * false and syncs the directory once itself.
   */
  readonly syncParent?: boolean;
}

export interface AtomicWriteOptions {
  /**
   * Makes the write durable: the temp file is synced before the rename and
   * its directory after it. Absent, the write is atomic but not synced.
   */
  readonly sync?: AtomicWriteSync;
}

export async function atomicWriteTextFile(
  path: string,
  content: string,
  options?:
    | (Deno.WriteFileOptions & { readonly sync?: undefined })
    // A synced write replaces the file whole: only `mode` applies.
    | ({ readonly mode?: number } & Required<AtomicWriteOptions>),
): Promise<void> {
  const { sync, ...writeOptions } = options ?? {};
  if (sync !== undefined) {
    return await writeSynced(
      path,
      new TextEncoder().encode(content),
      writeOptions.mode,
      sync,
    );
  }
  const dir = dirname(path);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    await Deno.writeTextFile(tmpPath, content, writeOptions);
    await Deno.rename(tmpPath, path);
  } catch (error) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Temp file may not exist if writeTextFile failed before creating it
    }
    throw error;
  }
}

export async function atomicWriteFile(
  path: string,
  content: Uint8Array,
  options?: AtomicWriteOptions,
): Promise<void> {
  if (options?.sync !== undefined) {
    return await writeSynced(path, content, undefined, options.sync);
  }
  const dir = dirname(path);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    await Deno.writeFile(tmpPath, content);
    await Deno.rename(tmpPath, path);
  } catch (error) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Temp file may not exist if writeFile failed before creating it
    }
    throw error;
  }
}

/**
 * writes whole to a new temp file beside target and syncs it on the same handle
 * without renaming; the caller renames or removes it; on failure the temp file
 * is removed
 */
export async function writeSyncedTempFile(
  target: string,
  content: Uint8Array,
  sync: AtomicWriteSync,
  mode?: number,
): Promise<string> {
  const tmpPath = join(dirname(target), `.${crypto.randomUUID()}.tmp`);
  const file = await Deno.open(tmpPath, {
    write: true,
    createNew: true,
    ...(mode !== undefined ? { mode } : {}),
  });
  try {
    let written = 0;
    while (written < content.length) {
      written += await file.write(content.subarray(written));
    }
    await syncWrittenFile(file, { temp: tmpPath, target }, sync);
  } catch (error) {
    file.close();
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
  file.close();
  return tmpPath;
}

/**
 * on POSIX it opens read-only, which fsync accepts, so a 0444 file still syncs;
 * Windows needs write access and leaves a file it refuses unsynced, best effort
 */
export async function syncExistingFile(
  path: string,
  sync: AtomicWriteSync,
): Promise<boolean> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(
      path,
      Deno.build.os === "windows" ? { write: true } : { read: true },
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    if (
      Deno.build.os === "windows" &&
      error instanceof Deno.errors.PermissionDenied
    ) {
      return true;
    }
    throw error;
  }
  try {
    await syncWrittenFile(file, { temp: path, target: path }, sync);
  } finally {
    file.close();
  }
  return true;
}

export async function syncWrittenFile(
  file: Deno.FsFile,
  paths: { readonly temp: string; readonly target: string },
  sync: AtomicWriteSync,
): Promise<void> {
  try {
    await (sync.syncFile ?? ((f: Deno.FsFile) => f.sync()))(file, paths);
  } catch (error) {
    throw error instanceof SyncFailedError
      ? error
      : new SyncFailedError(paths.target, error);
  }
}

export async function syncWrittenDirectory(
  dir: string,
  sync: AtomicWriteSync,
): Promise<void> {
  try {
    await (sync.syncDirectory ?? syncDirectoryStrict)(dir);
  } catch (error) {
    throw error instanceof SyncFailedError
      ? error
      : new SyncFailedError(dir, error);
  }
}

/**
 * a failure before the rename leaves the target unchanged; a directory sync
 * failing after it leaves the new target in place and rejects
 */
async function writeSynced(
  path: string,
  content: Uint8Array,
  mode: number | undefined,
  sync: AtomicWriteSync,
): Promise<void> {
  const tmpPath = await writeSyncedTempFile(path, content, sync, mode);
  try {
    await Deno.rename(tmpPath, path);
  } catch (error) {
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
  if (sync.syncParent === false) return;
  await syncWrittenDirectory(dirname(path), sync);
}
