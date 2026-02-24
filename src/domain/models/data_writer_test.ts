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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { ModelData } from "./model_data.ts";
import { ModelResource } from "./model_resource.ts";
import { ModelType } from "./model_type.ts";
import { VaultService } from "../vaults/vault_service.ts";
import {
  processSensitiveFields,
  processSensitiveResourceFields,
} from "./data_writer.ts";

/**
 * Creates a VaultService with a mock vault for testing.
 */
function createMockVaultService(vaultName = "test-vault"): VaultService {
  const service = new VaultService();
  service.registerVault({ name: vaultName, type: "mock", config: {} });
  return service;
}

const testModelType = ModelType.create("test/model");
const testModelId = "test-model-id";
const testMethodName = "create";

Deno.test("processSensitiveFields - replaces sensitive field with vault reference", async () => {
  const schema = z.object({
    name: z.string(),
    secret: z.string().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { name: "public-value", secret: "my-secret-value" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Non-sensitive field unchanged
  assertEquals(data.attributes.name, "public-value");

  // Sensitive field replaced with vault reference
  assertStringIncludes(data.attributes.secret as string, "vault.get");
  assertStringIncludes(data.attributes.secret as string, "'test-vault'");
  assertStringIncludes(data.attributes.secret as string, "'test/model/");
});

Deno.test("processSensitiveFields - stores actual value in vault", async () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { apiKey: "sk-live-abc123" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Verify the actual value was stored in vault
  const vaultKey = `test/model/${testModelId}/${testMethodName}/apiKey`;
  const storedValue = await vaultService.get("test-vault", vaultKey);
  assertEquals(storedValue, "sk-live-abc123");
});

Deno.test("processSensitiveFields - uses quoted strings in vault reference for CEL compatibility", async () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { token: "secret-token" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Verify quoted strings (critical for CEL parsing)
  const ref = data.attributes.token as string;
  assertStringIncludes(ref, "vault.get('test-vault'");
  assertStringIncludes(
    ref,
    `'test/model/${testModelId}/${testMethodName}/token'`,
  );
});

Deno.test("processSensitiveFields - handles non-string values with JSON.stringify", async () => {
  const schema = z.object({
    config: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
  });

  const configValue = { key1: "value1", key2: 42 };
  const data = ModelData.create({
    attributes: { config: configValue },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Verify the value stored is JSON stringified, not "[object Object]"
  const vaultKey = `test/model/${testModelId}/${testMethodName}/config`;
  const storedValue = await vaultService.get("test-vault", vaultKey);
  assertEquals(storedValue, JSON.stringify(configValue));
});

Deno.test("processSensitiveFields - throws error when no vault configured", async () => {
  const schema = z.object({
    secret: z.string().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { secret: "my-secret" },
  });

  const vaultService = new VaultService(); // No vaults registered

  await assertRejects(
    () =>
      processSensitiveFields({
        data,
        schema,
        vaultService,
        modelType: testModelType,
        modelId: testModelId,
        methodName: testMethodName,
      }),
    Error,
    "no vault is configured",
  );
});

Deno.test("processSensitiveFields - sensitiveOutput flag treats all fields as sensitive", async () => {
  const schema = z.object({
    field1: z.string(),
    field2: z.string(),
  });

  const data = ModelData.create({
    attributes: { field1: "value1", field2: "value2" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    sensitiveOutput: true,
    defaultVaultName: "test-vault",
  });

  // Both fields should be vault references
  assertStringIncludes(data.attributes.field1 as string, "vault.get");
  assertStringIncludes(data.attributes.field2 as string, "vault.get");

  // Verify values stored in vault
  const key1 = `test/model/${testModelId}/${testMethodName}/field1`;
  const key2 = `test/model/${testModelId}/${testMethodName}/field2`;
  assertEquals(await vaultService.get("test-vault", key1), "value1");
  assertEquals(await vaultService.get("test-vault", key2), "value2");
});

Deno.test("processSensitiveFields - uses custom vaultName from field metadata", async () => {
  const schema = z.object({
    secret: z.string().meta({ sensitive: true, vaultName: "special-vault" }),
  });

  const data = ModelData.create({
    attributes: { secret: "special-secret" },
  });

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "special-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "default-vault",
  });

  // Should use the field-level vault name, not the default
  assertStringIncludes(data.attributes.secret as string, "'special-vault'");
});

Deno.test("processSensitiveFields - uses custom vaultKey from field metadata", async () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true, vaultKey: "my-custom-key" }),
  });

  const data = ModelData.create({
    attributes: { apiKey: "key-value" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Should use custom vault key
  assertStringIncludes(data.attributes.apiKey as string, "'my-custom-key'");

  // Verify stored with custom key
  assertEquals(
    await vaultService.get("test-vault", "my-custom-key"),
    "key-value",
  );
});

Deno.test("processSensitiveFields - skips fields with null/undefined values", async () => {
  const schema = z.object({
    required: z.string().meta({ sensitive: true }),
    optional: z.string().optional().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { required: "has-value" },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Required field with value should be processed
  assertStringIncludes(data.attributes.required as string, "vault.get");

  // Optional field without value should not appear
  assertEquals(data.attributes.optional, undefined);
});

Deno.test("processSensitiveFields - returns data unchanged when no sensitive fields", async () => {
  const schema = z.object({
    name: z.string(),
    count: z.number(),
  });

  const data = ModelData.create({
    attributes: { name: "test", count: 42 },
  });

  const vaultService = createMockVaultService();
  const result = await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
  });

  // Data should be unchanged
  assertEquals(result.attributes.name, "test");
  assertEquals(result.attributes.count, 42);
});

Deno.test("processSensitiveFields - method vaultName overrides default", async () => {
  const schema = z.object({
    secret: z.string().meta({ sensitive: true }),
  });

  const data = ModelData.create({
    attributes: { secret: "my-secret" },
  });

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "method-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    methodVaultName: "method-vault",
    defaultVaultName: "default-vault",
  });

  assertStringIncludes(data.attributes.secret as string, "'method-vault'");
});

Deno.test("processSensitiveFields - handles nested sensitive fields without spurious keys", async () => {
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      region: z.string(),
    }),
    name: z.string(),
  });

  const data = ModelData.create({
    attributes: {
      credentials: { apiKey: "secret-key-123", region: "us-east-1" },
      name: "my-service",
    },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Non-sensitive field unchanged
  assertEquals(data.attributes.name, "my-service");

  // Nested non-sensitive field unchanged
  const creds = data.attributes.credentials as Record<string, unknown>;
  assertEquals(creds.region, "us-east-1");

  // Nested sensitive field replaced with vault reference
  assertStringIncludes(creds.apiKey as string, "vault.get");

  // No spurious literal dot-key should exist
  assertEquals(data.attributes["credentials.apiKey"], undefined);

  // Verify value stored in vault
  const vaultKey =
    `test/model/${testModelId}/${testMethodName}/credentials.apiKey`;
  const stored = await vaultService.get("test-vault", vaultKey);
  assertEquals(stored, "secret-key-123");

  // Verify serialization is clean (no spurious keys)
  const serialized = data.toData();
  const keys = Object.keys(serialized.attributes);
  assertEquals(keys.sort(), ["credentials", "name"]);
});

Deno.test("processSensitiveFields - snapshots values before mutation (no cross-contamination)", async () => {
  // When sensitiveOutput is true and a schema has nested sensitive fields,
  // both the parent (from sensitiveOutput) and child (from schema) may be processed.
  // The parent should store the ORIGINAL object, not one already containing vault refs.
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      region: z.string(),
    }),
  });

  const data = ModelData.create({
    attributes: {
      credentials: { apiKey: "original-secret", region: "us-east-1" },
    },
  });

  const vaultService = createMockVaultService();
  await processSensitiveFields({
    data,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    sensitiveOutput: true, // This adds "credentials" as a top-level sensitive field
    defaultVaultName: "test-vault",
  });

  // Both the nested field AND the top-level object should be vault refs
  const creds = data.attributes.credentials;
  assertStringIncludes(creds as string, "vault.get");

  // The nested field value stored in vault should be the original secret
  const nestedKey =
    `test/model/${testModelId}/${testMethodName}/credentials.apiKey`;
  assertEquals(
    await vaultService.get("test-vault", nestedKey),
    "original-secret",
  );

  // The top-level object stored in vault should contain the ORIGINAL values
  // (snapshotted before the nested field was replaced)
  const topKey = `test/model/${testModelId}/${testMethodName}/credentials`;
  const storedObject = JSON.parse(
    await vaultService.get("test-vault", topKey),
  );
  assertEquals(storedObject.apiKey, "original-secret");
  assertEquals(storedObject.region, "us-east-1");
});

Deno.test("processSensitiveResourceFields - replaces sensitive field in resource", async () => {
  const schema = z.object({
    instanceId: z.string(),
    privateKey: z.string().meta({ sensitive: true }),
  });

  const resource = ModelResource.create({
    attributes: {
      instanceId: "i-12345",
      privateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    },
  });

  const vaultService = createMockVaultService();
  await processSensitiveResourceFields({
    resource,
    schema,
    vaultService,
    modelType: testModelType,
    modelId: testModelId,
    methodName: testMethodName,
    defaultVaultName: "test-vault",
  });

  // Non-sensitive field unchanged
  assertEquals(resource.attributes.instanceId, "i-12345");

  // Sensitive field replaced with vault reference
  assertStringIncludes(resource.attributes.privateKey as string, "vault.get");
  assertStringIncludes(
    resource.attributes.privateKey as string,
    "'test-vault'",
  );

  // Verify value stored in vault
  const vaultKey = `test/model/${testModelId}/${testMethodName}/privateKey`;
  assertEquals(
    await vaultService.get("test-vault", vaultKey),
    "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  );
});
