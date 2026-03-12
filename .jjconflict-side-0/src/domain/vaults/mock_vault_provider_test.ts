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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { MockVaultProvider } from "./mock_vault_provider.ts";

Deno.test("MockVaultProvider - constructor", async (t) => {
  await t.step("should set the vault name", () => {
    const provider = new MockVaultProvider("test-vault");
    assertEquals(provider.getName(), "test-vault");
  });

  await t.step("should initialize with default secrets", () => {
    const provider = new MockVaultProvider("test-vault");
    const secrets = provider.listSecrets();
    assertEquals(secrets.includes("demo-api-key"), true);
    assertEquals(secrets.includes("demo-api-key-2"), true);
    assertEquals(secrets.includes("derived-api-key"), true);
  });

  await t.step("should accept custom secrets in constructor", () => {
    const provider = new MockVaultProvider("test-vault", {
      "custom-key": "custom-value",
    });
    const secrets = provider.listSecrets();
    assertEquals(secrets.includes("custom-key"), true);
  });
});

Deno.test("MockVaultProvider - get", async (t) => {
  await t.step("should return default secret values", async () => {
    const provider = new MockVaultProvider("test-vault");
    const value = await provider.get("demo-api-key");
    assertEquals(value, "super-secret-api-key-12345");
  });

  await t.step("should return custom secret values", async () => {
    const provider = new MockVaultProvider("test-vault", {
      "my-secret": "my-value",
    });
    const value = await provider.get("my-secret");
    assertEquals(value, "my-value");
  });

  await t.step("should throw for non-existent secret", () => {
    const provider = new MockVaultProvider("test-vault");
    const error = assertThrows(
      () => provider.get("non-existent-key"),
      Error,
    );
    assertStringIncludes(error.message, "Secret 'non-existent-key' not found");
    assertStringIncludes(error.message, "mock vault 'test-vault'");
  });
});

Deno.test("MockVaultProvider - put", async (t) => {
  await t.step("should store a new secret", async () => {
    const provider = new MockVaultProvider("test-vault");
    await provider.put("new-key", "new-value");
    const value = await provider.get("new-key");
    assertEquals(value, "new-value");
  });

  await t.step("should overwrite an existing secret", async () => {
    const provider = new MockVaultProvider("test-vault", {
      "existing-key": "old-value",
    });
    await provider.put("existing-key", "new-value");
    const value = await provider.get("existing-key");
    assertEquals(value, "new-value");
  });
});

Deno.test("MockVaultProvider - addSecret", async (t) => {
  await t.step("should add a secret via addSecret method", async () => {
    const provider = new MockVaultProvider("test-vault");
    provider.addSecret("added-key", "added-value");
    const value = await provider.get("added-key");
    assertEquals(value, "added-value");
  });
});

Deno.test("MockVaultProvider - listSecrets", async (t) => {
  await t.step("should list all secret keys", () => {
    const provider = new MockVaultProvider("test-vault", {
      "key1": "value1",
      "key2": "value2",
    });
    const secrets = provider.listSecrets();
    // Default secrets plus custom ones
    assertEquals(secrets.includes("key1"), true);
    assertEquals(secrets.includes("key2"), true);
    assertEquals(secrets.includes("demo-api-key"), true);
  });
});
