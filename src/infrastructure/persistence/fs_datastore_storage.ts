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
  DatastoreStorage,
  StorageCapabilities,
  StoredChunk,
} from "../../domain/datastore/datastore_storage.ts";
import { atomicWriteFile } from "./atomic_write.ts";
import { assertContainedPath } from "./safe_path.ts";

/** The largest chunk this storage accepts: core's own maximum, 16 MiB. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A namespace slug, or `_solo` for a solo-mode repository. */
const STORAGE_NAMESPACE = /^(?:_solo|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;

/**
 * The filesystem implementation of `storage/1` (swamp-club#3237), and the
 * reference for extension authors: each method is the smallest correct
 * version of the contract.
 *
 * A chunk lives at `<root>/_blobs/<namespace>/sha256/<aa>/<sha256>`, where
 * `<aa>` is the first two hex characters of the hash. A chunk's mtime is
 * its `lastModified`.
 */
export class FileSystemStorage implements DatastoreStorage {
  readonly contract = "storage/1" as const;
  readonly #blobsDir: string;

  /** `datastorePath` is the datastore root, where `_control/` also lives. */
  constructor(datastorePath: string) {
    this.#blobsDir = join(datastorePath, "_blobs");
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
    const path = this.#chunkPath(namespace, sha256);
    await Deno.mkdir(dirname(path), { recursive: true });
    try {
      // A temp file renamed into place: a reader never sees half a chunk.
      await atomicWriteFile(path, bytes);
    } catch (error) {
      // A concurrent put of the same hash can win the rename (Windows
      // refuses to replace a file another rename is replacing). Its bytes
      // are these bytes, so the chunk is stored; only refresh it.
      if ((await this.#size(path)) !== bytes.length) throw error;
      await Deno.utime(path, new Date(), new Date());
    }
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
        // Skips temp files and anything else that is not a chunk.
        if (!entry.isFile || !SHA256_HEX.test(entry.name)) continue;
        try {
          const info = await Deno.stat(join(hashDir, shard.name, entry.name));
          yield {
            sha256: entry.name,
            lastModified: info.mtime ?? new Date(0),
          };
        } catch (error) {
          // Deleted while listing.
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
    try {
      await Deno.remove(this.#chunkPath(namespace, sha256));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  #namespaceDir(namespace: string): string {
    if (!STORAGE_NAMESPACE.test(namespace)) {
      throw new Error(
        `Storage namespace must be a namespace slug or _solo: ${namespace}`,
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
