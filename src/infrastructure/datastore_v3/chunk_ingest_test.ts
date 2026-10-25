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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import {
  CHUNK_CACHE_CONTROL,
  ChunkHashMalformedError,
  ChunkHashMismatchError,
  ChunkIngestError,
  chunkReadResponse,
  ChunkSizeInvalidError,
  ChunkTooLargeError,
  ChunkTruncatedError,
  effectiveChunkLimit,
  FramedReader,
  ingestChunk,
  parseRange,
  StreamTooLargeError,
  StreamTrailingBytesError,
  StreamTruncatedError,
} from "./chunk_ingest.ts";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A stream yielding `bytes` split at `cuts` (offsets, any order). */
function streamOf(
  bytes: Uint8Array,
  cuts: readonly number[] = [],
): ReadableStream<Uint8Array> & { pulled: () => number } {
  const offsets = [...new Set([0, ...cuts, bytes.byteLength])]
    .filter((o) => o >= 0 && o <= bytes.byteLength)
    .sort((a, b) => a - b);
  const pieces: Uint8Array[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    pieces.push(bytes.slice(offsets[i], offsets[i + 1]));
  }
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.shift();
      if (next === undefined) controller.close();
      else {
        pulled++;
        controller.enqueue(next);
      }
    },
  }, { highWaterMark: 0 });
  return Object.assign(stream, { pulled: () => pulled });
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const LIMITS = { maxChunkBytes: 1024 };
const BIG = 1 << 30;

// ── ingestChunk ─────────────────────────────────────────────────────────

Deno.test("ingestChunk: returns bytes whose hash matches the declaration", async () => {
  const data = new TextEncoder().encode("hello chunk");
  const reader = new FramedReader(streamOf(data, [1, 5, 7]), {
    maxBytes: BIG,
  });
  const chunk = await ingestChunk(
    reader,
    { sha256: sha(data), size: data.byteLength },
    LIMITS,
  );
  assertEquals(chunk.bytes, data);
  assertEquals(chunk.sha256, sha(data));
  assertEquals(chunk.size, data.byteLength);
  await reader.assertEnd();
});

Deno.test("ingestChunk: reads one chunk and leaves the rest of the stream", async () => {
  const a = bytesOf(1, 2, 3, 4, 5);
  const b = bytesOf(9, 8, 7);
  const reader = new FramedReader(streamOf(concat(a, b), [2, 6]), {
    maxBytes: BIG,
  });
  const first = await ingestChunk(reader, { sha256: sha(a), size: 5 }, LIMITS);
  assertEquals(first.bytes, a);
  assertEquals(reader.consumed, 5);
  const second = await ingestChunk(reader, { sha256: sha(b), size: 3 }, LIMITS);
  assertEquals(second.bytes, b);
  await reader.assertEnd();
});

Deno.test("ingestChunk: accepts an empty chunk", async () => {
  const empty = new Uint8Array(0);
  const reader = new FramedReader(streamOf(empty), { maxBytes: BIG });
  const chunk = await ingestChunk(
    reader,
    { sha256: sha(empty), size: 0 },
    LIMITS,
  );
  assertEquals(chunk.bytes.byteLength, 0);
});

Deno.test("ingestChunk: refuses a size above maxChunkBytes before reading", async () => {
  const stream = streamOf(new Uint8Array(2000));
  const reader = new FramedReader(stream, { maxBytes: BIG });
  const error = await assertRejects(
    () => ingestChunk(reader, { sha256: "a".repeat(64), size: 1025 }, LIMITS),
    ChunkTooLargeError,
  );
  assertEquals(error.code, "chunk_too_large");
  assertEquals(error.limit, 1024);
  assertEquals(stream.pulled(), 0);
});

Deno.test("ingestChunk: the limit never exceeds CHUNK_BYTES", () => {
  assertEquals(
    effectiveChunkLimit({ maxChunkBytes: CHUNK_BYTES * 4 }),
    CHUNK_BYTES,
  );
  assertEquals(effectiveChunkLimit({ maxChunkBytes: 10 }), 10);
});

Deno.test("ingestChunk: accepts a chunk exactly at the limit", async () => {
  const data = new Uint8Array(1024).fill(7);
  const reader = new FramedReader(streamOf(data, [333]), { maxBytes: BIG });
  const chunk = await ingestChunk(
    reader,
    { sha256: sha(data), size: 1024 },
    LIMITS,
  );
  assertEquals(chunk.bytes, data);
});

Deno.test("ingestChunk: refuses a malformed sha256", async () => {
  for (
    const bad of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      ` ${"a".repeat(63)}`,
      "../" + "a".repeat(61),
    ]
  ) {
    const stream = streamOf(bytesOf(1));
    const error = await assertRejects(
      () =>
        ingestChunk(
          new FramedReader(stream, { maxBytes: BIG }),
          { sha256: bad, size: 1 },
          LIMITS,
        ),
      ChunkHashMalformedError,
    );
    assertEquals(error.code, "chunk_hash_malformed");
    assertEquals(stream.pulled(), 0);
  }
});

Deno.test("ingestChunk: refuses an invalid size", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const error = await assertRejects(
      () =>
        ingestChunk(
          new FramedReader(streamOf(bytesOf(1)), { maxBytes: BIG }),
          { sha256: "a".repeat(64), size: bad },
          LIMITS,
        ),
      ChunkSizeInvalidError,
    );
    assertEquals(error.code, "chunk_size_invalid");
  }
});

Deno.test("ingestChunk: refuses a stream that ends early", async () => {
  const data = bytesOf(1, 2, 3);
  const error = await assertRejects(
    () =>
      ingestChunk(
        new FramedReader(streamOf(data, [1]), { maxBytes: BIG }),
        { sha256: sha(bytesOf(1, 2, 3, 4)), size: 4 },
        LIMITS,
      ),
    ChunkTruncatedError,
  );
  assertEquals(error.code, "chunk_truncated");
  assertEquals(error.received, 3);
  assertEquals(error.size, 4);
  assertInstanceOf(error, ChunkIngestError);
});

Deno.test("ingestChunk: refuses bytes that do not match the declared hash", async () => {
  const data = bytesOf(1, 2, 3);
  const declared = sha(bytesOf(1, 2, 4));
  const error = await assertRejects(
    () =>
      ingestChunk(
        new FramedReader(streamOf(data), { maxBytes: BIG }),
        { sha256: declared, size: 3 },
        LIMITS,
      ),
    ChunkHashMismatchError,
  );
  assertEquals(error.code, "chunk_hash_mismatch");
  assertEquals(error.actual, sha(data));
});

Deno.test("ingestChunk: hands nothing to a stager when the hash mismatches", async () => {
  const staged: Uint8Array[] = [];
  const data = bytesOf(5, 5, 5);
  await assertRejects(async () => {
    const chunk = await ingestChunk(
      new FramedReader(streamOf(data), { maxBytes: BIG }),
      { sha256: "0".repeat(64), size: 3 },
      LIMITS,
    );
    staged.push(chunk.bytes);
  }, ChunkHashMismatchError);
  assertEquals(staged.length, 0);
});

Deno.test("ingestChunk: a stream cap below the chunk is refused as stream_too_large", async () => {
  const data = bytesOf(1, 2, 3, 4);
  const error = await assertRejects(
    () =>
      ingestChunk(
        new FramedReader(streamOf(data), { maxBytes: 3 }),
        { sha256: sha(data), size: 4 },
        LIMITS,
      ),
    StreamTooLargeError,
  );
  assertEquals(error.code, "stream_too_large");
});

Deno.test("ingestChunk: an aborted signal rejects with its reason", async () => {
  const controller = new AbortController();
  const reason = new Error("client went away");
  // A stream that never produces: the read waits until the abort.
  const stream = new ReadableStream<Uint8Array>({ pull() {} });
  const reader = new FramedReader(stream, { maxBytes: BIG });
  const pending = ingestChunk(
    reader,
    { sha256: "a".repeat(64), size: 4 },
    LIMITS,
    controller.signal,
  );
  controller.abort(reason);
  const error = await assertRejects(() => pending);
  assertStrictEquals(error, reason);
});

// ── FramedReader ────────────────────────────────────────────────────────

Deno.test("FramedReader: readUint32BE reads big-endian across a split", async () => {
  const reader = new FramedReader(
    streamOf(bytesOf(0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff), [
      1,
      3,
      6,
    ]),
    { maxBytes: BIG },
  );
  assertEquals(await reader.readUint32BE(), 0x01020304);
  assertEquals(await reader.readUint32BE(), 0xffffffff);
  await reader.assertEnd();
});

Deno.test("FramedReader: readExactly refuses past the overall cap before reading", async () => {
  const stream = streamOf(new Uint8Array(10));
  const reader = new FramedReader(stream, { maxBytes: 6 });
  assertEquals((await reader.readExactly(4)).byteLength, 4);
  await assertRejects(() => reader.readExactly(3), StreamTooLargeError);
  assertEquals(reader.consumed, 4);
  assertEquals((await reader.readExactly(2)).byteLength, 2);
});

Deno.test("FramedReader: readExactly refuses a stream that ends early", async () => {
  const reader = new FramedReader(streamOf(bytesOf(1, 2)), { maxBytes: BIG });
  const error = await assertRejects(
    () => reader.readExactly(3),
    StreamTruncatedError,
  );
  assertEquals(error.code, "stream_truncated");
  assertEquals(error.received, 2);
});

Deno.test("FramedReader: readExactly(0) reads nothing", async () => {
  const stream = streamOf(bytesOf(1));
  const reader = new FramedReader(stream, { maxBytes: BIG });
  assertEquals((await reader.readExactly(0)).byteLength, 0);
  assertEquals(stream.pulled(), 0);
});

Deno.test("FramedReader: assertEnd refuses trailing bytes, buffered or not", async () => {
  const buffered = new FramedReader(streamOf(bytesOf(1, 2, 3)), {
    maxBytes: BIG,
  });
  await buffered.readExactly(2);
  const error = await assertRejects(
    () => buffered.assertEnd(),
    StreamTrailingBytesError,
  );
  assertEquals(error.code, "stream_trailing_bytes");

  const unread = new FramedReader(streamOf(bytesOf(1, 2, 3), [2]), {
    maxBytes: BIG,
  });
  await unread.readExactly(2);
  await assertRejects(() => unread.assertEnd(), StreamTrailingBytesError);
});

Deno.test("FramedReader: assertEnd skips empty stream chunks", async () => {
  const pieces = [bytesOf(1), new Uint8Array(0), new Uint8Array(0)];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
  const reader = new FramedReader(stream, { maxBytes: BIG });
  assertEquals(await reader.readExactly(1), bytesOf(1));
  await reader.assertEnd();
});

Deno.test("FramedReader: rejects an invalid byte count", async () => {
  const reader = new FramedReader(streamOf(bytesOf(1)), { maxBytes: BIG });
  await assertRejects(() => reader.readExactly(-1), RangeError);
  await assertRejects(() => reader.readExactly(0.5), RangeError);
});

Deno.test("FramedReader: a framed commit body round-trips at any split", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.jsonValue(),
      fc.array(fc.uint8Array({ minLength: 0, maxLength: 64 }), {
        maxLength: 5,
      }),
      fc.array(fc.nat(1024), { maxLength: 12 }),
      async (envelope, chunks, cuts) => {
        const json = new TextEncoder().encode(JSON.stringify(envelope));
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, json.byteLength, false);
        const body = concat(length, json, ...chunks);
        const reader = new FramedReader(streamOf(body, cuts), {
          maxBytes: body.byteLength,
        });
        const n = await reader.readUint32BE();
        assertEquals(n, json.byteLength);
        const decoded = JSON.parse(
          new TextDecoder().decode(await reader.readExactly(n)),
        );
        assertEquals(decoded, JSON.parse(JSON.stringify(envelope)));
        for (const chunk of chunks) {
          const verified = await ingestChunk(
            reader,
            { sha256: sha(chunk), size: chunk.byteLength },
            LIMITS,
          );
          assertEquals(verified.bytes, chunk);
        }
        await reader.assertEnd();
        assertEquals(reader.consumed, body.byteLength);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("FramedReader: one corrupt chunk is found at any split", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 1, maxLength: 64 }),
      fc.nat(),
      fc.array(fc.nat(64), { maxLength: 8 }),
      async (chunk, flip, cuts) => {
        const declared = sha(chunk);
        const corrupt = chunk.slice();
        corrupt[flip % corrupt.length] ^= 0x01;
        const reader = new FramedReader(streamOf(corrupt, cuts), {
          maxBytes: BIG,
        });
        await assertRejects(
          () =>
            ingestChunk(
              reader,
              { sha256: declared, size: chunk.byteLength },
              LIMITS,
            ),
          ChunkHashMismatchError,
        );
      },
    ),
    { numRuns: 100 },
  );
});

// ── parseRange ──────────────────────────────────────────────────────────

Deno.test("parseRange: no header or an ignorable one answers undefined", () => {
  for (
    const header of [
      null,
      undefined,
      "",
      "items=0-1",
      "bytes=",
      "bytes=abc",
      "bytes=1-2-3",
      "bytes=0-1,3-4",
      "bytes=-",
      "bytes=--1",
      "bytes=5-2",
    ]
  ) {
    assertEquals(parseRange(header, 10), undefined, String(header));
  }
});

Deno.test("parseRange: bytes=a-b", () => {
  assertEquals(parseRange("bytes=0-0", 10), { start: 0, end: 0 });
  assertEquals(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assertEquals(parseRange("bytes=9-9", 10), { start: 9, end: 9 });
  assertEquals(parseRange("bytes=0-9", 10), { start: 0, end: 9 });
  // An end past the content is clamped.
  assertEquals(parseRange("bytes=3-1000", 10), { start: 3, end: 9 });
  assertEquals(parseRange("Bytes = 1-2 ", 10), { start: 1, end: 2 });
});

Deno.test("parseRange: bytes=a-", () => {
  assertEquals(parseRange("bytes=0-", 10), { start: 0, end: 9 });
  assertEquals(parseRange("bytes=9-", 10), { start: 9, end: 9 });
});

Deno.test("parseRange: bytes=-n", () => {
  assertEquals(parseRange("bytes=-1", 10), { start: 9, end: 9 });
  assertEquals(parseRange("bytes=-4", 10), { start: 6, end: 9 });
  assertEquals(parseRange("bytes=-10", 10), { start: 0, end: 9 });
  assertEquals(parseRange("bytes=-999", 10), { start: 0, end: 9 });
});

Deno.test("parseRange: unsatisfiable ranges", () => {
  assertEquals(parseRange("bytes=10-", 10), "unsatisfiable");
  assertEquals(parseRange("bytes=10-20", 10), "unsatisfiable");
  assertEquals(parseRange("bytes=99999999999999999999-", 10), "unsatisfiable");
  assertEquals(parseRange("bytes=-0", 10), "unsatisfiable");
  assertEquals(parseRange("bytes=0-0", 0), "unsatisfiable");
  assertEquals(parseRange("bytes=0-", 0), "unsatisfiable");
  assertEquals(parseRange("bytes=-5", 0), "unsatisfiable");
});

Deno.test("parseRange: any satisfiable range lies inside the content", () => {
  fc.assert(
    fc.property(
      fc.nat(100),
      fc.option(fc.nat(200), { nil: undefined }),
      fc.option(fc.nat(200), { nil: undefined }),
      (size, a, b) => {
        const header = `bytes=${a ?? ""}-${b ?? ""}`;
        const range = parseRange(header, size);
        if (range === undefined || range === "unsatisfiable") return;
        assert(range.start >= 0 && range.start <= range.end);
        assert(range.end < size);
      },
    ),
  );
});

// ── chunkReadResponse ───────────────────────────────────────────────────

const CONTENT = bytesOf(10, 11, 12, 13, 14);
const CONTENT_SHA = sha(CONTENT);

function assertCommonHeaders(response: Response): void {
  assertEquals(response.headers.get("etag"), `"${CONTENT_SHA}"`);
  assertEquals(response.headers.get("accept-ranges"), "bytes");
  assertEquals(response.headers.get("cache-control"), CHUNK_CACHE_CONTROL);
  assert(CHUNK_CACHE_CONTROL.includes("immutable"));
}

Deno.test("chunkReadResponse: 200 with the whole chunk", async () => {
  const response = chunkReadResponse(CONTENT, undefined, CONTENT_SHA);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-length"), "5");
  assertEquals(response.headers.get("content-range"), null);
  assertCommonHeaders(response);
  assertEquals(new Uint8Array(await response.arrayBuffer()), CONTENT);
});

Deno.test("chunkReadResponse: 206 with Content-Range", async () => {
  const response = chunkReadResponse(
    CONTENT,
    parseRange("bytes=1-3", 5),
    CONTENT_SHA,
  );
  assertEquals(response.status, 206);
  assertEquals(response.headers.get("content-range"), "bytes 1-3/5");
  assertEquals(response.headers.get("content-length"), "3");
  assertCommonHeaders(response);
  assertEquals(
    new Uint8Array(await response.arrayBuffer()),
    bytesOf(11, 12, 13),
  );
});

Deno.test("chunkReadResponse: 206 for the last byte", async () => {
  const response = chunkReadResponse(
    CONTENT,
    parseRange("bytes=-1", 5),
    CONTENT_SHA,
  );
  assertEquals(response.status, 206);
  assertEquals(response.headers.get("content-range"), "bytes 4-4/5");
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytesOf(14));
});

Deno.test("chunkReadResponse: 416 with bytes */size", async () => {
  const response = chunkReadResponse(
    CONTENT,
    parseRange("bytes=5-", 5),
    CONTENT_SHA,
  );
  assertEquals(response.status, 416);
  assertEquals(response.headers.get("content-range"), "bytes */5");
  assertCommonHeaders(response);
  assertEquals((await response.arrayBuffer()).byteLength, 0);
});

Deno.test("chunkReadResponse: serves a view of a larger buffer correctly", async () => {
  const backing = bytesOf(0, 0, 1, 2, 3, 0);
  const view = backing.subarray(2, 5);
  const response = chunkReadResponse(view, { start: 1, end: 2 }, sha(view));
  assertEquals(response.headers.get("content-range"), "bytes 1-2/3");
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytesOf(2, 3));
});
