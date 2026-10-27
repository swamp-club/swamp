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
import { syncDirectory } from "./sync_directory.ts";

/**
 * How an atomic write is made durable (swamp-club#4017). Each hook is
 * injectable so tests can observe the order; production passes `{}`.
 */
export interface AtomicWriteSync {
  /**
   * Syncs the written file before it is renamed into place; `file.sync()`
   * by default. `paths.target` is where the file is going, `paths.temp`
   * where it is now.
   */
  readonly syncFile?: (
    file: Deno.FsFile,
    paths: { readonly temp: string; readonly target: string },
  ) => Promise<void>;
  /** Syncs a directory; {@link syncDirectory} by default. */
  readonly syncDirectory?: (dir: string) => Promise<void>;
  /**
   * Whether the parent directory is synced after the rename; true by
   * default. A caller writing several files into one directory passes
   * false and syncs the directory once itself.
   */
  readonly syncParent?: boolean;
}

/** Options of the atomic write helpers. */
export interface AtomicWriteOptions {
  /**
   * Makes the write durable: the temp file is synced before the rename and
   * its directory after it. Absent, the write is atomic but not synced.
   */
  readonly sync?: AtomicWriteSync;
}

/**
 * Writes text content to a file atomically.
 *
 * Writes to a temporary file in the same directory, then renames to the
 * target path. This ensures the file is never left in a partially-written
 * state if the process crashes mid-write. With `options.sync` it is also
 * durable when this returns (see {@link AtomicWriteOptions.sync}).
 *
 * @param path The target file path
 * @param content The text content to write
 */
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

/**
 * Writes binary content to a file atomically.
 *
 * Writes to a temporary file in the same directory, then renames to the
 * target path. This ensures the file is never left in a partially-written
 * state if the process crashes mid-write. With `options.sync` it is also
 * durable when this returns (see {@link AtomicWriteOptions.sync}).
 *
 * @param path The target file path
 * @param content The binary content to write
 */
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
 * Writes `content` whole to a new temp file beside `target`, syncs it on
 * the handle that wrote it and closes it, without renaming it. Resolves the
 * temp path; the caller renames it into place, or removes it. On failure
 * the temp file is removed.
 */
export async function writeSyncedTempFile(
  target: string,
  content: Uint8Array,
  sync: AtomicWriteSync,
  mode?: number,
): Promise<string> {
  const tmpPath = join(dirname(target), `.${crypto.randomUUID()}.tmp`);
  const syncFile = sync.syncFile ?? ((file: Deno.FsFile) => file.sync());
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
    await syncFile(file, { temp: tmpPath, target });
  } catch (error) {
    file.close();
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
  file.close();
  return tmpPath;
}

/**
 * Syncs a file swamp did not write through a handle of its own, such as
 * content a subprocess wrote to a path it was given. Resolves false when
 * there is no file at `path`, true otherwise.
 *
 * On POSIX the file is opened read-only, which fsync accepts, so a file
 * left read-only (mode 0444) still syncs. Windows needs write access to
 * flush a file; a file it refuses to open for writing is left unsynced,
 * best effort. A sync through a new descriptor still reports a write-back
 * error no other descriptor has seen (Linux 4.16+).
 */
export async function syncExistingFile(
  path: string,
  sync: AtomicWriteSync,
): Promise<boolean> {
  const syncFile = sync.syncFile ?? ((file: Deno.FsFile) => file.sync());
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
    await syncFile(file, { temp: path, target: path });
  } finally {
    file.close();
  }
  return true;
}

/**
 * The synced form of the atomic writes: written whole and synced before
 * the rename, the directory synced after it. A failure before the rename
 * leaves the target unchanged; a directory sync that fails after it (only
 * an injected hook can, {@link syncDirectory} never throws) leaves the new
 * target in place.
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
  await (sync.syncDirectory ?? syncDirectory)(dirname(path));
}
