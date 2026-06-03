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

import { assertEquals, assertThrows } from "@std/assert";
import {
  type DatastoreTypeInfo,
  DatastoreTypeRegistry,
  type LazyDatastoreEntry,
} from "./datastore_type_registry.ts";

Deno.test("DatastoreTypeRegistry - register and get", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "test-store",
    name: "Test Store",
    description: "A test datastore",
    isBuiltIn: true,
  });

  const info = registry.get("test-store");
  assertEquals(info?.type, "test-store");
  assertEquals(info?.name, "Test Store");
  assertEquals(info?.isBuiltIn, true);
});

Deno.test("DatastoreTypeRegistry - get is case-insensitive", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "My-Store",
    name: "My Store",
    description: "A store",
    isBuiltIn: false,
  });

  assertEquals(registry.get("my-store")?.type, "My-Store");
  assertEquals(registry.get("MY-STORE")?.type, "My-Store");
});

Deno.test("DatastoreTypeRegistry - get returns undefined for unknown type", () => {
  const registry = new DatastoreTypeRegistry();
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("DatastoreTypeRegistry - has returns true for registered type", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "test-store",
    name: "Test",
    description: "test",
    isBuiltIn: true,
  });

  assertEquals(registry.has("test-store"), true);
  assertEquals(registry.has("TEST-STORE"), true);
  assertEquals(registry.has("unknown"), false);
});

Deno.test("DatastoreTypeRegistry - getAll returns all registered types", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "store-a",
    name: "A",
    description: "a",
    isBuiltIn: true,
  });
  registry.register({
    type: "store-b",
    name: "B",
    description: "b",
    isBuiltIn: false,
  });

  const all = registry.getAll();
  assertEquals(all.length, 2);
  assertEquals(all[0].type, "store-a");
  assertEquals(all[1].type, "store-b");
});

Deno.test("DatastoreTypeRegistry - register throws on duplicate", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "dup-store",
    name: "Dup",
    description: "dup",
    isBuiltIn: true,
  });

  assertThrows(
    () =>
      registry.register({
        type: "dup-store",
        name: "Dup Again",
        description: "dup again",
        isBuiltIn: true,
      }),
    Error,
    "already registered",
  );
});

Deno.test("DatastoreTypeRegistry - register user-defined type with createProvider", () => {
  const registry = new DatastoreTypeRegistry();
  const mockProvider = {
    createLock: () => ({
      acquire: () => Promise.resolve(),
      release: () => Promise.resolve(),
      withLock: <T>(fn: () => Promise<T>) => fn(),
      inspect: () => Promise.resolve(null),
      forceRelease: () => Promise.resolve(false),
    }),
    createVerifier: () => ({
      verify: () =>
        Promise.resolve({
          healthy: true,
          message: "ok",
          latencyMs: 1,
          datastoreType: "@myorg/custom",
        }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  };

  registry.register({
    type: "@myorg/custom",
    name: "Custom Store",
    description: "A custom datastore",
    isBuiltIn: false,
    createProvider: () => mockProvider,
  });

  const info = registry.get("@myorg/custom");
  assertEquals(info?.type, "@myorg/custom");
  assertEquals(info?.isBuiltIn, false);
  assertEquals(typeof info?.createProvider, "function");
});

// --- Lazy loading tests ---

function createLazyDatastoreEntry(type: string): LazyDatastoreEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/datastore-bundles/${type}.js`,
    sourcePath: `/repo/extensions/datastores/${type}.ts`,
    version: "2026.01.15.1",
  };
}

function createDatastoreTypeInfo(type: string): DatastoreTypeInfo {
  return {
    type,
    name: `${type} store`,
    description: `A ${type} datastore`,
    isBuiltIn: false,
  };
}

Deno.test("DatastoreTypeRegistry.registerLazy: stores lazy entries without importing", () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(createLazyDatastoreEntry("@myorg/custom"));

  assertEquals(registry.has("@myorg/custom"), true);
  assertEquals(registry.isLazy("@myorg/custom"), true);
  assertEquals(registry.get("@myorg/custom"), undefined);
});

Deno.test("DatastoreTypeRegistry.ensureTypeLoaded: calls type loader for lazy types", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(createLazyDatastoreEntry("@myorg/custom"));

  let loadedType: string | null = null;
  registry.setTypeLoader((type) => {
    loadedType = type;
    registry.promoteFromLazy(createDatastoreTypeInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/custom");

  assertEquals(loadedType, "@myorg/custom");
  assertEquals(registry.isLazy("@myorg/custom"), false);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom store");
});

Deno.test("DatastoreTypeRegistry.ensureTypeLoaded: no-op for already loaded types", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.register(createDatastoreTypeInfo("@myorg/loaded"));

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  assertEquals(called, false);
});

Deno.test("DatastoreTypeRegistry.ensureTypeLoaded: no-op for unknown types", async () => {
  const registry = new DatastoreTypeRegistry();

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/nonexistent");
  assertEquals(called, false);
});

Deno.test("DatastoreTypeRegistry.ensureTypeLoaded: concurrent callers share same promise", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(createLazyDatastoreEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader(async (type) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.promoteFromLazy(createDatastoreTypeInfo(type));
  });

  await Promise.all([
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
  ]);

  assertEquals(callCount, 1);
});

Deno.test("DatastoreTypeRegistry.ensureTypeLoaded: retries after transient failure", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(createLazyDatastoreEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader((type) => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error("transient I/O error"));
    }
    registry.promoteFromLazy(createDatastoreTypeInfo(type));
    return Promise.resolve();
  });

  let caught = false;
  try {
    await registry.ensureTypeLoaded("@myorg/custom");
  } catch {
    caught = true;
  }
  assertEquals(caught, true);

  await registry.ensureTypeLoaded("@myorg/custom");
  assertEquals(callCount, 2);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom store");
});

Deno.test("DatastoreTypeRegistry.resetLoadedFlag re-runs the loader on next ensureLoaded", async () => {
  const registry = new DatastoreTypeRegistry();
  let loadCount = 0;
  registry.setLoader(() => {
    loadCount++;
    return Promise.resolve();
  });

  await registry.ensureLoaded();
  assertEquals(loadCount, 1);

  // Without reset, a second ensureLoaded is a no-op.
  await registry.ensureLoaded();
  assertEquals(loadCount, 1);

  registry.resetLoadedFlag();
  await registry.ensureLoaded();
  assertEquals(loadCount, 2);
});
