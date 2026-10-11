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

// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createInMemoryRemote } from "./in_memory_remote.ts";
import type { DatastoreStorage } from "./datastore_types.ts";
import { assertStorageConformance } from "./storage_conformance.ts";

/** An in-memory storage and its backdating hook. */
function memory() {
  const remote = createInMemoryRemote({ storage: true });
  return {
    storage: remote.storage!(),
    setLastModified: remote.setChunkLastModified!,
  };
}

/** `memory()` with some of its methods replaced. */
function broken(
  change: (storage: DatastoreStorage) => Partial<DatastoreStorage>,
) {
  const { storage, setLastModified } = memory();
  const wrapped: DatastoreStorage = {
    contract: storage.contract,
    capabilities: () => storage.capabilities(),
    has: (...args) => storage.has(...args),
    put: (...args) => storage.put(...args),
    get: (...args) => storage.get(...args),
    touch: (...args) => storage.touch!(...args),
    list: (...args) => storage.list(...args),
    delete: (...args) => storage.delete(...args),
  };
  return { storage: { ...wrapped, ...change(storage) }, setLastModified };
}

async function assertCaught(
  setup: ReturnType<typeof memory>,
  message: string,
) {
  await assertRejects(
    () =>
      assertStorageConformance(() => setup.storage, {
        setLastModified: setup.setLastModified,
      }),
    Error,
    message,
  );
}

Deno.test("assertStorageConformance: the in-memory remote's storage conforms and is left empty", async () => {
  const { storage, setLastModified } = memory();
  const namespaces = new Set<string>();
  const recording: DatastoreStorage = {
    ...storage,
    capabilities: () => storage.capabilities(),
    put: (ns, ...rest) => {
      namespaces.add(ns);
      return storage.put(ns, ...rest);
    },
  };
  await assertStorageConformance(() => recording, { setLastModified });
  assertEquals(namespaces.size, 2);
  for (const ns of namespaces) {
    assertEquals(
      await Array.fromAsync(storage.list(ns, new AbortController().signal)),
      [],
      `the suite left chunks in ${ns}`,
    );
  }
});

Deno.test("assertStorageConformance: passes without setLastModified, and without touch", async () => {
  const { storage } = memory();
  await assertStorageConformance(() => storage);
  const { storage: noTouch } = broken(() => ({
    touch: undefined,
    capabilities: () => ({ maxChunkBytes: 1024, touch: false }),
  }));
  await assertStorageConformance(() => noTouch);
});

Deno.test("assertStorageConformance: catches touch declared but not implemented", async () => {
  await assertCaught(
    broken(() => ({ touch: undefined })),
    "touch must be implemented exactly when",
  );
});

Deno.test("assertStorageConformance: catches a touch that ignores missing chunks", async () => {
  await assertCaught(
    broken((s) => ({
      touch: async (ns, hashes, signal) => {
        await s.touch!(ns, hashes, signal);
        return new Set();
      },
    })),
    "touch must return exactly the hashes it did not find",
  );
});

Deno.test("assertStorageConformance: catches a touch that does not refresh lastModified", async () => {
  await assertCaught(
    broken((s) => ({
      // Reports missing chunks correctly but refreshes nothing.
      touch: async (ns, hashes, signal) => {
        const present = await s.has(ns, hashes, signal);
        return new Set(hashes.filter((h) => !present.has(h)));
      },
    })),
    "touch must refresh lastModified",
  );
});

Deno.test("assertStorageConformance: catches a put that keeps the caller's buffer", async () => {
  const chunks = new Map<string, Uint8Array>();
  await assertCaught(
    broken((s) => ({
      put: async (ns, sha, bytes, signal) => {
        await s.put(ns, sha, bytes, signal);
        chunks.set(`${ns}/${sha}`, bytes);
      },
      get: async (ns, sha, signal) =>
        chunks.get(`${ns}/${sha}`) ?? await s.get(ns, sha, signal),
    })),
    "must not change when the caller later changes",
  );
});

Deno.test("assertStorageConformance: catches a list that leaks other namespaces", async () => {
  await assertCaught(
    broken((s) => ({
      list: async function* (ns, signal) {
        yield* s.list(ns, signal);
        yield* s.list(`${ns}-other`, signal);
      },
    })),
    "list must not report another namespace's chunks",
  );
});

Deno.test("assertStorageConformance: catches a get that ignores an aborted signal", async () => {
  await assertCaught(
    broken((s) => ({
      get: (ns, sha) => s.get(ns, sha, new AbortController().signal),
    })),
    "get must reject when its signal has aborted",
  );
});

Deno.test("assertStorageConformance: catches handles that do not share their chunks", async () => {
  await assertRejects(
    () => assertStorageConformance(() => memory().storage),
    Error,
    "a second handle must see",
  );
});
