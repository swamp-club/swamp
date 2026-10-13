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
 * Writes files so they survive a crash (swamp-club#3239, swamp-club#3337).
 * A {@link DurableWriteBatch} writes each file to a temp file in the target's
 * directory and renames it into place, so a reader sees the old file or the
 * new one, never a partial one. Nothing is durable until the batch's
 * {@link DurableWriteBatch.barrier}: it fsyncs every file written, then every
 * directory a write or removal changed, once each.
 *
 * Batching is what makes a sync affordable: on macOS an fsync flushes the
 * drive's cache, about 7.5 ms per file when each write syncs on its own, and
 * a fraction of that per file when one barrier syncs them together. A batch
 * made with `sync: false` writes and renames only: the read model's
 * catch-up uses one, and checks its files after a reboot instead.
 *
 * Unlike `atomicWriteFile` in `persistence/atomic_write.ts`, it streams its
 * content and fsyncs.
 *
 * @module
 */

import { dirname, join } from "@std/path";

/** Files a batch holds open before it syncs them early: under macOS's 256. */
const DEFAULT_MAX_OPEN_FILES = 64;

/** Syncs a batch runs at once. */
const SYNC_PARALLELISM = 64;

/** Options for {@link DurableWriteBatch}. */
export interface DurableWriteBatchOptions {
  /**
   * False writes and renames without syncing anything: the barrier does
   * nothing. The read model's catch-up uses it and checks the files after a
   * reboot instead (swamp-club#3337). True by default.
   */
  readonly sync?: boolean;
  /** Written files held open before the batch syncs them early. */
  readonly maxOpenFiles?: number;
  /** How a written file is synced; `file.sync()` by default. */
  readonly syncFile?: (file: Deno.FsFile) => Promise<void>;
  /** How a directory is synced; {@link syncDirectory} by default. */
  readonly syncDirectory?: (dir: string) => Promise<void>;
}

/**
 * Writes and removals made durable together at a {@link barrier}. Each
 * written file stays open until it is synced, so its fsync reports any
 * write-back error on the handle that wrote it. Call {@link discard} when
 * done, whatever happened.
 */
export class DurableWriteBatch {
  readonly #sync: boolean;
  readonly #maxOpenFiles: number;
  readonly #syncFile: (file: Deno.FsFile) => Promise<void>;
  readonly #syncDirectory: (dir: string) => Promise<void>;
  /** Written files not yet synced, by path. */
  readonly #held = new Map<string, Deno.FsFile>();
  /** Directories to sync at the barrier. */
  readonly #dirs = new Set<string>();

  constructor(options: DurableWriteBatchOptions = {}) {
    this.#sync = options.sync ?? true;
    this.#maxOpenFiles = options.maxOpenFiles ?? DEFAULT_MAX_OPEN_FILES;
    this.#syncFile = options.syncFile ?? ((file) => file.sync());
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
  }

  /**
   * Writes `content` to `path` through a temp file and a rename, creating
   * its directory. `options.absentDirectories`, the directories above `path`
   * the caller just found absent, deepest first, saves looking them up; an
   * empty list says the directory exists. On failure, including an abort of
   * `signal` while streaming, the temp file is removed and `path` is left as
   * it was.
   */
  async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options: { readonly absentDirectories?: readonly string[] } = {},
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

  /** Whether the barrier syncs anything. */
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

  /** Records that an entry of `dir` was removed, so the barrier syncs it. */
  touch(dir: string): void {
    if (this.#sync) this.#dirs.add(dir);
  }

  /**
   * Makes every write and removal so far durable: syncs each written file,
   * then each touched directory once, deepest first.
   */
  async barrier(): Promise<void> {
    await this.#syncHeld();
    // A path is longer than any of its ancestors, so this puts each
    // directory before its parents.
    const dirs = [...this.#dirs].sort((a, b) => b.length - a.length);
    this.#dirs.clear();
    await forEachBounded(dirs, (dir) => this.#syncDirectory(dir));
  }

  /** Closes every file still held, without syncing it. */
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

/**
 * Writes `content` to `path` durably: one {@link DurableWriteBatch} write and
 * its barrier. The read model writes through batches; this is the one-file
 * form.
 */
export async function writeFileDurably(
  path: string,
  content: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const batch = new DurableWriteBatch();
  try {
    await batch.write(path, content, signal);
    await batch.barrier();
  } finally {
    batch.discard();
  }
}

/**
 * Runs `fn` over `items`, {@link SYNC_PARALLELISM} at a time, in order of
 * start. Every item runs even after one fails; the first error is thrown.
 */
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
