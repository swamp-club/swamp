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
 * Taking chunks in over HTTP, and serving them back (swamp-club#3915).
 *
 * - {@link FramedReader} reads exact byte counts out of a request body
 *   (`ReadableStream<Uint8Array>`), leaving the rest unread, under an
 *   overall byte cap. The commit request is framed as a 4-byte big-endian
 *   JSON length, the JSON envelope, then chunk bytes back to back.
 * - {@link ingestChunk} reads one declared chunk, hashing as it reads, and
 *   hands the bytes on only once their SHA-256 matched the declared one, so
 *   nothing unverified is ever staged. Memory is bounded at one chunk.
 * - {@link parseRange} and {@link chunkReadResponse} serve a chunk read with
 *   single-range support.
 *
 * @module
 */

// node:crypto, not WebCrypto: the digest is computed piece by piece as the
// body arrives, and crypto.subtle.digest cannot hash incrementally.
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";

/** The stable codes of {@link ChunkIngestError}. */
export type ChunkIngestErrorCode =
  | "chunk_hash_malformed"
  | "chunk_size_invalid"
  | "chunk_too_large"
  | "chunk_truncated"
  | "chunk_hash_mismatch"
  | "stream_truncated"
  | "stream_too_large"
  | "stream_trailing_bytes";

/** A refused chunk upload or framed body. `code` is stable for clients. */
export class ChunkIngestError extends Error {
  constructor(readonly code: ChunkIngestErrorCode, message: string) {
    super(message);
    this.name = "ChunkIngestError";
  }
}

/** The declared sha256 is not 64 lowercase hex characters. */
export class ChunkHashMalformedError extends ChunkIngestError {
  constructor(readonly sha256: string) {
    super(
      "chunk_hash_malformed",
      `Chunk sha256 must be 64 lowercase hex characters: ${
        JSON.stringify(sha256.slice(0, 80))
      }`,
    );
    this.name = "ChunkHashMalformedError";
  }
}

/** The declared size is not a non-negative safe integer. */
export class ChunkSizeInvalidError extends ChunkIngestError {
  constructor(readonly size: number) {
    super(
      "chunk_size_invalid",
      `Chunk size must be a non-negative integer: ${String(size)}`,
    );
    this.name = "ChunkSizeInvalidError";
  }
}

/** The declared size is above the chunk limit. Refused before reading. */
export class ChunkTooLargeError extends ChunkIngestError {
  constructor(readonly size: number, readonly limit: number) {
    super(
      "chunk_too_large",
      `Chunk of ${size} bytes is above the ${limit}-byte chunk limit`,
    );
    this.name = "ChunkTooLargeError";
  }
}

/** The stream ended before the chunk's declared size was read. */
export class ChunkTruncatedError extends ChunkIngestError {
  constructor(
    readonly sha256: string,
    readonly size: number,
    readonly received: number,
  ) {
    super(
      "chunk_truncated",
      `Chunk ${sha256} ended after ${received} of ${size} bytes`,
    );
    this.name = "ChunkTruncatedError";
  }
}

/** The chunk's bytes do not hash to its declared sha256. */
export class ChunkHashMismatchError extends ChunkIngestError {
  constructor(readonly sha256: string, readonly actual: string) {
    super(
      "chunk_hash_mismatch",
      `Chunk bytes hash to ${actual}, not the declared ${sha256}`,
    );
    this.name = "ChunkHashMismatchError";
  }
}

/** A framed stream ended before a read it was asked for. */
export class StreamTruncatedError extends ChunkIngestError {
  constructor(readonly wanted: number, readonly received: number) {
    super(
      "stream_truncated",
      `Request body ended after ${received} of ${wanted} expected bytes`,
    );
    this.name = "StreamTruncatedError";
  }
}

/** A read would take the framed stream past its overall byte cap. */
export class StreamTooLargeError extends ChunkIngestError {
  constructor(readonly maxBytes: number) {
    super(
      "stream_too_large",
      `Request body is larger than its ${maxBytes}-byte limit`,
    );
    this.name = "StreamTooLargeError";
  }
}

/** The framed stream has bytes after its last expected frame. */
export class StreamTrailingBytesError extends ChunkIngestError {
  constructor() {
    super(
      "stream_trailing_bytes",
      "Request body has unexpected bytes at its end",
    );
    this.name = "StreamTrailingBytesError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is a lowercase 64-hex SHA-256. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

function assertByteCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Byte count must be a non-negative integer: ${n}`);
  }
}

/**
 * Reads exact byte counts from a `ReadableStream<Uint8Array>`, keeping what
 * it has not handed out for the next read. Every read counts toward
 * `maxBytes`; a read that would pass it is refused before reading
 * ({@link StreamTooLargeError}). A stream that ends early is refused with
 * {@link StreamTruncatedError}. An aborted `signal` cancels the stream and
 * rejects with the signal's reason.
 */
export class FramedReader {
  readonly maxBytes: number;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);
  #consumed = 0;
  #done = false;

  constructor(
    stream: ReadableStream<Uint8Array>,
    options: { readonly maxBytes: number },
  ) {
    assertByteCount(options.maxBytes);
    this.maxBytes = options.maxBytes;
    this.#reader = stream.getReader();
  }

  /** Bytes handed out so far. */
  get consumed(): number {
    return this.#consumed;
  }

  /**
   * Yields the next `n` bytes as pieces in stream order, without buffering
   * more than the stream's own chunks. A piece may be a view of the
   * stream's buffer: copy it to keep it. Throws {@link StreamTruncatedError}
   * when the stream ends first, {@link StreamTooLargeError} (before reading)
   * past the cap.
   */
  async *pieces(
    n: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    assertByteCount(n);
    if (n > this.maxBytes - this.#consumed) {
      throw new StreamTooLargeError(this.maxBytes);
    }
    let remaining = n;
    while (remaining > 0) {
      if (this.#pending.byteLength === 0) {
        const next = await this.#readPiece(signal);
        if (next === undefined) {
          throw new StreamTruncatedError(n, n - remaining);
        }
        this.#pending = next;
      }
      const take = Math.min(remaining, this.#pending.byteLength);
      const piece = this.#pending.subarray(0, take);
      this.#pending = this.#pending.subarray(take);
      remaining -= take;
      this.#consumed += take;
      yield piece;
    }
  }

  /** The next `n` bytes, copied into one array. */
  async readExactly(n: number, signal?: AbortSignal): Promise<Uint8Array> {
    assertByteCount(n);
    if (n > this.maxBytes - this.#consumed) {
      throw new StreamTooLargeError(this.maxBytes);
    }
    const out = new Uint8Array(n);
    let offset = 0;
    for await (const piece of this.pieces(n, signal)) {
      out.set(piece, offset);
      offset += piece.byteLength;
    }
    return out;
  }

  /** The next 4 bytes as a big-endian unsigned 32-bit integer. */
  async readUint32BE(signal?: AbortSignal): Promise<number> {
    const bytes = await this.readExactly(4, signal);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  }

  /**
   * Refuses ({@link StreamTrailingBytesError}) when the stream has any byte
   * left; resolves once it ended. Reads at most one more stream chunk past
   * the end of what was handed out.
   */
  async assertEnd(signal?: AbortSignal): Promise<void> {
    if (this.#pending.byteLength > 0) {
      await this.cancel();
      throw new StreamTrailingBytesError();
    }
    const next = await this.#readPiece(signal);
    if (next !== undefined) {
      await this.cancel();
      throw new StreamTrailingBytesError();
    }
  }

  /** Cancels the underlying stream; later reads see it ended. */
  async cancel(reason?: unknown): Promise<void> {
    this.#done = true;
    this.#pending = new Uint8Array(0);
    await this.#reader.cancel(reason).catch(() => {});
  }

  /** The next non-empty stream chunk, or undefined once the stream ended. */
  async #readPiece(signal?: AbortSignal): Promise<Uint8Array | undefined> {
    while (!this.#done) {
      signal?.throwIfAborted();
      const onAbort = () => {
        // The pending read resolves as done once cancelled; the abort is
        // then reported below.
        this.#reader.cancel(signal?.reason).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.#reader.read();
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      signal?.throwIfAborted();
      if (result.done) {
        this.#done = true;
        return undefined;
      }
      if (result.value.byteLength > 0) return result.value;
    }
    return undefined;
  }
}

/** A chunk an upload declares. */
export interface ChunkDeclaration {
  /** Lowercase 64-hex SHA-256 of the chunk's bytes. */
  readonly sha256: string;
  /** The chunk's size in bytes. */
  readonly size: number;
}

/** The limits a chunk upload is held to. */
export interface ChunkIngestLimits {
  /**
   * The storage's `maxChunkBytes`. The effective limit is the smaller of it
   * and {@link CHUNK_BYTES}, the largest chunk core ever cuts.
   */
  readonly maxChunkBytes: number;
}

/** A chunk whose bytes hashed to its declared sha256. */
export interface VerifiedChunk {
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** The chunk-size limit {@link ingestChunk} applies for `limits`. */
export function effectiveChunkLimit(limits: ChunkIngestLimits): number {
  return Math.min(CHUNK_BYTES, limits.maxChunkBytes);
}

/**
 * Reads exactly `declared.size` bytes of one chunk from `reader`, hashing
 * them as they arrive, and returns them only once the hash matched. The
 * rest of the stream is left unread. Refuses, with a
 * {@link ChunkIngestError}: a malformed sha256 or size, a size above the
 * chunk limit (both before reading), a stream that ends early
 * ({@link ChunkTruncatedError}), and a hash mismatch. Stream-level refusals
 * ({@link StreamTooLargeError}) and aborts propagate as they are.
 *
 * For a whole request body that is one chunk, follow with
 * `reader.assertEnd()`.
 */
export async function ingestChunk(
  reader: FramedReader,
  declared: ChunkDeclaration,
  limits: ChunkIngestLimits,
  signal?: AbortSignal,
): Promise<VerifiedChunk> {
  const { sha256, size } = declared;
  if (typeof sha256 !== "string" || !isSha256Hex(sha256)) {
    throw new ChunkHashMalformedError(String(sha256));
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ChunkSizeInvalidError(size);
  }
  const limit = effectiveChunkLimit(limits);
  if (size > limit) throw new ChunkTooLargeError(size, limit);
  const bytes = new Uint8Array(size);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    for await (const piece of reader.pieces(size, signal)) {
      hash.update(piece);
      bytes.set(piece, offset);
      offset += piece.byteLength;
    }
  } catch (error) {
    if (error instanceof StreamTruncatedError) {
      throw new ChunkTruncatedError(sha256, size, error.received);
    }
    throw error;
  }
  const actual = hash.digest("hex");
  if (actual !== sha256) throw new ChunkHashMismatchError(sha256, actual);
  return { sha256, size, bytes };
}

/** An inclusive byte range of a chunk. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parses a `Range` header against content of `size` bytes. Returns the
 * inclusive range, `"unsatisfiable"` (answer 416), or undefined when there
 * is no header or it is to be ignored (answer 200 with the whole body).
 *
 * One range is supported: `bytes=a-b` (`b` past the end is clamped),
 * `bytes=a-`, and `bytes=-n` (the last `n` bytes). Ignored, as RFC 9110
 * allows: another unit, a malformed spec, a reversed range (`b < a`, an
 * invalid spec), and any multi-range request — swamp clients never ask for
 * one, and a multipart reply is not worth its weight here. Unsatisfiable:
 * a start at or past the end, `bytes=-0`, and any range of empty content.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  if (header === null || header === undefined) return undefined;
  const match = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(header);
  if (match === null) return undefined;
  const spec = match[1];
  if (spec.includes(",")) return undefined;
  const suffix = /^-(\d+)$/.exec(spec);
  if (suffix !== null) {
    const n = Number(suffix[1]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const bounded = /^(\d+)-(\d*)$/.exec(spec);
  if (bounded === null) return undefined;
  const start = Number(bounded[1]);
  const last = bounded[2] === "" ? undefined : Number(bounded[2]);
  if (last !== undefined && last < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return {
    start,
    end: last === undefined ? size - 1 : Math.min(last, size - 1),
  };
}

/** The `Cache-Control` of a chunk read: content-addressed, never changes. */
export const CHUNK_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * The response to a chunk read: 200 with the whole chunk, 206 with
 * `Content-Range` for a range, or 416 with `Content-Range: bytes *\/size`.
 * Every answer carries the quoted sha256 as its ETag, `Accept-Ranges:
 * bytes` and an immutable `Cache-Control`.
 */
export function chunkReadResponse(
  bytes: Uint8Array,
  range: ByteRange | "unsatisfiable" | undefined,
  sha256: string,
): Response {
  const size = bytes.byteLength;
  const headers = new Headers({
    "etag": `"${sha256}"`,
    "accept-ranges": "bytes",
    "cache-control": CHUNK_CACHE_CONTROL,
  });
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-type", "application/octet-stream");
  if (range === undefined) {
    headers.set("content-length", String(size));
    return new Response(toBody(bytes), { status: 200, headers });
  }
  const body = bytes.subarray(range.start, range.end + 1);
  headers.set("content-length", String(body.byteLength));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(toBody(body), { status: 206, headers });
}

function toBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
}
