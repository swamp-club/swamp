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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import type { DatastoreStorage } from "../datastore/datastore_storage.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../data/namespace.ts";
import { BlobRef } from "./blob_ref.ts";
import {
  CHUNK_BYTES,
  ChunkIntegrityError,
  ChunkMissingError,
  ChunkStore,
  SOLO_STORAGE_NAMESPACE,
  storageNamespaceOf,
} from "./chunk_store.ts";
import { MAX_INLINE_BYTES } from "./op.ts";
import { MemoryStorage, readAll, streamOf } from "./v3_test_helpers.ts";

const NS = restoreNamespace("team-a");
const live = () => new AbortController().signal;
const hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bytesOf = (length: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 256);

Deno.test("ChunkStore: chunk size is min(16 MiB, maxChunkBytes)", () => {
  assertEquals(new ChunkStore(new MemoryStorage()).chunkBytes, CHUNK_BYTES);
  assertEquals(
    new ChunkStore(new MemoryStorage({ maxChunkBytes: 5 })).chunkBytes,
    5,
  );
});

Deno.test("ChunkStore: refuses a storage with the wrong contract or capabilities", () => {
  const wrongContract = Object.assign(new MemoryStorage(), {
    contract: "storage/2",
  }) as unknown as DatastoreStorage;
  assertThrows(() => new ChunkStore(wrongContract), Error, "storage/1");
  for (const maxChunkBytes of [0, -1, 1.5, Number.NaN]) {
    assertThrows(
      () => new ChunkStore(new MemoryStorage({ maxChunkBytes })),
      Error,
      "maxChunkBytes",
    );
  }
  const touchNotDeclared = new MemoryStorage();
  touchNotDeclared.capabilities = () => ({
    maxChunkBytes: 10,
    touch: false,
  });
  assertThrows(() => new ChunkStore(touchNotDeclared), Error, "touch");
  const touchMissing = new MemoryStorage({ touch: false });
  touchMissing.capabilities = () => ({ maxChunkBytes: 10, touch: true });
  assertThrows(() => new ChunkStore(touchMissing), Error, "touch");
});

Deno.test("ChunkStore.write: content just above MAX_INLINE_BYTES is one chunk with no parts", async () => {
  const storage = new MemoryStorage();
  const content = bytesOf(MAX_INLINE_BYTES + 1);
  const ref = await new ChunkStore(storage).write(NS, content, live());
  assertEquals(ref.toJSON(), { sha256: hex(content), size: content.length });
  assertEquals([...storage.chunks.keys()], [`team-a/${hex(content)}`]);
});

Deno.test("ChunkStore.write: chunk boundaries", async () => {
  const cases: [number, number[]][] = [
    [4, [4]],
    [5, [4, 1]],
    [8, [4, 4]],
    [11, [4, 4, 3]],
  ];
  for (const [length, sizes] of cases) {
    const storage = new MemoryStorage({ maxChunkBytes: 4 });
    const content = bytesOf(length);
    const ref = await new ChunkStore(storage).write(NS, content, live());
    assertEquals(ref.sha256, hex(content));
    assertEquals(ref.size, length);
    assertEquals(ref.parts?.map((p) => p.size) ?? [length], sizes);
    if (ref.parts !== undefined) {
      ref.parts.forEach((part, i) =>
        assertEquals(part.sha256, hex(content.subarray(i * 4, i * 4 + 4)))
      );
    }
    assertEquals(
      storage.chunks.size,
      new Set(ref.parts?.map((p) => p.sha256)).size || 1,
    );
  }
});

Deno.test("ChunkStore.write: empty content is one empty chunk", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const empty = new Uint8Array(0);
  for (const content of [empty, streamOf(empty)]) {
    const ref = await store.write(NS, content, live());
    assertEquals(ref.toJSON(), { sha256: hex(empty), size: 0 });
    assertEquals(await readAll(store.read(NS, ref, live())), empty);
  }
});

Deno.test("ChunkStore.write: a stream gives the same reference however it is split", async () => {
  const content = bytesOf(23);
  const store = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }));
  const expected = await store.write(NS, content, live());
  for (const pieces of [[], [1], [3, 1, 9], [4, 4], [23], [2, 2, 2, 2, 2]]) {
    const ref = await store.write(NS, streamOf(content, pieces), live());
    assert(ref.equals(expected), `pieces ${pieces}`);
  }
});

Deno.test("ChunkStore.write: skips chunks already stored and touches them instead", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(9);
  await store.write(NS, content, live());
  assertEquals(storage.puts(), 3);
  storage.calls.length = 0;
  await store.write(NS, content, live());
  assertEquals(storage.calls, [
    "has 1",
    "touch 1",
    "has 1",
    "touch 1",
    "has 1",
    "touch 1",
  ]);
});

Deno.test("ChunkStore.write: without touch, puts a present chunk again", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4, touch: false });
  const store = new ChunkStore(storage);
  await store.write(NS, bytesOf(4), live());
  storage.calls.length = 0;
  await store.write(NS, bytesOf(4), live());
  assertEquals(storage.calls, ["has 1", `put ${hex(bytesOf(4)).slice(0, 8)}`]);
});

Deno.test("ChunkStore.write: puts a chunk again when touch no longer finds it", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(4);
  await store.write(NS, content, live());
  // The chunk vanishes between has and touch, as a concurrent GC could do.
  storage.has = (_ns, hashes) => Promise.resolve(new Set(hashes));
  storage.chunks.clear();
  storage.calls.length = 0;
  await store.write(NS, content, live());
  assertEquals(storage.calls, ["touch 1", `put ${hex(content).slice(0, 8)}`]);
  assert(storage.chunks.has(`team-a/${hex(content)}`));
});

Deno.test("ChunkStore.read: round-trips one and many chunks", async () => {
  const store = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }));
  for (const length of [1, 4, 5, 17]) {
    const content = bytesOf(length);
    const ref = await store.write(NS, content, live());
    assertEquals(await readAll(store.read(NS, ref, live())), content);
  }
});

Deno.test("ChunkStore.read: a corrupted or resized chunk is an integrity error", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(8);
  const ref = await store.write(NS, content, live());
  const key = `team-a/${ref.parts![1].sha256}`;
  const flipped = storage.chunks.get(key)!.slice();
  flipped[0] ^= 1;
  storage.chunks.set(key, flipped);
  await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkIntegrityError,
    "SHA-256",
  );
  storage.chunks.set(key, new Uint8Array(3));
  await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkIntegrityError,
    "3 bytes",
  );
});

Deno.test("ChunkStore.read: never yields a chunk that fails its check", async () => {
  const storage = new MemoryStorage();
  const store = new ChunkStore(storage);
  const ref = await store.write(NS, bytesOf(10), live());
  storage.chunks.set(`team-a/${ref.sha256}`, bytesOf(9).fill(1, 0, 9));
  const reader = store.read(NS, ref, live()).getReader();
  await assertRejects(() => reader.read(), ChunkIntegrityError);
});

Deno.test("ChunkStore.read: a missing chunk is ChunkMissingError", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const ref = await store.write(NS, bytesOf(6), live());
  storage.chunks.delete(`team-a/${ref.parts![0].sha256}`);
  const error = await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkMissingError,
  );
  assertEquals(error.sha256, ref.parts![0].sha256);
});

Deno.test("ChunkStore.read: whole-content digest mismatch errors at the end", async () => {
  const store = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }));
  const ref = await store.write(NS, bytesOf(6), live());
  const forged = BlobRef.create({
    sha256: "0".repeat(64),
    size: ref.size,
    parts: ref.parts,
  });
  await assertRejects(
    () => readAll(store.read(NS, forged, live())),
    ChunkIntegrityError,
    "2 chunks",
  );
  // The first chunk is handed on; the last is held back by the failed check.
  const reader = store.read(NS, forged, live()).getReader();
  assertEquals((await reader.read()).value?.length, 4);
  await assertRejects(() => reader.read(), ChunkIntegrityError);
});

Deno.test("ChunkStore: honours an aborted signal", async () => {
  const store = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }));
  const ref = await store.write(NS, bytesOf(6), live());
  const aborted = AbortSignal.abort(new Error("stop"));
  await assertRejects(
    () => store.write(NS, bytesOf(6), aborted),
    Error,
    "stop",
  );
  await assertRejects(
    () => store.write(NS, streamOf(bytesOf(6), [1]), aborted),
    Error,
    "stop",
  );
  await assertRejects(
    () => readAll(store.read(NS, ref, aborted)),
    Error,
    "stop",
  );
});

Deno.test("ChunkStore: solo mode stores under the _solo namespace, apart from named ones", async () => {
  assertEquals(storageNamespaceOf(SOLO_NAMESPACE), SOLO_STORAGE_NAMESPACE);
  assertEquals(storageNamespaceOf(NS), "team-a");
  const storage = new MemoryStorage();
  const store = new ChunkStore(storage);
  const ref = await store.write(SOLO_NAMESPACE, bytesOf(3), live());
  assertEquals([...storage.chunks.keys()], [`_solo/${ref.sha256}`]);
  await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkMissingError,
  );
});

Deno.test("ChunkStore.read: fetches nothing until the stream is read", async () => {
  const storage = new MemoryStorage();
  const store = new ChunkStore(storage);
  const ref = await store.write(NS, bytesOf(10), live());
  let gets = 0;
  const get = storage.get.bind(storage);
  storage.get = (...args) => {
    gets++;
    return get(...args);
  };
  const stream = store.read(NS, ref, live());
  await Promise.resolve();
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  assertEquals(gets, 0);
  assertEquals(await readAll(stream), bytesOf(10));
  assertEquals(gets, 1);
});

Deno.test("ChunkStore.write: cancels the source stream when a write fails, and only then", async () => {
  let cancelled = 0;
  const source = (length: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytesOf(length));
      },
      pull() {/* never closes */},
      cancel() {
        cancelled++;
      },
    });
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  storage.put = () => Promise.reject(new Error("storage down"));
  await assertRejects(
    () => new ChunkStore(storage).write(NS, source(8), live()),
    Error,
    "storage down",
  );
  assertEquals(cancelled, 1);
  const ok = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }));
  await ok.write(NS, streamOf(bytesOf(8), [3]), live());
  assertEquals(cancelled, 1);
});

Deno.test("ChunkStore.write: an abort interrupts a source stream that has stalled", async () => {
  const controller = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytesOf(3));
    },
    pull: () => new Promise(() => {/* never produces or closes */}),
  });
  const write = new ChunkStore(new MemoryStorage({ maxChunkBytes: 4 }))
    .write(NS, stalled, controller.signal);
  queueMicrotask(() => controller.abort(new Error("stop")));
  await assertRejects(() => write, Error, "stop");
});
