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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import {
  CHUNK_BYTES,
  ChunkStore,
} from "../../domain/datastore_v3/chunk_store.ts";
import { sha256Of } from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  CachedServeStorage,
  SERVE_STORAGE_UNSUPPORTED_CODE,
  ServeChunkStorage,
  ServeStorageUnsupportedError,
  storageNamespaceOf,
} from "./serve_datastore_storage.ts";
import { FakeServe, removeTempDir } from "./serve_upstream_test_helpers.ts";

const NO_SYNC = {
  syncFile: () => Promise.resolve(),
  syncDirectory: () => Promise.resolve(),
};

const live = () => new AbortController().signal;

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error("closing"));
  return controller.signal;
}

async function chunk(text: string) {
  return {
    sha256: await sha256Of(text),
    bytes: new TextEncoder().encode(text),
  };
}

async function withCache(
  fn: (cache: CachedServeStorage, serve: FakeServe) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-storage-" });
  const serve = new FakeServe();
  try {
    await fn(
      new CachedServeStorage(
        join(dir, "datastore"),
        new ServeChunkStorage(serve),
        NO_SYNC,
      ),
      serve,
    );
  } finally {
    await removeTempDir(dir);
  }
}

Deno.test("storageNamespaceOf: the solo namespace is _default, a named one is itself", () => {
  assertEquals(storageNamespaceOf(""), "_default");
  assertEquals(storageNamespaceOf("_default"), "_default");
  assertEquals(storageNamespaceOf("team-a"), "team-a");
});

Deno.test("ServeChunkStorage: has, get and put go to serve for the namespace it is bound to", async () => {
  const serve = new FakeServe();
  const storage = new ServeChunkStorage(serve);
  const a = await chunk("a");
  const b = await chunk("b");
  serve.chunks.set(a.sha256, a.bytes);

  for (const namespace of ["", "_default"]) {
    assertEquals(
      await storage.has(namespace, [a.sha256, b.sha256], live()),
      new Set([a.sha256]),
    );
    assertEquals(await storage.get(namespace, a.sha256, live()), a.bytes);
    assertEquals(await storage.get(namespace, b.sha256, live()), null);
  }
  await storage.put("", b.sha256, b.bytes, live());
  assertEquals(serve.uploads, [{ sha256: b.sha256, partition: undefined }]);
  assertEquals(serve.requests.hasChunks, 2);
  assertEquals(serve.requests.getChunk, 4);
});

Deno.test("ServeChunkStorage: another namespace holds nothing and asks serve nothing", async () => {
  const serve = new FakeServe("team-a");
  const storage = new ServeChunkStorage(serve);
  const a = await chunk("a");
  serve.chunks.set(a.sha256, a.bytes);

  assertEquals(
    await storage.has("team-a", [a.sha256], live()),
    new Set([a.sha256]),
  );
  assertEquals(await storage.has("", [a.sha256], live()), new Set());
  assertEquals(await storage.has("team-b", [a.sha256], live()), new Set());
  assertEquals(await storage.get("_default", a.sha256, live()), null);
  await assertRejects(
    () => storage.put("team-b", a.sha256, a.bytes, live()),
    Error,
    "serves namespace team-a, not team-b",
  );
  assertEquals(serve.requests.hasChunks, 1);
  assertEquals(serve.requests.getChunk, 0);
  assertEquals(serve.requests.putChunk, 0);
});

Deno.test("ServeChunkStorage: has of no hashes asks serve nothing", async () => {
  const serve = new FakeServe();
  assertEquals(
    await new ServeChunkStorage(serve).has("", [], live()),
    new Set(),
  );
  assertEquals(serve.requests.hasChunks, 0);
});

Deno.test("ServeChunkStorage: an aborted signal is refused before any request", async () => {
  const serve = new FakeServe();
  const storage = new ServeChunkStorage(serve);
  const a = await chunk("a");
  await assertRejects(
    () => storage.has("", [a.sha256], aborted()),
    Error,
    "closing",
  );
  await assertRejects(
    () => storage.get("", a.sha256, aborted()),
    Error,
    "closing",
  );
  await assertRejects(
    () => storage.put("", a.sha256, a.bytes, aborted()),
    Error,
    "closing",
  );
  assertEquals(serve.requests, {
    changes: 0,
    partitionCommits: 0,
    postCommit: 0,
    hasChunks: 0,
    putChunk: 0,
    getChunk: 0,
  });
});

Deno.test("ServeChunkStorage: list and delete are refused as unsupported", async () => {
  const storage = new ServeChunkStorage(new FakeServe());
  const listed = await assertRejects(
    async () => {
      for await (const _ of storage.list("", live())) {
        // Never reached.
      }
    },
    ServeStorageUnsupportedError,
  );
  assertEquals(listed.code, SERVE_STORAGE_UNSUPPORTED_CODE);
  assertEquals(listed.method, "list");
  const deleted = await assertRejects(
    async () => storage.delete("", (await chunk("a")).sha256, live()),
    ServeStorageUnsupportedError,
  );
  assertEquals(deleted.code, "datastore_v3_serve_storage_unsupported");
  assertEquals(deleted.method, "delete");
});

Deno.test("ServeChunkStorage: list and delete honour an aborted signal first", async () => {
  const storage = new ServeChunkStorage(new FakeServe());
  await assertRejects(
    async () => {
      for await (const _ of storage.list("", aborted())) {
        // Never reached.
      }
    },
    Error,
    "closing",
  );
  await assertRejects(
    () => storage.delete("", "0".repeat(64), aborted()),
    Error,
    "closing",
  );
});

Deno.test("ServeChunkStorage: offers no touch, so a chunk store takes it", () => {
  const storage = new ServeChunkStorage(new FakeServe());
  assertEquals(storage.capabilities(), {
    maxChunkBytes: CHUNK_BYTES,
    touch: false,
  });
  assertEquals("touch" in storage, false);
  new ChunkStore(storage);
});

Deno.test("CachedServeStorage.get: a chunk read from serve is kept, and the next read asks serve nothing", async () => {
  await withCache(async (cache, serve) => {
    const a = await chunk("a");
    serve.chunks.set(a.sha256, a.bytes);

    assertEquals(await cache.get("_default", a.sha256, live()), a.bytes);
    assertEquals(serve.requests.getChunk, 1);
    serve.chunks.clear();
    assertEquals(await cache.get("_default", a.sha256, live()), a.bytes);
    assertEquals(serve.requests.getChunk, 1);
  });
});

Deno.test("CachedServeStorage.get: a chunk serve lacks is null and nothing is kept", async () => {
  await withCache(async (cache, serve) => {
    const a = await chunk("a");
    assertEquals(await cache.get("_default", a.sha256, live()), null);
    assertEquals(
      await cache.statChunks("_default", [a.sha256], live()),
      new Map(),
    );
    assertEquals(serve.requests.getChunk, 1);
  });
});

Deno.test("CachedServeStorage.has: the cache's and serve's, asking serve only for what the cache lacks", async () => {
  await withCache(async (cache, serve) => {
    const local = await chunk("local");
    const remote = await chunk("remote");
    const neither = await chunk("neither");
    await cache.put("_default", local.sha256, local.bytes, live());
    serve.chunks.set(remote.sha256, remote.bytes);

    assertEquals(
      await cache.has(
        "_default",
        [local.sha256, remote.sha256, neither.sha256],
        live(),
      ),
      new Set([local.sha256, remote.sha256]),
    );
    assertEquals(serve.hasAsked, [[remote.sha256, neither.sha256]]);

    assertEquals(
      await cache.has("_default", [local.sha256], live()),
      new Set([local.sha256]),
    );
    assertEquals(serve.requests.hasChunks, 1, "the cache held them all");
  });
});

Deno.test("CachedServeStorage.put: lands in the cache only", async () => {
  await withCache(async (cache, serve) => {
    const a = await chunk("a");
    await cache.put("_default", a.sha256, a.bytes, live());
    assertEquals(serve.requests.putChunk, 0);
    assertEquals(serve.chunks.size, 0);
    assertEquals(await cache.get("_default", a.sha256, live()), a.bytes);
    assertEquals(serve.requests.getChunk, 0);
  });
});

Deno.test("CachedServeStorage: list and delete are the cache's", async () => {
  await withCache(async (cache, serve) => {
    const a = await chunk("a");
    await cache.put("_default", a.sha256, a.bytes, live());
    const listed: string[] = [];
    for await (const stored of cache.list("_default", live())) {
      listed.push(stored.sha256);
    }
    assertEquals(listed, [a.sha256]);
    await cache.delete("_default", a.sha256, live());
    assertEquals(
      await cache.statChunks("_default", [a.sha256], live()),
      new Map(),
    );
    assertEquals(serve.requests.putChunk + serve.requests.getChunk, 0);
  });
});

Deno.test("ServeStorageUnsupportedError: names the method refused", () => {
  assertThrows(
    () => {
      throw new ServeStorageUnsupportedError("delete");
    },
    ServeStorageUnsupportedError,
    "no way to delete chunks",
  );
});

/** a remote whose reads wait on a gate, counting how many run at once */
function gatedRemote(
  chunks: ReadonlyMap<string, Uint8Array>,
  fail: ReadonlySet<string> = new Set(),
) {
  let inFlight = 0;
  const seen = { reads: 0, mostAtOnce: 0 };
  const gate = Promise.withResolvers<void>();
  const remote = {
    async get(_namespace: string, sha256: string): Promise<Uint8Array | null> {
      seen.reads++;
      seen.mostAtOnce = Math.max(seen.mostAtOnce, ++inFlight);
      try {
        await gate.promise;
        if (fail.has(sha256)) throw new Error("serve unreachable");
        return chunks.get(sha256) ?? null;
      } finally {
        inFlight--;
      }
    },
    has: () => Promise.resolve(new Set<string>()),
  } as unknown as DatastoreStorage;
  return { remote, seen, open: () => gate.resolve() };
}

async function withGatedCache(
  remote: DatastoreStorage,
  fn: (cache: CachedServeStorage) => Promise<void>,
  offline = false,
) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-storage-" });
  try {
    await fn(
      new CachedServeStorage(join(dir, "datastore"), remote, {
        ...NO_SYNC,
        offline: () => offline,
      }),
    );
  } finally {
    await removeTempDir(dir);
  }
}

Deno.test("CachedServeStorage.prefetch: fetches what the cache lacks, eight at a time, and later reads are local", async () => {
  const all = await Promise.all(
    Array.from({ length: 12 }, (_, i) => chunk(`chunk-${i}`)),
  );
  const { remote, seen, open } = gatedRemote(
    new Map(all.map((c) => [c.sha256, c.bytes])),
  );
  await withGatedCache(remote, async (cache) => {
    for (const held of all.slice(0, 2)) {
      await cache.put("_default", held.sha256, held.bytes, live());
    }
    const prefetched = cache.prefetch(
      "_default",
      all.map((c) => c.sha256),
      live(),
    );
    await waitFor(() => seen.reads === 8, "eight reads in flight");
    open();
    await prefetched;
    assertEquals(seen, { reads: 10, mostAtOnce: 8 });
    for (const c of all) {
      assertEquals(await cache.get("_default", c.sha256, live()), c.bytes);
    }
    assertEquals(seen.reads, 10, "every read after the prefetch was local");
  });
});

Deno.test("CachedServeStorage.prefetch: a chunk it cannot fetch is left for its read, the rest are kept", async () => {
  const [good, bad] = await Promise.all([chunk("good"), chunk("bad")]);
  const { remote, seen, open } = gatedRemote(
    new Map([[good.sha256, good.bytes], [bad.sha256, bad.bytes]]),
    new Set([bad.sha256]),
  );
  open();
  await withGatedCache(remote, async (cache) => {
    await cache.prefetch("_default", [good.sha256, bad.sha256], live());
    assertEquals(seen.reads, 2);
    const held = await cache.statChunks(
      "_default",
      [good.sha256, bad.sha256],
      live(),
    );
    assertEquals([...held.keys()], [good.sha256]);
  });
});

Deno.test("CachedServeStorage.prefetch: an offline checkout fetches nothing", async () => {
  const [a, b] = await Promise.all([chunk("a"), chunk("b")]);
  const { remote, seen, open } = gatedRemote(
    new Map([[a.sha256, a.bytes], [b.sha256, b.bytes]]),
  );
  open();
  await withGatedCache(remote, async (cache) => {
    await cache.prefetch("_default", [a.sha256, b.sha256], live());
    assertEquals(seen.reads, 0);
  }, true);
});

Deno.test("CachedServeStorage.prefetch: stops at the first failure, so a hung serve costs one timeout, not one per chunk", async () => {
  const all = await Promise.all(
    Array.from({ length: 20 }, (_, i) => chunk(`chunk-${i}`)),
  );
  const { remote, seen, open } = gatedRemote(
    new Map(all.map((c) => [c.sha256, c.bytes])),
    new Set(all.map((c) => c.sha256)),
  );
  open();
  await withGatedCache(remote, async (cache) => {
    await cache.prefetch("_default", all.map((c) => c.sha256), live());
    assertEquals(seen.reads, 8, "only the reads already in flight");
  });
});

/** whether the cache alone holds the chunk, without asking serve */
async function cached(cache: CachedServeStorage, sha256: string) {
  return (await cache.statChunks("_default", [sha256], live())).has(sha256);
}

Deno.test("CachedServeStorage.releaseFetched: drops what it read from serve, never a chunk this checkout stored (swamp-club#4457)", async () => {
  await withCache(async (cache, serve) => {
    const fetched = await chunk("fetched");
    const ownPut = await chunk("own put");
    const ownStaged = await chunk("own staged");
    const fetchedThenStored = await chunk("fetched, then stored");
    for (const c of [fetched, fetchedThenStored]) {
      serve.chunks.set(c.sha256, c.bytes);
      await cache.get("_default", c.sha256, live());
    }
    await cache.put("_default", ownPut.sha256, ownPut.bytes, live());
    const stage = cache.stageChunks("_default");
    await stage.put(ownStaged.sha256, ownStaged.bytes, live());
    await stage.put(fetchedThenStored.sha256, fetchedThenStored.bytes, live());
    await stage.commit(live());

    await cache.releaseFetched(live());
    assertEquals(await cached(cache, fetched.sha256), false);
    assertEquals(await cached(cache, ownPut.sha256), true);
    assertEquals(await cached(cache, ownStaged.sha256), true);
    assertEquals(await cached(cache, fetchedThenStored.sha256), true);

    // serve still holds what was dropped, so the next read fetches it again
    assertEquals(
      await cache.get("_default", fetched.sha256, live()),
      fetched.bytes,
    );
    assertEquals(serve.requests.getChunk, 3);
  });
});
