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
 * serve's chunk endpoints offer no list, delete or touch, since chunk
 * collection belongs to serve; a put names no partition so serve takes it only
 * from admin, and commits carry their chunks. A cache sits in front
 */

import {
  type DatastoreStorage,
  STORAGE_CONTRACT,
  type StorageCapabilities,
  type StoredChunk,
} from "../../domain/datastore/datastore_storage.ts";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import { UserError } from "../../domain/errors.ts";
import {
  FileSystemStorage,
  type FileSystemStorageOptions,
} from "../persistence/fs_datastore_storage.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";

export const SERVE_STORAGE_UNSUPPORTED_CODE =
  "datastore_v3_serve_storage_unsupported";

export class ServeStorageUnsupportedError extends UserError {
  constructor(readonly method: "list" | "delete") {
    super(
      `Serve's datastore API has no way to ${
        method === "list" ? "list" : "delete"
      } chunks: chunk collection is done by serve, which owns the ` +
        `datastore's storage.`,
      SERVE_STORAGE_UNSUPPORTED_CODE,
    );
    this.name = "ServeStorageUnsupportedError";
  }
}

type ChunkClient = Pick<
  ServeDatastoreClient,
  "hasChunks" | "getChunk" | "putChunk" | "namespace"
>;

export class ServeChunkStorage implements DatastoreStorage {
  readonly contract = STORAGE_CONTRACT;
  readonly #client: ChunkClient;

  constructor(client: ChunkClient) {
    this.#client = client;
  }

  capabilities(): StorageCapabilities {
    return { maxChunkBytes: CHUNK_BYTES, touch: false };
  }

  async has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    signal.throwIfAborted();
    if (!this.#bound(namespace) || hashes.length === 0) return new Set();
    return await this.#client.hasChunks(hashes, signal);
  }

  async put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.#assertBound(namespace);
    await this.#client.putChunk(sha256, bytes, signal);
  }

  async get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    signal.throwIfAborted();
    if (!this.#bound(namespace)) return null;
    return await this.#client.getChunk(sha256, signal);
  }

  list(_namespace: string, signal: AbortSignal): AsyncIterable<StoredChunk> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<StoredChunk>> {
            if (signal.aborted) return Promise.reject(signal.reason);
            return Promise.reject(new ServeStorageUnsupportedError("list"));
          },
        };
      },
    };
  }

  delete(
    _namespace: string,
    _sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return Promise.reject(new ServeStorageUnsupportedError("delete"));
  }

  #bound(namespace: string): boolean {
    return storageNamespaceOf(namespace) === this.#client.namespace;
  }

  #assertBound(namespace: string): void {
    if (!this.#bound(namespace)) {
      throw new Error(
        `Serve's datastore API here serves namespace ` +
          `${this.#client.namespace}, not ${storageNamespaceOf(namespace)}`,
      );
    }
  }
}

export function storageNamespaceOf(namespace: string): string {
  return namespace === "" ? "_default" : namespace;
}

export class CachedServeStorage extends FileSystemStorage {
  readonly #remote: DatastoreStorage;
  readonly #offline: () => boolean;

  constructor(
    cacheRoot: string,
    remote: DatastoreStorage,
    options: FileSystemStorageOptions & {
      /**
       * whether the checkout works offline: the cache alone answers then, so
       * storing content never waits on serve
       */
      readonly offline?: () => boolean;
    } = {},
  ) {
    super(cacheRoot, options);
    this.#remote = remote;
    this.#offline = options.offline ?? (() => false);
  }

  override async has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const local = await super.has(namespace, hashes, signal);
    const rest = hashes.filter((hash) => !local.has(hash));
    if (rest.length === 0 || this.#offline()) return local;
    for (const hash of await this.#remote.has(namespace, rest, signal)) {
      local.add(hash);
    }
    return local;
  }

  override async get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const local = await super.get(namespace, sha256, signal);
    if (local !== null || this.#offline()) return local;
    const bytes = await this.#remote.get(namespace, sha256, signal);
    // The client checked the bytes' hash; keep them for the next read.
    if (bytes !== null) await super.put(namespace, sha256, bytes, signal);
    return bytes;
  }
}
