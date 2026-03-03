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

import { assertEquals, assertExists } from "@std/assert";
import { getVaultType, getVaultTypes } from "./vault_types.ts";

Deno.test("getVaultTypes contains expected built-in types", () => {
  const types = getVaultTypes().map((v) => v.type);
  assertEquals(types.includes("aws-sm"), true);
  assertEquals(types.includes("azure-kv"), true);
  assertEquals(types.includes("1password"), true);
  assertEquals(types.includes("local_encryption"), true);
  // mock vault is excluded from public listing (internal testing only)
  assertEquals(types.includes("mock"), false);
});

Deno.test("getVaultTypes returns at least 4 built-in types", () => {
  const types = getVaultTypes();
  assertEquals(types.length >= 4, true);
});

Deno.test("getVaultType returns vault type by identifier", () => {
  const aws = getVaultType("aws-sm");
  assertExists(aws);
  assertEquals(aws.type, "aws-sm");
  assertEquals(aws.name, "AWS Secrets Manager");

  const azureKv = getVaultType("azure-kv");
  assertExists(azureKv);
  assertEquals(azureKv.type, "azure-kv");
  assertEquals(azureKv.name, "Azure Key Vault");

  const onePassword = getVaultType("1password");
  assertExists(onePassword);
  assertEquals(onePassword.type, "1password");
  assertEquals(onePassword.name, "1Password");

  const local = getVaultType("local_encryption");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType is case-insensitive", () => {
  const aws = getVaultType("AWS-SM");
  assertExists(aws);
  assertEquals(aws.type, "aws-sm");

  const azureKv = getVaultType("AZURE-KV");
  assertExists(azureKv);
  assertEquals(azureKv.type, "azure-kv");

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
    if (
      ["aws-sm", "azure-kv", "1password", "local_encryption"].includes(
        vaultType.type,
      )
    ) {
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
