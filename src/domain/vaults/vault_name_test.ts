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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isReservedVaultName,
  isValidVaultName,
  reservedVaultNameMessage,
  VAULT_NAME_RULE,
  vaultCreateHint,
} from "./vault_name.ts";

Deno.test("isValidVaultName: accepts lowercase letters, digits and hyphens after a leading letter", () => {
  for (const name of ["a", "dev-secrets", "api-keys-v2", "prod-vault"]) {
    assertEquals(isValidVaultName(name), true, name);
  }
});

Deno.test("isValidVaultName: rejects names vault create rejects", () => {
  for (
    const name of [
      "",
      "MyVault",
      "VAULT",
      "123-vault",
      "vault_name",
      "_token-secrets",
      "_foo",
      "-lead",
      "has space",
    ]
  ) {
    assertEquals(isValidVaultName(name), false, name);
  }
});

Deno.test("isReservedVaultName: true only for underscore-prefixed names", () => {
  assertEquals(isReservedVaultName("_token-secrets"), true);
  assertEquals(isReservedVaultName("_foo"), true);
  assertEquals(isReservedVaultName("foo_"), false);
  assertEquals(isReservedVaultName("dev-secrets"), false);
  assertEquals(isReservedVaultName(""), false);
});

Deno.test("reservedVaultNameMessage: describes the control-plane vault for _token-secrets", () => {
  const message = reservedVaultNameMessage("_token-secrets");
  assertStringIncludes(message, "swamp's reserved control-plane vault");
  assertStringIncludes(message, "swamp access token reveal <name>");
  assertStringIncludes(message, "cannot be created with 'swamp vault create'");
});

Deno.test("reservedVaultNameMessage: describes other underscore names as reserved", () => {
  const message = reservedVaultNameMessage("_foo");
  assertStringIncludes(message, "reserved for swamp's internal vaults");
  assertStringIncludes(message, "cannot be created with 'swamp vault create'");
  assertEquals(message.includes("control-plane"), false);
});

Deno.test("vaultCreateHint: suggests vault create with the name when it is valid", () => {
  assertEquals(
    vaultCreateHint("dev-secrets"),
    "Create a vault using: swamp vault create <type> dev-secrets",
  );
});

Deno.test("vaultCreateHint: explains the rule and uses a placeholder for invalid names", () => {
  for (const name of ["MyVault", "1abc", "_foo"]) {
    const hint = vaultCreateHint(name);
    assertStringIncludes(hint, `'${name}' is not a valid vault name.`);
    assertStringIncludes(hint, VAULT_NAME_RULE);
    assertStringIncludes(hint, "swamp vault create <type> <name>");
    assertEquals(hint.includes(`swamp vault create <type> ${name}`), false);
  }
});

Deno.test("vaultCreateHint: uses the placeholder for an empty name", () => {
  assertEquals(
    vaultCreateHint(""),
    `'' is not a valid vault name. ${VAULT_NAME_RULE} ` +
      `Create a vault using: swamp vault create <type> <name>`,
  );
});
