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
 * The chunk store: content stored as content-addressed chunks over a
 * `storage/1` {@link DatastoreStorage} (swamp-club#3237).
 *
 * - **Writing** cuts content into chunks of `min(16 MiB, maxChunkBytes)`
 *   and uploads each one unless the storage already has it. A chunk found
 *   present is refreshed (touched, or put again without `touch`), so a
 *   commit never names a chunk that is about to expire.
 * - **Reading** checks each chunk's size and SHA-256 before handing its
 *   bytes on, and, for content in several chunks, the whole content's
 *   SHA-256 at the end. A mismatch errors the stream; unchecked bytes are
 *   never returned. Keep what a read yields only once it ends cleanly.
 * - **A chunk is present only at its size** (swamp-club#3617). On a storage
 *   that reads sizes ({@link ChunkStatReader}: the filesystem storage), a
 *   chunk a crash left short (a torn chunk) counts as missing: writing puts
 *   it again, and `missing` and `refresh` report it. Elsewhere a chunk the
 *   storage has is present. An existing chunk is trusted by its size, so a
 *   write never stores again a chunk damaged at the same size; the chunk
 *   verification of serve's maintenance timer finds that. On a storage that syncs chunk directories
 *   ({@link ChunkDirectorySync}), `syncStored` makes stored chunks' names
 *   durable.
 * - **One barrier per commit group** (swamp-club#3617): a commit-log unit
 *   writes a group's content into a {@link ChunkBatch} (`beginBatch`) and
 *   commits it before the commit is prepared or appended. On a storage that
 *   stages chunks ({@link ChunkStaging}) the batch's new chunks are synced
 *   together, then renamed, then every chunk the group names, found present
 *   or new, has its name made durable in one `syncStored`.
 * - **Storing a checkout copy's parts again** (swamp-club#3617): `refOf`
 *   cuts content exactly as `write` does without storing anything;
 *   `putParts` puts the listed parts straight from a source read by byte
 *   range, skipping any part whose bytes no longer match its name; and
 *   `verifyParts` reads and hashes stored parts to find damaged ones. The
 *   read model's checkout-copy guard uses them.
 *
 * Whether content is inlined in a commit or stored here is decided by
 * `putOp` (`MAX_INLINE_BYTES` in `op.ts`), not by this store.
 *
 * @module
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

/** The largest chunk core cuts, whatever the storage allows. */
export const CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The storage namespace of an unnamespaced datastore (commit namespace `""`):
 * a solo repository, or a team datastore served with no namespace. No slug
 * starts with `_`, so it cannot collide with a named namespace.
 */
export const UNNAMESPACED_STORAGE_NAMESPACE = "_default";

/**
 * A chunk's bytes do not match its reference, or content its digest.
 * `sha256` names the failing chunk; it is absent when every chunk matched
 * and only the whole content's digest did not.
 */
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

/** A chunk a reference names is not in the storage. */
export class ChunkMissingError extends Error {
  constructor(readonly namespace: string, readonly sha256: string) {
    super(`Chunk ${sha256} is missing from storage namespace ${namespace}`);
    this.name = "ChunkMissingError";
  }
}

/**
 * Storing a chunk failed in {@link ChunkStore.putParts}: the storage refused
 * the put (not an abort). Distinct from a source that changed, which
 * `putParts` reports instead of throwing.
 */
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

/** One part of content, with the byte offset it starts at. */
export interface ContentPart extends BlobPart {
  readonly offset: number;
}

/**
 * What {@link ChunkStore.refOf} finds: the reference `write` would return
 * for the content, and every part it would store, in order (one part for
 * content in a single chunk).
 */
export interface ContentParts {
  readonly ref: BlobRef;
  /** The whole content's SHA-256, as `ref.sha256`. */
  readonly sha256: string;
  /** The whole content's size, as `ref.size`. */
  readonly size: number;
  readonly parts: readonly ContentPart[];
}

/**
 * Reads up to `length` bytes of content starting at byte `offset`; fewer
 * (or none) when the content now ends sooner. Called again for each part,
 * so a file can be reopened or read by range.
 */
export type ContentRangeReader = (
  offset: number,
  length: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/** What {@link ChunkStore.putParts} did. */
export interface PutPartsResult {
  /** The hashes it put, in order. */
  readonly stored: readonly string[];
  /**
   * The hashes it skipped because the source no longer gives their bytes
   * at their offset: the source changed since it was cut. Never put.
   */
  readonly changed: readonly string[];
}

/**
 * Chunks a commit group stores or names, made durable together by one
 * barrier ({@link commit}) before the commit is prepared or appended
 * (swamp-club#3617). Made by {@link ChunkStore.beginBatch}; content goes in
 * through {@link ChunkStore.write}, and content stored before (a retry's
 * reused op) through {@link include}. Call {@link discard} when done,
 * whatever happened.
 *
 * On a storage that stages chunks ({@link ChunkStaging}) a chunk put into
 * the batch is not stored until {@link commit}: no reference to it may be
 * committed before then. Elsewhere it is put at once.
 */
export class ChunkBatch {
  readonly namespace: Namespace;
  readonly #ns: string;
  readonly #storage: DatastoreStorage;
  readonly #stage: ChunkStage | undefined;
  readonly #directorySync: ChunkDirectorySync | undefined;
  /** Every chunk the barrier covers: put into the batch or found present. */
  readonly #named = new Set<string>();
  #ended = false;

  /** Use {@link ChunkStore.beginBatch}. */
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

  /** Whether the batch already covers `sha256`. */
  covers(sha256: string): boolean {
    return this.#named.has(sha256);
  }

  /**
   * Stores `bytes` as the chunk `sha256` with the batch: staged until
   * {@link commit} on a storage that stages chunks, put at once elsewhere.
   * {@link ChunkStore.write} calls it.
   */
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

  /** Adds chunks already stored, so the barrier covers their names too. */
  include(hashes: Iterable<string>): void {
    if (this.#ended) throw new Error("This chunk batch has ended");
    for (const sha256 of hashes) this.#named.add(sha256);
  }

  /**
   * The barrier: stores every staged chunk, its bytes synced before its
   * rename, then makes the name of every chunk the batch covers durable
   * (`syncChunkDirectories`, which skips names known durable). Ends the
   * batch. A failure stores nothing more, and nothing the batch covers may
   * be committed.
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

  /** Ends the batch, removing whatever it staged and did not commit. */
  async discard(): Promise<void> {
    this.#ended = true;
    await this.#stage?.discard();
  }
}

/** The storage namespace of a repository's namespace. */
export function storageNamespaceOf(namespace: Namespace): string {
  return isEmptyNamespace(namespace)
    ? UNNAMESPACED_STORAGE_NAMESPACE
    : namespace;
}

/** Stores and reads content as chunks. A domain service; holds no state. */
export class ChunkStore {
  /** The size of every chunk but the last of a piece of content. */
  readonly chunkBytes: number;
  readonly #storage: DatastoreStorage;
  readonly #touch: boolean;
  readonly #stat: ChunkStatReader | undefined;
  readonly #directorySync: ChunkDirectorySync | undefined;
  readonly #staging: ChunkStaging | undefined;

  /**
   * Throws when the storage does not declare `storage/1`, declares a
   * `maxChunkBytes` that is not a positive safe integer, or declares
   * `touch` without implementing it (or the reverse).
   */
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

  /** A new {@link ChunkBatch} for content of `namespace`. */
  beginBatch(namespace: Namespace): ChunkBatch {
    return new ChunkBatch(
      namespace,
      this.#storage,
      this.#staging,
      this.#directorySync,
    );
  }

  /**
   * Stores `content` and returns its reference. Empty content is one empty
   * chunk. Rejects when `signal` aborts; chunks already uploaded stay, and
   * are harmless because no commit names them.
   *
   * With `batch`, every chunk goes into it: a new one is put with the batch
   * (on a storage that stages chunks, stored only at the batch's commit),
   * and one found present is refreshed and covered by its barrier. The
   * reference may be committed only once the batch has committed.
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

  /**
   * The reference {@link write} would return for `content`, and the parts it
   * would store with their offsets, cut exactly as `write` cuts them.
   * Stores nothing. Rejects when `signal` aborts.
   */
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
   * Puts each of `parts` straight into the storage, present or not (no
   * dedupe), reading its bytes from `source` at its offset. Each part is
   * hashed as it is read: a part whose bytes no longer match its size and
   * name is skipped and reported in `changed`, never put, so a source that
   * changed since {@link refOf} cannot store wrong bytes under a chunk's
   * name. A put the storage refuses throws {@link ChunkPutError}; an abort
   * rejects with the abort reason; a source that fails to read rejects
   * with its error. Parts put before a failure stay, and are harmless.
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
   * The parts of `parts` the storage holds damaged or not at all: each is
   * read and checked against its size and SHA-256. Costs a read of every
   * part; for the read model's replays, not routine checks.
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

  /**
   * The size and modification time of each of `hashes` stored, a hash not
   * stored left out; undefined when the storage cannot read sizes
   * ({@link ChunkStatReader}).
   */
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

  /** Whether {@link stat} reads sizes on this storage. */
  get readsSizes(): boolean {
    return this.#stat !== undefined;
  }

  /**
   * Makes the names of the stored chunks `hashes` durable, on a storage
   * that syncs chunk directories ({@link ChunkDirectorySync}); otherwise,
   * and for no hashes, does nothing.
   */
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
   * Streams the content `ref` names, from v3 chunks only: a `legacyKey`
   * (content still in a pre-v3 layout) is not read here. The stream errors with
   * {@link ChunkMissingError} or {@link ChunkIntegrityError}, or with the
   * abort reason when `signal` aborts.
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
    }, { highWaterMark: 0 }); // fetch nothing until the stream is read
  }

  /**
   * The chunks of `ref` the storage does not hold, in order, each once
   * however many parts repeat it; on a storage that reads sizes, a chunk
   * held at the wrong size (torn) too. A writer
   * checks this after its commit lands, so a chunk garbage collection
   * deleted meanwhile is stored again (swamp-club#3249).
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
   * Refreshes the chunks of `ref`, so a sweep's grace period counts from
   * now, and returns the ones the storage does not hold, in order, each
   * once (swamp-club#3586); on a storage that reads sizes, the ones held at the
   * wrong size too. A storage that cannot touch is only checked.
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

  /**
   * Makes one chunk present and fresh: put, touched, or put again. A chunk
   * held at the wrong size is put again. With `batch`, a put goes into it,
   * a chunk found present is covered by its barrier, and a chunk it already
   * covers is left alone.
   */
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

/** Every part of `ref`, one for content in a single chunk. */
function partsOf(ref: BlobRef): readonly BlobPart[] {
  return ref.parts ?? [{ sha256: ref.sha256, size: ref.size }];
}

/** The hashes of `parts` not in `stats` at their size, in order. */
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

/** `hashes` in order, each once: a chunk can back several parts. */
function unique(hashes: readonly string[]): string[] {
  return [...new Set(hashes)];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Cuts content into chunks of `size` bytes, the last one shorter. Empty
 * content gives one empty chunk.
 */
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
