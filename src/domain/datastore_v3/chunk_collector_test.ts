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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import type {
  DatastoreStorage,
  StoredChunk,
  TempFileSweeper,
} from "../datastore/datastore_storage.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../data/namespace.ts";
import {
  CHUNK_COLLECTION_BATCH,
  ChunkCollector,
  type ChunkCollectorOptions,
  DEFAULT_CHUNK_GRACE_MS,
} from "./chunk_collector.ts";
import { ChunkStore } from "./chunk_store.ts";
import type { CommitStore } from "./commit_store.ts";

const HOUR = 60 * 60 * 1000;
/** The collector's now in every test. */
const NOW = new Date("2026-10-11T12:00:00.000Z");
/** Older than the default grace period. */
const OLD = new Date(NOW.getTime() - DEFAULT_CHUNK_GRACE_MS - HOUR);
/** Within the default grace period. */
const FRESH = new Date(NOW.getTime() - HOUR);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * `storage/1` in memory with a `lastModified` per chunk, set by `put` and
 * `touch` from `clock`. `onListed` runs after the listing yields a chunk.
 */
class AgedStorage implements DatastoreStorage {
  readonly contract = "storage/1" as const;
  readonly chunks = new Map<string, { bytes: Uint8Array; at: Date }>();
  readonly deleted: string[] = [];
  /** Each listing, read and delete, in order. */
  readonly events: string[] = [];
  clock = () => NOW;
  onListed: (sha256: string) => Promise<void> | void = () => {};

  capabilities() {
    return { maxChunkBytes: 1024, touch: true };
  }

  /** Stores `bytes` under their digest, last modified at `at`. */
  seed(namespace: string, text: string, at: Date): string {
    const bytes = bytesOf(text);
    const sha256 = sha256Hex(bytes);
    this.chunks.set(`${namespace}/${sha256}`, { bytes, at });
    return sha256;
  }

  /** Stores `bytes` under a key they do not hash to. */
  seedDamaged(namespace: string, sha256: string, at: Date): void {
    this.chunks.set(`${namespace}/${sha256}`, { bytes: bytesOf("rot"), at });
  }

  stored(namespace: string): string[] {
    return [...this.chunks.keys()]
      .filter((key) => key.startsWith(`${namespace}/`))
      .map((key) => key.slice(namespace.length + 1))
      .sort();
  }

  has(namespace: string, hashes: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(
      new Set(hashes.filter((h) => this.chunks.has(`${namespace}/${h}`))),
    );
  }

  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.chunks.set(`${namespace}/${sha256}`, {
      bytes: bytes.slice(),
      at: this.clock(),
    });
    return Promise.resolve();
  }

  get(namespace: string, sha256: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push("get");
    const chunk = this.chunks.get(`${namespace}/${sha256}`);
    return Promise.resolve(chunk === undefined ? null : chunk.bytes.slice());
  }

  touch(namespace: string, hashes: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const missing = new Set<string>();
    for (const sha256 of hashes) {
      const chunk = this.chunks.get(`${namespace}/${sha256}`);
      if (chunk === undefined) missing.add(sha256);
      else chunk.at = this.clock();
    }
    return Promise.resolve(missing);
  }

  async *list(namespace: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push("list");
    // A snapshot of the keys, then each chunk's current state, as a real
    // listing reads a directory and then each entry.
    for (const key of [...this.chunks.keys()]) {
      if (!key.startsWith(`${namespace}/`)) continue;
      const chunk = this.chunks.get(key);
      if (chunk === undefined) continue;
      const sha256 = key.slice(namespace.length + 1);
      yield { sha256, lastModified: chunk.at } satisfies StoredChunk;
      await this.onListed(sha256);
    }
  }

  delete(namespace: string, sha256: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.chunks.delete(`${namespace}/${sha256}`);
    this.deleted.push(sha256);
    this.events.push("delete");
    return Promise.resolve();
  }
}

/**
 * The commit log's chunk index, by commit namespace. `afterLookup` runs
 * after each lookup has computed its answer, before the collector sees it.
 */
class FakeRefs implements Pick<CommitStore, "referencedChunks"> {
  readonly refs = new Map<string, Set<string>>();
  readonly lookups: { namespace: string; count: number }[] = [];
  afterLookup: () => Promise<void> | void = () => {};

  add(namespace: string, sha256: string): void {
    const set = this.refs.get(namespace) ?? new Set();
    set.add(sha256);
    this.refs.set(namespace, set);
  }

  async referencedChunks(namespace: string, hashes: readonly string[]) {
    this.lookups.push({ namespace, count: hashes.length });
    const set = this.refs.get(namespace) ?? new Set();
    const found = new Set(hashes.filter((h) => set.has(h)));
    await this.afterLookup();
    return found;
  }
}

function collector(
  storage: AgedStorage,
  refs: FakeRefs,
  options: Partial<ChunkCollectorOptions> = {},
): ChunkCollector {
  return new ChunkCollector({
    commitStore: refs,
    storage,
    clock: () => NOW,
    ...options,
  });
}

const signal = new AbortController().signal;
const ACME = restoreNamespace("acme");
const UNNAMESPACED = SOLO_NAMESPACE;

Deno.test("ChunkCollector.collect: deletes old unreferenced chunks and keeps referenced or fresh ones", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const orphan = storage.seed("acme", "orphan", OLD);
  const named = storage.seed("acme", "named", new Date(0));
  const young = storage.seed("acme", "young", FRESH);
  refs.add("acme", named);

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(storage.stored("acme"), [named, young].sort());
  assertEquals(storage.deleted, [orphan]);
  assertEquals(report, {
    namespace: "acme",
    scanned: 3,
    referenced: 1,
    deleted: 1,
    restored: 0,
    keptOverBudget: 0,
    keptTooNew: 1,
    verified: 0,
    damaged: [],
    tempFilesRemoved: 0,
  });
});

Deno.test('ChunkCollector.collect: the unnamespaced datastore sweeps _default against commit namespace ""', async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const named = storage.seed("_default", "named", OLD);
  const orphan = storage.seed("_default", "orphan", OLD);
  const other = storage.seed("acme", "orphan", OLD);
  refs.add("", named);
  // A ref in another namespace does not keep a chunk here.
  refs.add("acme", orphan);

  const report = await collector(storage, refs).collect(UNNAMESPACED, {
    signal,
  });

  assertEquals(report.namespace, "_default");
  assertEquals(storage.stored("_default"), [named]);
  assertEquals(storage.stored("acme"), [other]);
  // The batch's check, then the re-check of what it deleted.
  assertEquals(refs.lookups.map((l) => l.namespace), ["", ""]);
});

Deno.test("ChunkCollector.collect: checks references and deletes a batch at a time", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const total = CHUNK_COLLECTION_BATCH * 2 + 5;
  for (let i = 0; i < total; i++) storage.seed("acme", `chunk ${i}`, OLD);

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(report.deleted, total);
  assertEquals(storage.stored("acme"), []);
  // Each batch is checked, then what it deleted is checked again.
  assertEquals(refs.lookups.map((l) => l.count), [
    CHUNK_COLLECTION_BATCH,
    CHUNK_COLLECTION_BATCH,
    CHUNK_COLLECTION_BATCH,
    CHUNK_COLLECTION_BATCH,
    5,
    5,
  ]);
});

Deno.test("ChunkCollector.collect: the grace period is measured from the collector's now", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const atCutoff = storage.seed(
    "acme",
    "at cutoff",
    new Date(NOW.getTime() - 2 * HOUR),
  );
  const pastCutoff = storage.seed(
    "acme",
    "past cutoff",
    new Date(NOW.getTime() - 2 * HOUR - 1),
  );

  await collector(storage, refs, { graceMs: 2 * HOUR }).collect(ACME, {
    signal,
  });

  assertEquals(storage.stored("acme"), [atCutoff]);
  assertEquals(storage.deleted, [pastCutoff]);
});

Deno.test("ChunkCollector.collect: a chunk refreshed by a write before the listing reaches it is kept", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const first = storage.seed("acme", "first", OLD);
  const second = storage.seed("acme", "second", OLD);
  const chunks = new ChunkStore(storage);
  storage.onListed = async (sha256) => {
    // A unit stores the second chunk's content while the sweep runs: the
    // chunk store finds it present and touches it.
    if (sha256 === first) await chunks.write(ACME, bytesOf("second"), signal);
  };

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(storage.stored("acme"), [second]);
  assertEquals(report.keptTooNew, 1);
});

Deno.test("ChunkCollector.collect: a chunk whose commit lands before its batch's reference check is kept", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const chunk = storage.seed("acme", "landing", OLD);
  // Listed as old and unreferenced; the commit naming it lands next.
  storage.onListed = () => refs.add("acme", chunk);

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(storage.stored("acme"), [chunk]);
  assertEquals(report.referenced, 1);
});

Deno.test("ChunkCollector.collect: a commit landing between a batch's reference check and its delete is caught by the re-check, and the chunk put back", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const content = bytesOf("reused");
  const chunk = storage.seed("acme", "reused", OLD);
  const chunks = new ChunkStore(storage);
  let lookups = 0;
  refs.afterLookup = async () => {
    // After the first check finds it unreferenced, a unit dedups against
    // the old chunk (has() finds it, touch() refreshes it) and commits.
    if (++lookups !== 1) return;
    await chunks.write(ACME, content, signal);
    refs.add("acme", chunk);
  };

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(storage.deleted, [chunk]);
  assertEquals(storage.stored("acme"), [chunk]);
  assertEquals(storage.chunks.get(`acme/${chunk}`)?.bytes, content);
  assertEquals([report.deleted, report.restored], [0, 1]);
});

Deno.test("ChunkCollector.collect: a commit landing after the re-check finds its chunk deleted, and the writer's post-commit check stores it again", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const content = bytesOf("reused");
  const chunk = storage.seed("acme", "reused", OLD);
  const chunks = new ChunkStore(storage);
  let ref: Awaited<ReturnType<ChunkStore["write"]>> | undefined;
  let lookups = 0;
  refs.afterLookup = async () => {
    // The unit refreshes the chunk before the sweep's first check; its
    // commit lands only after the re-check.
    if (++lookups === 1) ref = await chunks.write(ACME, content, signal);
  };

  const report = await collector(storage, refs).collect(ACME, { signal });
  assertEquals([report.deleted, report.restored], [1, 0]);
  assertEquals(storage.stored("acme"), []);

  // The commit lands, then the writer checks its chunks (what
  // commit_log_unit_of_work does after every append) and stores the
  // missing one again.
  refs.add("acme", chunk);
  assertEquals(await chunks.missing(ACME, ref!, signal), [chunk]);
  await chunks.write(ACME, content, signal);
  assertEquals(await chunks.missing(ACME, ref!, signal), []);
});

Deno.test("ChunkCollector.collect: a sweep aborted between deletes still re-checks what it deleted and puts back a chunk a commit landed on", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const first = storage.seed("acme", "first", OLD);
  const second = storage.seed("acme", "second", OLD);
  const controller = new AbortController();
  const del = storage.delete.bind(storage);
  storage.delete = async (namespace, sha256, sig) => {
    await del(namespace, sha256, sig);
    // A commit naming the chunk landed before its delete (its writer's
    // check saw it present), and then the sweep is aborted.
    refs.add("acme", sha256);
    controller.abort();
  };

  await assertRejects(() =>
    collector(storage, refs).collect(ACME, { signal: controller.signal })
  );

  // The first chunk was deleted and put back; the second was never reached.
  assertEquals(storage.stored("acme"), [first, second].sort());
  assertEquals(storage.deleted.length, 1);
});

Deno.test("ChunkCollector.collect: candidates past the read budget are kept, never deleted unread", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  for (let i = 0; i < 5; i++) storage.seed("acme", `ten bytes${i}`, OLD);

  const report = await collector(storage, refs).collect(ACME, {
    sweepReadBytes: 25,
    signal,
  });

  // 10 + 10 leaves 5 of the budget, so a third candidate is read too.
  assertEquals([report.deleted, report.keptOverBudget], [3, 2]);
  assertEquals(storage.stored("acme").length, 2);
  const none = await collector(storage, refs).collect(ACME, {
    sweepReadBytes: 0,
    signal,
  });
  assertEquals([none.deleted, none.keptOverBudget], [0, 2]);
});

Deno.test("ChunkCollector.collect: a damaged candidate is deleted and reported, never put back", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const rotten = "e".repeat(64);
  storage.seedDamaged("acme", rotten, OLD);

  const report = await collector(storage, refs).collect(ACME, { signal });

  assertEquals(storage.stored("acme"), []);
  assertEquals(report.damaged, [{ sha256: rotten, referenced: false }]);
  assertEquals([report.deleted, report.restored], [0, 0]);
});

Deno.test("ChunkCollector.collect: deletes a damaged chunk whatever its age, and a later write stores it again", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const good = storage.seed("acme", "good", FRESH);
  const content = bytesOf("damaged in place");
  const rotten = sha256Hex(content);
  const rottenOrphan = "f".repeat(64);
  storage.seedDamaged("acme", rotten, FRESH);
  storage.seedDamaged("acme", rottenOrphan, OLD);
  refs.add("acme", rotten);

  const report = await collector(storage, refs).collect(ACME, {
    verifyBytes: 1024,
    signal,
  });

  assertEquals(storage.stored("acme"), [good]);
  assertEquals(report.verified, 3);
  assertEquals(
    [...report.damaged].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    [
      { sha256: rotten, referenced: true },
      { sha256: rottenOrphan, referenced: false },
    ].sort((a, b) => a.sha256.localeCompare(b.sha256)),
  );
  assertEquals(report.deleted, 0);

  // Writes trust has(): with the damaged chunk gone, the write puts it.
  await new ChunkStore(storage).write(ACME, content, signal);
  assertEquals(storage.chunks.get(`acme/${rotten}`)?.bytes, content);
});

Deno.test("ChunkCollector.collect: verifies chunks only until the byte budget is spent", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  for (let i = 0; i < 5; i++) storage.seed("acme", `ten bytes${i}`, FRESH);

  const none = await collector(storage, refs).collect(ACME, { signal });
  assertEquals(none.verified, 0);
  const some = await collector(storage, refs).collect(ACME, {
    verifyBytes: 25,
    signal,
  });
  // 10 + 10 leaves 5 of the budget, so the third chunk is read too.
  assertEquals(some.verified, 3);
});

Deno.test("ChunkCollector.collect: verifies in a pass of its own, before the sweep reads its candidates", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  for (let i = 0; i < 4; i++) storage.seed("acme", `chunk ${i}`, OLD);

  await collector(storage, refs).collect(ACME, {
    verifyBytes: 1024,
    signal,
  });

  assertEquals(storage.events, [
    "list",
    "get",
    "get",
    "get",
    "get",
    "list",
    "get",
    "get",
    "get",
    "get",
    "delete",
    "delete",
    "delete",
    "delete",
  ]);
});

Deno.test("ChunkCollector.collect: removes stale temp files with the grace cutoff", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  const calls: { namespace: string; olderThan: Date }[] = [];
  const tempFiles: TempFileSweeper = {
    removeStaleTempFiles: (namespace, olderThan) => {
      calls.push({ namespace, olderThan });
      return Promise.resolve(2);
    },
  };

  const report = await collector(storage, refs, {
    tempFiles,
    graceMs: HOUR,
  }).collect(UNNAMESPACED, { signal });

  assertEquals(report.tempFilesRemoved, 2);
  assertEquals(calls, [{
    namespace: "_default",
    olderThan: new Date(NOW.getTime() - HOUR),
  }]);
});

Deno.test("ChunkCollector.collect: rejects when aborted, keeping what it has not reached", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  for (let i = 0; i < 3; i++) storage.seed("acme", `chunk ${i}`, OLD);
  const controller = new AbortController();
  storage.onListed = () => controller.abort();

  await assertRejects(() =>
    collector(storage, refs).collect(ACME, { signal: controller.signal })
  );
  assertEquals(storage.stored("acme").length, 3);
  await assertRejects(() =>
    collector(storage, refs).collect(ACME, { signal: controller.signal })
  );
});

Deno.test("ChunkCollector: refuses a grace period or verify budget that is not a non-negative integer", async () => {
  const storage = new AgedStorage();
  const refs = new FakeRefs();
  for (const graceMs of [-1, 1.5, Number.NaN]) {
    assertThrows(() => collector(storage, refs, { graceMs }), Error, "graceMs");
  }
  await assertRejects(
    () => collector(storage, refs).collect(ACME, { verifyBytes: -1, signal }),
    Error,
    "verifyBytes",
  );
});
