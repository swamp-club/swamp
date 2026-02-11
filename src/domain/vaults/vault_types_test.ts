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
import { getVaultType, getVaultTypes, VAULT_TYPES } from "./vault_types.ts";

Deno.test("VAULT_TYPES contains expected types", () => {
  const types = VAULT_TYPES.map((v) => v.type);
  assertEquals(types.includes("aws"), true);
  assertEquals(types.includes("local_encryption"), true);
  // mock vault is excluded from public listing (internal testing only)
  assertEquals(types.includes("mock"), false);
});

Deno.test("getVaultTypes returns all vault types", () => {
  const types = getVaultTypes();
  assertEquals(types.length, 2);
  assertEquals(types, VAULT_TYPES);
});

Deno.test("getVaultType returns vault type by identifier", () => {
  const aws = getVaultType("aws");
  assertExists(aws);
  assertEquals(aws.type, "aws");
  assertEquals(aws.name, "AWS Secrets Manager");

  const local = getVaultType("local_encryption");
  assertExists(local);
  assertEquals(local.type, "local_encryption");
});

Deno.test("getVaultType is case-insensitive", () => {
  const aws = getVaultType("AWS");
  assertExists(aws);
  assertEquals(aws.type, "aws");

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

Deno.test("all vault types have required fields", () => {
  for (const vaultType of VAULT_TYPES) {
    assertExists(vaultType.type);
    assertExists(vaultType.name);
    assertExists(vaultType.description);
    assertEquals(vaultType.type.length > 0, true);
    assertEquals(vaultType.name.length > 0, true);
    assertEquals(vaultType.description.length > 0, true);
  }
});
