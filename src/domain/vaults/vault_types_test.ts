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

import { assertEquals, assertExists } from "@std/assert";
import {
  type LazyVaultEntry,
  VaultTypeRegistry,
} from "./vault_type_registry.ts";
import {
  ensureAllVaultTypesLoaded,
  getVaultType,
  getVaultTypes,
} from "./vault_types.ts";

Deno.test("getVaultTypes contains expected built-in types", () => {
  const types = getVaultTypes().map((v) => v.type);
  assertEquals(types.includes("local_encryption"), true);
  // mock vault is excluded from public listing (internal testing only)
  assertEquals(types.includes("mock"), false);
  // aws-sm, azure-kv, and 1password are now extensions, not built-in
  assertEquals(types.includes("aws-sm"), false);
  assertEquals(types.includes("azure-kv"), false);
  assertEquals(types.includes("1password"), false);
});

Deno.test("getVaultTypes returns at least 1 built-in type", () => {
  const types = getVaultTypes();
  assertEquals(types.length >= 1, true);
});

Deno.test("getVaultType returns vault type by identifier", () => {
  const local = getVaultType("local_encryption");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType is case-insensitive", () => {
  const local = getVaultType("LOCAL_ENCRYPTION");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType returns undefined for unknown type", () => {
  const unknown = getVaultType("unknown");
  assertEquals(unknown, undefined);

  const empty = getVaultType("");
  assertEquals(empty, undefined);
});

Deno.test("built-in vault types have isBuiltIn flag set", () => {
  const types = getVaultTypes();
  for (const vaultType of types) {
    if (vaultType.type === "local_encryption") {
      assertEquals(vaultType.isBuiltIn, true);
    }
  }
});

Deno.test("all vault types have required fields", () => {
  for (const vaultType of getVaultTypes()) {
    assertExists(vaultType.type);
    assertExists(vaultType.name);
    assertExists(vaultType.description);
    assertEquals(vaultType.type.length > 0, true);
    assertEquals(vaultType.name.length > 0, true);
    assertEquals(vaultType.description.length > 0, true);
  }
});

function lazyVaultEntry(type: string): LazyVaultEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/vault-bundles/${type}.js`,
    sourcePath: `/repo/extensions/vaults/${type}.ts`,
    version: "2026.01.15.1",
  };
}

Deno.test("ensureAllVaultTypesLoaded: imports every lazy type so it is listed as declared", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(lazyVaultEntry("@test/one"));
  registry.registerLazy(lazyVaultEntry("@test/two"));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy({
      type,
      name: `Declared ${type}`,
      description: `Description of ${type}`,
      isBuiltIn: false,
    });
    return Promise.resolve();
  });

  await ensureAllVaultTypesLoaded(registry);

  assertEquals(registry.getAllLazy(), []);
  assertEquals(
    registry.getAll().map((t) => [t.type, t.name, t.description]),
    [
      ["@test/one", "Declared @test/one", "Description of @test/one"],
      ["@test/two", "Declared @test/two", "Description of @test/two"],
    ],
  );
});

Deno.test("ensureAllVaultTypesLoaded: a type that fails to import keeps its placeholder and the rest still load", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(lazyVaultEntry("@test/broken"));
  registry.registerLazy(lazyVaultEntry("@test/good"));
  registry.setTypeLoader((type) => {
    if (type === "@test/broken") {
      return Promise.reject(new Error("name: expected string"));
    }
    registry.promoteFromLazy({
      type,
      name: "Good Vault",
      description: "A good vault",
      isBuiltIn: false,
    });
    return Promise.resolve();
  });

  await ensureAllVaultTypesLoaded(registry);

  assertEquals(registry.getAllLazy().map((e) => e.type), ["@test/broken"]);
  assertEquals(registry.getAll().map((t) => t.name), ["Good Vault"]);
});

Deno.test("ensureAllVaultTypesLoaded: a type the loader skips is dropped from the listing", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(lazyVaultEntry("@test/skipped"));
  registry.setTypeLoader(() => Promise.resolve());

  await ensureAllVaultTypesLoaded(registry);

  assertEquals(registry.getAllLazy(), []);
  assertEquals(registry.getAll(), []);
});

Deno.test("ensureAllVaultTypesLoaded: runs the extension loader before importing lazy types", async () => {
  const registry = new VaultTypeRegistry();
  const calls: string[] = [];
  registry.setLoader(() => {
    calls.push("index");
    registry.registerLazy(lazyVaultEntry("@test/indexed"));
    return Promise.resolve();
  });
  registry.setTypeLoader((type) => {
    calls.push(type);
    return Promise.resolve();
  });

  await ensureAllVaultTypesLoaded(registry);

  assertEquals(calls, ["index", "@test/indexed"]);
});
