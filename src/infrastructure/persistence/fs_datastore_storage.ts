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
import type {
  ChunkDirectorySync,
  ChunkQuarantine,
  ChunkStage,
  ChunkStaging,
  ChunkStat,
  ChunkStatReader,
  DatastoreStorage,
  QuarantinedChunk,
  StorageCapabilities,
  StoredChunk,
  TempFileSweeper,
} from "../../domain/datastore/datastore_storage.ts";
import { assertContainedPath } from "./safe_path.ts";
import { barrierSync, type BarrierSyncResult } from "./barrier_sync.ts";
import { syncDirectory } from "./sync_directory.ts";

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TEMP_FILE =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const STORAGE_NAMESPACE = /^(?:_default|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;
const MAX_NAMESPACE_LENGTH = 64;
const SYNC_PARALLELISM = 64;
/**
 * past this the memo starts over, which only costs directory syncs it could
 * have skipped
 */
const MAX_DURABLE_CHUNKS = 100_000;

/**
 * each ancestor is synced once per process whoever created it; a put that
 * creates a directory below one drops it, so the next sync covers the new entry
 */
const SYNCED_ANCESTORS = new Map<string, Promise<void>>();

const DURABLE = Object.freeze({});

/**
 * a chunk is marked only by a directory sync started after its last put, move
 * or delete here, each of which drops it; a sync in flight marks with its own
 * token and keeps only chunks still holding it
 */
const DURABLE_CHUNKS = new Map<string, object>();

/**
 * devices whose volume refused the macOS ordering barrier in this process go
 * straight to the full sync
 */
const FULL_SYNC_DEVICES = new Set<number>();

export interface FileSystemStorageOptions {
  readonly syncFile?: (file: Deno.FsFile) => Promise<void>;
  readonly syncDirectory?: (dir: string) => Promise<void>;
  readonly syncedAncestors?: Map<string, Promise<void>>;
  readonly durableChunks?: Map<string, object>;
  /**
   * when only the commits.db device makes commits durable, chunks on macOS sync
   * with the ordering barrier instead of a drive-cache flush; unset, every sync
   * is full
   */
  readonly orderedBefore?: string;
  readonly barrierSync?: (path: string) => Promise<BarrierSyncResult>;
  readonly deviceOf?: (path: string) => Promise<number>;
  readonly platform?: typeof Deno.build.os;
  readonly fullSyncDevices?: Set<number>;
}

/**
 * reference for extension authors: each method is the smallest correct version
 * of the contract. A put syncs its temp file before the rename so a chunk's
 * name never points at bytes a power loss could tear
 */
export class FileSystemStorage
  implements
    DatastoreStorage,
    TempFileSweeper,
    ChunkStatReader,
    ChunkStaging,
    ChunkDirectorySync,
    ChunkQuarantine {
  readonly contract = "storage/1" as const;
  readonly #root: string;
  readonly #blobsDir: string;
  readonly #syncFile: (file: Deno.FsFile) => Promise<void>;
  readonly #syncDirectory: (dir: string) => Promise<void>;
  readonly #syncedAncestors: Map<string, Promise<void>>;
  readonly #durableChunks: Map<string, object>;
  readonly #orderedBefore: string | undefined;
  readonly #barrierSync: (path: string) => Promise<BarrierSyncResult>;
  readonly #deviceOf: (path: string) => Promise<number>;
  readonly #platform: typeof Deno.build.os;
  readonly #fullSyncDevices: Set<number>;
  #barrierDeviceLookup: Promise<number | undefined> | undefined;

  constructor(datastorePath: string, options: FileSystemStorageOptions = {}) {
    this.#root = datastorePath;
    this.#blobsDir = join(datastorePath, "_blobs");
    this.#syncFile = options.syncFile ?? ((file) => file.sync());
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
    this.#syncedAncestors = options.syncedAncestors ?? SYNCED_ANCESTORS;
    this.#durableChunks = options.durableChunks ?? DURABLE_CHUNKS;
    this.#orderedBefore = options.orderedBefore;
    this.#barrierSync = options.barrierSync ?? ((path) => barrierSync(path));
    this.#deviceOf = options.deviceOf ??
      (async (path) => (await Deno.stat(path)).dev);
    this.#platform = options.platform ?? Deno.build.os;
    this.#fullSyncDevices = options.fullSyncDevices ?? FULL_SYNC_DEVICES;
  }

  capabilities(): StorageCapabilities {
    return { maxChunkBytes: MAX_CHUNK_BYTES, touch: true };
  }

  async has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    signal.throwIfAborted();
    const found = await Promise.all(
      hashes.map((sha256) => this.#exists(this.#chunkPath(namespace, sha256))),
    );
    return new Set(hashes.filter((_, i) => found[i]));
  }

  async put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const stage = this.stageChunks(namespace);
    try {
      await stage.put(sha256, bytes, signal);
      await stage.commit(signal);
    } catch (error) {
      // if the chunk in place already holds exactly these bytes, only refresh
      // it; otherwise rethrow, since a put must never leave a damaged chunk in
      // place
      const path = this.#chunkPath(namespace, sha256);
      if (signal.aborted || !(await this.#holds(path, bytes))) throw error;
      await Deno.utime(path, new Date(), new Date());
    } finally {
      await stage.discard();
    }
  }

  /**
   * temp files are closed unsynced and the commit syncs them all before any
   * rename so the syncs coalesce; on macOS each sync is a drive-cache flush
   * unless the ordering barrier may run
   */
  stageChunks(namespace: string): ChunkStage {
    const staged = new Map<string, string>();
    /**
     * reserved before the temp file is written, so a concurrent put of the same
     * hash shares it instead of writing a second temp file nothing would remove
     */
    const writes = new Map<string, Promise<void>>();
    let ended = false;
    const removeStaged = async () => {
      const left = [...staged.values()];
      staged.clear();
      await Promise.all(left.map((tmp) => Deno.remove(tmp).catch(() => {})));
    };
    const write = async (sha256: string, bytes: Uint8Array) => {
      const path = this.#chunkPath(namespace, sha256);
      await this.#makeShard(namespace, dirname(path));
      const tmp = await writeTemp(path, bytes);
      if (ended) {
        // The stage ended while this was written: nothing would remove it.
        await Deno.remove(tmp).catch(() => {});
        throw new Error("This chunk stage has ended");
      }
      staged.set(sha256, tmp);
    };
    return {
      put: async (sha256, bytes, signal) => {
        signal.throwIfAborted();
        if (ended) throw new Error("This chunk stage has ended");
        const pending = writes.get(sha256);
        if (pending !== undefined) return await pending;
        const written = write(sha256, bytes);
        writes.set(sha256, written);
        try {
          await written;
        } catch (error) {
          // A failed write reserves nothing: a later put tries again.
          if (writes.get(sha256) === written) writes.delete(sha256);
          throw error;
        }
      },
      commit: async (signal) => {
        ended = true;
        try {
          signal.throwIfAborted();
          // A synced temp file renamed into place: a reader never sees half
          // a chunk, and a power loss never leaves the name on unwritten
          // bytes.
          await forEachBounded(
            [...staged.values()],
            (tmp) => this.#syncTemp(tmp),
          );
          signal.throwIfAborted();
          for (const [sha256, tmp] of staged) {
            await this.#renameInto(tmp, this.#chunkPath(namespace, sha256));
            staged.delete(sha256);
          }
        } finally {
          await removeStaged();
        }
      },
      discard: async () => {
        ended = true;
        await removeStaged();
      },
    };
  }

  async get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    signal.throwIfAborted();
    try {
      return await Deno.readFile(this.#chunkPath(namespace, sha256), {
        signal,
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  /** Sizes read with `stat`; a non-file entry counts as not stored. */
  async statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>> {
    signal.throwIfAborted();
    const stats = await Promise.all(
      hashes.map(async (sha256) => {
        try {
          const info = await Deno.stat(this.#chunkPath(namespace, sha256));
          return info.isFile
            ? { size: info.size, lastModified: info.mtime ?? new Date(0) }
            : undefined;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        }
      }),
    );
    const found = new Map<string, ChunkStat>();
    hashes.forEach((sha256, i) => {
      const stat = stats[i];
      if (stat !== undefined) found.set(sha256, stat);
    });
    return found;
  }

  /**
   * a chunk counts as durable once covered here, until this process puts, moves
   * or deletes it again; one another process stored is synced when first named;
   * concurrent callers share an ancestor sync
   */
  async syncChunkDirectories(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const paths = [
      ...new Set(hashes.map((sha256) => this.#chunkPath(namespace, sha256))),
    ].filter((path) => this.#durableChunks.get(path) !== DURABLE);
    if (paths.length === 0) return;
    if (this.#durableChunks.size + paths.length > MAX_DURABLE_CHUNKS) {
      this.#durableChunks.clear();
    }
    const token = {};
    for (const path of paths) this.#durableChunks.set(path, token);
    try {
      const shards = [...new Set(paths.map((path) => dirname(path)))];
      await forEachBounded(shards, (dir) => this.#syncDir(dir));
      signal.throwIfAborted();
      for (const dir of this.#ancestorsOf(namespace)) {
        await this.#syncAncestor(dir);
      }
    } catch (error) {
      for (const path of paths) {
        if (this.#durableChunks.get(path) === token) {
          this.#durableChunks.delete(path);
        }
      }
      throw error;
    }
    for (const path of paths) {
      if (this.#durableChunks.get(path) === token) {
        this.#durableChunks.set(path, DURABLE);
      }
    }
  }

  /**
   * mtime is set to now so another process's temp-file sweep keeps the chunk
   * for a grace period; a sweep that removes it anyway is treated as done
   */
  async quarantineChunk(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<QuarantinedChunk | undefined> {
    signal.throwIfAborted();
    const path = this.#chunkPath(namespace, sha256);
    const aside = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
    this.#durableChunks.delete(path);
    try {
      await Deno.rename(path, aside);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    const now = new Date();
    await Deno.utime(aside, now, now).catch(ignoreNotFound);
    return {
      read: async (readSignal) => {
        readSignal.throwIfAborted();
        try {
          return await Deno.readFile(aside, { signal: readSignal });
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return null;
          throw error;
        }
      },
      remove: async (removeSignal) => {
        removeSignal.throwIfAborted();
        await Deno.remove(aside).catch(ignoreNotFound);
      },
      putBack: async (putSignal) => {
        putSignal.throwIfAborted();
        this.#durableChunks.delete(path);
        // Linked, never renamed, back: a link fails when a chunk is at the
        // path already, one another process stored since this moved it
        // aside, and that chunk is kept.
        try {
          await Deno.link(aside, path);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          if (!(error instanceof Deno.errors.AlreadyExists)) {
            // A file system without hard links: put back only onto nothing.
            if (await this.#exists(path)) {
              await Deno.remove(aside).catch(ignoreNotFound);
              return;
            }
            await Deno.rename(aside, path).catch(ignoreNotFound);
            return;
          }
        }
        // Back, or kept out by a chunk there: the moved-aside name goes
        // either way, and a temp-file sweep removes it if this cannot.
        await Deno.remove(aside).catch(() => {});
      },
    };
  }

  async touch(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    signal.throwIfAborted();
    const now = new Date();
    const missing = new Set<string>();
    for (const sha256 of hashes) {
      try {
        await Deno.utime(this.#chunkPath(namespace, sha256), now, now);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        missing.add(sha256);
      }
    }
    return missing;
  }

  async *list(
    namespace: string,
    signal: AbortSignal,
  ): AsyncIterable<StoredChunk> {
    signal.throwIfAborted();
    const hashDir = join(this.#namespaceDir(namespace), "sha256");
    for (const shard of await this.#entries(hashDir)) {
      if (!shard.isDirectory || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      for (const entry of await this.#entries(join(hashDir, shard.name))) {
        signal.throwIfAborted();
        if (!entry.isFile || !SHA256_HEX.test(entry.name)) continue;
        try {
          const info = await Deno.stat(join(hashDir, shard.name, entry.name));
          yield {
            sha256: entry.name,
            lastModified: info.mtime ?? new Date(0),
          };
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    }
  }

  async delete(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const path = this.#chunkPath(namespace, sha256);
    this.#durableChunks.delete(path);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  /**
   * chunk garbage collection passes its grace cutoff, so a put still writing
   * keeps its file; not part of storage/1
   */
  async removeStaleTempFiles(
    namespace: string,
    olderThan: Date,
    signal: AbortSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    const hashDir = join(this.#namespaceDir(namespace), "sha256");
    let removed = 0;
    for (const shard of await this.#entries(hashDir)) {
      if (!shard.isDirectory || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      for (const entry of await this.#entries(join(hashDir, shard.name))) {
        signal.throwIfAborted();
        if (!entry.isFile || !TEMP_FILE.test(entry.name)) continue;
        const path = join(hashDir, shard.name, entry.name);
        try {
          const mtime = (await Deno.stat(path)).mtime;
          if (mtime === null || mtime.getTime() >= olderThan.getTime()) {
            continue;
          }
          await Deno.remove(path);
          removed++;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    }
    return removed;
  }

  #namespaceDir(namespace: string): string {
    if (
      namespace.length > MAX_NAMESPACE_LENGTH ||
      !STORAGE_NAMESPACE.test(namespace)
    ) {
      throw new Error(
        `Storage namespace must be a namespace slug or _default: ${namespace}`,
      );
    }
    assertContainedPath(namespace, this.#blobsDir);
    return join(this.#blobsDir, namespace);
  }

  #chunkPath(namespace: string, sha256: string): string {
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(
        `Chunk hash must be 64 lowercase hex characters: ${sha256}`,
      );
    }
    return join(
      this.#namespaceDir(namespace),
      "sha256",
      sha256.slice(0, 2),
      sha256,
    );
  }

  #ancestorsOf(namespace: string): string[] {
    const namespaceDir = this.#namespaceDir(namespace);
    return [
      join(namespaceDir, "sha256"),
      namespaceDir,
      this.#blobsDir,
      this.#root,
    ];
  }

  async #syncAncestor(dir: string): Promise<void> {
    let sync = this.#syncedAncestors.get(dir);
    if (sync === undefined) {
      // A failed sync is forgotten, so the next caller tries again.
      const started: Promise<void> = this.#syncDir(dir).catch(
        (error) => {
          if (this.#syncedAncestors.get(dir) === started) {
            this.#syncedAncestors.delete(dir);
          }
          throw error;
        },
      );
      sync = started;
      this.#syncedAncestors.set(dir, started);
    }
    await sync;
  }

  /**
   * a directory created here is a new entry in its parent, so the parent is
   * dropped from the memo and synced again at the next syncChunkDirectories
   */
  async #makeShard(namespace: string, shard: string): Promise<void> {
    try {
      await Deno.mkdir(shard);
      this.#syncedAncestors.delete(dirname(shard));
      return;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) return;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.mkdir(shard, { recursive: true });
    for (const dir of this.#ancestorsOf(namespace)) {
      this.#syncedAncestors.delete(dir);
    }
  }

  async #syncTemp(tmp: string): Promise<void> {
    if (await this.#barrier(tmp)) return;
    // Windows syncs only a handle opened for writing.
    const file = await Deno.open(tmp, { write: true });
    try {
      await this.#syncFile(file);
    } finally {
      file.close();
    }
  }

  async #syncDir(dir: string): Promise<void> {
    if (await this.#barrier(dir)) return;
    await this.#syncDirectory(dir);
  }

  /**
   * a volume that refuses the barrier is remembered, so its later syncs go
   * straight to the full sync; nothing falls back to no sync
   */
  async #barrier(path: string): Promise<boolean> {
    const device = await this.#barrierDevice();
    if (device === undefined || this.#fullSyncDevices.has(device)) {
      return false;
    }
    if ((await this.#barrierSync(path)) === "synced") return true;
    this.#fullSyncDevices.add(device);
    return false;
  }

  #barrierDevice(): Promise<number | undefined> {
    const orderedBefore = this.#orderedBefore;
    if (orderedBefore === undefined || this.#platform !== "darwin") {
      return Promise.resolve(undefined);
    }
    this.#barrierDeviceLookup ??= (async () => {
      try {
        const [blobs, commits] = await Promise.all([
          this.#deviceOf(this.#blobsDir),
          this.#deviceOf(dirname(orderedBefore)),
        ]);
        return blobs === commits ? blobs : undefined;
      } catch {
        return undefined;
      }
    })();
    return this.#barrierDeviceLookup;
  }

  async #renameInto(tmp: string, path: string): Promise<void> {
    this.#durableChunks.delete(path);
    try {
      await Deno.rename(tmp, path);
    } catch (error) {
      // a concurrent put of the same hash can win the rename (Windows refuses
      // to replace a file another rename is replacing); identical bytes in
      // place are only refreshed, anything else rethrows
      if (!(await this.#holdsSame(path, tmp))) throw error;
      await Deno.utime(path, new Date(), new Date());
      await Deno.remove(tmp).catch(() => {});
    }
  }

  async #holds(path: string, bytes: Uint8Array): Promise<boolean> {
    if ((await this.#size(path)) !== bytes.length) return false;
    const stored = await Deno.readFile(path);
    return stored.every((byte, i) => byte === bytes[i]);
  }

  async #holdsSame(path: string, tmp: string): Promise<boolean> {
    const size = await this.#size(path);
    if (size === null || size !== (await this.#size(tmp))) return false;
    const [stored, staged] = await Promise.all([
      Deno.readFile(path),
      Deno.readFile(tmp),
    ]);
    return stored.every((byte, i) => byte === staged[i]);
  }

  async #exists(path: string): Promise<boolean> {
    return (await this.#size(path)) !== null;
  }

  async #size(path: string): Promise<number | null> {
    try {
      const info = await Deno.stat(path);
      return info.isFile ? info.size : null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  async #entries(dir: string): Promise<Deno.DirEntry[]> {
    try {
      return await Array.fromAsync(Deno.readDir(dir));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }
}

async function writeTemp(path: string, bytes: Uint8Array): Promise<string> {
  const tmp = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(tmp, { write: true, createNew: true });
    let written = 0;
    while (written < bytes.length) {
      written += await file.write(bytes.subarray(written));
    }
  } catch (error) {
    file?.close();
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
  // Closed before it is synced or renamed, as Windows requires.
  file.close();
  return tmp;
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
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
