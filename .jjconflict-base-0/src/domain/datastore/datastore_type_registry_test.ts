// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { DatastoreTypeRegistry } from "./datastore_type_registry.ts";

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
