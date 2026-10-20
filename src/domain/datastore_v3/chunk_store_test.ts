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
import type {
  ChunkStat,
  DatastoreStorage,
} from "../datastore/datastore_storage.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../data/namespace.ts";
import { BlobRef } from "./blob_ref.ts";
import {
  CHUNK_BYTES,
  ChunkIntegrityError,
  ChunkMissingError,
  ChunkPutError,
  ChunkStore,
  type ContentRangeReader,
  storageNamespaceOf,
  UNNAMESPACED_STORAGE_NAMESPACE,
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

Deno.test("ChunkStore: an unnamespaced datastore stores under _default, apart from named ones", async () => {
  assertEquals(UNNAMESPACED_STORAGE_NAMESPACE, "_default");
  assertEquals(
    storageNamespaceOf(SOLO_NAMESPACE),
    UNNAMESPACED_STORAGE_NAMESPACE,
  );
  assertEquals(storageNamespaceOf(NS), "team-a");
  const storage = new MemoryStorage();
  const store = new ChunkStore(storage);
  const ref = await store.write(SOLO_NAMESPACE, bytesOf(3), live());
  assertEquals([...storage.chunks.keys()], [`_default/${ref.sha256}`]);
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

Deno.test("ChunkStore.refresh: touches the chunks it holds and returns the missing ones; checks only on a storage that cannot touch (swamp-club#3586)", async () => {
  for (const touch of [true, false]) {
    const storage = new MemoryStorage({ maxChunkBytes: 4, touch });
    const store = new ChunkStore(storage);
    const ref = await store.write(SOLO_NAMESPACE, bytesOf(10), live());
    const [first, ...rest] = ref.chunkHashes();
    await storage.delete("_default", first, live());
    const callsBefore = storage.calls.length;
    assertEquals(await store.refresh(SOLO_NAMESPACE, ref, live()), [first]);
    const calls = storage.calls.slice(callsBefore);
    assertEquals(
      calls.some((call) => call.startsWith("touch")),
      touch,
      `touch: ${touch}`,
    );
    assert(rest.length > 0);
  }
});

/**
 * A memory storage that reads chunk sizes and syncs chunk directories, as
 * the filesystem storage does (swamp-club#3617).
 */
class StatMemoryStorage extends MemoryStorage {
  readonly synced: { namespace: string; hashes: string[] }[] = [];

  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>> {
    signal.throwIfAborted();
    this.calls.push(`stat ${hashes.length}`);
    const found = new Map<string, ChunkStat>();
    for (const sha256 of hashes) {
      const bytes = this.chunks.get(`${namespace}/${sha256}`);
      if (bytes !== undefined) {
        found.set(sha256, { size: bytes.length, lastModified: new Date(0) });
      }
    }
    return Promise.resolve(found);
  }

  syncChunkDirectories(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.synced.push({ namespace, hashes: [...hashes] });
    return Promise.resolve();
  }

  /** Leaves the first `length` bytes of a chunk, as a power loss can. */
  tear(namespace: string, sha256: string, length: number): void {
    const key = `${namespace}/${sha256}`;
    this.chunks.set(key, this.chunks.get(key)!.slice(0, length));
  }
}

/** Reads `content` by range, as a file opened again would be. */
function rangeOf(content: () => Uint8Array): ContentRangeReader {
  return (offset, length, signal) => {
    signal.throwIfAborted();
    return Promise.resolve(content().slice(offset, offset + length));
  };
}

Deno.test("ChunkStore: a torn chunk counts as missing on a storage that reads sizes, and writing puts it again (swamp-club#3617)", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  assert(store.readsSizes);
  const content = bytesOf(10);
  const ref = await store.write(NS, content, live());
  const [first, second, third] = ref.chunkHashes();
  storage.tear("team-a", second, 1);
  assertEquals(await store.missing(NS, ref, live()), [second]);
  assertEquals(await store.refresh(NS, ref, live()), [second]);
  // An empty torn chunk is still held, at the wrong size.
  storage.tear("team-a", third, 0);
  assertEquals(await store.missing(NS, ref, live()), [second, third]);

  storage.calls.length = 0;
  assert((await store.write(NS, content, live())).equals(ref));
  assertEquals(storage.calls, [
    "stat 1",
    "touch 1",
    "stat 1",
    `put ${second.slice(0, 8)}`,
    "stat 1",
    `put ${third.slice(0, 8)}`,
  ]);
  assertEquals(await store.missing(NS, ref, live()), []);
  assertEquals(await readAll(store.read(NS, ref, live())), content);
  assert(first !== second);
});

Deno.test("ChunkStore.missing and refresh: a chunk backing several parts is listed once (swamp-club#3617)", async () => {
  for (
    const storage of [
      new MemoryStorage({ maxChunkBytes: 4 }),
      new MemoryStorage({ maxChunkBytes: 4, touch: true }),
      new StatMemoryStorage({ maxChunkBytes: 4 }),
    ]
  ) {
    const store = new ChunkStore(storage);
    // Three identical 4-byte chunks, then a shorter last one.
    const ref = await store.write(NS, new Uint8Array(14), live());
    const [repeated, , , last] = ref.chunkHashes();
    assertEquals(ref.chunkHashes().filter((h) => h === repeated).length, 3);
    await storage.delete("team-a", repeated, live());
    await storage.delete("team-a", last, live());
    assertEquals(await store.missing(NS, ref, live()), [repeated, last]);
    assertEquals(await store.refresh(NS, ref, live()), [repeated, last]);
  }
});

Deno.test("ChunkStore: without a size reader, a chunk the storage has is present (regression guard)", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  assert(!store.readsSizes);
  const ref = await store.write(NS, bytesOf(10), live());
  const second = ref.chunkHashes()[1];
  storage.chunks.set(`team-a/${second}`, new Uint8Array([1]));
  assertEquals(await store.missing(NS, ref, live()), []);
  assertEquals(await store.refresh(NS, ref, live()), []);
  assertEquals(await store.stat(NS, [second], live()), undefined);
});

Deno.test("ChunkStore.stat: reads stored sizes through the storage", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const ref = await store.write(SOLO_NAMESPACE, bytesOf(5), live());
  const [first, second] = ref.chunkHashes();
  const stats = await store.stat(
    SOLO_NAMESPACE,
    [first, second, "f".repeat(64)],
    live(),
  );
  assertEquals(stats?.get(first)?.size, 4);
  assertEquals(stats?.get(second)?.size, 1);
  assertEquals(stats?.size, 2);
});

Deno.test("ChunkStore.syncStored: syncs the chunks' directories in the storage namespace, and nothing for no hashes or a storage that cannot", async () => {
  const storage = new StatMemoryStorage();
  const store = new ChunkStore(storage);
  await store.syncStored(SOLO_NAMESPACE, ["a".repeat(64)], live());
  await store.syncStored(NS, ["b".repeat(64), "c".repeat(64)], live());
  await store.syncStored(NS, [], live());
  assertEquals(storage.synced, [
    { namespace: UNNAMESPACED_STORAGE_NAMESPACE, hashes: ["a".repeat(64)] },
    { namespace: "team-a", hashes: ["b".repeat(64), "c".repeat(64)] },
  ]);
  // A storage without the capability: nothing to call, nothing thrown.
  await new ChunkStore(new MemoryStorage()).syncStored(
    NS,
    ["a".repeat(64)],
    live(),
  );
});

Deno.test("ChunkStore.refOf: gives write's reference and every part with its offset, storing nothing", async () => {
  for (const length of [0, 3, 4, 9, 12]) {
    const storage = new MemoryStorage({ maxChunkBytes: 4 });
    const store = new ChunkStore(storage);
    const content = bytesOf(length);
    const found = await store.refOf(streamOf(content, [1, 2, 5]), live());
    assertEquals(storage.calls, []);
    const ref = await store.write(NS, content, live());
    assert(found.ref.equals(ref), `length ${length}`);
    assertEquals(found.sha256, ref.sha256);
    assertEquals(found.size, length);
    assertEquals(
      found.parts.map(({ sha256, size }) => ({ sha256, size })),
      ref.parts ?? [{ sha256: ref.sha256, size: ref.size }],
    );
    assertEquals(
      found.parts.map((part) => part.offset),
      found.parts.map((_, i) => i * 4),
    );
  }
});

Deno.test("ChunkStore.putParts: puts every listed part from its offset, present or not", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(10);
  await store.write(NS, content, live());
  const { parts } = await store.refOf(content, live());
  storage.tear("team-a", parts[1].sha256, 2);
  storage.calls.length = 0;
  const result = await store.putParts(
    NS,
    rangeOf(() => content),
    [parts[0], parts[1]],
    live(),
  );
  assertEquals(result, {
    stored: [parts[0].sha256, parts[1].sha256],
    changed: [],
  });
  assertEquals(storage.calls, [
    `put ${parts[0].sha256.slice(0, 8)}`,
    `put ${parts[1].sha256.slice(0, 8)}`,
  ]);
  assertEquals(
    await store.missing(NS, (await store.refOf(content, live())).ref, live()),
    [],
  );
});

Deno.test("ChunkStore.putParts: a source that changed after refOf stores nothing under the old names (ADV-60)", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  let file = bytesOf(10);
  const { parts } = await store.refOf(file, live());
  // A writer replaces the file between the cut and the put: the middle
  // part's bytes change, and the file ends sooner.
  file = file.slice(0, 9);
  file[5] ^= 0xff;
  const result = await store.putParts(NS, rangeOf(() => file), parts, live());
  assertEquals(result, {
    stored: [parts[0].sha256],
    changed: [parts[1].sha256, parts[2].sha256],
  });
  assertEquals(
    [...storage.chunks.keys()],
    [`team-a/${parts[0].sha256}`],
  );
});

Deno.test("ChunkStore.putParts: a refused put is ChunkPutError; an abort rejects with its reason", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(8);
  const { parts } = await store.refOf(content, live());
  const denied = new Error("AccessDenied");
  storage.put = () => Promise.reject(denied);
  const error = await assertRejects(
    () => store.putParts(NS, rangeOf(() => content), parts, live()),
    ChunkPutError,
    "AccessDenied",
  );
  assertEquals(error.sha256, parts[0].sha256);
  assertEquals(error.namespace, "team-a");
  assertEquals(error.cause, denied);

  const controller = new AbortController();
  const reason = new Error("stop");
  storage.put = () => {
    controller.abort(reason);
    return Promise.reject(reason);
  };
  const aborted = await assertRejects(() =>
    store.putParts(NS, rangeOf(() => content), parts, controller.signal)
  );
  assertEquals(aborted, reason);
});

Deno.test("ChunkStore.verifyParts: reports parts missing, short or holding other bytes", async () => {
  const storage = new StatMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const content = bytesOf(16);
  await store.write(NS, content, live());
  const { parts } = await store.refOf(content, live());
  storage.tear("team-a", parts[1].sha256, 3);
  const same = storage.chunks.get(`team-a/${parts[2].sha256}`)!;
  storage.chunks.set(`team-a/${parts[2].sha256}`, same.map((b) => b ^ 1));
  storage.chunks.delete(`team-a/${parts[3].sha256}`);
  assertEquals(await store.verifyParts(NS, parts, live()), parts.slice(1));
  assertEquals(await store.verifyParts(NS, [parts[0]], live()), []);
});

Deno.test("ChunkIntegrityError: names the chunk that failed its check (swamp-club#3617)", async () => {
  const storage = new MemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const ref = await store.write(NS, bytesOf(8), live());
  const bad = ref.parts![1].sha256;
  storage.chunks.set(`team-a/${bad}`, new Uint8Array(3));
  const short = await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkIntegrityError,
  );
  assertEquals([short.namespace, short.sha256], ["team-a", bad]);
  storage.chunks.set(`team-a/${bad}`, new Uint8Array(4));
  const wrong = await assertRejects(
    () => readAll(store.read(NS, ref, live())),
    ChunkIntegrityError,
  );
  assertEquals(wrong.sha256, bad);
});

/**
 * A storage that stages chunks ({@link ChunkStaging}) as the filesystem
 * storage does: nothing staged is stored until the stage commits.
 */
class StagingMemoryStorage extends StatMemoryStorage {
  failCommit = false;

  stageChunks(namespace: string) {
    const staged = new Map<string, Uint8Array>();
    return {
      put: (sha256: string, bytes: Uint8Array, signal: AbortSignal) => {
        signal.throwIfAborted();
        this.calls.push(`stage ${sha256.slice(0, 8)}`);
        staged.set(sha256, bytes.slice());
        return Promise.resolve();
      },
      commit: (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (this.failCommit) return Promise.reject(new Error("sync failed"));
        this.calls.push(`commit ${staged.size}`);
        for (const [sha256, bytes] of staged) {
          this.chunks.set(`${namespace}/${sha256}`, bytes);
        }
        staged.clear();
        return Promise.resolve();
      },
      discard: () => {
        staged.clear();
        return Promise.resolve();
      },
    };
  }
}

Deno.test("ChunkStore.beginBatch: a write stages new chunks and covers present ones; the commit stores them, then syncs every name once (swamp-club#3617)", async () => {
  const storage = new StagingMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  const present = bytesOf(4);
  const fresh = new Uint8Array(4).fill(9);
  await store.write(NS, present, live());
  storage.calls.length = 0;

  const batch = store.beginBatch(NS);
  let ref: BlobRef;
  try {
    const content = new Uint8Array(12);
    content.set(present, 0);
    content.set(fresh, 4);
    content.set(fresh, 8);
    ref = await store.write(NS, content, live(), batch);
    // Staged once, not stored: no commit may name it yet.
    assertEquals(storage.calls.filter((c) => c.startsWith("stage ")), [
      `stage ${hex(fresh).slice(0, 8)}`,
    ]);
    assertEquals(storage.puts(), 0);
    assertEquals(await store.missing(NS, ref, live()), [hex(fresh)]);
    assertEquals(storage.synced, []);
    await batch.commit(live());
  } finally {
    await batch.discard();
  }
  assertEquals(await store.missing(NS, ref, live()), []);
  assertEquals(storage.synced, [
    { namespace: "team-a", hashes: [hex(present), hex(fresh)] },
  ]);
  await assertRejects(() => batch.commit(live()), Error, "ended");
});

Deno.test("ChunkStore.beginBatch: a failed commit stores nothing and syncs nothing; without staging, a batch puts at once", async () => {
  const storage = new StagingMemoryStorage({ maxChunkBytes: 4 });
  const store = new ChunkStore(storage);
  storage.failCommit = true;
  const batch = store.beginBatch(NS);
  try {
    const ref = await store.write(NS, bytesOf(4), live(), batch);
    await assertRejects(() => batch.commit(live()), Error, "sync failed");
    assertEquals(await store.missing(NS, ref, live()), [ref.sha256]);
  } finally {
    await batch.discard();
  }
  assertEquals(storage.synced, []);

  const plain = new StatMemoryStorage({ maxChunkBytes: 4 });
  const direct = new ChunkStore(plain);
  const other = direct.beginBatch(NS);
  try {
    const ref = await direct.write(NS, bytesOf(4), live(), other);
    assertEquals(plain.puts(), 1);
    await other.commit(live());
    assertEquals(plain.synced, [{ namespace: "team-a", hashes: [ref.sha256] }]);
  } finally {
    await other.discard();
  }
  // A batch takes only content of its own namespace.
  await assertRejects(
    () =>
      direct.write(SOLO_NAMESPACE, bytesOf(4), live(), direct.beginBatch(NS)),
    Error,
    "namespace",
  );
});
