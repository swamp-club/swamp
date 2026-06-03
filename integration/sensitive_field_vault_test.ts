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

/**
 * Integration tests for sensitive field vault storage.
 *
 * Tests the full flow: resource data with sensitive fields → processSensitiveResourceData →
 * vault storage → data has vault references instead of plaintext.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { processSensitiveResourceData } from "../src/domain/models/data_writer.ts";

Deno.test("Integration: sensitive output fields stored in vault with references in persisted data", async () => {
  const modelType = ModelType.create("test/sensitive-output");
  const modelId = crypto.randomUUID();
  const methodName = "createKeyPair";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
      publicKey: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = {
    keyId: "key-12345",
    keyMaterial:
      "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    publicKey: "ssh-rsa AAAAB3... user@host",
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
  );

  // Non-sensitive fields unchanged
  assertEquals(data.keyId, "key-12345");
  assertEquals(data.publicKey, "ssh-rsa AAAAB3... user@host");

  // Sensitive field replaced with vault reference
  const keyMaterialRef = data.keyMaterial as string;
  assertStringIncludes(keyMaterialRef, "vault.get");
  assertStringIncludes(keyMaterialRef, "'test-vault'");
  assertStringIncludes(keyMaterialRef, "${{ vault.get('test-vault'");

  // Verify the actual secret was stored in the vault
  const vaultKey = `test-sensitive-output-${modelId}-${methodName}-keyMaterial`;
  const storedSecret = await vaultService.get("test-vault", vaultKey);
  assertEquals(
    storedSecret,
    "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  );

  // Verify data can be serialized to JSON (simulates persistence)
  const persistedJson = JSON.stringify(data);
  const parsed = JSON.parse(persistedJson);
  assertEquals(parsed.keyId, "key-12345");
  assertStringIncludes(parsed.keyMaterial, "vault.get");
  assertEquals(parsed.publicKey, "ssh-rsa AAAAB3... user@host");
});

Deno.test("Integration: sensitiveOutput flag vaults all fields", async () => {
  const modelType = ModelType.create("test/all-sensitive");
  const modelId = crypto.randomUUID();
  const methodName = "generate";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      field1: z.string(),
      field2: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  };

  const data: Record<string, unknown> = {
    field1: "secret-value-1",
    field2: "secret-value-2",
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
  );

  // Both fields should be vault references
  assertStringIncludes(data.field1 as string, "vault.get");
  assertStringIncludes(data.field2 as string, "vault.get");

  // Verify values stored in vault
  const key1 = `test-all-sensitive-${modelId}-${methodName}-field1`;
  const key2 = `test-all-sensitive-${modelId}-${methodName}-field2`;
  assertEquals(
    await vaultService.get("test-vault", key1),
    "secret-value-1",
  );
  assertEquals(
    await vaultService.get("test-vault", key2),
    "secret-value-2",
  );
});

Deno.test("Integration: custom vaultKey from schema metadata", async () => {
  const modelType = ModelType.create("test/custom-key");
  const modelId = crypto.randomUUID();
  const methodName = "generate";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({
        sensitive: true,
        vaultKey: "generated-api-key",
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { apiKey: "sk-live-abc123def456" };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
  );

  // Verify vault reference uses custom key with quoted strings
  assertEquals(
    data.apiKey,
    "${{ vault.get('test-vault', 'generated-api-key') }}",
  );

  // Verify stored with custom key
  assertEquals(
    await vaultService.get("test-vault", "generated-api-key"),
    "sk-live-abc123def456",
  );
});
