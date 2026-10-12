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

/**
 * Writes a file so it survives a crash (swamp-club#3239): content goes to a
 * temp file in the target's directory, is fsynced, and is renamed into
 * place; then the directory is fsynced so the rename is durable too. A
 * reader sees the old file or the new one, never a partial one.
 *
 * Unlike `atomicWriteFile` in `persistence/atomic_write.ts`, it streams its
 * content and fsyncs: the read model advances its cursor only once a
 * commit's files are durable.
 *
 * @module
 */

import { dirname, join } from "@std/path";

/**
 * Writes `content` to `path` durably, creating its directory and syncing
 * every directory it created. On failure,
 * including an abort of `signal` while streaming, the temp file is removed
 * and `path` is left as it was.
 */
export async function writeFileDurably(
  path: string,
  content: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  let created: string[] = [];
  try {
    created = await missingDirectories(dir);
    await Deno.mkdir(dir, { recursive: true });
    const file = await Deno.open(tmpPath, { write: true, createNew: true });
    try {
      if (content instanceof Uint8Array) {
        await writeAll(file, content);
      } else {
        for await (const piece of content) {
          signal.throwIfAborted();
          await writeAll(file, piece);
        }
      }
      signal.throwIfAborted();
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(tmpPath, path);
  } catch (error) {
    await Deno.remove(tmpPath).catch(() => {});
    // A stream never read (the directory or temp file failed first) is
    // cancelled, so its source stops; one read in part is already released.
    if (!(content instanceof Uint8Array) && !content.locked) {
      await content.cancel(error).catch(() => {});
    }
    throw error;
  }
  await syncDirectory(dir);
  // A directory this write created is durable only once its parent is
  // synced; otherwise a power loss could drop the file with it.
  for (const made of created) await syncDirectory(dirname(made));
}

/**
 * The directories from `dir` up that do not exist yet, deepest first: the
 * ones `mkdir` with `recursive` creates.
 */
async function missingDirectories(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = dir;; current = dirname(current)) {
    try {
      await Deno.lstat(current);
      return missing;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    missing.push(current);
    if (dirname(current) === current) return missing;
  }
}

/**
 * Fsyncs a directory so a rename or removal in it is durable. Windows cannot
 * open a directory to sync it, and some filesystems refuse; both are
 * skipped, as SQLite skips them.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  let handle: Deno.FsFile | undefined;
  try {
    handle = await Deno.open(dir, { read: true });
    await handle.sync();
  } catch {
    // Best effort: the file itself is already synced.
  } finally {
    handle?.close();
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}
