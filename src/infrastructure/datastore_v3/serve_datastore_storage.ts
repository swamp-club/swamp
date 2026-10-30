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
 * Chunk storage for a v3 checkout whose upstream is serve
 * (swamp-club#3985).
 *
 * - {@link ServeChunkStorage} is serve's chunk endpoints as a `storage/1`
 *   storage: `has` is `POST chunks/has`, `get` is `GET chunks/{sha256}`,
 *   `put` is `PUT chunks/{sha256}`. It offers neither `list` nor `delete`:
 *   serve has no route for them, since chunk collection belongs to the
 *   process that owns the storage, which is serve. Nor `touch`: serve
 *   touches what `has` finds. A `put` names no partition, so serve takes it
 *   only from `admin`; a checkout's own commits never use it (the sink
 *   carries their chunks with their partition).
 * - {@link CachedServeStorage} is what a serve-mode checkout opens: its
 *   local chunk cache, a filesystem storage under the checkout, with serve
 *   behind it for chunks the cache lacks. Every put lands in the cache, with
 *   the cache's staging and barrier, so a unit's commit group works as on a
 *   filesystem datastore; the sink then sends serve the ones it lacks. A
 *   chunk read from serve is kept in the cache. `list` and `delete` are the
 *   cache's, so the checkout's own sweep keeps the cache bounded.
 *
 * @module
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

/** Error code for a storage method serve's chunk endpoints cannot offer. */
export const SERVE_STORAGE_UNSUPPORTED_CODE =
  "datastore_v3_serve_storage_unsupported";

/** Thrown for `list` and `delete` on {@link ServeChunkStorage}. */
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

/**
 * Serve's chunk endpoints as a `storage/1` storage, bound to the namespace
 * the client is. A chunk of another namespace is one serve does not hold.
 */
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

  /** Whether `namespace` is the one serve's API is bound to. */
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

/** The namespace serve's API path names: `_default` for the solo one. */
export function storageNamespaceOf(namespace: string): string {
  return namespace === "" ? "_default" : namespace;
}

/**
 * A serve-mode checkout's chunk storage: its local cache, with serve behind
 * it for the chunks the cache lacks. See the module doc.
 */
export class CachedServeStorage extends FileSystemStorage {
  readonly #remote: DatastoreStorage;
  readonly #offline: () => boolean;

  constructor(
    cacheRoot: string,
    remote: DatastoreStorage,
    options: FileSystemStorageOptions & {
      /**
       * Whether the checkout works offline (swamp-club#4195): the cache
       * alone answers then, so storing content never waits on serve.
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
