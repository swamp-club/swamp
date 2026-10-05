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
import { createVaultProvider } from "./vault_provider_factory.ts";
import { z } from "zod";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";

Deno.test("createVaultProvider: creates mock provider", () => {
  const provider = createVaultProvider("mock", "test-vault", {});
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createVaultProvider: creates local_encryption provider", () => {
  const provider = createVaultProvider("local_encryption", "test-vault", {
    auto_generate: true,
    base_dir: "/tmp",
  });
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createVaultProvider: throws for unsupported type", () => {
  assertThrows(
    () => createVaultProvider("nonexistent", "test-vault", {}),
    Error,
    "Unsupported vault type",
  );
});

Deno.test("createVaultProvider: is case insensitive for built-in types", () => {
  const provider = createVaultProvider("Mock", "test-vault", {});
  assertEquals(provider.getName(), "test-vault");
});

Deno.test("createVaultProvider: a stored config that fails the type's schema names the vault and the missing field (swamp-club#3003)", () => {
  const type = `@test/factory-config-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type,
    name: "Factory config",
    description: "Vault type with a required config field",
    isBuiltIn: false,
    configSchema: z.object({
      token: z.string().describe("API token"),
    }),
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    assertThrows(
      () => createVaultProvider(type, "shared", {}),
      Error,
      `Invalid config for vault type '${type}' (vault 'shared'): missing ` +
        "required field 'token' (API token).",
    );
  } finally {
    vaultTypeRegistry.invalidateType(type);
  }
});
