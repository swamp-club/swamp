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
import { VaultTypeRegistry } from "./vault_type_registry.ts";
import { getVaultType, getVaultTypes, listVaultTypes } from "./vault_types.ts";

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

const LAZY_VAULT_SOURCE = (type: string, name: string) => `
export const vault = {
  type: "${type}",
  name: ${name},
  description: "Declared description",
  createProvider: () => ({}),
};
`;

function lazyVaultRegistry(
  entries: Array<{ type: string; description?: string }>,
): VaultTypeRegistry {
  const registry = new VaultTypeRegistry();
  for (const { type, description } of entries) {
    registry.registerLazy({
      type,
      bundlePath: `/repo/.swamp/vault-bundles/${type}.js`,
      sourcePath: `/repo/extensions/vaults/${type}.ts`,
      version: "",
      description,
    });
  }
  return registry;
}

Deno.test("listVaultTypes: lists a lazy type under its declared name and description without loading it", async () => {
  const registry = lazyVaultRegistry([{ type: "@test/lazy" }]);
  let typeLoads = 0;
  registry.setTypeLoader(() => {
    typeLoads++;
    return Promise.resolve();
  });

  const types = await listVaultTypes(
    registry,
    () => Promise.resolve(LAZY_VAULT_SOURCE("@test/lazy", `"Lazy Vault"`)),
  );

  assertEquals(types, [{
    type: "@test/lazy",
    name: "Lazy Vault",
    description: "Declared description",
    isBuiltIn: false,
  }]);
  assertEquals(typeLoads, 0);
  assertEquals(registry.isLazy("@test/lazy"), true);
});

Deno.test("listVaultTypes: an unreadable source keeps the type id and the catalog description", async () => {
  const registry = lazyVaultRegistry([
    { type: "@test/gone", description: "From the catalog" },
  ]);

  const types = await listVaultTypes(
    registry,
    () => Promise.reject(new Deno.errors.NotFound("gone")),
  );

  assertEquals(types.map((t) => [t.name, t.description]), [
    ["@test/gone", "From the catalog"],
  ]);
});

Deno.test("listVaultTypes: a computed name keeps the type id", async () => {
  const registry = lazyVaultRegistry([{ type: "@test/computed" }]);

  const types = await listVaultTypes(
    registry,
    () => Promise.resolve(LAZY_VAULT_SOURCE("@test/computed", "label")),
  );

  assertEquals(types.map((t) => [t.name, t.description]), [
    ["@test/computed", "Declared description"],
  ]);
});

Deno.test("listVaultTypes: a loaded type is listed from the registry, not from source", async () => {
  const registry = new VaultTypeRegistry();
  registry.register({
    type: "@test/loaded",
    name: "Loaded Vault",
    description: "From the registry",
    isBuiltIn: false,
  });

  const types = await listVaultTypes(
    registry,
    () => Promise.reject(new Error("source must not be read")),
  );

  assertEquals(types.map((t) => t.name), ["Loaded Vault"]);
});
