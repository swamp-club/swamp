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
import {
  type DriverTypeInfo,
  DriverTypeRegistry,
  type LazyDriverEntry,
} from "./driver_type_registry.ts";

Deno.test("DriverTypeRegistry - register and get", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "test-driver",
    name: "Test Driver",
    description: "A test driver",
    isBuiltIn: true,
  });

  const info = registry.get("test-driver");
  assertEquals(info?.type, "test-driver");
  assertEquals(info?.name, "Test Driver");
  assertEquals(info?.isBuiltIn, true);
});

Deno.test("DriverTypeRegistry - get is case-insensitive", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "My-Driver",
    name: "My Driver",
    description: "A driver",
    isBuiltIn: false,
  });

  assertEquals(registry.get("my-driver")?.type, "My-Driver");
  assertEquals(registry.get("MY-DRIVER")?.type, "My-Driver");
});

Deno.test("DriverTypeRegistry - get returns undefined for unknown type", () => {
  const registry = new DriverTypeRegistry();
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("DriverTypeRegistry - has returns true for registered type", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "test-driver",
    name: "Test",
    description: "test",
    isBuiltIn: true,
  });

  assertEquals(registry.has("test-driver"), true);
  assertEquals(registry.has("TEST-DRIVER"), true);
  assertEquals(registry.has("unknown"), false);
});

Deno.test("DriverTypeRegistry - getAll returns all registered types", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "driver-a",
    name: "A",
    description: "a",
    isBuiltIn: true,
  });
  registry.register({
    type: "driver-b",
    name: "B",
    description: "b",
    isBuiltIn: false,
  });

  const all = registry.getAll();
  assertEquals(all.length, 2);
  assertEquals(all[0].type, "driver-a");
  assertEquals(all[1].type, "driver-b");
});

Deno.test("DriverTypeRegistry - register throws on duplicate", () => {
  const registry = new DriverTypeRegistry();
  registry.register({
    type: "dup-driver",
    name: "Dup",
    description: "dup",
    isBuiltIn: true,
  });

  assertThrows(
    () =>
      registry.register({
        type: "dup-driver",
        name: "Dup Again",
        description: "dup again",
        isBuiltIn: true,
      }),
    Error,
    "already registered",
  );
});

Deno.test("DriverTypeRegistry - register user-defined type with createDriver", () => {
  const registry = new DriverTypeRegistry();
  const mockDriver = {
    type: "@myorg/custom",
    execute: () =>
      Promise.resolve({
        status: "success" as const,
        outputs: [],
        logs: [],
        durationMs: 0,
      }),
  };

  registry.register({
    type: "@myorg/custom",
    name: "Custom Driver",
    description: "A custom driver",
    isBuiltIn: false,
    createDriver: () => mockDriver,
  });

  const info = registry.get("@myorg/custom");
  assertEquals(info?.type, "@myorg/custom");
  assertEquals(info?.isBuiltIn, false);
  assertEquals(typeof info?.createDriver, "function");
});

// --- Lazy loading tests ---

function createLazyDriverEntry(type: string): LazyDriverEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/driver-bundles/${type}.js`,
    sourcePath: `/repo/extensions/drivers/${type}.ts`,
    version: "2026.01.15.1",
  };
}

function createDriverTypeInfo(type: string): DriverTypeInfo {
  return {
    type,
    name: `${type} driver`,
    description: `A ${type} driver`,
    isBuiltIn: false,
  };
}

Deno.test("DriverTypeRegistry.registerLazy: stores lazy entries without importing", () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(createLazyDriverEntry("@myorg/custom"));

  assertEquals(registry.has("@myorg/custom"), true);
  assertEquals(registry.isLazy("@myorg/custom"), true);
  assertEquals(registry.get("@myorg/custom"), undefined);
});

Deno.test("DriverTypeRegistry.ensureTypeLoaded: calls type loader for lazy types", async () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(createLazyDriverEntry("@myorg/custom"));

  let loadedType: string | null = null;
  registry.setTypeLoader((type) => {
    loadedType = type;
    registry.promoteFromLazy(createDriverTypeInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/custom");

  assertEquals(loadedType, "@myorg/custom");
  assertEquals(registry.isLazy("@myorg/custom"), false);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom driver");
});

Deno.test("DriverTypeRegistry.ensureTypeLoaded: no-op for already loaded types", async () => {
  const registry = new DriverTypeRegistry();
  registry.register(createDriverTypeInfo("@myorg/loaded"));

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  assertEquals(called, false);
});

Deno.test("DriverTypeRegistry.ensureTypeLoaded: no-op for unknown types", async () => {
  const registry = new DriverTypeRegistry();

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/nonexistent");
  assertEquals(called, false);
});

Deno.test("DriverTypeRegistry.ensureTypeLoaded: concurrent callers share same promise", async () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(createLazyDriverEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader(async (type) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.promoteFromLazy(createDriverTypeInfo(type));
  });

  await Promise.all([
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
  ]);

  assertEquals(callCount, 1);
});

Deno.test("DriverTypeRegistry.ensureTypeLoaded: retries after transient failure", async () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(createLazyDriverEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader((type) => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error("transient I/O error"));
    }
    registry.promoteFromLazy(createDriverTypeInfo(type));
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
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom driver");
});
