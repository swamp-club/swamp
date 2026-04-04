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
  type LazyVaultEntry,
  type VaultTypeInfo,
  VaultTypeRegistry,
} from "./vault_type_registry.ts";

Deno.test("VaultTypeRegistry - register and get", () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "test-vault",
    name: "Test Vault",
    description: "A test vault",
    isBuiltIn: true,
  });

  const info = registry.get("test-vault");
  assertEquals(info?.type, "test-vault");
  assertEquals(info?.name, "Test Vault");
  assertEquals(info?.isBuiltIn, true);
});

Deno.test("VaultTypeRegistry - get is case-insensitive", () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "My-Vault",
    name: "My Vault",
    description: "A vault",
    isBuiltIn: false,
  });

  assertEquals(registry.get("my-vault")?.type, "My-Vault");
  assertEquals(registry.get("MY-VAULT")?.type, "My-Vault");
});

Deno.test("VaultTypeRegistry - get returns undefined for unknown type", () => {
  const registry = new VaultTypeRegistry();
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("VaultTypeRegistry - has returns true for registered type", () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "test-vault",
    name: "Test",
    description: "test",
    isBuiltIn: true,
  });

  assertEquals(registry.has("test-vault"), true);
  assertEquals(registry.has("TEST-VAULT"), true);
  assertEquals(registry.has("unknown"), false);
});

Deno.test("VaultTypeRegistry - getAll returns all registered types", () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "vault-a",
    name: "A",
    description: "a",
    isBuiltIn: true,
  });
  registry.register({
    type: "vault-b",
    name: "B",
    description: "b",
    isBuiltIn: false,
  });

  const all = registry.getAll();
  assertEquals(all.length, 2);
  assertEquals(all[0].type, "vault-a");
  assertEquals(all[1].type, "vault-b");
});

Deno.test("VaultTypeRegistry - register throws on duplicate", () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "dup-vault",
    name: "Dup",
    description: "dup",
    isBuiltIn: true,
  });

  assertThrows(
    () =>
      registry.register({
        type: "dup-vault",
        name: "Dup Again",
        description: "dup again",
        isBuiltIn: true,
      }),
    Error,
    "already registered",
  );
});

Deno.test("VaultTypeRegistry - register user-defined type with createProvider", () => {
  const registry = new VaultTypeRegistry();
  const mockProvider = {
    get: () => Promise.resolve("secret"),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => "mock",
  };

  registry.register({
    type: "@myorg/custom",
    name: "Custom Vault",
    description: "A custom vault",
    isBuiltIn: false,
    createProvider: () => mockProvider,
  });

  const info = registry.get("@myorg/custom");
  assertEquals(info?.type, "@myorg/custom");
  assertEquals(info?.isBuiltIn, false);
  assertEquals(typeof info?.createProvider, "function");
});

// --- Lazy loading tests ---

function createLazyVaultEntry(type: string): LazyVaultEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/vault-bundles/${type}.js`,
    sourcePath: `/repo/extensions/vaults/${type}.ts`,
    version: "2026.01.15.1",
  };
}

function createVaultTypeInfo(type: string): VaultTypeInfo {
  return {
    type,
    name: `${type} vault`,
    description: `A ${type} vault`,
    isBuiltIn: false,
  };
}

Deno.test("VaultTypeRegistry.registerLazy: stores lazy entries without importing", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  assertEquals(registry.has("@myorg/custom"), true);
  assertEquals(registry.isLazy("@myorg/custom"), true);
  assertEquals(registry.get("@myorg/custom"), undefined);
});

Deno.test("VaultTypeRegistry.registerLazy: skips if already loaded", () => {
  const registry = new VaultTypeRegistry();
  registry.register(createVaultTypeInfo("@myorg/custom"));
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  assertEquals(registry.isLazy("@myorg/custom"), false);
});

Deno.test("VaultTypeRegistry.has: returns true for lazy types", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  assertEquals(registry.has("@myorg/custom"), true);
  assertEquals(registry.has("@myorg/nonexistent"), false);
});

Deno.test("VaultTypeRegistry.get: returns undefined for lazy types", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  assertEquals(registry.get("@myorg/custom"), undefined);
});

Deno.test("VaultTypeRegistry.ensureTypeLoaded: calls type loader for lazy types", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  let loadedType: string | null = null;
  registry.setTypeLoader((type) => {
    loadedType = type;
    registry.promoteFromLazy(createVaultTypeInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/custom");

  assertEquals(loadedType, "@myorg/custom");
  assertEquals(registry.isLazy("@myorg/custom"), false);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom vault");
});

Deno.test("VaultTypeRegistry.ensureTypeLoaded: no-op for already loaded types", async () => {
  const registry = new VaultTypeRegistry();
  registry.register(createVaultTypeInfo("@myorg/loaded"));

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  assertEquals(called, false);
});

Deno.test("VaultTypeRegistry.ensureTypeLoaded: no-op for unknown types", async () => {
  const registry = new VaultTypeRegistry();

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/nonexistent");
  assertEquals(called, false);
});

Deno.test("VaultTypeRegistry.ensureTypeLoaded: concurrent callers share same promise", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader(async (type) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.promoteFromLazy(createVaultTypeInfo(type));
  });

  await Promise.all([
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
    registry.ensureTypeLoaded("@myorg/custom"),
  ]);

  assertEquals(callCount, 1);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom vault");
});

Deno.test("VaultTypeRegistry.ensureTypeLoaded: retries after transient failure", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  let callCount = 0;
  registry.setTypeLoader((type) => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error("transient I/O error"));
    }
    registry.promoteFromLazy(createVaultTypeInfo(type));
    return Promise.resolve();
  });

  let caught = false;
  try {
    await registry.ensureTypeLoaded("@myorg/custom");
  } catch {
    caught = true;
  }
  assertEquals(caught, true);
  assertEquals(callCount, 1);

  await registry.ensureTypeLoaded("@myorg/custom");
  assertEquals(callCount, 2);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom vault");
});

Deno.test("VaultTypeRegistry.promoteFromLazy: moves lazy to loaded", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/custom"));

  assertEquals(registry.isLazy("@myorg/custom"), true);

  registry.promoteFromLazy(createVaultTypeInfo("@myorg/custom"));

  assertEquals(registry.isLazy("@myorg/custom"), false);
  assertEquals(registry.get("@myorg/custom")?.name, "@myorg/custom vault");
});

Deno.test("VaultTypeRegistry.getAllLazy: returns lazy entries", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(createLazyVaultEntry("@myorg/a"));
  registry.registerLazy(createLazyVaultEntry("@myorg/b"));
  registry.register(createVaultTypeInfo("@myorg/c"));

  const lazy = registry.getAllLazy();
  assertEquals(lazy.length, 2);
  assertEquals(lazy.map((e) => e.type).sort(), ["@myorg/a", "@myorg/b"]);
});
