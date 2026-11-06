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
 * a read checks each chunk's size and SHA-256 and errors the stream on
 * mismatch, so keep its bytes only once it ends cleanly; where sizes are
 * readable a short (torn) chunk counts as missing
 */

// node:crypto, not WebCrypto: the whole-content digest is computed chunk by
// chunk, and crypto.subtle.digest cannot hash incrementally.
import { createHash } from "node:crypto";
import {
  type ChunkDirectorySync,
  type ChunkStage,
  type ChunkStaging,
  type ChunkStat,
  type ChunkStatReader,
  type DatastoreStorage,
  isChunkDirectorySync,
  isChunkStaging,
  isChunkStatReader,
  STORAGE_CONTRACT,
} from "../datastore/datastore_storage.ts";
import { isEmptyNamespace, type Namespace } from "../data/namespace.ts";
import { type BlobPart, BlobRef } from "./blob_ref.ts";

export const CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The storage namespace of an unnamespaced datastore (commit namespace `""`):
 * a solo repository, or a team datastore served with no namespace. No slug
 * starts with `_`, so it cannot collide with a named namespace.
 */
export const UNNAMESPACED_STORAGE_NAMESPACE = "_default";

export class ChunkIntegrityError extends Error {
  readonly namespace?: string;
  readonly sha256?: string;

  constructor(
    message: string,
    chunk?: { readonly namespace: string; readonly sha256: string },
  ) {
    super(message);
    this.name = "ChunkIntegrityError";
    if (chunk !== undefined) {
      this.namespace = chunk.namespace;
      this.sha256 = chunk.sha256;
    }
  }
}

export class ChunkMissingError extends Error {
  constructor(readonly namespace: string, readonly sha256: string) {
    super(`Chunk ${sha256} is missing from storage namespace ${namespace}`);
    this.name = "ChunkMissingError";
  }
}

export class ChunkPutError extends Error {
  constructor(
    readonly namespace: string,
    readonly sha256: string,
    override readonly cause: unknown,
  ) {
    super(
      `Storing chunk ${sha256} in storage namespace ${namespace} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ChunkPutError";
  }
}

export interface ContentPart extends BlobPart {
  readonly offset: number;
}

export interface ContentParts {
  readonly ref: BlobRef;
  readonly sha256: string;
  readonly size: number;
  readonly parts: readonly ContentPart[];
}

/**
 * returns fewer bytes (or none) when the content now ends sooner; called again
 * for each part, so a file can be reopened or read by range
 */
export type ContentRangeReader = (
  offset: number,
  length: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export interface PutPartsResult {
  readonly stored: readonly string[];
  /**
   * skipped because the source does not give their bytes at their offset (it
   * changed since it was cut); never put
   */
  readonly changed: readonly string[];
}

/**
 * on a staging storage a chunk put into the batch is not stored until commit,
 * so no reference to it may be committed before then; call discard when done,
 * whatever happened
 */
export class ChunkBatch {
  readonly namespace: Namespace;
  readonly #ns: string;
  readonly #storage: DatastoreStorage;
  readonly #stage: ChunkStage | undefined;
  readonly #directorySync: ChunkDirectorySync | undefined;
  readonly #named = new Set<string>();
  #ended = false;

  constructor(
    namespace: Namespace,
    storage: DatastoreStorage,
    staging: ChunkStaging | undefined,
    directorySync: ChunkDirectorySync | undefined,
  ) {
    this.namespace = namespace;
    this.#ns = storageNamespaceOf(namespace);
    this.#storage = storage;
    this.#stage = staging?.stageChunks(this.#ns);
    this.#directorySync = directorySync;
  }

  covers(sha256: string): boolean {
    return this.#named.has(sha256);
  }

  async put(
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#ended) throw new Error("This chunk batch has ended");
    if (this.#stage !== undefined) {
      await this.#stage.put(sha256, bytes, signal);
    } else {
      await this.#storage.put(this.#ns, sha256, bytes, signal);
    }
    this.#named.add(sha256);
  }

  include(hashes: Iterable<string>): void {
    if (this.#ended) throw new Error("This chunk batch has ended");
    for (const sha256 of hashes) this.#named.add(sha256);
  }

  /**
   * stores staged chunks (bytes synced before rename), then makes every covered
   * chunk's name durable; a failure stores nothing more and nothing the batch
   * covers may be committed
   */
  async commit(signal: AbortSignal): Promise<void> {
    if (this.#ended) throw new Error("This chunk batch has ended");
    this.#ended = true;
    await this.#stage?.commit(signal);
    if (this.#directorySync === undefined || this.#named.size === 0) return;
    await this.#directorySync.syncChunkDirectories(
      this.#ns,
      [...this.#named],
      signal,
    );
  }

  async discard(): Promise<void> {
    this.#ended = true;
    await this.#stage?.discard();
  }
}

export function storageNamespaceOf(namespace: Namespace): string {
  return isEmptyNamespace(namespace)
    ? UNNAMESPACED_STORAGE_NAMESPACE
    : namespace;
}

// prefetch keeps what it fetches; ChunkStore asks only a storage that does
export interface ReleasingStorage {
  releaseFetched(signal: AbortSignal): Promise<void>;
}

export interface PrefetchingStorage {
  prefetch(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
}

export class ChunkStore {
  readonly chunkBytes: number;
  readonly #storage: DatastoreStorage;
  readonly #touch: boolean;
  readonly #stat: ChunkStatReader | undefined;
  readonly #directorySync: ChunkDirectorySync | undefined;
  readonly #staging: ChunkStaging | undefined;

  constructor(storage: DatastoreStorage) {
    if (storage.contract !== STORAGE_CONTRACT) {
      throw new Error(
        `Storage declares contract ${
          String(storage.contract)
        }; the chunk store needs ${STORAGE_CONTRACT}`,
      );
    }
    const { maxChunkBytes, touch } = storage.capabilities();
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
      throw new Error(
        `Storage maxChunkBytes must be a positive integer: ${
          String(maxChunkBytes)
        }`,
      );
    }
    if (touch !== (typeof storage.touch === "function")) {
      throw new Error(
        "Storage capabilities().touch must be true exactly when it implements touch",
      );
    }
    this.chunkBytes = Math.min(CHUNK_BYTES, maxChunkBytes);
    this.#storage = storage;
    this.#touch = touch;
    this.#stat = isChunkStatReader(storage) ? storage : undefined;
    this.#directorySync = isChunkDirectorySync(storage) ? storage : undefined;
    this.#staging = isChunkStaging(storage) ? storage : undefined;
  }

  beginBatch(namespace: Namespace): ChunkBatch {
    return new ChunkBatch(
      namespace,
      this.#storage,
      this.#staging,
      this.#directorySync,
    );
  }

  /**
   * chunks already uploaded when aborted stay and are harmless since no commit
   * names them; with batch, the reference may be committed only once the batch
   * has committed
   */
  async write(
    namespace: Namespace,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    batch?: ChunkBatch,
  ): Promise<BlobRef> {
    const ns = storageNamespaceOf(namespace);
    if (batch !== undefined && storageNamespaceOf(batch.namespace) !== ns) {
      throw new Error(
        `A chunk batch for namespace ${batch.namespace} cannot store content of namespace ${namespace}`,
      );
    }
    const whole = createHash("sha256");
    const parts: BlobPart[] = [];
    let size = 0;
    for await (const chunk of cut(content, this.chunkBytes, signal)) {
      signal.throwIfAborted();
      whole.update(chunk);
      const sha256 = sha256Hex(chunk);
      await this.#store(ns, sha256, chunk, signal, batch);
      parts.push({ sha256, size: chunk.length });
      size += chunk.length;
    }
    const sha256 = whole.digest("hex");
    return parts.length === 1
      ? BlobRef.create({ sha256, size })
      : BlobRef.create({ sha256, size, parts });
  }

  async refOf(
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ContentParts> {
    const whole = createHash("sha256");
    const parts: ContentPart[] = [];
    let size = 0;
    for await (const chunk of cut(content, this.chunkBytes, signal)) {
      signal.throwIfAborted();
      whole.update(chunk);
      parts.push({
        sha256: sha256Hex(chunk),
        size: chunk.length,
        offset: size,
      });
      size += chunk.length;
    }
    const sha256 = whole.digest("hex");
    const ref = parts.length === 1
      ? BlobRef.create({ sha256, size })
      : BlobRef.create({
        sha256,
        size,
        parts: parts.map(({ sha256, size }) => ({ sha256, size })),
      });
    return { ref, sha256, size, parts };
  }

  /**
   * a part whose bytes do not match its size and name is skipped and reported
   * in changed, never put, so a changed source cannot store wrong bytes under a
   * chunk's name
   */
  async putParts(
    namespace: Namespace,
    source: ContentRangeReader,
    parts: readonly ContentPart[],
    signal: AbortSignal,
  ): Promise<PutPartsResult> {
    const ns = storageNamespaceOf(namespace);
    const stored: string[] = [];
    const changed: string[] = [];
    for (const part of parts) {
      signal.throwIfAborted();
      const bytes = await source(part.offset, part.size, signal);
      signal.throwIfAborted();
      if (bytes.length !== part.size || sha256Hex(bytes) !== part.sha256) {
        changed.push(part.sha256);
        continue;
      }
      try {
        await this.#storage.put(ns, part.sha256, bytes, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ChunkPutError(ns, part.sha256, error);
      }
      stored.push(part.sha256);
    }
    return { stored, changed };
  }

  /**
   * costs a read of every part; for the read model's replays, not routine
   * checks
   */
  async verifyParts<P extends BlobPart>(
    namespace: Namespace,
    parts: readonly P[],
    signal: AbortSignal,
  ): Promise<P[]> {
    const ns = storageNamespaceOf(namespace);
    const damaged: P[] = [];
    for (const part of parts) {
      signal.throwIfAborted();
      const bytes = await this.#storage.get(ns, part.sha256, signal);
      if (
        bytes === null || bytes.length !== part.size ||
        sha256Hex(bytes) !== part.sha256
      ) {
        damaged.push(part);
      }
    }
    return damaged;
  }

  async stat(
    namespace: Namespace,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ChunkStat> | undefined> {
    if (this.#stat === undefined) return undefined;
    return await this.#stat.statChunks(
      storageNamespaceOf(namespace),
      hashes,
      signal,
    );
  }

  get readsSizes(): boolean {
    return this.#stat !== undefined;
  }

  async syncStored(
    namespace: Namespace,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#directorySync === undefined || hashes.length === 0) return;
    await this.#directorySync.syncChunkDirectories(
      storageNamespaceOf(namespace),
      hashes,
      signal,
    );
  }

  /**
   * lets a storage that keeps what it fetches drop it, once the files made
   * from it are durable; nothing for any other storage
   */
  async releaseFetched(signal: AbortSignal): Promise<void> {
    const storage = this.#storage as Partial<ReleasingStorage>;
    await storage.releaseFetched?.(signal);
  }

  /**
   * warms a storage that keeps what it fetches, a few chunks at a time, so the
   * reads that follow are local; best effort: the reads report any failure
   */
  async prefetch(
    namespace: Namespace,
    refs: readonly BlobRef[],
    signal: AbortSignal,
  ): Promise<void> {
    const storage = this.#storage as Partial<PrefetchingStorage>;
    if (storage.prefetch === undefined) return;
    const hashes = [
      ...new Set(
        refs.flatMap((ref) =>
          (ref.parts ?? [{ sha256: ref.sha256 }]).map((part) => part.sha256)
        ),
      ),
    ];
    if (hashes.length < 2) return;
    await storage.prefetch(storageNamespaceOf(namespace), hashes, signal);
  }

  /**
   * reads v3 chunks only: a legacyKey (content still in a pre-v3 layout) is not
   * read here
   */
  read(
    namespace: Namespace,
    ref: BlobRef,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    const ns = storageNamespaceOf(namespace);
    const parts = ref.parts ?? [{ sha256: ref.sha256, size: ref.size }];
    const whole = ref.parts === undefined ? undefined : createHash("sha256");
    const storage = this.#storage;
    let next = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        signal.throwIfAborted();
        const part = parts[next++];
        const bytes = await storage.get(ns, part.sha256, signal);
        if (bytes === null) throw new ChunkMissingError(ns, part.sha256);
        if (bytes.length !== part.size) {
          throw new ChunkIntegrityError(
            `Chunk ${part.sha256} holds ${bytes.length} bytes, not ${part.size}`,
            { namespace: ns, sha256: part.sha256 },
          );
        }
        if (sha256Hex(bytes) !== part.sha256) {
          throw new ChunkIntegrityError(
            `Chunk ${part.sha256} does not match its SHA-256`,
            { namespace: ns, sha256: part.sha256 },
          );
        }
        whole?.update(bytes);
        const last = next === parts.length;
        // Checked before the last chunk is handed on, so a reader never
        // receives all of the content when its digest is wrong.
        if (last && whole !== undefined && whole.digest("hex") !== ref.sha256) {
          throw new ChunkIntegrityError(
            `Content read from ${parts.length} chunks does not match its SHA-256 ${ref.sha256}`,
          );
        }
        controller.enqueue(bytes);
        if (last) controller.close();
      },
    }, { highWaterMark: 0 });
  }

  /**
   * a writer checks this after its commit lands, so a chunk garbage collection
   * deleted meanwhile is stored again
   */
  async missing(
    namespace: Namespace,
    ref: BlobRef,
    signal: AbortSignal,
  ): Promise<string[]> {
    const ns = storageNamespaceOf(namespace);
    if (this.#stat !== undefined) {
      const stats = await this.#stat.statChunks(ns, ref.chunkHashes(), signal);
      return wrongSize(partsOf(ref), stats);
    }
    const hashes = ref.chunkHashes();
    const present = await this.#storage.has(ns, hashes, signal);
    return unique(hashes.filter((sha256) => !present.has(sha256)));
  }

  /**
   * refreshes the chunks so a sweep's grace period counts from now; a storage
   * that cannot touch is only checked
   */
  async refresh(
    namespace: Namespace,
    ref: BlobRef,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (!this.#touch) return await this.missing(namespace, ref, signal);
    const ns = storageNamespaceOf(namespace);
    const hashes = ref.chunkHashes();
    const missing = await this.#storage.touch!(ns, hashes, signal);
    if (this.#stat === undefined) {
      return unique(hashes.filter((sha256) => missing.has(sha256)));
    }
    const stats = await this.#stat.statChunks(ns, hashes, signal);
    for (const sha256 of missing) stats.delete(sha256);
    return wrongSize(partsOf(ref), stats);
  }

  async #store(
    ns: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    batch: ChunkBatch | undefined,
  ): Promise<void> {
    if (batch?.covers(sha256)) return;
    const present = this.#stat !== undefined
      ? (await this.#stat.statChunks(ns, [sha256], signal)).get(sha256)
        ?.size === bytes.length
      : (await this.#storage.has(ns, [sha256], signal)).has(sha256);
    if (present && this.#touch) {
      const missing = await this.#storage.touch!(ns, [sha256], signal);
      if (!missing.has(sha256)) {
        batch?.include([sha256]);
        return;
      }
    }
    if (batch !== undefined) await batch.put(sha256, bytes, signal);
    else await this.#storage.put(ns, sha256, bytes, signal);
  }
}

function partsOf(ref: BlobRef): readonly BlobPart[] {
  return ref.parts ?? [{ sha256: ref.sha256, size: ref.size }];
}

function wrongSize(
  parts: readonly BlobPart[],
  stats: ReadonlyMap<string, ChunkStat>,
): string[] {
  return unique(
    parts
      .filter((part) => stats.get(part.sha256)?.size !== part.size)
      .map((part) => part.sha256),
  );
}

function unique(hashes: readonly string[]): string[] {
  return [...new Set(hashes)];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* cut(
  content: Uint8Array | ReadableStream<Uint8Array>,
  size: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    if (content.length === 0) yield new Uint8Array(0);
    for (let at = 0; at < content.length; at += size) {
      yield content.subarray(at, at + size);
    }
    return;
  }
  // Pieces read but not yet cut, so a small stream never allocates a whole
  // chunk.
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let yielded = false;
  let drained = false;
  const reader = content.getReader();
  // An abort cancels the source, so a read waiting on a stalled stream
  // settles; the check after it then rejects instead of treating the
  // cancel as the end of the content.
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        drained = true;
        break;
      }
      pending.push(value);
      pendingBytes += value.length;
      while (pendingBytes >= size) {
        const joined = concat(pending, pendingBytes);
        yield joined.subarray(0, size);
        yielded = true;
        pending = pendingBytes > size ? [joined.subarray(size)] : [];
        pendingBytes -= size;
      }
    }
  } finally {
    // A write that failed or aborted part-way cancels the caller's source,
    // so a file or network stream is closed now rather than left open.
    signal.removeEventListener("abort", onAbort);
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (pendingBytes > 0 || !yielded) yield concat(pending, pendingBytes);
}

function concat(pieces: readonly Uint8Array[], length: number): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const joined = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}
