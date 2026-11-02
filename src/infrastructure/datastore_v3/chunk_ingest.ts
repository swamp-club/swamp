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
 * ingestChunk hashes as it reads and hands bytes on only once the SHA-256
 * matched, so nothing unverified is staged; memory is bounded at one chunk
 */

// node:crypto, not WebCrypto: the digest is computed piece by piece as the
// body arrives, and crypto.subtle.digest cannot hash incrementally.
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";

export type ChunkIngestErrorCode =
  | "chunk_hash_malformed"
  | "chunk_size_invalid"
  | "chunk_too_large"
  | "chunk_truncated"
  | "chunk_hash_mismatch"
  | "stream_truncated"
  | "stream_too_large"
  | "stream_trailing_bytes";

export class ChunkIngestError extends Error {
  constructor(readonly code: ChunkIngestErrorCode, message: string) {
    super(message);
    this.name = "ChunkIngestError";
  }
}

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

export class ChunkSizeInvalidError extends ChunkIngestError {
  constructor(readonly size: number) {
    super(
      "chunk_size_invalid",
      `Chunk size must be a non-negative integer: ${String(size)}`,
    );
    this.name = "ChunkSizeInvalidError";
  }
}

export class ChunkTooLargeError extends ChunkIngestError {
  constructor(readonly size: number, readonly limit: number) {
    super(
      "chunk_too_large",
      `Chunk of ${size} bytes is above the ${limit}-byte chunk limit`,
    );
    this.name = "ChunkTooLargeError";
  }
}

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

export class ChunkHashMismatchError extends ChunkIngestError {
  constructor(readonly sha256: string, readonly actual: string) {
    super(
      "chunk_hash_mismatch",
      `Chunk bytes hash to ${actual}, not the declared ${sha256}`,
    );
    this.name = "ChunkHashMismatchError";
  }
}

export class StreamTruncatedError extends ChunkIngestError {
  constructor(readonly wanted: number, readonly received: number) {
    super(
      "stream_truncated",
      `Request body ended after ${received} of ${wanted} expected bytes`,
    );
    this.name = "StreamTruncatedError";
  }
}

export class StreamTooLargeError extends ChunkIngestError {
  constructor(readonly maxBytes: number) {
    super(
      "stream_too_large",
      `Request body is larger than its ${maxBytes}-byte limit`,
    );
    this.name = "StreamTooLargeError";
  }
}

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

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

function assertByteCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Byte count must be a non-negative integer: ${n}`);
  }
}

/**
 * a read that would pass maxBytes is refused before reading; an aborted signal
 * cancels the stream and rejects with the signal's reason
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

  get consumed(): number {
    return this.#consumed;
  }

  /** a piece may be a view of the stream's buffer: copy it to keep it */
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

  async readUint32BE(signal?: AbortSignal): Promise<number> {
    const bytes = await this.readExactly(4, signal);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  }

  /** reads at most one more stream chunk past the end of what was handed out */
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

  async cancel(reason?: unknown): Promise<void> {
    this.#done = true;
    this.#pending = new Uint8Array(0);
    await this.#reader.cancel(reason).catch(() => {});
  }

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

export interface CarriedChunk {
  readonly bytes: Uint8Array;
}

/**
 * the envelope is serialized as given; listing each carried chunk's sha256 and
 * size in chunks, in the same order, is the caller's part
 */
export function encodeCommitBody(
  envelope: object,
  chunks: readonly CarriedChunk[] = [],
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  if (json.byteLength > 0xffff_ffff) {
    throw new RangeError(
      `Commit envelope of ${json.byteLength} bytes does not fit its 4-byte length`,
    );
  }
  let total = 4 + json.byteLength;
  for (const chunk of chunks) total += chunk.bytes.byteLength;
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, json.byteLength, false);
  body.set(json, 4);
  let offset = 4 + json.byteLength;
  for (const chunk of chunks) {
    body.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return body;
}

export interface ChunkDeclaration {
  readonly sha256: string;
  readonly size: number;
}

export interface ChunkIngestLimits {
  /**
   * the effective limit is the smaller of it and CHUNK_BYTES, the largest chunk
   * core ever cuts
   */
  readonly maxChunkBytes: number;
}

export interface VerifiedChunk {
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export function effectiveChunkLimit(limits: ChunkIngestLimits): number {
  return Math.min(CHUNK_BYTES, limits.maxChunkBytes);
}

/**
 * the rest of the stream is left unread; a malformed sha256 or size, or a size
 * above the limit, is refused before reading. For a whole request body that is
 * one chunk, follow with reader.assertEnd()
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

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * ignored, as RFC 9110 allows: another unit, a malformed or reversed spec, and
 * multi-range requests, which swamp clients never make; unsatisfiable: a start
 * at or past the end, bytes=-0, or empty content
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
