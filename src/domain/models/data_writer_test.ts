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
import {
  createFileWriterFactory,
  createResourceWriter,
  processSensitiveResourceData,
  sanitizeVaultKey,
} from "./data_writer.ts";
import { ModelType } from "./model_type.ts";
import type { ResourceOutputSpec } from "./model.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { generateDataId } from "../data/data_id.ts";
import { VaultService } from "../vaults/vault_service.ts";

/**
 * Creates a minimal mock UnifiedDataRepository for tag resolution tests.
 */
function createMockRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
  };
}

const modelType = ModelType.create("swamp/test");
const modelId = "test-model-id";

const testResources: Record<string, ResourceOutputSpec> = {
  item: {
    schema: z.object({ value: z.string() }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
};

const testFiles = {
  log: {
    contentType: "text/plain",
    lifetime: "infinite" as const,
    garbageCollection: 10,
  },
};

// --- createResourceWriter tag resolution tests ---

Deno.test("createResourceWriter: definition tags appear on produced data", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined, // tagOverrides
    undefined, // dataOutputOverrides
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createResourceWriter: spec tags override definition tags for same key", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const resourcesWithTags: Record<string, ResourceOutputSpec> = {
    item: {
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { env: "staging" },
    },
  };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    resourcesWithTags,
    undefined,
    undefined,
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "staging");
});

Deno.test("createResourceWriter: runtime tags override definition and spec tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };
  const runtimeTags = { env: "prod" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    undefined,
    definitionTags,
    runtimeTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "prod");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createResourceWriter: tagOverrides (workflow) override definition tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const tagOverrides = { source: "step-output", workflow: "my-wf" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
    undefined,
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["source"], "step-output");
  assertEquals(handle.tags["workflow"], "my-wf");
});

Deno.test("createResourceWriter: full tag resolution chain", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform", scope: "def" };
  const tagOverrides = { source: "step-output", scope: "workflow" };
  const runtimeTags = { env: "prod", runId: "123" };
  const dataOutputOverrides = [{
    specName: "item",
    tags: { scope: "override" },
  }];

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
    dataOutputOverrides,
    definitionTags,
    runtimeTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  // runtime overrides definition
  assertEquals(handle.tags["env"], "prod");
  // definition tag preserved
  assertEquals(handle.tags["team"], "platform");
  // workflow tag overridden by runtime
  assertEquals(handle.tags["source"], "step-output");
  // runtime tag added
  assertEquals(handle.tags["runId"], "123");
  // dataOutputOverrides has highest priority
  assertEquals(handle.tags["scope"], "override");
});

// --- createFileWriterFactory tag resolution tests ---

Deno.test("createFileWriterFactory: definition tags appear on produced data", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    undefined,
    undefined, // callbacks
    definitionTags,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createFileWriterFactory: runtime tags override definition tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const runtimeTags = { env: "prod" };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    undefined,
    undefined,
    definitionTags,
    runtimeTags,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.tags["env"], "prod");
});

Deno.test("createResourceWriter: resolvedVarySuffix modifies instance name", async () => {
  const repo = createMockRepo();
  const dataOutputOverrides = [{
    specName: "item",
    resolvedVarySuffix: "prod",
  }];

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    dataOutputOverrides,
  );

  const handle = await writeResource("item", "result", { value: "hello" });
  assertEquals(handle.name, "result-prod");
});

Deno.test("createResourceWriter: resolvedVarySuffix with multiple dimensions", async () => {
  const repo = createMockRepo();
  const dataOutputOverrides = [{
    specName: "item",
    resolvedVarySuffix: "prod-us-east-1",
  }];

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    dataOutputOverrides,
  );

  const handle = await writeResource("item", "result", { value: "hello" });
  assertEquals(handle.name, "result-prod-us-east-1");
});

Deno.test("createResourceWriter: no resolvedVarySuffix leaves name unchanged", async () => {
  const repo = createMockRepo();
  const dataOutputOverrides = [{
    specName: "item",
    tags: { env: "prod" },
  }];

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    dataOutputOverrides,
  );

  const handle = await writeResource("item", "result", { value: "hello" });
  assertEquals(handle.name, "result");
});

Deno.test("createFileWriterFactory: resolvedVarySuffix modifies instance name", async () => {
  const repo = createMockRepo();
  const dataOutputOverrides = [{
    specName: "log",
    resolvedVarySuffix: "staging",
  }];

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    dataOutputOverrides,
  );

  const writer = createFileWriter("log", "app-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.name, "app-log-staging");
});

Deno.test("createResourceWriter: no definition or runtime tags still works", async () => {
  const repo = createMockRepo();

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["type"], "resource");
  assertEquals(handle.tags["specName"], "item");
});

// --- processSensitiveResourceData tests ---

function createTestVaultService(vaultName = "test-vault"): VaultService {
  const service = new VaultService();
  service.registerVault({ name: vaultName, type: "mock", config: {} });
  return service;
}

Deno.test("processSensitiveResourceData: replaces sensitive field with vault reference", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      name: z.string(),
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = {
    name: "public-value",
    secret: "my-secret-value",
  };

  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertEquals(data.name, "public-value");
  assertStringIncludes(data.secret as string, "vault.get");
  assertStringIncludes(data.secret as string, "'test-vault'");
});

Deno.test("processSensitiveResourceData: stores actual value in vault", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { apiKey: "sk-live-abc123" };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  const vaultKey = `swamp-test-${modelId}-create-apiKey`;
  const storedValue = await vaultService.get("test-vault", vaultKey);
  assertEquals(storedValue, "sk-live-abc123");
});

Deno.test("processSensitiveResourceData: uses single-quoted strings for CEL compatibility", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      token: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { token: "secret-token" };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  const ref = data.token as string;
  assertStringIncludes(ref, "vault.get('test-vault'");
  assertStringIncludes(ref, `'swamp-test-${modelId}-create-token'`);
});

Deno.test("processSensitiveResourceData: handles non-string values with JSON.stringify", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      config: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const configValue = { key1: "value1", key2: 42 };
  const data: Record<string, unknown> = { config: configValue };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  const vaultKey = `swamp-test-${modelId}-create-config`;
  const storedValue = await vaultService.get("test-vault", vaultKey);
  assertEquals(storedValue, JSON.stringify(configValue));
});

Deno.test("processSensitiveResourceData: throws error when no vault configured", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService(); // No vaults registered

  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        "create",
      ),
    Error,
    "no vault is configured",
  );
});

Deno.test("processSensitiveResourceData: sensitiveOutput flag treats all fields as sensitive", async () => {
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
    field1: "value1",
    field2: "value2",
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertStringIncludes(data.field1 as string, "vault.get");
  assertStringIncludes(data.field2 as string, "vault.get");

  const key1 = `swamp-test-${modelId}-create-field1`;
  const key2 = `swamp-test-${modelId}-create-field2`;
  assertEquals(await vaultService.get("test-vault", key1), "value1");
  assertEquals(await vaultService.get("test-vault", key2), "value2");
});

Deno.test("processSensitiveResourceData: uses custom vaultName from field metadata", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({
        sensitive: true,
        vaultName: "special-vault",
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "special-secret" };
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

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertStringIncludes(data.secret as string, "'special-vault'");
});

Deno.test("processSensitiveResourceData: uses custom vaultKey from field metadata", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({
        sensitive: true,
        vaultKey: "my-custom-key",
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { apiKey: "key-value" };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertStringIncludes(data.apiKey as string, "'my-custom-key'");
  assertEquals(
    await vaultService.get("test-vault", "my-custom-key"),
    "key-value",
  );
});

Deno.test("processSensitiveResourceData: skips fields with null/undefined values", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      required: z.string().meta({ sensitive: true }),
      optional: z.string().optional().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { required: "has-value" };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertStringIncludes(data.required as string, "vault.get");
  assertEquals(data.optional, undefined);
});

Deno.test("processSensitiveResourceData: no-op when no sensitive fields", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      name: z.string(),
      count: z.number(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { name: "test", count: 42 };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertEquals(data.name, "test");
  assertEquals(data.count, 42);
});

Deno.test("processSensitiveResourceData: spec vaultName overrides default vault", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    vaultName: "spec-vault",
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "spec-vault", type: "mock", config: {} });
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertStringIncludes(data.secret as string, "'spec-vault'");
});

Deno.test("processSensitiveResourceData: handles nested sensitive fields", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      name: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = {
    credentials: { apiKey: "secret-key-123", region: "us-east-1" },
    name: "my-service",
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  assertEquals(data.name, "my-service");
  const creds = data.credentials as Record<string, unknown>;
  assertEquals(creds.region, "us-east-1");
  assertStringIncludes(creds.apiKey as string, "vault.get");
  assertEquals(data["credentials.apiKey"], undefined);

  const vaultKey = `swamp-test-${modelId}-create-credentials.apiKey`;
  assertEquals(
    await vaultService.get("test-vault", vaultKey),
    "secret-key-123",
  );
});

Deno.test("processSensitiveResourceData: snapshots values before mutation", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  };

  const data: Record<string, unknown> = {
    credentials: { apiKey: "original-secret", region: "us-east-1" },
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
  );

  // Top-level "credentials" should also be a vault ref
  assertStringIncludes(data.credentials as string, "vault.get");

  // The nested apiKey's original value should be stored
  const nestedKey = `swamp-test-${modelId}-create-credentials.apiKey`;
  assertEquals(
    await vaultService.get("test-vault", nestedKey),
    "original-secret",
  );

  // The top-level object stored should contain ORIGINAL values
  const topKey = `swamp-test-${modelId}-create-credentials`;
  const storedObject = JSON.parse(
    await vaultService.get("test-vault", topKey),
  );
  assertEquals(storedObject.apiKey, "original-secret");
  assertEquals(storedObject.region, "us-east-1");
});

// --- sanitizeVaultKey tests ---

Deno.test("sanitizeVaultKey: replaces slashes with dashes", () => {
  assertEquals(sanitizeVaultKey("a/b/c"), "a-b-c");
});

Deno.test("sanitizeVaultKey: removes @ prefix", () => {
  assertEquals(sanitizeVaultKey("@user/aws/ec2"), "user-aws-ec2");
});

Deno.test("sanitizeVaultKey: replaces backslashes", () => {
  assertEquals(sanitizeVaultKey("a\\b\\c"), "a-b-c");
});

Deno.test("sanitizeVaultKey: collapses double dots", () => {
  assertEquals(sanitizeVaultKey("a..b"), "a.b");
});

Deno.test("sanitizeVaultKey: removes null bytes", () => {
  assertEquals(sanitizeVaultKey("a\0b"), "ab");
});

Deno.test("sanitizeVaultKey: handles full namespaced model type path", () => {
  const modelId = "941fe7df-b959-414e-a3a3-df30bbd3796e";
  const raw = `@user/aws/ec2-keypair/${modelId}/create/KeyMaterial`;
  assertEquals(
    sanitizeVaultKey(raw),
    `user-aws-ec2-keypair-${modelId}-create-KeyMaterial`,
  );
});

Deno.test("processSensitiveResourceData: handles namespaced model types (#447)", async () => {
  const namespacedType = ModelType.create("@user/aws/ec2-keypair");
  const id = "941fe7df-b959-414e-a3a3-df30bbd3796e";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      KeyMaterial: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = {
    KeyMaterial: "-----BEGIN RSA PRIVATE KEY-----",
  };

  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    namespacedType,
    id,
    "create",
  );

  // Should not throw — key is sanitized
  const expectedKey = `user-aws-ec2-keypair-${id}-create-KeyMaterial`;
  assertStringIncludes(data.KeyMaterial as string, expectedKey);

  const stored = await vaultService.get("test-vault", expectedKey);
  assertEquals(stored, "-----BEGIN RSA PRIVATE KEY-----");
});
