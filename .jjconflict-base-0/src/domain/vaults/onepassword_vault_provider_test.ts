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
  OnePasswordVaultProvider,
  parseSecretKey,
} from "./onepassword_vault_provider.ts";

Deno.test("OnePasswordVaultProvider - constructor and configuration", async (t) => {
  await t.step("should store and return the vault name via getName", () => {
    const provider = new OnePasswordVaultProvider("my-1p-vault", {
      op_vault: "Engineering",
    });
    assertEquals(provider.getName(), "my-1p-vault");
  });

  await t.step("should accept config with op_vault and op_account", () => {
    const provider = new OnePasswordVaultProvider("multi-account", {
      op_vault: "Engineering",
      op_account: "my-team.1password.com",
    });
    assertEquals(provider.getName(), "multi-account");
  });

  await t.step("should throw error when op_vault is empty", () => {
    assertThrows(
      () =>
        new OnePasswordVaultProvider("bad-vault", {
          op_vault: "",
        }),
      Error,
      "1Password vault name is required",
    );
  });

  await t.step("should handle various vault name formats", () => {
    let provider = new OnePasswordVaultProvider("simple", {
      op_vault: "Engineering",
    });
    assertEquals(provider.getName(), "simple");

    provider = new OnePasswordVaultProvider("my-production-vault", {
      op_vault: "Production Secrets",
    });
    assertEquals(provider.getName(), "my-production-vault");
  });
});

Deno.test("parseSecretKey - key mapping", async (t) => {
  await t.step(
    "should default field to 'password' when no slash present",
    () => {
      const result = parseSecretKey("api-key", "Engineering");
      assertEquals(result.item, "api-key");
      assertEquals(result.field, "password");
      assertEquals(result.isFullUri, false);
      assertEquals(result.uri, "op://Engineering/api-key/password");
    },
  );

  await t.step("should split item and field on first slash", () => {
    const result = parseSecretKey("api-key/token", "Engineering");
    assertEquals(result.item, "api-key");
    assertEquals(result.field, "token");
    assertEquals(result.isFullUri, false);
    assertEquals(result.uri, "op://Engineering/api-key/token");
  });

  await t.step("should support section/field paths", () => {
    const result = parseSecretKey("db/connection/host", "Engineering");
    assertEquals(result.item, "db");
    assertEquals(result.field, "connection/host");
    assertEquals(result.isFullUri, false);
    assertEquals(result.uri, "op://Engineering/db/connection/host");
  });

  await t.step("should pass through full op:// URIs", () => {
    const result = parseSecretKey("op://Shared/cert/pem", "Engineering");
    assertEquals(result.item, "cert");
    assertEquals(result.field, "pem");
    assertEquals(result.isFullUri, true);
    assertEquals(result.uri, "op://Shared/cert/pem");
  });

  await t.step(
    "should default field to 'password' for op:// URI with no field",
    () => {
      const result = parseSecretKey("op://Shared/cert", "Engineering");
      assertEquals(result.item, "cert");
      assertEquals(result.field, "password");
      assertEquals(result.isFullUri, true);
      assertEquals(result.uri, "op://Shared/cert");
    },
  );

  await t.step("should handle vault names with spaces", () => {
    const result = parseSecretKey("api-key", "My Vault Name");
    assertEquals(result.uri, "op://My Vault Name/api-key/password");
  });

  await t.step("should handle complex item names", () => {
    const result = parseSecretKey("my-app-prod-db", "Engineering");
    assertEquals(result.item, "my-app-prod-db");
    assertEquals(result.field, "password");
    assertEquals(result.uri, "op://Engineering/my-app-prod-db/password");
  });
});

// Note: Integration tests for get/put/list operations require the 1Password CLI
// and authentication. The op CLI operations are tested through integration tests
// or manual testing.
