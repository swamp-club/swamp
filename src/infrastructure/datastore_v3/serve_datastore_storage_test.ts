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
