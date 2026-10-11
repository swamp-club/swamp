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
  type DatastoreStorage,
  STORAGE_CONTRACT,
} from "../datastore/datastore_storage.ts";
import { isEmptyNamespace, type Namespace } from "../data/namespace.ts";
import { type BlobPart, BlobRef } from "./blob_ref.ts";

/** The largest chunk core cuts, whatever the storage allows. */
export const CHUNK_BYTES = 16 * 1024 * 1024;

/** The storage namespace of a solo-mode repository. No slug starts with `_`. */
export const SOLO_STORAGE_NAMESPACE = "_solo";

/** A chunk's bytes do not match its reference, or content its digest. */
export class ChunkIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkIntegrityError";
  }
}

/** A chunk a reference names is not in the storage. */
export class ChunkMissingError extends Error {
  constructor(readonly namespace: string, readonly sha256: string) {
    super(`Chunk ${sha256} is missing from storage namespace ${namespace}`);
    this.name = "ChunkMissingError";
  }
}

/** The storage namespace of a repository's namespace. */
export function storageNamespaceOf(namespace: Namespace): string {
  return isEmptyNamespace(namespace) ? SOLO_STORAGE_NAMESPACE : namespace;
}

/** Stores and reads content as chunks. A domain service; holds no state. */
export class ChunkStore {
  /** The size of every chunk but the last of a piece of content. */
  readonly chunkBytes: number;
  readonly #storage: DatastoreStorage;
  readonly #touch: boolean;

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
  }

  /**
   * Stores `content` and returns its reference. Empty content is one empty
   * chunk. Rejects when `signal` aborts; chunks already uploaded stay, and
   * are harmless because no commit names them.
   */
  async write(
    namespace: Namespace,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<BlobRef> {
    const ns = storageNamespaceOf(namespace);
    const whole = createHash("sha256");
    const parts: BlobPart[] = [];
    let size = 0;
    for await (const chunk of cut(content, this.chunkBytes, signal)) {
      signal.throwIfAborted();
      whole.update(chunk);
      const sha256 = sha256Hex(chunk);
      await this.#store(ns, sha256, chunk, signal);
      parts.push({ sha256, size: chunk.length });
      size += chunk.length;
    }
    const sha256 = whole.digest("hex");
    return parts.length === 1
      ? BlobRef.create({ sha256, size })
      : BlobRef.create({ sha256, size, parts });
  }

  /**
   * Streams the content `ref` names. The stream errors with
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
          );
        }
        if (sha256Hex(bytes) !== part.sha256) {
          throw new ChunkIntegrityError(
            `Chunk ${part.sha256} does not match its SHA-256`,
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

  /** Makes one chunk present and fresh: put, touched, or put again. */
  async #store(
    ns: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const present = await this.#storage.has(ns, [sha256], signal);
    if (present.has(sha256) && this.#touch) {
      const missing = await this.#storage.touch!(ns, [sha256], signal);
      if (!missing.has(sha256)) return;
    }
    await this.#storage.put(ns, sha256, bytes, signal);
  }
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
  const reader = content.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
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
