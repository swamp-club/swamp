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

/**
 * Integration tests for sensitive field vault storage.
 *
 * Tests the full flow: model data with sensitive fields → processSensitiveFields →
 * vault storage → persisted data has vault references instead of plaintext.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { ModelData } from "../src/domain/models/model_data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { processSensitiveFields } from "../src/domain/models/data_writer.ts";

Deno.test("Integration: sensitive output fields stored in vault with references in persisted data", async () => {
  const modelType = ModelType.create("test/sensitive-output");
  const modelId = crypto.randomUUID();
  const methodName = "createKeyPair";

  const dataSchema = z.object({
    keyId: z.string(),
    keyMaterial: z.string().meta({ sensitive: true }),
    publicKey: z.string(),
  });

  // Create model data with sensitive field
  const data = ModelData.create({
    id: modelId,
    attributes: {
      keyId: "key-12345",
      keyMaterial:
        "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
      publicKey: "ssh-rsa AAAAB3... user@host",
    },
  });

  // Create a mock vault
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  // Process sensitive fields
  await processSensitiveFields({
    data,
    schema: dataSchema,
    vaultService,
    modelType,
    modelId,
    methodName,
    defaultVaultName: "test-vault",
  });

  // keyId should be plaintext (not sensitive)
  assertEquals(data.attributes.keyId, "key-12345");

  // publicKey should be plaintext (not sensitive)
  assertEquals(data.attributes.publicKey, "ssh-rsa AAAAB3... user@host");

  // keyMaterial should be a vault reference (sensitive field)
  const keyMaterialRef = data.attributes.keyMaterial as string;
  assertStringIncludes(keyMaterialRef, "vault.get");
  assertStringIncludes(keyMaterialRef, "'test-vault'");
  // Verify quoted strings for CEL compatibility
  assertStringIncludes(keyMaterialRef, "${{ vault.get('test-vault'");

  // Verify the actual secret was stored in the vault
  const vaultKey = `test/sensitive-output/${modelId}/${methodName}/keyMaterial`;
  const storedSecret = await vaultService.get("test-vault", vaultKey);
  assertEquals(
    storedSecret,
    "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  );

  // Verify data can be serialized to JSON (simulates persistence)
  const persistedJson = JSON.stringify(data.toData());
  const parsed = JSON.parse(persistedJson);
  assertEquals(parsed.attributes.keyId, "key-12345");
  assertStringIncludes(parsed.attributes.keyMaterial, "vault.get");
  assertEquals(parsed.attributes.publicKey, "ssh-rsa AAAAB3... user@host");
});

Deno.test("Integration: sensitiveOutput flag vaults all fields", async () => {
  const modelType = ModelType.create("test/all-sensitive");
  const modelId = crypto.randomUUID();
  const methodName = "generate";

  const dataSchema = z.object({
    field1: z.string(),
    field2: z.string(),
  });

  const data = ModelData.create({
    id: modelId,
    attributes: { field1: "secret-value-1", field2: "secret-value-2" },
  });

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveFields({
    data,
    schema: dataSchema,
    vaultService,
    modelType,
    modelId,
    methodName,
    sensitiveOutput: true,
    defaultVaultName: "test-vault",
  });

  // Both fields should be vault references
  assertStringIncludes(data.attributes.field1 as string, "vault.get");
  assertStringIncludes(data.attributes.field2 as string, "vault.get");

  // Verify values stored in vault
  const key1 = `test/all-sensitive/${modelId}/${methodName}/field1`;
  const key2 = `test/all-sensitive/${modelId}/${methodName}/field2`;
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

  const dataSchema = z.object({
    apiKey: z.string().meta({
      sensitive: true,
      vaultKey: "generated-api-key",
    }),
  });

  const data = ModelData.create({
    id: modelId,
    attributes: { apiKey: "sk-live-abc123def456" },
  });

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveFields({
    data,
    schema: dataSchema,
    vaultService,
    modelType,
    modelId,
    methodName,
    defaultVaultName: "test-vault",
  });

  // Verify vault reference uses custom key with quoted strings
  assertEquals(
    data.attributes.apiKey,
    "${{ vault.get('test-vault', 'generated-api-key') }}",
  );

  // Verify stored with custom key
  assertEquals(
    await vaultService.get("test-vault", "generated-api-key"),
    "sk-live-abc123def456",
  );
});
