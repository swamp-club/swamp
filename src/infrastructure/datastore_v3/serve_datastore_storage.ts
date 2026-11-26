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
  type ChunkStage,
  type DatastoreStorage,
  STORAGE_CONTRACT,
  type StorageCapabilities,
  type StoredChunk,
} from "../../domain/datastore/datastore_storage.ts";
import {
  CHUNK_BYTES,
  type PrefetchingStorage,
  type PrefetchReport,
} from "../../domain/datastore_v3/chunk_store.ts";
import { UserError } from "../../domain/errors.ts";
import {
  FileSystemStorage,
  type FileSystemStorageOptions,
} from "../persistence/fs_datastore_storage.ts";
import type { DecodedChunkBatch } from "./chunk_ingest.ts";
import {
  ChunkBatchUnsupportedError,
  type ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  ServeRateLimitedError,
  ServeUnreachableError,
} from "./serve_upstream_errors.ts";

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

type ChunkClient =
  & Pick<
    ServeDatastoreClient,
    "hasChunks" | "getChunk" | "putChunk" | "namespace"
  >
  & Partial<Pick<ServeDatastoreClient, "getChunks" | "takesChunkBatch">>;

/** a storage that can read many chunks in one round trip */
export interface BatchReadingStorage {
  /** undefined when the other side has no batch read */
  getMany(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<DecodedChunkBatch | undefined>;
}

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

  async getMany(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<DecodedChunkBatch | undefined> {
    signal.throwIfAborted();
    const client = this.#client;
    if (
      !this.#bound(namespace) || client.getChunks === undefined ||
      client.takesChunkBatch?.() !== true
    ) {
      return undefined;
    }
    try {
      return await client.getChunks(hashes, signal);
    } catch (error) {
      if (error instanceof ChunkBatchUnsupportedError) return undefined;
      throw error;
    }
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

const PREFETCH_CONCURRENCY = 8;
/** hashes per batch read; serve caps the bytes and defers the rest */
export const PREFETCH_BATCH_HASHES = 128;
/** tries for a chunk serve refused with 429 because its chunk slots were full */
export const PREFETCH_ATTEMPTS = 3;
/** chunks, or batch reads, failing in a row before the prefetch gives up on serve */
export const PREFETCH_STOP_AFTER = 3;
const PREFETCH_RETRY_MS = 200;

export class CachedServeStorage extends FileSystemStorage
  implements PrefetchingStorage {
  readonly #remote: DatastoreStorage;
  readonly #offline: () => boolean;
  /** chunks read from serve and not since stored here, by namespace */
  readonly #fetched = new Map<string, Set<string>>();

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

  async prefetch(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<PrefetchReport> {
    const report: PrefetchReport = {
      requested: 0,
      fetched: 0,
      retries: 0,
      failed: 0,
    };
    if (this.#offline()) return report;
    let local: Set<string>;
    try {
      local = await super.has(namespace, hashes, signal);
    } catch {
      return report;
    }
    let rest = hashes.filter((hash) => !local.has(hash));
    report.requested = rest.length;
    const remote = this.#remote as Partial<BatchReadingStorage>;
    if (remote.getMany !== undefined && rest.length > 0) {
      const left = await this.#prefetchBatches(
        remote as BatchReadingStorage,
        namespace,
        rest,
        signal,
        report,
      );
      if (left === "stop") return report;
      rest = left;
    }
    let next = 0;
    let failingInARow = 0;
    let unreachable = false;
    const fetchOne = async (
      hash: string,
    ): Promise<"fetched" | "failed" | "unreachable"> => {
      for (let attempt = 1;; attempt++) {
        try {
          await this.get(namespace, hash, signal);
          return "fetched";
        } catch (error) {
          if (error instanceof ServeUnreachableError) return "unreachable";
          if (
            !(error instanceof ServeRateLimitedError) ||
            attempt >= PREFETCH_ATTEMPTS || signal.aborted
          ) {
            return "failed";
          }
          report.retries++;
          await abortableDelay(PREFETCH_RETRY_MS * attempt, signal);
        }
      }
    };
    const worker = async () => {
      // one bad chunk never ends the prefetch; an unreachable serve or a run of
      // failures does, so a hung serve costs one timeout, not one per chunk
      while (
        next < rest.length && !unreachable &&
        failingInARow < PREFETCH_STOP_AFTER && !signal.aborted
      ) {
        const outcome = await fetchOne(rest[next++]);
        if (outcome === "fetched") {
          report.fetched++;
          failingInARow = 0;
        } else {
          report.failed++;
          failingInARow++;
          if (outcome === "unreachable") unreachable = true;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PREFETCH_CONCURRENCY, rest.length) },
        worker,
      ),
    );
    return report;
  }

  /**
   * fetches in batches, many chunks per round trip; returns the hashes still
   * to fetch one at a time (all of them when serve has no batch read), or
   * stop when serve is unreachable or failing
   */
  async #prefetchBatches(
    remote: BatchReadingStorage,
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
    report: PrefetchReport,
  ): Promise<string[] | "stop"> {
    const queue = [...hashes];
    const singly: string[] = [];
    let unsupported = false;
    let stop = false;
    let failingInARow = 0;
    const fetchBatch = async (
      batch: string[],
    ): Promise<DecodedChunkBatch | undefined | "failed"> => {
      for (let attempt = 1;; attempt++) {
        try {
          return await remote.getMany(namespace, batch, signal);
        } catch (error) {
          if (error instanceof ServeUnreachableError) {
            stop = true;
            return "failed";
          }
          if (
            !(error instanceof ServeRateLimitedError) ||
            attempt >= PREFETCH_ATTEMPTS || signal.aborted
          ) {
            return "failed";
          }
          report.retries++;
          await abortableDelay(PREFETCH_RETRY_MS * attempt, signal);
        }
      }
    };
    const worker = async () => {
      while (
        queue.length > 0 && !unsupported && !stop &&
        failingInARow < PREFETCH_STOP_AFTER && !signal.aborted
      ) {
        const batch = queue.splice(0, PREFETCH_BATCH_HASHES);
        const result = await fetchBatch(batch);
        if (result === undefined) {
          unsupported = true;
          for (const hash of batch) singly.push(hash);
          return;
        }
        report.batches = (report.batches ?? 0) + 1;
        if (result === "failed") {
          // read one at a time later, as before batches, unless serve stopped
          for (const hash of batch) singly.push(hash);
          failingInARow++;
          continue;
        }
        failingInARow = 0;
        for (const [sha256, bytes] of result.chunks) {
          await this.#keepFetched(namespace, sha256, bytes, signal);
          report.fetched++;
        }
        for (const hash of result.deferred) queue.push(hash);
        // a shared vouch budget may run out: each of these gets its own read
        for (const hash of result.undecided) singly.push(hash);
        report.missing = (report.missing ?? 0) + result.missing.length;
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            PREFETCH_CONCURRENCY,
            Math.ceil(queue.length / PREFETCH_BATCH_HASHES),
          ),
        },
        worker,
      ),
    );
    if (stop || failingInARow >= PREFETCH_STOP_AFTER) {
      report.failed += queue.length + singly.length;
      return "stop";
    }
    return unsupported ? queue.concat(singly) : singly;
  }

  async #keepFetched(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    await super.put(namespace, sha256, bytes, signal);
    let fetched = this.#fetched.get(namespace);
    if (fetched === undefined) {
      this.#fetched.set(namespace, fetched = new Set());
    }
    fetched.add(sha256);
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
    if (bytes !== null) {
      await this.#keepFetched(namespace, sha256, bytes, signal);
    }
    return bytes;
  }

  override async put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    this.#fetched.get(namespace)?.delete(sha256);
    await super.put(namespace, sha256, bytes, signal);
  }

  // a write of bytes already here touches the chunk instead of putting it
  override touch(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const fetched = this.#fetched.get(namespace);
    for (const sha256 of hashes) fetched?.delete(sha256);
    return super.touch(namespace, hashes, signal);
  }

  override stageChunks(namespace: string): ChunkStage {
    const stage = super.stageChunks(namespace);
    return {
      ...stage,
      put: (sha256, bytes, signal) => {
        this.#fetched.get(namespace)?.delete(sha256);
        return stage.put(sha256, bytes, signal);
      },
    };
  }

  /**
   * removes the chunks read from serve once the files made from them are
   * durable: serve keeps them, so a later read fetches again. A chunk this
   * checkout stored itself (its own commits, sent or not) is never removed
   */
  async releaseFetched(signal: AbortSignal): Promise<void> {
    for (const [namespace, hashes] of this.#fetched) {
      for (const sha256 of [...hashes]) {
        signal.throwIfAborted();
        hashes.delete(sha256);
        await super.delete(namespace, sha256, signal);
      }
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
