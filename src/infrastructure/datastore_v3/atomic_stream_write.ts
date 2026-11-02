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
 * nothing is durable until the batch barrier, which fsyncs every file then
 * every changed directory once; sync: false only writes and renames, as
 * read-model catch-up checks its files after a reboot
 */

import { dirname, join } from "@std/path";
import {
  type FileAccess,
  modeWithAccess,
} from "../../domain/datastore_v3/file_access.ts";
import { syncDirectory } from "../persistence/sync_directory.ts";

export { syncDirectory };

/** Files a batch holds open before it syncs them early: under macOS's 256. */
const DEFAULT_MAX_OPEN_FILES = 64;

const SYNC_PARALLELISM = 64;

export interface DurableWriteBatchOptions {
  /**
   * false writes and renames without syncing, so the barrier does nothing;
   * read-model catch-up uses it and checks the files after a reboot instead
   */
  readonly sync?: boolean;
  readonly maxOpenFiles?: number;
  readonly syncFile?: (file: Deno.FsFile) => Promise<void>;
  readonly syncDirectory?: (dir: string) => Promise<void>;
}

/**
 * each written file stays open until synced, so its fsync reports any
 * write-back error on the handle that wrote it; call discard when done,
 * whatever happened
 */
export class DurableWriteBatch {
  readonly #sync: boolean;
  readonly #maxOpenFiles: number;
  readonly #syncFile: (file: Deno.FsFile) => Promise<void>;
  readonly #syncDirectory: (dir: string) => Promise<void>;
  readonly #held = new Map<string, Deno.FsFile>();
  readonly #dirs = new Set<string>();

  constructor(options: DurableWriteBatchOptions = {}) {
    this.#sync = options.sync ?? true;
    this.#maxOpenFiles = options.maxOpenFiles ?? DEFAULT_MAX_OPEN_FILES;
    this.#syncFile = options.syncFile ?? ((file) => file.sync());
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  /**
   * options.access is applied to the temp file before the rename, so path never
   * exists without it (ignored on Windows); on failure, including abort, the
   * temp file is removed and path is left as it was
   */
  async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options: {
      readonly absentDirectories?: readonly string[];
      readonly written?: (info: Deno.FileInfo) => void;
      readonly access?: FileAccess;
    } = {},
  ): Promise<void> {
    await this.release(path);
    const dir = dirname(path);
    const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
    let file: Deno.FsFile | undefined;
    let created: string[];
    try {
      created = options.absentDirectories !== undefined
        ? [...options.absentDirectories]
        : await missingDirectories(dir);
      if (created.length > 0) await Deno.mkdir(dir, { recursive: true });
      try {
        file = await Deno.open(tmpPath, { write: true, createNew: true });
      } catch (error) {
        // A hint can be stale: the directory was removed since the caller
        // looked. Find what is missing and make it, as without a hint.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        created = await missingDirectories(dir);
        await Deno.mkdir(dir, { recursive: true });
        file = await Deno.open(tmpPath, { write: true, createNew: true });
      }
      if (content instanceof Uint8Array) {
        await writeAll(file, content);
      } else {
        for await (const piece of content) {
          signal.throwIfAborted();
          await writeAll(file, piece);
        }
      }
      signal.throwIfAborted();
      if (options.access !== undefined && Deno.build.os !== "windows") {
        // The temp file is this batch's own (created new, under a random
        // name), so chmod by path cannot follow a link to another file.
        const created = (await file.stat()).mode ?? 0o666;
        await Deno.chmod(tmpPath, modeWithAccess(created, options.access));
      }
      options.written?.(await file.stat());
      if (!this.#sync) {
        // Nothing to sync, so nothing to hold: close before the rename, as
        // Windows prefers.
        const written = file;
        file = undefined;
        written.close();
      }
      await Deno.rename(tmpPath, path);
    } catch (error) {
      file?.close();
      await Deno.remove(tmpPath).catch(() => {});
      // A stream never read (the directory or temp file failed first) is
      // cancelled, so its source stops; one read in part is already released.
      if (!(content instanceof Uint8Array) && !content.locked) {
        await content.cancel(error).catch(() => {});
      }
      throw error;
    }
    if (file === undefined) return;
    this.#held.set(path, file);
    this.#dirs.add(dir);
    // A directory this write created is durable only once its parent is
    // synced; otherwise a power loss could drop the file with it.
    for (const made of created) this.#dirs.add(dirname(made));
    if (this.#held.size >= this.#maxOpenFiles) await this.#syncHeld();
  }

  get syncs(): boolean {
    return this.#sync;
  }

  /**
   * Syncs and closes the file this batch wrote at `path`, if it holds one.
   * Call it before removing `path`: Windows cannot replace or remove a file
   * that is still open.
   */
  async release(path: string): Promise<void> {
    const file = this.#held.get(path);
    if (file === undefined) return;
    this.#held.delete(path);
    try {
      await this.#syncFile(file);
    } finally {
      file.close();
    }
  }

  touch(dir: string): void {
    if (this.#sync) this.#dirs.add(dir);
  }

  async barrier(): Promise<void> {
    await this.#syncHeld();
    // A path is longer than any of its ancestors, so this puts each
    // directory before its parents.
    const dirs = [...this.#dirs].sort((a, b) => b.length - a.length);
    this.#dirs.clear();
    await forEachBounded(dirs, (dir) => this.#syncDirectory(dir));
  }

  discard(): void {
    for (const file of this.#held.values()) file.close();
    this.#held.clear();
    this.#dirs.clear();
  }

  async #syncHeld(): Promise<void> {
    const files = [...this.#held.values()];
    this.#held.clear();
    await forEachBounded(files, async (file) => {
      try {
        await this.#syncFile(file);
      } finally {
        file.close();
      }
    });
  }
}

export async function writeFileDurably(
  path: string,
  content: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: Pick<DurableWriteBatchOptions, "syncFile" | "syncDirectory"> = {},
): Promise<void> {
  const batch = new DurableWriteBatch(options);
  try {
    await batch.write(path, content, signal);
    await batch.barrier();
  } finally {
    batch.discard();
  }
}

/** every item runs even after one fails; the first error is thrown */
async function forEachBounded<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SYNC_PARALLELISM, items.length) }, worker),
  );
  if (failure !== undefined) throw failure.error;
}

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

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}
