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
  createResourceReader,
  createResourceWriter,
  processSensitiveResourceData,
  resolveVaultRefsInData,
  sanitizeVaultKey,
} from "./data_writer.ts";
import { ModelType } from "./model_type.ts";
import type { ResourceOutputSpec } from "./model.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
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
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    rename: () => {
      throw new Error("not implemented");
    },
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

Deno.test("createResourceWriter: populates ownerDefinition.workflowRunId from tagOverrides", async () => {
  const repo = createMockRepo();
  const workflowRunId = "6be8c3b8-ff3f-4e23-b998-fd9456d84d0a";
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    workflowRunId,
  };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.metadata.ownerDefinition.workflowRunId, workflowRunId);
  assertEquals(handle.metadata.ownerDefinition.ownerType, "model-method");
  assertEquals(handle.metadata.ownerDefinition.ownerRef, modelId);
});

Deno.test("createResourceWriter: omits ownerDefinition.workflowRunId when not in tagOverrides", async () => {
  const repo = createMockRepo();
  const tagOverrides = { source: "step-output", workflow: "my-wf" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.metadata.ownerDefinition.workflowRunId, undefined);
});

Deno.test("createResourceWriter: populates ownerDefinition.jobName and stepName from tagOverrides", async () => {
  const repo = createMockRepo();
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    job: "my-job",
    step: "my-step",
  };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.metadata.ownerDefinition.jobName, "my-job");
  assertEquals(handle.metadata.ownerDefinition.stepName, "my-step");
  assertEquals(handle.metadata.ownerDefinition.workflowName, "my-wf");
});

Deno.test("createResourceWriter: omits ownerDefinition.jobName when not in tagOverrides", async () => {
  const repo = createMockRepo();
  const tagOverrides = { source: "step-output", workflow: "my-wf" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.metadata.ownerDefinition.jobName, undefined);
});

Deno.test("createFileWriterFactory: populates ownerDefinition.workflowRunId from tagOverrides", async () => {
  const repo = createMockRepo();
  const workflowRunId = "6be8c3b8-ff3f-4e23-b998-fd9456d84d0a";
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    workflowRunId,
  };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    tagOverrides,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.metadata.ownerDefinition.workflowRunId, workflowRunId);
  assertEquals(handle.metadata.ownerDefinition.ownerType, "model-method");
  assertEquals(handle.metadata.ownerDefinition.ownerRef, modelId);
});

Deno.test("createFileWriterFactory: populates ownerDefinition.jobName and stepName from tagOverrides", async () => {
  const repo = createMockRepo();
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    job: "my-job",
    step: "my-step",
  };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    tagOverrides,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.metadata.ownerDefinition.jobName, "my-job");
  assertEquals(handle.metadata.ownerDefinition.stepName, "my-step");
  assertEquals(handle.metadata.ownerDefinition.workflowName, "my-wf");
});

Deno.test("createResourceWriter: rejects reserved data name 'latest'", async () => {
  const repo = createMockRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  await assertRejects(
    () => writeResource("item", "latest", { value: "hello" }),
    Error,
    "reserved for internal use",
  );
});

Deno.test("createResourceWriter: rejects reserved data name case-insensitively", async () => {
  const repo = createMockRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  await assertRejects(
    () => writeResource("item", "LATEST", { value: "hello" }),
    Error,
    "reserved for internal use",
  );
});

Deno.test("createFileWriterFactory: rejects reserved data name 'latest'", () => {
  const repo = createMockRepo();
  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
  );

  try {
    createFileWriter("log", "latest");
    throw new Error("Expected reserved name error");
  } catch (e) {
    assertStringIncludes((e as Error).message, "reserved for internal use");
  }
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

// --- createResourceReader tests ---

Deno.test("createResourceReader: returns parsed JSON for existing data", async () => {
  const data = { name: "test", count: 42 };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
  };

  const readResource = createResourceReader(repo, modelType, modelId);
  const result = await readResource("my-instance");
  assertEquals(result, { name: "test", count: 42 });
});

Deno.test("createResourceReader: returns null for missing data", async () => {
  const repo = createMockRepo();
  const readResource = createResourceReader(repo, modelType, modelId);
  const result = await readResource("nonexistent");
  assertEquals(result, null);
});

Deno.test("createResourceReader: passes version parameter through to getContent", async () => {
  let capturedVersion: number | undefined;
  const data = { value: "versioned" };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: (
      _type: ModelType,
      _modelId: string,
      _dataName: string,
      version?: number,
    ) => {
      capturedVersion = version;
      return Promise.resolve(encoded);
    },
  };

  const readResource = createResourceReader(repo, modelType, modelId);
  await readResource("my-instance", 3);
  assertEquals(capturedVersion, 3);
});

Deno.test("createResourceReader: preserves vault reference strings without VaultService", async () => {
  const data = {
    name: "my-resource",
    secret: "${{ vault.get('my-vault', 'my-key') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
  };

  const readResource = createResourceReader(repo, modelType, modelId);
  const result = await readResource("my-instance");
  assertEquals(result?.secret, "${{ vault.get('my-vault', 'my-key') }}");
});

Deno.test("createResourceReader: resolves vault references when VaultService provided", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "my-key", "resolved-secret");

  const data = {
    name: "my-resource",
    secret: "${{ vault.get('test-vault', 'my-key') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const result = await readResource("my-instance");
  assertEquals(result?.name, "my-resource");
  assertEquals(result?.secret, "resolved-secret");
});

Deno.test("createResourceReader: resolves vault references in nested objects", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "nested-key", "nested-secret");

  const data = {
    config: {
      region: "us-east-1",
      token: "${{ vault.get('test-vault', 'nested-key') }}",
    },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const result = await readResource("my-instance");
  const config = result?.config as Record<string, unknown>;
  assertEquals(config.region, "us-east-1");
  assertEquals(config.token, "nested-secret");
});

Deno.test("createResourceReader: mixed vault and non-vault strings work correctly", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "secret-key", "the-secret");

  const data = {
    name: "plain-string",
    secret: "${{ vault.get('test-vault', 'secret-key') }}",
    count: 42,
    nested: { flag: true },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const result = await readResource("my-instance");
  assertEquals(result?.name, "plain-string");
  assertEquals(result?.secret, "the-secret");
  assertEquals(result?.count, 42);
  assertEquals((result?.nested as Record<string, unknown>).flag, true);
});

Deno.test("createResourceReader: returns null for empty content", async () => {
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(new Uint8Array([])),
  };
  const readResource = createResourceReader(repo, modelType, modelId);
  const result = await readResource("empty-instance");
  assertEquals(result, null);
});

Deno.test("createResourceReader: throws descriptive error for invalid JSON", async () => {
  const repo = {
    ...createMockRepo(),
    getContent: () =>
      Promise.resolve(new TextEncoder().encode("{name: invalid")),
  };
  const readResource = createResourceReader(repo, modelType, modelId);
  const err = await assertRejects(
    () => readResource("bad-instance"),
    Error,
  );
  assertStringIncludes(
    err.message,
    "Failed to parse stored data for instance 'bad-instance'",
  );
});

Deno.test("createResourceReader: throws when stored data is an array", async () => {
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(new TextEncoder().encode("[1, 2, 3]")),
  };
  const readResource = createResourceReader(repo, modelType, modelId);
  const err = await assertRejects(
    () => readResource("array-instance"),
    Error,
  );
  assertStringIncludes(err.message, "is not a JSON object");
});

Deno.test("createResourceReader: throws when stored data is a primitive", async () => {
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(new TextEncoder().encode("42")),
  };
  const readResource = createResourceReader(repo, modelType, modelId);
  const err = await assertRejects(
    () => readResource("primitive-instance"),
    Error,
  );
  assertStringIncludes(err.message, "is not a JSON object");
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

// --- resolveVaultRefsInData tests ---

Deno.test("resolveVaultRefsInData: resolves top-level vault expressions", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");

  const data: Record<string, unknown> = {
    plain: "hello",
    secret: "${{ vault.get('test-vault', 'k1') }}",
  };

  await resolveVaultRefsInData(data, vaultService);
  assertEquals(data.plain, "hello");
  assertEquals(data.secret, "secret-value");
});

Deno.test("resolveVaultRefsInData: resolves nested vault expressions", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "nested", "nested-secret");

  const data: Record<string, unknown> = {
    outer: {
      inner: "${{ vault.get('test-vault', 'nested') }}",
      keep: "unchanged",
    },
  };

  await resolveVaultRefsInData(data, vaultService);
  const outer = data.outer as Record<string, unknown>;
  assertEquals(outer.inner, "nested-secret");
  assertEquals(outer.keep, "unchanged");
});

Deno.test("resolveVaultRefsInData: resolves vault expressions in arrays", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "arr-key", "arr-secret");

  const data: Record<string, unknown> = {
    items: ["plain", "${{ vault.get('test-vault', 'arr-key') }}"],
  };

  await resolveVaultRefsInData(data, vaultService);
  assertEquals(data.items, ["plain", "arr-secret"]);
});

Deno.test("resolveVaultRefsInData: does not modify non-matching strings", async () => {
  const vaultService = createTestVaultService();

  const data: Record<string, unknown> = {
    normal: "just a string",
    partial: "prefix ${{ vault.get('x', 'y') }} suffix",
    number: 42,
    flag: true,
    nothing: null,
  };

  await resolveVaultRefsInData(data, vaultService);
  assertEquals(data.normal, "just a string");
  // Partial match should NOT resolve (regex requires full-string match)
  assertEquals(data.partial, "prefix ${{ vault.get('x', 'y') }} suffix");
  assertEquals(data.number, 42);
  assertEquals(data.flag, true);
  assertEquals(data.nothing, null);
});

Deno.test("resolveVaultRefsInData: registers resolved secrets with redactor", async () => {
  const { SecretRedactor } = await import("../secrets/mod.ts");
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "redact-key", "super-secret");

  const redactor = new SecretRedactor();
  const data: Record<string, unknown> = {
    secret: "${{ vault.get('test-vault', 'redact-key') }}",
  };

  await resolveVaultRefsInData(data, vaultService, redactor);
  assertEquals(data.secret, "super-secret");
  assertEquals(redactor.hasSecrets, true);
  assertEquals(
    redactor.redact("the value is super-secret here"),
    "the value is *** here",
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
