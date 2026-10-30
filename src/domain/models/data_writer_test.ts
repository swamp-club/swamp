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

import { join } from "@std/path";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import {
  createFileWriterFactory,
  createResourceDeleter,
  createResourceReader,
  createResourceWriter,
  getSensitiveFieldsForResolution,
  modelRequiresVault,
  parseSensitiveFieldsTag,
  parseStoredVaultReference,
  processSensitiveResourceData,
  readSensitiveFieldJsonPlaces,
  readSensitiveFieldsTag,
  RECORD_KIND_TAG,
  recordSensitiveVaultRefsUnread,
  resolveSensitiveVaultRefs,
  resolveSensitiveVaultRefsLeavingUnread,
  resolveVaultRefsInData,
  sanitizeVaultKey,
  SENSITIVE_FIELD_JSON_TAG,
  SENSITIVE_FIELD_KEYS_TAG,
  SENSITIVE_FIELDS_ALL,
  SENSITIVE_FIELDS_TAG,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
  SensitiveFieldsTagInvalidError,
  sensitiveVaultReferences,
} from "./data_writer.ts";
import { ModelType } from "./model_type.ts";
import type { ResourceOutputSpec } from "./model.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import { sensitiveOutputTargetVaults } from "./sensitive_output_vault.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { SOLO_NAMESPACE } from "../data/namespace.ts";
import { Data } from "../data/data.ts";
import { generateDataId } from "../data/data_id.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { SecretRedactor } from "../secrets/secret_redactor.ts";
import type {
  SecretSink,
  UnreadSensitiveReference,
} from "../secrets/run_sensitive_values.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "../vaults/run_vault_access.ts";
import { ResourceSensitiveFieldsInvalidError } from "../vaults/secret_reference_errors.ts";

/**
 * Creates a minimal mock UnifiedDataRepository for tag resolution tests.
 */
function createMockRepo(): UnifiedDataRepository {
  return {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findAllForType: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    iterateForModel: async function* () {
      yield* [];
    },
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    ensureContentLocal: () => Promise.resolve("current" as const),
    isContentAcceptedSync: () => true,
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({
        version: 1,
        contentPath: "/tmp/mock",
        priorVersions: [],
      }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    findByTaggedName: () => Promise.resolve([]),
    rename: () => {
      throw new Error("not implemented");
    },
    saveDeferred: () =>
      Promise.resolve({
        type: ModelType.create("test"),
        modelId: "",
        dataName: "",
        version: 1,
      }),
    finalizeVersionDeferred: () =>
      Promise.resolve({
        receipt: {
          type: ModelType.create("test"),
          modelId: "",
          dataName: "",
          version: 1,
        },
        size: 0,
        checksum: "",
      }),
    advanceLatestMarkers: () => Promise.resolve(),
    rollbackVersions: () => Promise.resolve(),
  };
}

const modelType = ModelType.create("swamp/test");
const modelId = "test-model-id";

function createMockDataEntity(
  tags: Record<string, string> = {},
): Data {
  return Data.create({
    name: "test",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", ...tags },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test/model:test" },
  });
}

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

Deno.test("createResourceWriter: populates ownerDefinition.workflowId from tagOverrides", async () => {
  const repo = createMockRepo();
  const workflowId = "5e646ae3-17a6-4ada-9a5b-6355a657b088";
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    workflowId,
    workflowRunId: "7e820a5f-518e-4d35-8f9e-60b55bbb15df",
  };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.metadata.ownerDefinition.workflowId, workflowId);
});

Deno.test("createResourceWriter: omits ownerDefinition.workflowId when not in tagOverrides", async () => {
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
  assertEquals(handle.metadata.ownerDefinition.workflowId, undefined);
});

Deno.test("createFileWriterFactory: populates ownerDefinition.workflowId from tagOverrides", async () => {
  const repo = createMockRepo();
  const workflowId = "5e646ae3-17a6-4ada-9a5b-6355a657b088";
  const tagOverrides = {
    source: "step-output",
    workflow: "my-wf",
    workflowId,
    workflowRunId: "7e820a5f-518e-4d35-8f9e-60b55bbb15df",
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
  assertEquals(handle.metadata.ownerDefinition.workflowId, workflowId);
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

Deno.test("createResourceWriter: rejects undefined instance name", async () => {
  const repo = createMockRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  await assertRejects(
    () =>
      writeResource(
        "item",
        undefined as unknown as string,
        { value: "hello" },
      ),
    Error,
    "instance name must be a non-empty string",
  );
});

Deno.test("createResourceWriter: rejects null instance name", async () => {
  const repo = createMockRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  await assertRejects(
    () => writeResource("item", null as unknown as string, { value: "hello" }),
    Error,
    "instance name must be a non-empty string",
  );
});

Deno.test("createResourceWriter: rejects numeric instance name", async () => {
  const repo = createMockRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  await assertRejects(
    () => writeResource("item", 42 as unknown as string, { value: "hello" }),
    Error,
    "instance name must be a non-empty string",
  );
});

Deno.test("createFileWriterFactory: rejects undefined instance name", () => {
  const repo = createMockRepo();
  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
  );

  try {
    createFileWriter("log", undefined as unknown as string);
    throw new Error("Expected validation error");
  } catch (e) {
    assertStringIncludes(
      (e as Error).message,
      "instance name must be a non-empty string",
    );
  }
});

Deno.test("createFileWriterFactory: rejects null instance name", () => {
  const repo = createMockRepo();
  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
  );

  try {
    createFileWriter("log", null as unknown as string);
    throw new Error("Expected validation error");
  } catch (e) {
    assertStringIncludes(
      (e as Error).message,
      "instance name must be a non-empty string",
    );
  }
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
    "creds",
    "main",
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
    "creds",
    "main",
  );

  const vaultKey = `swamp-test-${modelId}-create-creds-main-apiKey`;
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
    "creds",
    "main",
  );

  const ref = data.token as string;
  assertStringIncludes(ref, "vault.get('test-vault'");
  assertStringIncludes(ref, `'swamp-test-${modelId}-create-creds-main-token'`);
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
    "creds",
    "main",
  );

  const vaultKey = `swamp-test-${modelId}-create-creds-main-config`;
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
        "creds",
        "main",
      ),
    Error,
    "no vault is configured",
  );
});

// swamp-club#2422: serve registers the reserved _token-secrets vault
// everywhere. It must not count as a configured vault, or a repo with no user
// vault gets a misleading reserved-vault error instead of the no-vault one.
Deno.test("processSensitiveResourceData: throws no-vault error when only a reserved vault is registered", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "_token-secrets",
    type: "mock",
    config: {},
  });

  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        "create",
        "creds",
        "main",
      ),
    Error,
    "no vault is configured",
  );
  assertEquals(data.secret, "my-secret");
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
    "creds",
    "main",
  );

  assertStringIncludes(data.field1 as string, "vault.get");
  assertStringIncludes(data.field2 as string, "vault.get");

  const key1 = `swamp-test-${modelId}-create-creds-main-field1`;
  const key2 = `swamp-test-${modelId}-create-creds-main-field2`;
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
    "creds",
    "main",
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
    "creds",
    "main",
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
    "creds",
    "main",
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
    "creds",
    "main",
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
    "creds",
    "main",
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
    "creds",
    "main",
  );

  assertEquals(data.name, "my-service");
  const creds = data.credentials as Record<string, unknown>;
  assertEquals(creds.region, "us-east-1");
  assertStringIncludes(creds.apiKey as string, "vault.get");
  assertEquals(data["credentials.apiKey"], undefined);

  const vaultKey = `swamp-test-${modelId}-create-creds-main-credentials.apiKey`;
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
    "creds",
    "main",
  );

  // Top-level "credentials" should also be a vault ref
  assertStringIncludes(data.credentials as string, "vault.get");

  // The nested apiKey's original value should be stored
  const nestedKey =
    `swamp-test-${modelId}-create-creds-main-credentials.apiKey`;
  assertEquals(
    await vaultService.get("test-vault", nestedKey),
    "original-secret",
  );

  // The top-level object stored should contain ORIGINAL values
  const topKey = `swamp-test-${modelId}-create-creds-main-credentials`;
  const storedObject = JSON.parse(
    await vaultService.get("test-vault", topKey),
  );
  assertEquals(storedObject.apiKey, "original-secret");
  assertEquals(storedObject.region, "us-east-1");
});

Deno.test("processSensitiveResourceData: different instance names produce distinct vault keys", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const dataA: Record<string, unknown> = { secret: "AAAA" };
  const dataB: Record<string, unknown> = { secret: "BBBB" };
  const vaultService = createTestVaultService();

  await processSensitiveResourceData(
    dataA,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "instance-a",
  );
  await processSensitiveResourceData(
    dataB,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "instance-b",
  );

  const keyA = `swamp-test-${modelId}-create-creds-instance-a-secret`;
  const keyB = `swamp-test-${modelId}-create-creds-instance-b-secret`;
  assertEquals(await vaultService.get("test-vault", keyA), "AAAA");
  assertEquals(await vaultService.get("test-vault", keyB), "BBBB");
});

Deno.test("processSensitiveResourceData: different spec names produce distinct vault keys", async () => {
  const specA: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const specB: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const dataA: Record<string, unknown> = { apiKey: "key-from-spec-a" };
  const dataB: Record<string, unknown> = { apiKey: "key-from-spec-b" };
  const vaultService = createTestVaultService();

  await processSensitiveResourceData(
    dataA,
    specA,
    vaultService,
    modelType,
    modelId,
    "create",
    "specA",
    "main",
  );
  await processSensitiveResourceData(
    dataB,
    specB,
    vaultService,
    modelType,
    modelId,
    "create",
    "specB",
    "main",
  );

  const keyA = `swamp-test-${modelId}-create-specA-main-apiKey`;
  const keyB = `swamp-test-${modelId}-create-specB-main-apiKey`;
  assertEquals(await vaultService.get("test-vault", keyA), "key-from-spec-a");
  assertEquals(await vaultService.get("test-vault", keyB), "key-from-spec-b");
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
  const mockData = createMockDataEntity({
    [SENSITIVE_FIELDS_TAG]: JSON.stringify(["secret"]),
  });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
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
  const mockData = createMockDataEntity({
    [SENSITIVE_FIELDS_TAG]: JSON.stringify(["config.token"]),
  });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
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
  const mockData = createMockDataEntity({
    [SENSITIVE_FIELDS_TAG]: JSON.stringify(["secret"]),
  });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
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
    "keypair",
    "main",
  );

  // Should not throw — key is sanitized
  const expectedKey =
    `user-aws-ec2-keypair-${id}-create-keypair-main-KeyMaterial`;
  assertStringIncludes(data.KeyMaterial as string, expectedKey);

  const stored = await vaultService.get("test-vault", expectedKey);
  assertEquals(stored, "-----BEGIN RSA PRIVATE KEY-----");
});

// --- modelRequiresVault tests ---

Deno.test("modelRequiresVault: returns false for undefined resources", () => {
  assertEquals(modelRequiresVault(undefined), false);
});

Deno.test("modelRequiresVault: returns false for resources without sensitive fields", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    output: {
      schema: z.object({ name: z.string(), count: z.number() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };
  assertEquals(modelRequiresVault(resources), false);
});

Deno.test("modelRequiresVault: returns true for schema with sensitive metadata", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        endpoint: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };
  assertEquals(modelRequiresVault(resources), true);
});

Deno.test("modelRequiresVault: returns true for sensitiveOutput flag", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    secret: {
      schema: z.object({ data: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
      sensitiveOutput: true,
    },
  };
  assertEquals(modelRequiresVault(resources), true);
});

Deno.test("modelRequiresVault: returns false when no spec is sensitive", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    a: {
      schema: z.object({ x: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    b: {
      schema: z.object({ y: z.number() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };
  assertEquals(modelRequiresVault(resources), false);
});

// --- createResourceWriter defense-in-depth tests ---

Deno.test("createResourceWriter: throws when sensitive fields present but no vaultService", async () => {
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        endpoint: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };

  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    resources,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // no vaultService
    "create",
  );

  await assertRejects(
    () =>
      writeResource("creds", "main", {
        apiKey: "secret-value",
        endpoint: "https://example.com",
      }),
    Error,
    "no vault is configured",
  );
});

Deno.test("createResourceWriter: succeeds for non-sensitive resources without vaultService", async () => {
  const resources: Record<string, ResourceOutputSpec> = {
    output: {
      schema: z.object({ name: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };

  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    resources,
  );

  const handle = await writeResource("output", "main", {
    name: "test",
  });
  assertEquals(handle.name, "main");
});

// --- getHandles deduplication tests ---

Deno.test("createFileWriterFactory: getHandles returns one handle per writeText call", async () => {
  const repo = createMockRepo();
  const { createFileWriter, getHandles } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
  );

  const writer = createFileWriter("log", "test-log");
  await writer.writeText("hello");

  assertEquals(getHandles().length, 1);
});

Deno.test("createFileWriterFactory: getHandles returns one handle per writeAll call", async () => {
  const repo = createMockRepo();
  const { createFileWriter, getHandles } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
  );

  const writer = createFileWriter("log", "test-log");
  await writer.writeAll(new TextEncoder().encode("hello"));

  assertEquals(getHandles().length, 1);
});

Deno.test("createFileWriterFactory: getHandles returns one handle per writeStream call", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    const repo = {
      ...createMockRepo(),
      allocateVersion: () =>
        Promise.resolve({
          version: 1,
          contentPath: tmpFile,
          priorVersions: [],
        }),
    };
    const { createFileWriter, getHandles } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const writer = createFileWriter("log", "test-log");
    await writer.writeStream(stream);

    assertEquals(getHandles().length, 1);
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
});

// --- createResourceDeleter tests ---

Deno.test("createResourceDeleter: delegates to repo.delete with correct arguments", async () => {
  let capturedType: ModelType | undefined;
  let capturedModelId: string | undefined;
  let capturedName: string | undefined;
  const repo = {
    ...createMockRepo(),
    delete: (
      type: ModelType,
      id: string,
      dataName: string,
    ) => {
      capturedType = type;
      capturedModelId = id;
      capturedName = dataName;
      return Promise.resolve();
    },
  };

  const deleteResource = createResourceDeleter(repo, modelType, modelId);
  await deleteResource("stale-data");
  assertEquals(capturedType, modelType);
  assertEquals(capturedModelId, modelId);
  assertEquals(capturedName, "stale-data");
});

Deno.test("createResourceDeleter: propagates repository errors", async () => {
  const repo = {
    ...createMockRepo(),
    delete: () => Promise.reject(new Error("delete failed")),
  };

  const deleteResource = createResourceDeleter(repo, modelType, modelId);
  await assertRejects(
    () => deleteResource("some-data"),
    Error,
    "delete failed",
  );
});

Deno.test("processSensitiveResourceData: uses defaultVaultName when no field or spec vaultName", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService(undefined, "repo-default");
  vaultService.registerVault({
    name: "first-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "repo-default",
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
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'repo-default'");
});

Deno.test("createResourceWriter: definition-level vaultName override routes sensitive fields to specified vault", async () => {
  const repo = createMockRepo();
  const sensitiveResources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        secret: z.string().meta({ sensitive: true }),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "override-vault",
    type: "mock",
    config: {},
  });

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    sensitiveResources,
    undefined, // tagOverrides
    [{ specName: "creds", vaultName: "override-vault" }], // dataOutputOverrides
    undefined, // definitionTags
    undefined, // runtimeTags
    undefined, // definitionName
    vaultService,
    "create", // methodName
  );

  const data = { secret: "my-secret-value" };
  await writeResource("creds", "main", data);

  assertStringIncludes(data.secret as string, "'override-vault'");
});

Deno.test("createResourceWriter: an empty vaultName override is ignored, so sensitive fields go to the spec vault", async () => {
  const repo = createMockRepo();
  const sensitiveResources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        secret: z.string().meta({ sensitive: true }),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
      vaultName: "spec-vault",
    },
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({ name: "spec-vault", type: "mock", config: {} });

  const overrides = [{ specName: "creds", vaultName: "" }];
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    sensitiveResources,
    undefined, // tagOverrides
    overrides, // dataOutputOverrides
    undefined, // definitionTags
    undefined, // runtimeTags
    undefined, // definitionName
    vaultService,
    "create", // methodName
  );

  const data = { secret: "my-secret-value" };
  await writeResource("creds", "main", data);

  assertStringIncludes(data.secret as string, "'spec-vault'");
  // The pre-run prediction resolves the same vault.
  assertEquals(
    sensitiveOutputTargetVaults(sensitiveResources, overrides, vaultService),
    ["spec-vault"],
  );
});

/** The key a stored vault reference names: the one a reader resolves. */
function referencedVaultKey(reference: unknown): string {
  const match = /vault\.get\('[^']+', '([^']+)'\)/.exec(String(reference));
  if (!match) throw new Error(`Not a vault reference: ${String(reference)}`);
  return match[1];
}

const varySensitiveResources: Record<string, ResourceOutputSpec> = {
  creds: {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
      pinned: z.string().meta({ sensitive: true, vaultKey: "pinned-key" })
        .optional(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
};

/**
 * A resource writer for one vary instance. These tests are about the vault
 * key a vary suffix makes, so the writer runs as `os` (linux unless a test
 * says otherwise) rather than the host: on Windows the data-name portability
 * rule (swamp-club#3568), which has tests of its own, refuses some suffixes
 * before any vault key is made.
 */
function varyResourceWriter(
  vaultService: VaultService,
  resolvedVarySuffix?: string,
  os: typeof Deno.build.os = "linux",
) {
  return createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    varySensitiveResources,
    undefined, // tagOverrides
    resolvedVarySuffix === undefined
      ? undefined
      : [{ specName: "creds", resolvedVarySuffix }], // dataOutputOverrides
    undefined, // definitionTags
    undefined, // runtimeTags
    undefined, // definitionName
    vaultService,
    "create", // methodName
    undefined, // onEvent
    undefined, // redactor
    false, // deferred
    os,
  ).writeResource;
}

Deno.test("createResourceWriter: vary instances keep their own secret for a sensitive field (swamp-club#3633)", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });

  const us = { secret: "US-SECRET" };
  const eu = { secret: "EU-SECRET" };
  const usHandle = await varyResourceWriter(vaultService, "us")(
    "creds",
    "creds",
    us,
  );
  const euHandle = await varyResourceWriter(vaultService, "eu")(
    "creds",
    "creds",
    eu,
  );

  assertEquals([usHandle.name, euHandle.name], ["creds-us", "creds-eu"]);
  const usKey = referencedVaultKey(us.secret);
  const euKey = referencedVaultKey(eu.secret);
  assertEquals(
    usKey,
    sanitizeVaultKey(
      `${modelType.normalized}/${modelId}/create/creds/creds-us/secret`,
    ),
  );
  assertEquals(
    euKey,
    sanitizeVaultKey(
      `${modelType.normalized}/${modelId}/create/creds/creds-eu/secret`,
    ),
  );
  // Each record's reference reads back its own instance's value.
  assertEquals(await vaultService.get("v", usKey), "US-SECRET");
  assertEquals(await vaultService.get("v", euKey), "EU-SECRET");
});

Deno.test("createResourceWriter: a multi-dimension vary suffix lands in the generated vault key", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });

  const data = { secret: "s" };
  await varyResourceWriter(vaultService, "prod-us-east-1")(
    "creds",
    "creds",
    data,
  );

  assertEquals(
    referencedVaultKey(data.secret),
    sanitizeVaultKey(
      `${modelType.normalized}/${modelId}/create/creds/creds-prod-us-east-1/secret`,
    ),
  );
});

/** The instance segment a vary write's generated key ends up with. */
async function varyKeySegment(suffix: string): Promise<string> {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });
  const data = { secret: "s" };
  await varyResourceWriter(vaultService, suffix)("creds", "creds", data);
  const prefix = sanitizeVaultKey(
    `${modelType.normalized}/${modelId}/create/creds/creds-`,
  );
  const key = referencedVaultKey(data.secret);
  assert(key.startsWith(prefix) && key.endsWith("-secret"), key);
  return key.slice(prefix.length, -"-secret".length);
}

/** Writes each vary value's own secret, then reads each one back. */
async function assertEachVaryValueReadsItsOwnSecret(
  suffixes: string[],
): Promise<void> {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });
  const written = [];
  for (const suffix of suffixes) {
    const data: Record<string, unknown> = { secret: `secret-for-${suffix}` };
    await varyResourceWriter(vaultService, suffix)("creds", "creds", data);
    written.push({ suffix, data });
  }
  assertEquals(
    new Set(written.map(({ data }) => referencedVaultKey(data.secret))).size,
    suffixes.length,
  );
  for (const { suffix, data } of written) {
    await resolveVaultRefsInData(data, vaultService);
    assertEquals(data.secret, `secret-for-${suffix}`);
  }
}

Deno.test("createResourceWriter: vary values the key sanitizer would fold together keep their own secrets", async () => {
  // A quote would end the key inside its reference, and sanitizeVaultKey
  // drops @.
  await assertEachVaryValueReadsItsOwnSecret(["a'b", "a-b", "x@y", "xy"]);
});

Deno.test("createResourceWriter: a vary suffix outside the verbatim form is hashed to a fixed-length key segment", async () => {
  const hashed = /^h-[0-9a-f]{32}$/;
  for (
    const suffix of [
      "o'brien",
      "x@y",
      "us east",
      '{"region":"us"}',
      // Azure Key Vault names refuse . and _, and ignore case.
      "Prod",
      "ip-10-0-0-1.ec2.internal",
      "v1_2",
      "a".repeat(33),
      // An ARN as coerceToSuffix hands it over, with / already turned to --.
      "arn:aws:iam::123456789012:role--" + "r".repeat(180),
    ]
  ) {
    const segment = await varyKeySegment(suffix);
    assert(hashed.test(segment), `${suffix} -> ${segment}`);
  }
});

Deno.test("createResourceWriter: on windows a vary suffix Windows refuses in a data name stores no secret", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });
  const keysBefore = await vaultService.list("v");

  await assertRejects(
    () =>
      varyResourceWriter(vaultService, '{"region":"us"}', "windows")(
        "creds",
        "creds",
        { secret: "s" },
      ),
    Error,
    `Data name 'creds-{"region":"us"}'`,
  );
  assertEquals(await vaultService.list("v"), keysBefore);
});

Deno.test("createResourceWriter: a short vary suffix of key-safe characters is kept as written", async () => {
  for (
    const suffix of ["us", "prod-us-east-1", "a".repeat(32)]
  ) {
    assertEquals(await varyKeySegment(suffix), suffix);
  }
});

Deno.test("createResourceWriter: vary values that differ only in case keep their own secrets in a case-insensitive vault", async () => {
  // Azure Key Vault, and local_encryption on macOS or Windows, treat keys
  // that differ only in case as one secret.
  const keys = [];
  for (const suffix of ["prod", "Prod", "PROD"]) {
    const vaultService = new VaultService();
    vaultService.registerVault({ name: "v", type: "mock", config: {} });
    const data = { secret: "s" };
    await varyResourceWriter(vaultService, suffix)("creds", "creds", data);
    keys.push(referencedVaultKey(data.secret).toLowerCase());
  }
  assertEquals(new Set(keys).size, 3);
});

Deno.test("createResourceWriter: a vary suffix kept as written is never longer than its hashed form", async () => {
  // A suffix that would be kept at the longest length, and one character over
  // it: keeping the first must not make its key longer than hashing would.
  const kept = await varyKeySegment("k".repeat(32));
  const hashed = await varyKeySegment("k".repeat(33));
  assert(kept.length < hashed.length, `${kept} vs ${hashed}`);
});

Deno.test("createResourceWriter: a long vary value still stores its secret in a file-backed vault", async () => {
  // A local_encryption vault stores each key as a file name, which most
  // filesystems cap at 255 bytes.
  const suffix = "v".repeat(200);
  const segment = await varyKeySegment(suffix);
  assertEquals(segment.length, 34);
  await assertEachVaryValueReadsItsOwnSecret([suffix, "v".repeat(201)]);
});

Deno.test("createResourceWriter: a field's explicit vaultKey is not changed by a vary suffix", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });

  const data = { secret: "s", pinned: "p" };
  await varyResourceWriter(vaultService, "us")("creds", "creds", data);

  assertEquals(referencedVaultKey(data.pinned), "pinned-key");
});

Deno.test("createResourceWriter: without a vary suffix the generated vault key is built from the data name", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });

  const data = { secret: "s" };
  await varyResourceWriter(vaultService)("creds", "creds", data);

  assertEquals(
    referencedVaultKey(data.secret),
    sanitizeVaultKey(
      `${modelType.normalized}/${modelId}/create/creds/creds/secret`,
    ),
  );
});

Deno.test("createResourceWriter: a vary write is decided with the suffixed key it is stored under", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "v", type: "mock", config: {} });
  const decided: (string | undefined)[] = [];

  const data = { secret: "s" };
  await runWithVaultAccess(
    RunVaultAccess.create({
      policy: {
        principal: "user:bot",
        decide: (_vault, _action, secretKey) => {
          decided.push(secretKey);
          return { allowed: true, reason: "granted" };
        },
      },
    }),
    () => varyResourceWriter(vaultService, "us")("creds", "creds", data),
  );

  // The store decides before any put, and the put decides again: both name
  // the key the reference points at.
  const storedKey = referencedVaultKey(data.secret);
  assertStringIncludes(storedKey, "-creds-us-secret");
  assert(decided.length > 0);
  assertEquals(decided.filter((key) => key !== storedKey), []);
});

Deno.test("processSensitiveResourceData: falls back to vaultNames[0] when no default configured", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "alpha-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "beta-vault",
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
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'alpha-vault'");
});

Deno.test("processSensitiveResourceData: throws when target vault name starts with underscore", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({
        sensitive: true,
        vaultName: "_token-secrets",
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { secret: "my-secret" };
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "_token-secrets",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "user-vault",
    type: "mock",
    config: {},
  });

  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        "create",
        "creds",
        "main",
      ),
    Error,
    "reserved for internal use",
  );
});

// --- createResourceWriter attributes tests ---

Deno.test("createResourceWriter: resource handle includes attributes from written data", async () => {
  const repo = createMockRepo();

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  const handle = await writeResource("item", "test-item", {
    value: "hello",
  });
  assertEquals(handle.attributes, { value: "hello" });
});

Deno.test("createResourceWriter: attributes is a shallow copy of the data", async () => {
  const repo = createMockRepo();

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  const data = { value: "hello" };
  const handle = await writeResource("item", "test-item", data);
  data.value = "mutated";
  assertEquals(handle.attributes, { value: "hello" });
});

// --- resolveSensitiveVaultRefs tests ---

Deno.test("resolveSensitiveVaultRefs: resolves only specified field paths", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");

  const data: Record<string, unknown> = {
    sensitive: "${{ vault.get('test-vault', 'k1') }}",
    untrusted: "${{ vault.get('test-vault', 'k1') }}",
    plain: "hello",
  };

  await resolveSensitiveVaultRefs(data, ["sensitive"], vaultService);
  assertEquals(data.sensitive, "secret-value");
  assertEquals(data.untrusted, "${{ vault.get('test-vault', 'k1') }}");
  assertEquals(data.plain, "hello");
});

Deno.test("resolveSensitiveVaultRefs: resolves nested dot-paths", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "nested-secret");

  const data: Record<string, unknown> = {
    config: {
      apiKey: "${{ vault.get('test-vault', 'k1') }}",
      region: "us-east-1",
    },
  };

  await resolveSensitiveVaultRefs(data, ["config.apiKey"], vaultService);
  const config = data.config as Record<string, unknown>;
  assertEquals(config.apiKey, "nested-secret");
  assertEquals(config.region, "us-east-1");
});

Deno.test("resolveSensitiveVaultRefs: star mode resolves all strings", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "s1");
  await vaultService.put("test-vault", "k2", "s2");

  const data: Record<string, unknown> = {
    a: "${{ vault.get('test-vault', 'k1') }}",
    b: "${{ vault.get('test-vault', 'k2') }}",
    c: "plain",
  };

  await resolveSensitiveVaultRefs(data, "*", vaultService);
  assertEquals(data.a, "s1");
  assertEquals(data.b, "s2");
  assertEquals(data.c, "plain");
});

Deno.test("resolveSensitiveVaultRefs: empty paths array resolves nothing", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret");

  const data: Record<string, unknown> = {
    field: "${{ vault.get('test-vault', 'k1') }}",
  };

  await resolveSensitiveVaultRefs(data, [], vaultService);
  assertEquals(data.field, "${{ vault.get('test-vault', 'k1') }}");
});

Deno.test("resolveSensitiveVaultRefs: attacker-controlled text in non-sensitive field stays literal", async () => {
  const vaultService = createTestVaultService("production");
  await vaultService.put("production", "database-password", "p@ssw0rd!");

  const data: Record<string, unknown> = {
    apiKey: "${{ vault.get('production', 'database-password') }}",
    prTitle: "${{ vault.get('production', 'database-password') }}",
    status: "open",
  };

  await resolveSensitiveVaultRefs(data, ["apiKey"], vaultService);
  assertEquals(data.apiKey, "p@ssw0rd!");
  assertEquals(
    data.prTitle,
    "${{ vault.get('production', 'database-password') }}",
  );
  assertEquals(data.status, "open");
});

Deno.test("resolveSensitiveVaultRefs: registers resolved secrets with redactor", async () => {
  const { SecretRedactor } = await import("../secrets/mod.ts");
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "super-secret");

  const redactor = new SecretRedactor();
  const data: Record<string, unknown> = {
    secret: "${{ vault.get('test-vault', 'k1') }}",
  };

  await resolveSensitiveVaultRefs(data, ["secret"], vaultService, redactor);
  assertEquals(data.secret, "super-secret");
  assertEquals(redactor.hasSecrets, true);
  assertEquals(
    redactor.redact("the value is super-secret here"),
    "the value is *** here",
  );
});

// --- parseSensitiveFieldsTag tests ---

Deno.test("parseSensitiveFieldsTag: parses JSON array of paths", () => {
  const tags = { [SENSITIVE_FIELDS_TAG]: '["apiKey","config.token"]' };
  assertEquals(parseSensitiveFieldsTag(tags), ["apiKey", "config.token"]);
});

Deno.test("parseSensitiveFieldsTag: returns star for sensitiveOutput", () => {
  const tags = { [SENSITIVE_FIELDS_TAG]: SENSITIVE_FIELDS_ALL };
  assertEquals(parseSensitiveFieldsTag(tags), "*");
});

Deno.test("parseSensitiveFieldsTag: returns null when tag absent", () => {
  assertEquals(parseSensitiveFieldsTag({}), null);
});

// The lenient contract is the expression-facing accessors' until the
// typed-secrets accessor adapter refuses a malformed tag; readResource refuses
// it today through getSensitiveFieldsForResolution (swamp-club#3530).
Deno.test("parseSensitiveFieldsTag: returns null for invalid JSON", () => {
  const tags = { [SENSITIVE_FIELDS_TAG]: "not-json" };
  assertEquals(parseSensitiveFieldsTag(tags), null);
});

// --- getSensitiveFieldsForResolution tests ---

const fallbackSpecs: Record<string, ResourceOutputSpec> = {
  creds: {
    schema: z.object({
      name: z.string(),
      secret: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
  all: {
    schema: z.object({ secret: z.string() }),
    sensitiveOutput: true,
    lifetime: "infinite",
    garbageCollection: 10,
  },
};

Deno.test("getSensitiveFieldsForResolution: a present tag wins over the schema", () => {
  assertEquals(
    getSensitiveFieldsForResolution(
      { specName: "creds", [SENSITIVE_FIELDS_TAG]: JSON.stringify(["name"]) },
      fallbackSpecs,
      "inst",
    ),
    ["name"],
  );
  assertEquals(
    getSensitiveFieldsForResolution(
      { specName: "creds", [SENSITIVE_FIELDS_TAG]: SENSITIVE_FIELDS_ALL },
      fallbackSpecs,
      "inst",
    ),
    SENSITIVE_FIELDS_ALL,
  );
});

/** Tags of a resource record written before the writers stamped their kind. */
function legacyTags(specName?: string): Record<string, string> {
  return { type: "resource", ...(specName ? { specName } : {}) };
}

Deno.test("getSensitiveFieldsForResolution: an absent tag on a legacy resource record falls back to the spec schema", () => {
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags("creds"), fallbackSpecs, "i"),
    ["secret"],
  );
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags("all"), fallbackSpecs, "i"),
    SENSITIVE_FIELDS_ALL,
  );
});

Deno.test("getSensitiveFieldsForResolution: an absent tag resolves nothing without specs, a spec name, a matching spec or a sensitive field", () => {
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags("creds"), undefined, "i"),
    null,
  );
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags(), fallbackSpecs, "i"),
    null,
  );
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags("other"), fallbackSpecs, "i"),
    null,
  );
  assertEquals(
    getSensitiveFieldsForResolution(legacyTags("item"), testResources, "i"),
    null,
  );
});

Deno.test("getSensitiveFieldsForResolution: a record the writer stamped never falls back to its specName (swamp-club#3684)", () => {
  for (const kind of ["resource", "file"]) {
    for (const specName of ["creds", "all"]) {
      assertEquals(
        getSensitiveFieldsForResolution(
          { ...legacyTags(specName), [RECORD_KIND_TAG]: kind },
          fallbackSpecs,
          "i",
        ),
        null,
        `${kind} ${specName}`,
      );
    }
  }
});

Deno.test("getSensitiveFieldsForResolution: a legacy record that is not a resource does not fall back", () => {
  for (const type of ["file", "", "Resource"]) {
    assertEquals(
      getSensitiveFieldsForResolution(
        { type, specName: "all" },
        fallbackSpecs,
        "i",
      ),
      null,
      type,
    );
  }
  assertEquals(
    getSensitiveFieldsForResolution({ specName: "all" }, fallbackSpecs, "i"),
    null,
  );
});

Deno.test("getSensitiveFieldsForResolution: a stamped record still resolves the fields its sensitive-fields tag names", () => {
  assertEquals(
    getSensitiveFieldsForResolution(
      {
        ...legacyTags("creds"),
        [RECORD_KIND_TAG]: "resource",
        [SENSITIVE_FIELDS_TAG]: JSON.stringify(["secret"]),
      },
      fallbackSpecs,
      "i",
    ),
    ["secret"],
  );
});

Deno.test("getSensitiveFieldsForResolution: a malformed tag fails with secret_reference_invalid, naming the record and the tag key but not the tag", () => {
  for (
    const malformed of ['["secret"', "[1,2]", '{"secret":true}', "null", ""]
  ) {
    const error = assertThrows(
      () =>
        getSensitiveFieldsForResolution(
          { specName: "creds", [SENSITIVE_FIELDS_TAG]: malformed },
          fallbackSpecs,
          "my-instance",
        ),
      ResourceSensitiveFieldsInvalidError,
      "my-instance",
    );
    assertEquals(error.code, "secret_reference_invalid", malformed);
    assertStringIncludes(error.message, SENSITIVE_FIELDS_TAG);
    if (malformed !== "") {
      assert(!error.message.includes(malformed), malformed);
    }
  }
});

// --- createResourceReader: non-sensitive fields NOT resolved ---

Deno.test("createResourceReader: does NOT resolve vault refs in non-sensitive fields", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");

  const data = {
    sensitive: "${{ vault.get('test-vault', 'k1') }}",
    untrusted: "${{ vault.get('test-vault', 'k1') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const mockData = createMockDataEntity({
    [SENSITIVE_FIELDS_TAG]: JSON.stringify(["sensitive"]),
  });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const result = await readResource("my-instance");
  assertEquals(result?.sensitive, "secret-value");
  assertEquals(result?.untrusted, "${{ vault.get('test-vault', 'k1') }}");
});

Deno.test("createResourceReader: legacy data without tag uses schema fallback", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");

  const data = {
    name: "public",
    secret: "${{ vault.get('test-vault', 'k1') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const mockData = createMockDataEntity({ specName: "creds" });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
  };

  const resourceSpecs: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        name: z.string(),
        secret: z.string().meta({ sensitive: true }),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
    undefined,
    resourceSpecs,
  );
  const result = await readResource("my-instance");
  assertEquals(result?.secret, "secret-value");
  assertEquals(result?.name, "public");
});

for (
  const [label, tags] of [
    [
      "an untagged record the resource writer stamped",
      { specName: "creds", [RECORD_KIND_TAG]: "resource" },
    ],
    [
      "a file record under a file spec named like a sensitive resource spec",
      { type: "file", specName: "creds", [RECORD_KIND_TAG]: "file" },
    ],
  ] as const
) {
  Deno.test(`createResourceReader: ${label} resolves nothing (swamp-club#3684)`, async () => {
    const vaultService = createTestVaultService();
    await vaultService.put("test-vault", "k1", "secret-value");
    const data = {
      name: "public",
      secret: "${{ vault.get('test-vault', 'k1') }}",
    };
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const repo = {
      ...createMockRepo(),
      getContent: () => Promise.resolve(encoded),
      findByName: () => Promise.resolve(createMockDataEntity(tags)),
    };

    const readResource = createResourceReader(
      repo,
      modelType,
      modelId,
      vaultService,
      undefined,
      fallbackSpecs,
    );
    assertEquals(await readResource("my-instance"), data);
  });
}

Deno.test("createResourceReader: a malformed tag fails the read before any vault read, even when the spec could resolve the field (swamp-club#3530)", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");
  // Any vault read would reject with its own error, so the tag error proves
  // none was issued.
  (vaultService as { get: VaultService["get"] }).get = () =>
    Promise.reject(new Error("vault read issued"));

  const data = {
    name: "public",
    secret: "${{ vault.get('test-vault', 'k1') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const mockData = createMockDataEntity({
    specName: "creds",
    [SENSITIVE_FIELDS_TAG]: '["secret"',
  });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
    undefined,
    fallbackSpecs,
  );
  const error = await assertRejects(
    () => readResource("my-instance"),
    ResourceSensitiveFieldsInvalidError,
    "my-instance",
  );
  assertEquals(error.code, "secret_reference_invalid");
});

Deno.test("createResourceReader: a malformed tag fails the read without a VaultService too", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ secret: "x" }));
  const mockData = createMockDataEntity({ [SENSITIVE_FIELDS_TAG]: "[1,2]" });
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
  };

  const readResource = createResourceReader(repo, modelType, modelId);
  await assertRejects(
    () => readResource("my-instance"),
    ResourceSensitiveFieldsInvalidError,
    "my-instance",
  );
});

Deno.test("createResourceReader: legacy data without tag or specs skips resolution", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k1", "secret-value");

  const data = {
    secret: "${{ vault.get('test-vault', 'k1') }}",
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const mockData = createMockDataEntity({});
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(mockData),
  };

  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const result = await readResource("my-instance");
  assertEquals(result?.secret, "${{ vault.get('test-vault', 'k1') }}");
});

Deno.test("processSensitiveResourceData: decides every target vault before storing any value", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      allowed: z.string().meta({ sensitive: true, vaultName: "outputs" }),
      refused: z.string().meta({ sensitive: true, vaultName: "erp" }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "outputs", type: "mock", config: {} });
  vaultService.registerVault({ name: "erp", type: "mock", config: {} });
  const outputsBefore = await vaultService.list("outputs");
  const data: Record<string, unknown> = { allowed: "a", refused: "b" };

  await runWithVaultAccess(
    RunVaultAccess.create({
      allowedVaults: ["outputs"],
      allowListSource: "wf",
    }),
    () =>
      assertRejects(
        () =>
          processSensitiveResourceData(
            data,
            spec,
            vaultService,
            modelType,
            modelId,
            "create",
            "creds",
            "main",
          ),
        VaultAccessDeniedError,
        "'erp'",
      ),
  );

  // The allowed field was not stored ahead of the refusal: no orphan.
  assertEquals(await vaultService.list("outputs"), outputsBefore);
  assertEquals(data, { allowed: "a", refused: "b" });
});

Deno.test("processSensitiveResourceData: decides each target with the key the put names, before storing any value", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      pinned: z.string().meta({ sensitive: true, vaultKey: "api-token" }),
      generated: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    vaultName: "outputs",
  };
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "outputs", type: "mock", config: {} });
  const outputsBefore = await vaultService.list("outputs");
  const data: Record<string, unknown> = { pinned: "a", generated: "b" };
  const decided: (string | undefined)[] = [];

  await runWithVaultAccess(
    RunVaultAccess.create({
      policy: {
        principal: "user:bot",
        decide: (_vault, _action, secretKey) => {
          decided.push(secretKey);
          return secretKey?.endsWith("-generated")
            ? { allowed: false, reason: "denied by grant g-key" }
            : { allowed: true, reason: "granted" };
        },
      },
    }),
    () =>
      assertRejects(
        () =>
          processSensitiveResourceData(
            data,
            spec,
            vaultService,
            modelType,
            modelId,
            "create",
            "creds",
            "main",
          ),
        VaultAccessDeniedError,
        "denied by grant g-key",
      ),
  );

  const generatedKey = sanitizeVaultKey(
    `${modelType.normalized}/${modelId}/create/creds/main/generated`,
  );
  assertEquals(decided, ["api-token", generatedKey]);
  // The allowed field was not stored ahead of the refusal: no orphan.
  assertEquals(await vaultService.list("outputs"), outputsBefore);
  assertEquals(data, { pinned: "a", generated: "b" });
});

// --- createResourceWriter persisted redaction tests (swamp-club#3585) ---

/**
 * A mock repository that keeps the last record and content saved, so a reader
 * built on it reads back what the writer persisted.
 */
function createCapturingRepo(): UnifiedDataRepository & {
  persisted: () => string;
} {
  let saved: { data: Data; content: Uint8Array } | null = null;
  return {
    ...createMockRepo(),
    save: (_type, _modelId, data, content) => {
      saved = { data, content };
      return Promise.resolve({ version: 1 });
    },
    findByName: () => Promise.resolve(saved?.data ?? null),
    getContent: () => Promise.resolve(saved?.content ?? null),
    persisted: () => new TextDecoder().decode(saved?.content),
  };
}

/** Writes one resource through a writer whose redactor knows `secrets`. */
async function writeRedacted(
  spec: ResourceOutputSpec,
  instanceName: string,
  data: Record<string, unknown>,
  secrets: string[],
) {
  const repo = createCapturingRepo();
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "test-vault", type: "mock", config: {} });
  const redactor = new SecretRedactor();
  for (const secret of secrets) redactor.addSecret(secret);
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    { r: spec },
    undefined, // tagOverrides
    undefined, // dataOutputOverrides
    undefined, // definitionTags
    undefined, // runtimeTags
    undefined, // definitionName
    vaultService,
    "put",
    undefined, // onEvent
    redactor,
  );
  await writeResource("r", instanceName, data);
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  // Redaction keeps the payload valid JSON (swamp-club#3754); a payload that
  // does not parse reads as undefined, which a test then reports.
  let persisted;
  try {
    persisted = JSON.parse(repo.persisted());
  } catch {
    persisted = undefined;
  }
  return { repo, readResource, persisted };
}

const HOST = "192.0.2.10";
const hostSpec: ResourceOutputSpec = {
  schema: z.object({
    host: z.string(),
    port: z.number(),
    token: z.string().meta({ sensitive: true }),
  }),
  lifetime: "infinite",
  garbageCollection: 5,
};

Deno.test("createResourceWriter: a secret in the instance name does not mask the vault key in a sensitive field's reference", async () => {
  const data = { host: HOST, port: 22, token: "dummy-token" };
  const { readResource, persisted } = await writeRedacted(
    hostSpec,
    `root~${HOST}~22`,
    data,
    [HOST],
  );

  assertEquals(persisted.token, data.token);
  assertStringIncludes(persisted.token, `root~${HOST}~22-token`);
  const read = await readResource(`root~${HOST}~22`);
  assertEquals(read?.token, "dummy-token");
});

Deno.test("createResourceWriter: a non-sensitive field holding a secret is still persisted as ***", async () => {
  const { persisted } = await writeRedacted(
    hostSpec,
    `root~${HOST}~22`,
    { host: HOST, port: 22, token: "dummy-token" },
    [HOST],
  );

  assertEquals(persisted.host, "***");
  assertEquals(persisted.port, 22);
});

Deno.test("createResourceWriter: a nested sensitive field keeps its reference intact", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({ apiKey: z.string().meta({ sensitive: true }) }),
      note: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const data = { credentials: { apiKey: "key-value" }, note: `at ${HOST}` };
  const { readResource, persisted } = await writeRedacted(
    spec,
    `n~${HOST}`,
    data,
    [HOST],
  );

  assertEquals(persisted.credentials.apiKey, data.credentials.apiKey);
  assertEquals(persisted.note, "at ***");
  const read = await readResource(`n~${HOST}`);
  assertEquals(
    (read?.credentials as Record<string, unknown>).apiKey,
    "key-value",
  );
});

Deno.test("createResourceWriter: sensitiveOutput keeps every top-level reference intact", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ a: z.string(), b: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
    sensitiveOutput: true,
  };
  const data = { a: "first", b: HOST };
  const { readResource, persisted } = await writeRedacted(
    spec,
    `n~${HOST}`,
    data,
    [HOST],
  );

  assertEquals(persisted, data);
  assertEquals(await readResource(`n~${HOST}`), { a: "first", b: HOST });
});

Deno.test("createResourceWriter: redaction preserves a dotted own key's reference when the instance name contains a secret", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.record(z.string(), z.string()),
    lifetime: "infinite",
    garbageCollection: 5,
    sensitiveOutput: true,
  };
  const data = { "a.b": "private-value", note: HOST };
  const { readResource, persisted } = await writeRedacted(
    spec,
    `n~${HOST}`,
    data,
    [HOST],
  );
  assertEquals(persisted, data);
  assertStringIncludes(persisted["a.b"], HOST);
  assertEquals(await readResource(`n~${HOST}`), {
    "a.b": "private-value",
    note: HOST,
  });
});

Deno.test("createResourceWriter: an object key containing a secret is still redacted", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ labels: z.record(z.string(), z.string()) }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const { persisted } = await writeRedacted(
    spec,
    "main",
    { labels: { [`for-${HOST}`]: "x" } },
    [HOST],
  );

  assertEquals(persisted, { labels: { "for-***": "x" } });
});

Deno.test("createResourceWriter: redaction cannot merge an unvaulted reference into a sensitive field", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      "***": z.string().meta({ sensitive: true, vaultKey: "stored" }),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  for (const reverse of [false, true]) {
    const fields: Array<[string, string]> = [
      ["***", "benign"],
      ["known-secret", "${{ vault.get('test-vault', 'victim') }}"],
    ];
    await assertRejects(
      () =>
        writeRedacted(
          spec,
          "main",
          Object.fromEntries(reverse ? fields.reverse() : fields),
          ["known-secret"],
        ),
      Error,
      "redaction would merge object property names",
    );
  }
});

Deno.test("createResourceWriter: final serialization must retain the generated sensitive references", async () => {
  await assertRejects(
    () =>
      writeRedacted(
        hostSpec,
        "main",
        { host: HOST, port: 22, token: "sensitive-value" },
        ["token"],
      ),
    Error,
    "serialization or redaction changed the generated vault references",
  );
});

Deno.test("createResourceWriter: rejected redaction preserves the existing resource and its vault value", async () => {
  for (
    const rejection of [
      {
        secret: "known-secret",
        extra: { "***": "a", "known-secret": "b" },
        message: "redaction would merge object property names",
      },
      {
        secret: "token",
        extra: {},
        message:
          "serialization or redaction changed the generated vault references",
      },
    ]
  ) {
    const repo = createCapturingRepo();
    const vault = new VaultService();
    vault.registerVault({ name: "test-vault", type: "mock", config: {} });
    const redactor = new SecretRedactor();
    const { writeResource } = createResourceWriter(
      repo,
      modelType,
      modelId,
      {
        r: {
          schema: z.object({
            token: z.string().meta({ sensitive: true, vaultKey: "stored" }),
          }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vault,
      "put",
      undefined,
      redactor,
    );
    await writeResource("r", "main", { token: "original" });
    const persisted = repo.persisted();
    redactor.addSecret(rejection.secret);
    await assertRejects(
      () =>
        writeResource("r", "main", {
          token: "replacement",
          ...rejection.extra,
        }),
      Error,
      rejection.message,
    );
    assertEquals(repo.persisted(), persisted);
    assertEquals(await vault.get("test-vault", "stored"), "original");
    assertEquals(
      await createResourceReader(repo, modelType, modelId, vault)("main"),
      { token: "original" },
    );
  }
});

Deno.test("createResourceWriter: a number equal to a numeric secret is persisted as the string ***, so the record stays valid JSON and keeps its verified writer tag (swamp-club#3754)", async () => {
  const { repo, persisted } = await writeRedacted(
    hostSpec,
    "main",
    { host: HOST, port: 1234, token: "sensitive-value" },
    ["1234"],
  );
  assertEquals(persisted.port, "***");
  assertEquals(persisted.host, HOST);
  const record = await repo.findByName(modelType, modelId, "main");
  assertExists(record);
  assertEquals(record.tags[SENSITIVE_FIELDS_TAG], '["token"]');
  assertEquals(
    record.tags[SENSITIVE_FIELDS_VERSION_TAG],
    SENSITIVE_FIELDS_VERSION,
  );
});

Deno.test("createResourceWriter: redaction works on the JSON structure, so a number node equal to a numeric secret becomes ***, a larger number holding its digits is kept, and a string or a key holding it is masked as text (swamp-club#3754)", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      pin: z.number(),
      rows: z.number(),
      note: z.string(),
      samples: z.array(z.number()),
      labels: z.record(z.string(), z.string()),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const { repo, persisted } = await writeRedacted(
    spec,
    "main",
    {
      pin: 5432,
      rows: 154321,
      note: "port 5432",
      samples: [5432, 54321, 2.5],
      labels: { "db-5432": "x" },
    },
    ["5432"],
  );
  assertEquals(JSON.parse(repo.persisted()), persisted);
  assertEquals(persisted, {
    pin: "***",
    rows: 154321,
    note: "port ***",
    samples: ["***", 54321, 2.5],
    labels: { "db-***": "x" },
  });
});

Deno.test("createResourceWriter: a secret made only of JSON punctuation masks a value equal to it and leaves the record's structure intact (swamp-club#3798)", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      note: z.string(),
      empty: z.string(),
      nested: z.object({}),
      list: z.array(z.string()),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const { repo } = await writeRedacted(
    spec,
    "main",
    { note: '":"', empty: "", nested: {}, list: ["", '","'] },
    ['":"', '","'],
  );
  assertEquals(JSON.parse(repo.persisted()), {
    note: "***",
    empty: "",
    nested: {},
    list: ["", "***"],
  });
});

Deno.test("createResourceWriter: a secret containing a JSON-escaped character is masked", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const { persisted } = await writeRedacted(
    spec,
    "main",
    { note: 'before pa"ss\\word after' },
    ['pa"ss\\word'],
  );

  assertEquals(persisted.note, "before *** after");
});

Deno.test("createResourceWriter: without registered secrets the content is plain JSON.stringify", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const data = { note: HOST, when: new Date(0), gone: undefined };

  const { repo } = await writeRedacted(spec, "main", data, []);

  assertEquals(repo.persisted(), JSON.stringify(data));
});

Deno.test("createResourceWriter: redaction keeps JSON.stringify serialization of dates and undefined", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const data = { note: HOST, when: new Date(0), gone: undefined };

  const { repo } = await writeRedacted(spec, "main", data, [HOST]);

  assertEquals(
    repo.persisted(),
    JSON.stringify({ note: "***", when: new Date(0) }),
  );
});

Deno.test("createResourceWriter: a sensitive object with a sensitive child writes without throwing", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      creds: z.object({ key: z.string().meta({ sensitive: true }) }).meta({
        sensitive: true,
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const data: Record<string, unknown> = { creds: { key: "key-value" } };

  const { persisted } = await writeRedacted(spec, `n~${HOST}`, data, [HOST]);

  assertEquals(persisted.creds, data.creds);
});

Deno.test("createResourceWriter: a JSON secret written back as an object is not persisted in clear", async () => {
  const jsonSecret = JSON.stringify({ user: "svc", pass: "hunter22" });
  const data = { obj: JSON.parse(jsonSecret), note: "plain", token: "t" };
  const spec: ResourceOutputSpec = {
    schema: z.object({
      obj: z.unknown(),
      note: z.string(),
      token: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };

  const { repo } = await writeRedacted(spec, "main", data, [
    jsonSecret,
    "svc",
  ]);

  const text = repo.persisted();
  assertEquals(text.includes("hunter22"), false);
  assertStringIncludes(text, JSON.stringify(data.token));
});

Deno.test("createResourceWriter: a secret holding an escape sequence written back unescaped is not persisted in clear", async () => {
  const oneLineKey = "-----BEGIN KEY-----\\nMIIEsecretbody\\n-----END KEY-----";
  const spec: ResourceOutputSpec = {
    schema: z.object({ key: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  };

  const { repo } = await writeRedacted(
    spec,
    "main",
    { key: oneLineKey.replace(/\\n/g, "\n") },
    [oneLineKey],
  );

  assertEquals(repo.persisted().includes("MIIEsecretbody"), false);
});

// --- data name portability (swamp-club#3568) ---

/** A mock repository that counts every call that could write data. */
function createCountingRepo(): UnifiedDataRepository & {
  writes: () => number;
  savedNames: () => string[];
} {
  const repo = createMockRepo();
  let writes = 0;
  const savedNames: string[] = [];
  return {
    ...repo,
    save: (type, id, data, content) => {
      writes++;
      savedNames.push(data.name);
      return repo.save(type, id, data, content);
    },
    saveDeferred: (type, id, data, content) => {
      writes++;
      savedNames.push(data.name);
      return repo.saveDeferred(type, id, data, content);
    },
    allocateVersion: (type, id, data, options) => {
      writes++;
      savedNames.push(data.name);
      return repo.allocateVersion(type, id, data, options);
    },
    writes: () => writes,
    savedNames: () => savedNames,
  };
}

function portabilityWarnings(events: MethodExecutionEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "data_name_portability_warning" ? [e.message] : []
  );
}

function resourceWriterOn(
  repo: UnifiedDataRepository,
  os: typeof Deno.build.os,
  events: MethodExecutionEvent[],
  dataOutputOverrides?: Parameters<typeof createResourceWriter>[5],
) {
  return createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    dataOutputOverrides,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (e) => events.push(e),
    undefined,
    false,
    os,
  ).writeResource;
}

function fileWriterOn(
  repo: UnifiedDataRepository,
  os: typeof Deno.build.os,
  events: MethodExecutionEvent[],
  dataOutputOverrides?: Parameters<typeof createFileWriterFactory>[5],
) {
  return createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    dataOutputOverrides,
    { onEvent: (e) => events.push(e) },
    undefined,
    undefined,
    undefined,
    false,
    os,
  ).createFileWriter;
}

for (const os of ["linux", "darwin"] as const) {
  Deno.test(`createResourceWriter: on ${os} a Windows-forbidden name is written unchanged with one warning`, async () => {
    const repo = createCountingRepo();
    const events: MethodExecutionEvent[] = [];
    const writeResource = resourceWriterOn(repo, os, events);

    await writeResource("item", "owner:repo:branches", { value: "a" });
    await writeResource("item", "owner:repo:branches", { value: "b" });

    assertEquals(repo.savedNames(), [
      "owner:repo:branches",
      "owner:repo:branches",
    ]);
    const warnings = portabilityWarnings(events);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "'owner:repo:branches'");
    assertStringIncludes(warnings[0], "contains ':'");
  });

  Deno.test(`createFileWriter: on ${os} a Windows-forbidden name is written unchanged with one warning`, async () => {
    const repo = createCountingRepo();
    const events: MethodExecutionEvent[] = [];
    const createFileWriter = fileWriterOn(repo, os, events);

    await createFileWriter("log", "a?b").writeText("x");
    await createFileWriter("log", "a?b").writeText("y");

    assertEquals(repo.savedNames(), ["a?b", "a?b"]);
    const warnings = portabilityWarnings(events);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "contains '?'");
  });
}

Deno.test("createResourceWriter: on windows a Windows-forbidden name is refused before any write", async () => {
  const repo = createCountingRepo();
  const events: MethodExecutionEvent[] = [];
  const writeResource = resourceWriterOn(repo, "windows", events);

  const error = await assertRejects(() =>
    writeResource("item", "owner:repo:branches", { value: "a" })
  );
  assertStringIncludes(
    (error as Error).message,
    "Data name 'owner:repo:branches'",
  );
  assertStringIncludes((error as Error).message, "contains ':'");
  assertEquals(repo.writes(), 0);
  assertEquals(portabilityWarnings(events), []);
});

Deno.test("createFileWriter: on windows a Windows-forbidden name is refused before any write", () => {
  const repo = createCountingRepo();
  const events: MethodExecutionEvent[] = [];
  const createFileWriter = fileWriterOn(repo, "windows", events);

  assertThrows(
    () => createFileWriter("log", "a|b"),
    Error,
    "contains '|'",
  );
  assertEquals(repo.writes(), 0);
});

Deno.test("createResourceWriter: on windows a reserved device name or trailing dot is written with a warning", async () => {
  const repo = createCountingRepo();
  const events: MethodExecutionEvent[] = [];
  const writeResource = resourceWriterOn(repo, "windows", events);

  await writeResource("item", "CON", { value: "a" });
  await writeResource("item", "trailing.", { value: "a" });

  assertEquals(repo.savedNames(), ["CON", "trailing."]);
  assertEquals(portabilityWarnings(events).length, 2);
});

Deno.test("createResourceWriter: a portable name writes with no warning on every os", async () => {
  for (const os of ["linux", "darwin", "windows"] as const) {
    const repo = createCountingRepo();
    const events: MethodExecutionEvent[] = [];
    const writeResource = resourceWriterOn(repo, os, events);

    await writeResource("item", "owner-repo-branches", { value: "a" });

    assertEquals(repo.savedNames(), ["owner-repo-branches"]);
    assertEquals(portabilityWarnings(events), []);
  }
});

Deno.test("createResourceWriter: the portability check covers the vary suffix", async () => {
  const overrides = [{ specName: "item", resolvedVarySuffix: "us:east" }];

  const events: MethodExecutionEvent[] = [];
  const repo = createCountingRepo();
  await resourceWriterOn(repo, "linux", events, overrides)("item", "plain", {
    value: "a",
  });
  assertEquals(repo.savedNames(), ["plain-us:east"]);
  assertStringIncludes(portabilityWarnings(events)[0], "'plain-us:east'");

  const windowsRepo = createCountingRepo();
  await assertRejects(
    () =>
      resourceWriterOn(windowsRepo, "windows", [], overrides)("item", "plain", {
        value: "a",
      }),
    Error,
    "'plain-us:east'",
  );
  assertEquals(windowsRepo.writes(), 0);
});

Deno.test("createFileWriter: the portability check covers the vary suffix", async () => {
  const overrides = [{ specName: "log", resolvedVarySuffix: "us:east" }];

  const events: MethodExecutionEvent[] = [];
  const repo = createCountingRepo();
  await fileWriterOn(repo, "linux", events, overrides)("log", "plain")
    .writeText("x");
  assertEquals(repo.savedNames(), ["plain-us:east"]);
  assertStringIncludes(portabilityWarnings(events)[0], "'plain-us:east'");

  const windowsRepo = createCountingRepo();
  assertThrows(
    () => fileWriterOn(windowsRepo, "windows", [], overrides)("log", "plain"),
    Error,
    "'plain-us:east'",
  );
  assertEquals(windowsRepo.writes(), 0);
});

// --- Reserved tag refusal (swamp-club#3635) ---

/** A forged sensitive-fields tag value: it would mark `value` sensitive. */
const FORGED_TAG_VALUE = JSON.stringify(["value"]);
const FORGED_TAG = { [SENSITIVE_FIELDS_TAG]: FORGED_TAG_VALUE };

/** A reserved tag key a source forges, and how the refusal explains it. */
interface ForgedTag {
  key: string;
  value: string;
  reason: string;
}

const FORGED_TAGS: ForgedTag[] = [
  {
    key: SENSITIVE_FIELDS_TAG,
    value: FORGED_TAG_VALUE,
    reason: "tag keys starting with '_swamp.' are written by swamp alone",
  },
  {
    key: RECORD_KIND_TAG,
    value: "forged-kind",
    reason: "tag keys starting with '_swamp.' are written by swamp alone",
  },
  // swamp-club#3684: a forged specName pointed an untagged record at a
  // sensitive spec, so readResource resolved reference text in it.
  {
    key: "specName",
    value: "forged-spec",
    reason:
      "swamp writes the 'specName' tag itself to record which spec wrote the data",
  },
];

/** Where a reserved tag enters one write, and how the refusal names it. */
interface ReservedTagSource {
  label: string;
  forged: ForgedTag;
  definitionTags?: Record<string, string>;
  specTags?: Record<string, string>;
  overrideTags?: Record<string, string>;
  tagOverrides?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  dataOutputTags?: Record<string, string>;
  /** Text the refusal must contain, given the write's kind and spec. */
  expected: (kind: "resource" | "file", specName: string) => string[];
}

const RESERVED_TAG_SOURCES: ReservedTagSource[] = FORGED_TAGS.flatMap(
  (forged) => {
    const tag = { [forged.key]: forged.value };
    const sources: Omit<ReservedTagSource, "forged">[] = [
      {
        label: "definition tags",
        definitionTags: tag,
        expected: () => ["from the behavior definition's tags", "Remove it."],
      },
      {
        label: "spec default tags",
        specTags: tag,
        expected: (kind, specName) => [
          `from the default tags of ${kind} spec '${specName}' in behavior type 'swamp/test'`,
          "The behavior type's author must remove it.",
        ],
      },
      {
        label: "method write overrides",
        overrideTags: tag,
        expected: (kind, specName) => [
          `from the write overrides of ${kind} spec '${specName}' in behavior type 'swamp/test'`,
          "The behavior type's author must remove it.",
        ],
      },
      {
        label: "workflow tags",
        tagOverrides: { workflow: "wf", ...tag },
        expected: () => ["from the workflow's tags", "Remove it."],
      },
      {
        label: "runtime tags",
        runtimeTags: tag,
        expected: () => ["from --tag", "Remove it."],
      },
      {
        label: "data output override tags",
        dataOutputTags: tag,
        expected: (_kind, specName) => [
          `from the data output override for spec '${specName}'`,
          "Remove it.",
        ],
      },
    ];
    return sources.map((source) => ({
      ...source,
      label: `${forged.key} in ${source.label}`,
      forged,
    }));
  },
);

function assertReservedTagRefusal(
  error: Error,
  source: ReservedTagSource,
  kind: "resource" | "file",
  specName: string,
): void {
  assertStringIncludes(
    error.message,
    `Tag '${source.forged.key}' `,
  );
  assertStringIncludes(error.message, source.forged.reason);
  for (const text of source.expected(kind, specName)) {
    assertStringIncludes(error.message, text);
  }
  // The value may be sensitive; the refusal never repeats it.
  assertEquals(error.message.includes(source.forged.value), false);
}

for (const source of RESERVED_TAG_SOURCES) {
  Deno.test(`createResourceWriter: refuses a reserved tag from ${source.label} and persists nothing`, async () => {
    const repo = createCountingRepo();
    const vaultService = createTestVaultService();
    const puts: string[] = [];
    const put = vaultService.put.bind(vaultService);
    vaultService.put = (vaultName, key, value, options, caller) => {
      puts.push(key);
      return put(vaultName, key, value, options, caller);
    };
    const resources: Record<string, ResourceOutputSpec> = {
      item: {
        // A sensitive field, so a write that got past the refusal would vault.
        schema: z.object({
          value: z.string(),
          secret: z.string().meta({ sensitive: true }),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
        ...(source.specTags ? { tags: source.specTags } : {}),
      },
    };

    const { writeResource } = createResourceWriter(
      repo,
      modelType,
      modelId,
      resources,
      source.tagOverrides,
      source.dataOutputTags
        ? [{ specName: "item", tags: source.dataOutputTags }]
        : undefined,
      source.definitionTags,
      source.runtimeTags,
      undefined,
      vaultService,
      "create",
    );

    const error = await assertRejects(() =>
      writeResource(
        "item",
        "main",
        { value: "plain", secret: "s3cret" },
        source.overrideTags ? { tags: source.overrideTags } : undefined,
      )
    );
    assertReservedTagRefusal(error as Error, source, "resource", "item");
    assertEquals(repo.writes(), 0);
    assertEquals(puts, []);
  });

  Deno.test(`createFileWriterFactory: refuses a reserved tag from ${source.label} and persists nothing`, () => {
    const repo = createCountingRepo();
    const files = {
      log: {
        ...testFiles.log,
        ...(source.specTags ? { tags: source.specTags } : {}),
      },
    };

    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      files,
      source.tagOverrides,
      source.dataOutputTags
        ? [{ specName: "log", tags: source.dataOutputTags }]
        : undefined,
      undefined,
      source.definitionTags,
      source.runtimeTags,
    );

    const error = assertThrows(() =>
      createFileWriter(
        "log",
        "main",
        source.overrideTags ? { tags: source.overrideTags } : undefined,
      )
    );
    assertReservedTagRefusal(error as Error, source, "file", "log");
    assertEquals(repo.writes(), 0);
  });
}

Deno.test("createResourceWriter: a forged sensitive-fields tag cannot make reference text in a plain field resolve", async () => {
  // swamp-club#3635: the field's value is ordinary method output (an HTTP
  // body, say) that happens to look like a stored vault reference. Before the
  // fix the forged tag was persisted, and createResourceReader resolved the
  // text to the vault's plaintext.
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "db-password", "hunter2");
  const reference = "${{ vault.get('test-vault', 'db-password') }}";
  const repo = createCountingRepo();

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    { workflow: "wf", ...FORGED_TAG },
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "fetch",
  );

  await assertRejects(
    () => writeResource("item", "response", { value: reference }),
    Error,
    `Tag '${SENSITIVE_FIELDS_TAG}' from the workflow's tags is reserved`,
  );
  assertEquals(repo.writes(), 0);
});

Deno.test("createResourceWriter: a forged specName cannot point an untagged record at a sensitive spec", async () => {
  // swamp-club#3684: nothing in `item` is sensitive, so the record carried no
  // sensitive-fields tag, and readResource chose its fields by the specName
  // tag a --tag flag had overwritten with a sensitiveOutput spec's name.
  const repo = createCountingRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    { ...testResources, ...fallbackSpecs },
    undefined,
    undefined,
    undefined,
    { specName: "all" },
    undefined,
    createTestVaultService(),
    "fetch",
  );

  await assertRejects(
    () =>
      writeResource("item", "response", {
        value: "${{ vault.get('test-vault', 'db-password') }}",
      }),
    Error,
    "Tag 'specName' from --tag is reserved",
  );
  assertEquals(repo.writes(), 0);
});

Deno.test("createResourceWriter: stamps the record kind after every tag source", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    testResources,
    { workflow: "wf", type: "workflow-type" },
    [{ specName: "item", tags: { type: "override-type" } }],
    { type: "definition-type" },
    { type: "runtime-type" },
    "my-def",
  );

  const handle = await writeResource("item", "main", { value: "v" });
  assertEquals(handle.tags[RECORD_KIND_TAG], "resource");
  assertEquals(handle.tags["specName"], "item");
  // The plain type tag stays a user tag.
  assertEquals(handle.tags["type"], "override-type");
});

Deno.test("createFileWriterFactory: stamps the record kind after every tag source", async () => {
  const { createFileWriter } = createFileWriterFactory(
    createMockRepo(),
    modelType,
    modelId,
    testFiles,
    { workflow: "wf", type: "workflow-type" },
    [{ specName: "log", tags: { type: "override-type" } }],
    undefined,
    { type: "definition-type" },
    { type: "runtime-type" },
  );

  const handle = await createFileWriter("log", "main").writeText("hello");
  assertEquals(handle.tags[RECORD_KIND_TAG], "file");
  assertEquals(handle.tags["specName"], "log");
  assertEquals(handle.tags["type"], "override-type");
});

Deno.test("createResourceWriter: the writer still sets its own sensitive-fields tag after vaulting", async () => {
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        endpoint: z.string(),
        apiKey: z.string().meta({ sensitive: true }),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  };

  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    resources,
    { workflow: "wf" },
    undefined,
    { env: "dev" },
    { run: "1" },
    undefined,
    createTestVaultService(),
    "create",
  );

  const handle = await writeResource("creds", "main", {
    endpoint: "https://example.com",
    apiKey: "secret-value",
  });
  assertEquals(handle.tags[SENSITIVE_FIELDS_TAG], JSON.stringify(["apiKey"]));
  assertEquals(
    handle.tags[SENSITIVE_FIELDS_VERSION_TAG],
    SENSITIVE_FIELDS_VERSION,
  );
});

Deno.test("createResourceWriter: tag keys that only look reserved are persisted unchanged", async () => {
  const lookalikes = {
    "swamp.sensitiveFields": "a",
    "_swampx": "b",
    "_SWAMP.sensitiveFields": "c",
    "my._swamp.key": "d",
    "SpecName": "e",
    "specNames": "f",
  };

  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    testResources,
    undefined,
    undefined,
    lookalikes,
  );

  const handle = await writeResource("item", "main", { value: "v" });
  for (const [key, value] of Object.entries(lookalikes)) {
    assertEquals(handle.tags[key], value);
  }
  assertEquals(handle.tags[SENSITIVE_FIELDS_TAG], undefined);
});

Deno.test("createResourceWriter: a data output override for another spec is not checked", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    testResources,
    undefined,
    [{ specName: "other", tags: FORGED_TAG }],
  );

  const handle = await writeResource("item", "main", { value: "v" });
  assertEquals(handle.tags[SENSITIVE_FIELDS_TAG], undefined);
});

// --- readSensitiveFieldsTag and parseStoredVaultReference (typed-secrets 3.3) ---

Deno.test("readSensitiveFieldsTag: an absent tag means no sensitive fields, and the star value every top-level field", () => {
  assertEquals(readSensitiveFieldsTag({}), { kind: "none" });
  assertEquals(
    readSensitiveFieldsTag({ [SENSITIVE_FIELDS_TAG]: SENSITIVE_FIELDS_ALL }),
    { kind: "all" },
  );
});

Deno.test("readSensitiveFieldsTag: the writer's list of dot-paths is read as segment lists", () => {
  assertEquals(
    readSensitiveFieldsTag({
      [SENSITIVE_FIELDS_TAG]: JSON.stringify([
        "apiKey",
        "config.token",
        "a.b.c",
      ]),
    }),
    {
      kind: "paths",
      paths: [["apiKey"], ["config", "token"], ["a", "b", "c"]],
    },
  );
  assertEquals(readSensitiveFieldsTag({ [SENSITIVE_FIELDS_TAG]: "[]" }), {
    kind: "paths",
    paths: [],
  });
});

Deno.test("readSensitiveFieldsTag: a tag the writer could not have produced throws, naming the reason and never the tag", () => {
  const cases: Array<[unknown, string]> = [
    ["not-json {", "not JSON"],
    ['"apiKey"', "not a list of path strings"],
    ['{"apiKey": true}', "not a list of path strings"],
    ["[1]", "not a list of path strings"],
    ['["apiKey", null]', "not a list of path strings"],
    ["null", "not a list of path strings"],
    ['[""]', "an empty path"],
    ['["a..b"]', "an empty path segment"],
    ['[".a"]', "an empty path segment"],
    ['["a."]', "an empty path segment"],
    ['["__proto__.x"]', "the unsafe path segment '__proto__'"],
    ['["a.constructor"]', "the unsafe path segment 'constructor'"],
    ['["prototype"]', "the unsafe path segment 'prototype'"],
    [42, "not text"],
    [["apiKey"], "not text"],
  ];
  for (const [raw, reason] of cases) {
    const error = assertThrows(
      () => readSensitiveFieldsTag({ [SENSITIVE_FIELDS_TAG]: raw as string }),
      SensitiveFieldsTagInvalidError,
      reason,
      String(raw),
    );
    assertEquals(error.reason, reason);
    assertEquals(
      error.message,
      `The ${SENSITIVE_FIELDS_TAG} tag is invalid: ${reason}`,
    );
    assertEquals(error.message.includes("apiKey"), false, String(raw));
  }
});

Deno.test("readSensitiveFieldJsonPlaces: the JSON places a path list lists, as segment lists", () => {
  const tags = {
    [SENSITIVE_FIELDS_TAG]: JSON.stringify([
      "spec.services.0.port",
      "spec.services.0.image.token",
    ]),
    [SENSITIVE_FIELD_KEYS_TAG]: JSON.stringify([["env", "eu.west"]]),
    [SENSITIVE_FIELD_JSON_TAG]: JSON.stringify([
      ["spec", "services", 0, "port"],
      ["env", "eu.west"],
      // Listed by neither path tag, so ignored.
      ["spec", "services", 1, "port"],
    ]),
  };
  assertEquals(readSensitiveFieldJsonPlaces(tags), [
    ["spec", "services", "0", "port"],
    ["env", "eu.west"],
  ]);
});

Deno.test("readSensitiveFieldJsonPlaces: nothing without a path list, or from a malformed JSON tag", () => {
  const json = JSON.stringify([["port"]]);
  assertEquals(readSensitiveFieldJsonPlaces({}), []);
  assertEquals(
    readSensitiveFieldJsonPlaces({ [SENSITIVE_FIELD_JSON_TAG]: json }),
    [],
  );
  assertEquals(
    readSensitiveFieldJsonPlaces({
      [SENSITIVE_FIELDS_TAG]: SENSITIVE_FIELDS_ALL,
      [SENSITIVE_FIELD_JSON_TAG]: json,
    }),
    [],
  );
  for (const malformed of ["not-json", '["port"]', "[[]]", '[["a", -1]]']) {
    assertEquals(
      readSensitiveFieldJsonPlaces({
        [SENSITIVE_FIELDS_TAG]: JSON.stringify(["port"]),
        [SENSITIVE_FIELD_JSON_TAG]: malformed,
      }),
      [],
      malformed,
    );
  }
  assertEquals(
    readSensitiveFieldJsonPlaces({
      [SENSITIVE_FIELDS_TAG]: JSON.stringify(["port"]),
      [SENSITIVE_FIELD_JSON_TAG]: json,
    }),
    [["port"]],
  );
});

Deno.test("readSensitiveFieldsTag: unlike parseSensitiveFieldsTag, a malformed tag is never read as absent", () => {
  const tags = { [SENSITIVE_FIELDS_TAG]: "not-json" };
  assertEquals(parseSensitiveFieldsTag(tags), null);
  assertThrows(
    () => readSensitiveFieldsTag(tags),
    SensitiveFieldsTagInvalidError,
  );
});

Deno.test("parseStoredVaultReference: exactly one anchored stored reference, in the writer's spacing or any", () => {
  const reference = {
    vaultName: "my-vault",
    key: "test-model-abc-run-creds-main-apiKey",
  };
  for (
    const text of [
      "${{ vault.get('my-vault', 'test-model-abc-run-creds-main-apiKey') }}",
      "${{vault.get('my-vault','test-model-abc-run-creds-main-apiKey')}}",
      "${{   vault.get(  'my-vault' ,  'test-model-abc-run-creds-main-apiKey'  )   }}",
    ]
  ) {
    assertEquals(parseStoredVaultReference(text), reference, text);
  }
});

Deno.test("parseStoredVaultReference: text that is not one whole stored reference is not a reference", () => {
  for (
    const text of [
      "",
      "plain",
      "prefix ${{ vault.get('v', 'k') }}",
      "${{ vault.get('v', 'k') }} suffix",
      "${{ vault.get('v', 'k') }}${{ vault.get('v', 'k') }}",
      '${{ vault.get("v", "k") }}',
      "${{ vault.get(v, k) }}",
      "${{ vault.get('v') }}",
      "${{ vault.get('', 'k') }}",
      "${{ env.HOME }}",
      "${{ 'x' + vault.get('v', 'k') }}",
      "${{ vault.get('v', 'k') }}\n",
    ]
  ) {
    assertEquals(
      parseStoredVaultReference(text),
      undefined,
      JSON.stringify(text),
    );
  }
});

Deno.test("createResourceWriter: a redactor masking only sentinels serializes text without them as plain JSON.stringify, and masks a sentinel that reaches the data (typed-secrets 3.4)", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const registry = new SecretBagRegistry();
  const sentinel = new VaultSecretBag(registry).addSecret(
    { vaultName: "v", key: "k" },
    "loc",
  );
  const redactor = new SecretRedactor();
  redactor.maskSentinelsOf(registry);
  assertEquals(redactor.hasSecrets, true);
  const write = async (data: Record<string, unknown>) => {
    const repo = createCapturingRepo();
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: {},
    });
    const { writeResource } = createResourceWriter(
      repo,
      modelType,
      modelId,
      { r: spec },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vaultService,
      "put",
      undefined,
      redactor,
    );
    await writeResource("r", "main", data);
    return repo.persisted();
  };
  const plain = { note: "plain", when: new Date(0), gone: undefined };
  assertEquals(await write(plain), JSON.stringify(plain));
  assertEquals(JSON.parse(await write({ note: `x ${sentinel}` })), {
    note: "x ***",
  });
});

Deno.test("sensitiveVaultReferences: names the whole-string reference at each listed path and nothing nested below or elsewhere (swamp-club#3529)", () => {
  const data = {
    password: "${{ vault.get('v', 'a') }}",
    creds: {
      key: "${{ vault.get('v', 'b') }}",
      list: ["${{ vault.get('v', 'c') }}", "plain"],
    },
    untrusted: "${{ vault.get('v', 'd') }}",
    note: "n",
  };
  // The writer vaults the whole value at a listed path, so a reference
  // nested below one is not the writer's and is not named.
  assertEquals(
    sensitiveVaultReferences(data, ["password", "creds", "missing"]),
    [{ vaultName: "v", key: "a" }],
  );
  assertEquals(sensitiveVaultReferences(data, ["creds.key"]), [
    { vaultName: "v", key: "b" },
  ]);
  assertEquals(sensitiveVaultReferences(data, ["note", "creds.list"]), []);
});

Deno.test("sensitiveVaultReferences: the star tag names each top-level key's whole-string reference by its own name, once; no tag names none", () => {
  const data = {
    a: "${{ vault.get('v', 'a') }}",
    // A dotted key is a top-level key of its own under the star tag.
    "b.c": "${{ vault.get('w', 'a') }}",
    repeat: "${{ vault.get('v', 'a') }}",
    // Nested below a top-level key: not where the writer puts a reference.
    nested: { d: "${{ vault.get('v', 'nested') }}" },
    // Not a whole-string reference, so not one the resolver resolves.
    e: "text ${{ vault.get('v', 'x') }}",
  };
  assertEquals(sensitiveVaultReferences(data, SENSITIVE_FIELDS_ALL), [
    { vaultName: "v", key: "a" },
    { vaultName: "w", key: "a" },
  ]);
  assertEquals(sensitiveVaultReferences(data, null), []);
  assertEquals(sensitiveVaultReferences(data, []), []);
});

Deno.test("processSensitiveResourceData: under sensitiveOutput a top-level key holding a dot is vaulted by its own name, not read as a nested path (swamp-club#3529)", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({ note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  };
  const crafted = "${{ vault.get('other', 'target') }}";
  const data: Record<string, unknown> = { note: "n", "a.b": crafted };
  const vaultService = createTestVaultService();
  const vaulted = await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "all",
    "main",
  );
  // The dotted own key is named by its keys, never as a dot path.
  assertEquals(vaulted.paths, ["note", ["a.b"]]);
  assertEquals(Object.keys(data).sort(), ["a.b", "note"]);
  // The crafted text is a value the vault holds, behind a reference the
  // writer made; the key is never written as a nested path.
  const stored = data["a.b"] as string;
  assertEquals(stored === crafted, false);
  assertStringIncludes(stored, "vault.get('test-vault'");
  // Under the star tag the dotted key is a location of its own.
  const [, dotted] = sensitiveVaultReferences(data, SENSITIVE_FIELDS_ALL);
  assertEquals(sensitiveVaultReferences({ x: stored }, ["x"]), [dotted]);
  assertEquals(await vaultService.get("test-vault", dotted.key), crafted);
});

Deno.test("processSensitiveResourceData: a dotted own key does not take a nested field's custom vault key", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      a: z.object({
        b: z.string().meta({ sensitive: true, vaultKey: "nested-key" }),
      }),
      "a.b": z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
    sensitiveOutput: true,
  };
  const data: Record<string, unknown> = { a: { b: "nested" }, "a.b": "own" };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "all",
    "main",
  );
  assertEquals(await vaultService.get("test-vault", "nested-key"), "nested");
  const ref = parseStoredVaultReference(data["a.b"] as string)!;
  assertEquals(await vaultService.get(ref.vaultName, ref.key), "own");
});

Deno.test("processSensitiveResourceData: duplicate target keys are refused before any secret is overwritten", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "shared", "original");
  const spec: ResourceOutputSpec = {
    schema: z.object({
      first: z.string().meta({ sensitive: true, vaultKey: "shared" }),
      second: z.string().meta({ sensitive: true, vaultKey: "shared" }),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  };
  const data = { first: "first", second: "second" };
  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        "run",
        "all",
        "main",
      ),
    Error,
    "target the same vault key",
  );
  assertEquals(await vaultService.get("test-vault", "shared"), "original");
  assertEquals(data, { first: "first", second: "second" });
});

Deno.test("createResourceWriter: a caller cannot forge the sensitive-field writer version", async () => {
  const repo = createCountingRepo();
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    { [SENSITIVE_FIELDS_VERSION_TAG]: SENSITIVE_FIELDS_VERSION },
  );
  await assertRejects(
    () => writeResource("item", "main", { value: "v" }),
    Error,
    `Tag '${SENSITIVE_FIELDS_VERSION_TAG}' from the workflow's tags is reserved`,
  );
  assertEquals(repo.writes(), 0);
});

Deno.test("createFileWriterFactory.getUnfinalizedReceipts: names a writer whose path getFilePath handed out and that was never finalised, and no other (swamp-club#3736)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-unfinalized-" });
  try {
    let version = 0;
    const repo: UnifiedDataRepository = {
      ...createMockRepo(),
      allocateVersion: () => {
        version++;
        return Promise.resolve({
          version,
          contentPath: join(dir, `${version}-raw`),
          priorVersions: [],
        });
      },
    };
    const factory = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    const [spec] = Object.keys(testFiles);
    const unfinished = factory.createFileWriter(spec, "unfinished");
    await unfinished.getFilePath();
    const finished = factory.createFileWriter(spec, "finished");
    await finished.getFilePath();
    await finished.finalize();
    // A line writer's partial content keeps its behaviour on failure.
    const lines = factory.createFileWriter(spec, "lines");
    await lines.writeLine("first");
    factory.createFileWriter(spec, "unused");
    assertEquals(
      factory.getUnfinalizedReceipts().map((r) => [r.dataName, r.version]),
      [["unfinished", 1]],
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// --- unreadable sensitive references (swamp-club#3806) ---

/** A sink that keeps what it is given. */
function recordingSink(): SecretSink & {
  secrets: string[];
  unread: UnreadSensitiveReference[];
} {
  const secrets: string[] = [];
  const unread: UnreadSensitiveReference[] = [];
  return {
    secrets,
    unread,
    addSecret: (value) => secrets.push(value),
    recordUnread: (reference) => unread.push(reference),
  };
}

Deno.test("resolveSensitiveVaultRefsLeavingUnread: a failing read is recorded and the other fields are still read", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "present", "secret-value");
  const missing = "${{ vault.get('test-vault', 'missing') }}";
  const data: Record<string, unknown> = {
    first: missing,
    second: "${{ vault.get('test-vault', 'present') }}",
  };
  const sink = recordingSink();

  await resolveSensitiveVaultRefsLeavingUnread(
    data,
    ["first", "second"],
    vaultService,
    sink,
  );

  assertEquals(data.first, missing);
  assertEquals(data.second, "secret-value");
  assertEquals(sink.secrets, ["secret-value"]);
  assertEquals(sink.unread.length, 1);
  const [reference] = sink.unread;
  assertEquals(reference.text, missing);
  assertEquals(reference.vaultName, "test-vault");
  assertEquals(reference.key, "missing");
  assertEquals(reference.fieldPath, "first");
  assertStringIncludes(reference.reason, "missing");
});

Deno.test("resolveSensitiveVaultRefsLeavingUnread: the * tag records a failing own key, dotted or not", async () => {
  const vaultService = createTestVaultService();
  const missing = "${{ vault.get('test-vault', 'missing') }}";
  const data: Record<string, unknown> = { "a.b": missing, nested: [missing] };
  const sink = recordingSink();

  await resolveSensitiveVaultRefsLeavingUnread(
    data,
    SENSITIVE_FIELDS_ALL,
    vaultService,
    sink,
  );

  assertEquals(data, { "a.b": missing, nested: [missing] });
  assertEquals(sink.unread.map((r) => r.fieldPath), ["a.b", "nested.0"]);
});

Deno.test("resolveSensitiveVaultRefsLeavingUnread: a refusal by the run's vault access is rethrown, not recorded", async () => {
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "erp", type: "mock", config: {} });
  await vaultService.put("erp", "k", "secret-value");
  const sink = recordingSink();

  await runWithVaultAccess(
    RunVaultAccess.create({ allowedVaults: ["other"], allowListSource: "wf" }),
    () =>
      assertRejects(
        () =>
          resolveSensitiveVaultRefsLeavingUnread(
            { secret: "${{ vault.get('erp', 'k') }}" },
            ["secret"],
            vaultService,
            sink,
          ),
        VaultAccessDeniedError,
      ),
  );
  assertEquals(sink.unread, []);
});

Deno.test("resolveSensitiveVaultRefs: a failing read throws, for readResource", async () => {
  const vaultService = createTestVaultService();
  const sink = recordingSink();
  await assertRejects(() =>
    resolveSensitiveVaultRefs(
      { secret: "${{ vault.get('test-vault', 'missing') }}" },
      ["secret"],
      vaultService,
      sink,
    )
  );
  assertEquals(sink.unread, []);
});

Deno.test("resolveVaultRefsInData: a failing read still throws", async () => {
  const vaultService = createTestVaultService();
  await assertRejects(() =>
    resolveVaultRefsInData(
      { secret: "${{ vault.get('test-vault', 'missing') }}" },
      vaultService,
    )
  );
});

Deno.test("recordSensitiveVaultRefsUnread: records every tagged reference with the error and leaves them as stored", async () => {
  const first = "${{ vault.get('a', 'k1') }}";
  const second = "${{ vault.get('b', 'k2') }}";
  const data: Record<string, unknown> = {
    first,
    nested: { second },
    plain: "hello",
  };
  const sink = recordingSink();

  await recordSensitiveVaultRefsUnread(
    data,
    ["first", "nested.second", "plain"],
    new Error("vault config unreadable"),
    sink,
  );

  assertEquals(data, { first, nested: { second }, plain: "hello" });
  assertEquals(
    sink.unread.map((r) => [r.vaultName, r.key, r.fieldPath, r.reason]),
    [
      ["a", "k1", "first", "vault config unreadable"],
      ["b", "k2", "nested.second", "vault config unreadable"],
    ],
  );
});

// --- sensitive fields inside arrays, records and unions (swamp-club#3038) ---

const elementSpec: ResourceOutputSpec = {
  schema: z.object({
    name: z.string(),
    services: z.array(z.object({
      image: z.object({
        creds: z.string().meta({ sensitive: true }),
        tag: z.string(),
      }),
    })),
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
    auth: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("password"),
        password: z.string().meta({ sensitive: true }),
      }),
      z.object({ kind: z.literal("none") }),
    ]),
  }),
  lifetime: "infinite",
  garbageCollection: 10,
};

function elementData(): Record<string, unknown> {
  return {
    name: "app",
    services: [
      { image: { creds: "creds-zero", tag: "v1" } },
      { image: { creds: "creds-one", tag: "v2" } },
    ],
    accounts: {
      prod: { token: "token-prod" },
      "eu.west": { token: "token-eu" },
    },
    auth: { kind: "password", password: "pw-value" },
  };
}

const elementKeyPrefix = `swamp-test-${modelId}-create-creds-main`;

/** The keys a test stored, without the ones the mock vault starts with. */
async function storedKeys(vaultService: VaultService): Promise<string[]> {
  const seeded = new Set(await createTestVaultService().list("test-vault"));
  return (await vaultService.list("test-vault")).filter((k) => !seeded.has(k));
}

Deno.test("processSensitiveResourceData: vaults fields inside array elements, record values and union members", async () => {
  const data = elementData();
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    elementSpec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  const stored = JSON.stringify(data);
  for (
    const secret of [
      "creds-zero",
      "creds-one",
      "token-prod",
      "token-eu",
      "pw-value",
    ]
  ) {
    assertEquals(stored.includes(secret), false, secret);
  }
  const services = data.services as { image: Record<string, unknown> }[];
  assertEquals(services[0].image.tag, "v1");
  assertEquals(
    services[0].image.creds,
    `\${{ vault.get('test-vault', '${elementKeyPrefix}-services.0.image.creds') }}`,
  );
  assertEquals(
    await vaultService.get(
      "test-vault",
      `${elementKeyPrefix}-services.1.image.creds`,
    ),
    "creds-one",
  );
  assertEquals(
    await vaultService.get(
      "test-vault",
      `${elementKeyPrefix}-accounts.prod.token`,
    ),
    "token-prod",
  );
  // A field in a union member sits once per object, so its key is unchanged.
  assertEquals(
    await vaultService.get("test-vault", `${elementKeyPrefix}-auth.password`),
    "pw-value",
  );
});

Deno.test("processSensitiveResourceData: returns dot paths, and key lists for keys holding a dot", async () => {
  const data = elementData();
  const { paths } = await processSensitiveResourceData(
    data,
    elementSpec,
    createTestVaultService(),
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  assertEquals(paths, [
    "services.0.image.creds",
    "services.1.image.creds",
    "accounts.prod.token",
    ["accounts", "eu.west", "token"],
    "auth.password",
  ]);
});

Deno.test("processSensitiveResourceData: a record key outside plain characters gets a safe, distinct vault key", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      accounts: z.record(
        z.string(),
        z.object({ token: z.string().meta({ sensitive: true }) }),
      ),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    accounts: {
      "a'b/c\\..d": { token: "first" },
      "a-b-c-d": { token: "second" },
      "": { token: "third" },
    },
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  const keys = await storedKeys(vaultService);
  assertEquals(keys.length, 3);
  for (const key of keys) {
    assertEquals(/['"/\\\0]|\.\./.test(key), false, key);
  }
  const accounts = data.accounts as Record<string, Record<string, string>>;
  // Each reference is one the readers match, and names its own value.
  const refPattern = /^\$\{\{ vault\.get\('test-vault', '([^']+)'\) \}\}$/;
  const resolved = await Promise.all(
    Object.values(accounts).map((account) => {
      const match = refPattern.exec(account.token);
      return vaultService.get("test-vault", match![1]);
    }),
  );
  assertEquals(resolved, ["first", "second", "third"]);
});

Deno.test("processSensitiveResourceData: an element key stays the same from write to write", async () => {
  const keysOf = async () => {
    const vaultService = createTestVaultService();
    await processSensitiveResourceData(
      elementData(),
      elementSpec,
      vaultService,
      modelType,
      modelId,
      "create",
      "creds",
      "main",
    );
    return (await storedKeys(vaultService)).sort();
  };
  assertEquals(await keysOf(), await keysOf());
});

Deno.test("processSensitiveResourceData: a declared vaultKey on an array field gets one key per element", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      users: z.array(z.object({
        password: z.string().meta({ sensitive: true, vaultKey: "user-pw" }),
      })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    users: [{ password: "alpha" }, { password: "beta" }],
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  assertEquals(
    await vaultService.get("test-vault", "user-pw.users.0.password"),
    "alpha",
  );
  assertEquals(
    await vaultService.get("test-vault", "user-pw.users.1.password"),
    "beta",
  );
});

Deno.test("processSensitiveResourceData: refuses before storing when an element value would share a key with another field", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      other: z.string().meta({
        sensitive: true,
        vaultKey: "k.list.0.token",
      }),
      list: z.array(z.object({
        token: z.string().meta({ sensitive: true, vaultKey: "k" }),
      })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    other: "one",
    list: [{ token: "two" }],
  };
  const vaultService = createTestVaultService();
  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        "create",
        "creds",
        "main",
      ),
    Error,
    "Sensitive fields 'other' and 'list[0].token' target the same vault key in 'test-vault'",
  );
  assertEquals(await storedKeys(vaultService), []);
  assertEquals(data.other, "one");
});

Deno.test("processSensitiveResourceData: a sensitive container holding a sensitive field is stored whole, and the data holds an object of the field's reference, as before swamp-club#3038", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }).meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    credentials: { apiKey: "key-value", region: "us-east-1" },
  };
  const vaultService = createTestVaultService();
  const { paths, jsonKeys } = await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  assertEquals(paths, ["credentials", "credentials.apiKey"]);
  assertEquals(jsonKeys, []);
  // The unmarked field is held only in the container's vault value.
  assertEquals(data.credentials, {
    apiKey:
      `\${{ vault.get('test-vault', '${elementKeyPrefix}-credentials.apiKey') }}`,
  });
  assertEquals(
    JSON.parse(
      await vaultService.get("test-vault", `${elementKeyPrefix}-credentials`),
    ),
    { apiKey: "key-value", region: "us-east-1" },
  );
  assertEquals(
    await vaultService.get(
      "test-vault",
      `${elementKeyPrefix}-credentials.apiKey`,
    ),
    "key-value",
  );
});

Deno.test("processSensitiveResourceData: a declared vaultKey inside a sensitiveOutput spec is still written", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      creds: z.object({
        apiKey: z.string().meta({ sensitive: true, vaultKey: "prod-api-key" }),
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  };
  const data: Record<string, unknown> = { creds: { apiKey: "rotated" } };
  const vaultService = createTestVaultService();
  const { paths } = await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  assertEquals(await vaultService.get("test-vault", "prod-api-key"), "rotated");
  // The data holds the reference to the whole value, not a nested one.
  assertEquals(
    data.creds,
    `\${{ vault.get('test-vault', '${elementKeyPrefix}-creds') }}`,
  );
  assertEquals(paths, ["creds.apiKey", "creds"]);
});

Deno.test("processSensitiveResourceData: an element value inside a stored container is not stored again", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      creds: z.object({
        keys: z.array(z.string().meta({ sensitive: true })),
      }).meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    { creds: { keys: ["a", "b"] } },
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  assertEquals(await storedKeys(vaultService), [`${elementKeyPrefix}-creds`]);
});

Deno.test("processSensitiveResourceData: a long element key is cut and ends in a hash of the whole", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      items: z.record(
        z.string(),
        z.string().meta({ sensitive: true, vaultKey: "declared" }),
      ),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const long = (c: string) => c.repeat(300);
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    { items: { [long("a") + "x"]: "first", [long("a") + "y"]: "second" } },
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  const keys = await storedKeys(vaultService);
  assertEquals(keys.length, 2);
  for (const key of keys) {
    assertEquals(key.length, 200, key);
    assertEquals(key.startsWith("declared.items."), true, key);
  }
});

Deno.test("processSensitiveResourceData: a long element path keeps a valid key", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      a: z.array(z.array(z.array(z.object({
        deeply_nested_field_name: z.record(
          z.string(),
          z.string().meta({ sensitive: true }),
        ),
      })))),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    a: [[[{ deeply_nested_field_name: { ["k.".repeat(40)]: "deep" } }]]],
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  const [key] = await storedKeys(vaultService);
  assertEquals(/['"/\\\0]|\.\./.test(key), false, key);
  assertEquals(await vaultService.get("test-vault", key), "deep");
});

Deno.test("processSensitiveResourceData: no-vault error names element paths", async () => {
  const data = elementData();
  await assertRejects(
    () =>
      processSensitiveResourceData(
        data,
        elementSpec,
        new VaultService(),
        modelType,
        modelId,
        "create",
        "creds",
        "main",
      ),
    Error,
    "'services[0].image.creds'",
  );
});

Deno.test("modelRequiresVault: true for a spec whose only sensitive field sits in an array", () => {
  assertEquals(
    modelRequiresVault({
      r: {
        schema: z.object({
          list: z.array(z.object({
            apiKey: z.string().meta({ sensitive: true }),
          })),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    }),
    true,
  );
});

Deno.test("createResourceWriter: throws for an array-only sensitive spec with no vaultService", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: elementSpec },
  );
  await assertRejects(
    () => writeResource("creds", "main", elementData()),
    Error,
    "no vault is configured",
  );
});

Deno.test("createResourceWriter: records element dot paths and the key-list tag", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: elementSpec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createTestVaultService(),
    "create",
  );
  const handle = await writeResource("creds", "main", elementData());
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELDS_TAG]), [
    "services.0.image.creds",
    "services.1.image.creds",
    "accounts.prod.token",
    "auth.password",
  ]);
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELD_KEYS_TAG]), [
    ["accounts", "eu.west", "token"],
  ]);
});

Deno.test("createResourceWriter: object-nested sensitive fields write no key-list tag", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    {
      creds: {
        schema: z.object({
          credentials: z.object({
            apiKey: z.string().meta({ sensitive: true }),
          }),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createTestVaultService(),
    "create",
  );
  const handle = await writeResource("creds", "main", {
    credentials: { apiKey: "k" },
  });
  assertEquals(handle.tags[SENSITIVE_FIELDS_TAG], '["credentials.apiKey"]');
  assertEquals(handle.tags[SENSITIVE_FIELD_KEYS_TAG], undefined);
});

Deno.test("resolveSensitiveVaultRefs: resolves element dot paths and key lists, and leaves untagged references", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k0", "zero");
  await vaultService.put("test-vault", "ke", "eu");
  await vaultService.put("test-vault", "planted", "should-not-resolve");
  const ref = (key: string) => `\${{ vault.get('test-vault', '${key}') }}`;
  const data: Record<string, unknown> = {
    services: [{ image: { creds: ref("k0") } }, { note: ref("planted") }],
    accounts: {
      "eu.west": { token: ref("ke") },
      // Where a dot split of accounts.eu.west.token would land.
      eu: { west: { token: ref("planted") } },
    },
  };
  await resolveSensitiveVaultRefs(
    data,
    ["services.0.image.creds", ["accounts", "eu.west", "token"]],
    vaultService,
  );
  const services = data.services as Record<string, Record<string, unknown>>[];
  const note = (services[1] as Record<string, unknown>).note;
  assertEquals(services[0].image.creds, "zero");
  assertEquals(note, ref("planted"));
  const accounts = data.accounts as Record<string, Record<string, unknown>>;
  assertEquals(accounts["eu.west"].token, "eu");
  assertEquals(
    (accounts.eu.west as Record<string, unknown>).token,
    ref("planted"),
  );
});

Deno.test("resolveSensitiveVaultRefs: a key list naming no place creates nothing", async () => {
  const data: Record<string, unknown> = { a: {} };
  await resolveSensitiveVaultRefs(
    data,
    [["a", "b", "c"], ["__proto__", "polluted"]],
    createTestVaultService(),
  );
  assertEquals(data, { a: {} });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test("parseSensitiveFieldsTag: adds the key lists from the key-list tag", () => {
  const tags = {
    [SENSITIVE_FIELDS_TAG]: '["services.0.image.creds"]',
    [SENSITIVE_FIELD_KEYS_TAG]: '[["accounts","eu.west","token"]]',
  };
  assertEquals(parseSensitiveFieldsTag(tags), [
    "services.0.image.creds",
    ["accounts", "eu.west", "token"],
  ]);
});

Deno.test("parseSensitiveFieldsTag: ignores a malformed key-list tag whole", () => {
  for (
    const raw of [
      "not-json",
      '{"a":1}',
      '[["ok"],"flat"]',
      "[[]]",
      '[["a",-1]]',
      '[["a",1.5]]',
      '[["a",null]]',
    ]
  ) {
    const tags = {
      [SENSITIVE_FIELDS_TAG]: '["x"]',
      [SENSITIVE_FIELD_KEYS_TAG]: raw,
    };
    assertEquals(parseSensitiveFieldsTag(tags), ["x"], raw);
  }
});

Deno.test("parseSensitiveFieldsTag: a key-list tag alone is not read", () => {
  const tags = { [SENSITIVE_FIELD_KEYS_TAG]: '[["a","b.c"]]' };
  assertEquals(parseSensitiveFieldsTag(tags), null);
});

Deno.test("createResourceWriter: no-vault error says some fields when it cannot name them", async () => {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    {
      creds: {
        schema: z.object({
          list: z.array(z.object({ k: z.string().meta({ sensitive: true }) })),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
  );
  await assertRejects(
    () => writeResource("creds", "main", { list: [] }),
    Error,
    "Cannot persist data: some fields in resource 'creds' are marked as sensitive",
  );
});

const plantedTags = {
  [SENSITIVE_FIELD_KEYS_TAG]: '[["notes","x"]]',
  [SENSITIVE_FIELD_JSON_TAG]: '[["notes","x"]]',
};

Deno.test("createResourceWriter: refuses a supplied key-list or JSON tag, as every reserved tag (swamp-club#3635)", async () => {
  for (const [key, value] of Object.entries(plantedTags)) {
    const { writeResource } = createResourceWriter(
      createMockRepo(),
      modelType,
      modelId,
      testResources,
      undefined,
      undefined,
      undefined,
      { [key]: value },
    );
    await assertRejects(
      () => writeResource("item", "main", { value: "v" }),
      Error,
      `Tag '${key}' from --tag is reserved`,
    );
  }
});

Deno.test("createFileWriterFactory: refuses a supplied key-list or JSON tag, as every reserved tag (swamp-club#3635)", () => {
  for (const [key, value] of Object.entries(plantedTags)) {
    const { createFileWriter } = createFileWriterFactory(
      createMockRepo(),
      modelType,
      modelId,
      testFiles,
      { [key]: value },
    );
    assertThrows(
      () => createFileWriter("log", "main"),
      Error,
      `Tag '${key}' from the workflow's tags is reserved`,
    );
  }
});

// --- element values read back with their original type ---

const typedSpec: ResourceOutputSpec = {
  schema: z.object({
    port: z.number().meta({ sensitive: true }),
    services: z.array(z.object({
      name: z.string(),
      port: z.number().meta({ sensitive: true }),
      token: z.string().meta({ sensitive: true }),
      creds: z.object({ user: z.string(), password: z.string() }).meta({
        sensitive: true,
      }),
    })),
    "by.host": z.record(z.string(), z.number().meta({ sensitive: true })),
  }),
  lifetime: "infinite",
  garbageCollection: 10,
};

function typedData(): Record<string, unknown> {
  return {
    port: 5432,
    services: [
      {
        name: "web",
        port: 8080,
        token: "tok-web",
        creds: { user: "admin", password: "hunter22" },
      },
    ],
    "by.host": { "db.internal": 6543 },
  };
}

async function writeTyped(
  vaultService: VaultService,
  spec: ResourceOutputSpec = typedSpec,
) {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  return await writeResource("creds", "main", typedData());
}

Deno.test("createResourceWriter: lists element values that were not strings in the JSON tag", async () => {
  const handle = await writeTyped(createTestVaultService());
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELD_JSON_TAG]), [
    ["services", 0, "port"],
    ["services", 0, "creds"],
    ["by.host", "db.internal"],
  ]);
});

Deno.test("createResourceWriter: a sensitiveOutput spec writes no JSON tag", async () => {
  const handle = await writeTyped(createTestVaultService(), {
    ...typedSpec,
    sensitiveOutput: true,
  });
  assertEquals(handle.tags[SENSITIVE_FIELDS_TAG], SENSITIVE_FIELDS_ALL);
  assertEquals(handle.tags[SENSITIVE_FIELD_JSON_TAG], undefined);
});

const unionSpec: ResourceOutputSpec = {
  schema: z.object({
    port: z.number().meta({ sensitive: true }),
    auth: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("basic"),
        creds: z.object({ user: z.string(), pass: z.string() }).meta({
          sensitive: true,
        }),
        port: z.number().meta({ sensitive: true }),
      }),
      z.object({
        type: z.literal("token"),
        token: z.string().meta({ sensitive: true }),
      }),
    ]),
    lazy: z.lazy(() =>
      z.object({ retries: z.number().meta({ sensitive: true }) })
    ),
  }),
  lifetime: "infinite",
  garbageCollection: 10,
};

async function writeUnion(vaultService: VaultService) {
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: unionSpec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  return await writeResource("creds", "main", {
    port: 5432,
    auth: { type: "basic", creds: { user: "u", pass: "p4ss" }, port: 6543 },
    lazy: { retries: 3 },
  });
}

Deno.test("createResourceWriter: lists newly vaulted non-string union and lazy fields in the JSON tag, not fields vaulted before", async () => {
  const handle = await writeUnion(createTestVaultService());
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELD_JSON_TAG]), [
    ["auth", "creds"],
    ["auth", "port"],
    ["lazy", "retries"],
  ]);
});

Deno.test("resolveSensitiveVaultRefs: union and lazy fields read back as written, a field vaulted before as its JSON text", async () => {
  const vaultService = createTestVaultService();
  const handle = await writeUnion(vaultService);
  const data = structuredClone(handle.attributes) as Record<string, unknown>;
  await resolveSensitiveVaultRefs(
    data,
    parseSensitiveFieldsTag(handle.tags) as SensitiveFieldPathList,
    vaultService,
  );
  assertEquals(data.port, "5432");
  assertEquals(data.auth, {
    type: "basic",
    creds: { user: "u", pass: "p4ss" },
    port: 6543,
  });
  assertEquals(data.lazy, { retries: 3 });
});

Deno.test("resolveSensitiveVaultRefs: a union member's container holding a marked field stays an object of resolved references", async () => {
  const vaultService = createTestVaultService();
  const spec: ResourceOutputSpec = {
    schema: z.object({
      auth: z.union([
        z.object({
          creds: z.object({
            apiKey: z.string().meta({ sensitive: true }),
            region: z.string(),
          }).meta({ sensitive: true }),
        }),
        z.string(),
      ]),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  const handle = await writeResource("creds", "main", {
    auth: { creds: { apiKey: "k-123", region: "us" } },
  });
  assertEquals(handle.tags[SENSITIVE_FIELD_JSON_TAG], undefined);
  const data = structuredClone(handle.attributes) as Record<string, unknown>;
  await resolveSensitiveVaultRefs(
    data,
    parseSensitiveFieldsTag(handle.tags) as SensitiveFieldPathList,
    vaultService,
  );
  assertEquals(data.auth, { creds: { apiKey: "k-123" } });
});

Deno.test("resolveSensitiveVaultRefs: element values read back as written, top-level ones as before", async () => {
  const vaultService = createTestVaultService();
  const handle = await writeTyped(vaultService);
  const data = structuredClone(handle.attributes) as Record<string, unknown>;
  const redactor = new SecretRedactor();
  await resolveSensitiveVaultRefs(
    data,
    parseSensitiveFieldsTag(handle.tags) as SensitiveFieldPathList,
    vaultService,
    redactor,
  );
  // A top-level value keeps reading back as its JSON text, as on main.
  assertEquals(data.port, "5432");
  const [service] = data.services as Record<string, unknown>[];
  assertEquals(service.port, 8080);
  assertEquals(service.token, "tok-web");
  assertEquals(service.creds, { user: "admin", password: "hunter22" });
  assertEquals(data["by.host"], { "db.internal": 6543 });
  // A restored object is registered as the text it was stored as, never
  // field by field: what the schema does not mark inside it stays readable.
  assertEquals(
    redactor.redact('{"user":"admin","password":"hunter22"}'),
    "***",
  );
  assertEquals(redactor.redact("login admin"), "login admin");
  // A marked value is registered as itself.
  assertEquals(
    redactor.redact("port 8080, token tok-web"),
    "port ***, token ***",
  );
});

Deno.test("resolveSensitiveVaultRefs: registers the fields marked inside a restored element object, and nothing else in it", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      services: z.array(z.object({
        image: z.object({
          registry_type: z.string(),
          username: z.string(),
          token: z.string().meta({ sensitive: true }),
        }).meta({ sensitive: true }),
      })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  const handle = await writeResource("creds", "main", {
    services: [{
      image: {
        registry_type: "DOCKER_HUB",
        username: "deploy",
        token: "tok-registry",
      },
    }],
  });
  // The token is tagged beside its element object, and not stored again.
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELDS_TAG]), [
    "services.0.image",
    "services.0.image.token",
  ]);
  assertEquals((await storedKeys(vaultService)).length, 1);

  const data = structuredClone(handle.attributes) as Record<string, unknown>;
  const redactor = new SecretRedactor();
  await resolveSensitiveVaultRefs(
    data,
    parseSensitiveFieldsTag(handle.tags) as SensitiveFieldPathList,
    vaultService,
    redactor,
  );
  assertEquals((data.services as Record<string, unknown>[])[0].image, {
    registry_type: "DOCKER_HUB",
    username: "deploy",
    token: "tok-registry",
  });
  assertEquals(
    redactor.redact("pushing to DOCKER_HUB as deploy"),
    "pushing to DOCKER_HUB as deploy",
  );
  assertEquals(redactor.redact("token tok-registry"), "token ***");
});

Deno.test("createResourceWriter: a plain resource written after a container was read keeps its ordinary values", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }).meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const plain: ResourceOutputSpec = {
    schema: z.object({ region: z.string(), note: z.string() }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  const redactor = new SecretRedactor();
  const written: string[] = [];
  const repo: UnifiedDataRepository = {
    ...createMockRepo(),
    save: (_type, _modelId, _data, content) => {
      written.push(new TextDecoder().decode(content));
      return Promise.resolve({ version: 1 });
    },
  };
  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    { creds: spec, out: plain },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
    undefined,
    redactor,
  );
  const handle = await writeResource("creds", "main", {
    credentials: { apiKey: "key-value", region: "us-east-1" },
  });

  // A method reads its prior state, as readResource does ...
  const prior = structuredClone(handle.attributes) as Record<string, unknown>;
  await resolveSensitiveVaultRefs(
    prior,
    parseSensitiveFieldsTag(handle.tags) as SensitiveFieldPathList,
    vaultService,
    redactor,
  );
  const credentials = prior.credentials as Record<string, string>;
  // ... and writes a plain resource from it and its own ordinary values.
  const out = await writeResource("out", "out", {
    region: "us-east-1",
    note: `key ${credentials.apiKey}`,
  });
  const persisted = JSON.parse(written.at(-1)!);
  assertEquals(persisted.region, "us-east-1");
  assertEquals(persisted.note, "key ***");
  assertEquals(out.attributes?.region, "us-east-1");
});

type SensitiveFieldPathList = Exclude<
  ReturnType<typeof parseSensitiveFieldsTag>,
  null | "*"
>;

Deno.test("parseSensitiveFieldsTag: marks only the places the other tags name", () => {
  const tags = {
    [SENSITIVE_FIELDS_TAG]: '["services.0.port","token"]',
    [SENSITIVE_FIELD_KEYS_TAG]: '[["by.host","db.internal"]]',
    [SENSITIVE_FIELD_JSON_TAG]:
      '[["services",0,"port"],["by.host","db.internal"],["untagged",0]]',
  };
  assertEquals(parseSensitiveFieldsTag(tags), [
    { keys: ["services", 0, "port"], json: true },
    "token",
    { keys: ["by.host", "db.internal"], json: true },
  ]);
});

Deno.test("parseSensitiveFieldsTag: ignores a malformed JSON tag, and one alone", () => {
  for (const raw of ["not-json", '["flat"]', "[[]]", '[["a",-1]]']) {
    assertEquals(
      parseSensitiveFieldsTag({
        [SENSITIVE_FIELDS_TAG]: '["a"]',
        [SENSITIVE_FIELD_JSON_TAG]: raw,
      }),
      ["a"],
      raw,
    );
  }
  assertEquals(
    parseSensitiveFieldsTag({ [SENSITIVE_FIELD_JSON_TAG]: '[["a"]]' }),
    null,
  );
});

Deno.test("resolveSensitiveVaultRefs: a JSON place keeps text that does not parse, and skips a value that is not a reference", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k", "not json");
  const data: Record<string, unknown> = {
    a: ["${{ vault.get('test-vault', 'k') }}"],
    b: ["[1,2]"],
  };
  await resolveSensitiveVaultRefs(
    data,
    [{ keys: ["a", 0], json: true }, { keys: ["b", 0], json: true }],
    vaultService,
  );
  assertEquals(data, { a: ["not json"], b: ["[1,2]"] });
});

Deno.test("createResourceWriter: a record key the strict tag reading refuses as a path segment goes in the key-list tag, and readResource resolves it", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      tokens: z.record(z.string(), z.string().meta({ sensitive: true })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  const handle = await writeResource("creds", "main", {
    tokens: { plain: "p", constructor: "c", prototype: "t", "": "e" },
  });
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELDS_TAG]), [
    "tokens.plain",
  ]);
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELD_KEYS_TAG]), [
    ["tokens", "constructor"],
    ["tokens", "prototype"],
    ["tokens", ""],
  ]);

  const encoded = new TextEncoder().encode(JSON.stringify(handle.attributes));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(createMockDataEntity(handle.tags)),
  };
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  assertEquals((await readResource("main"))?.tokens, {
    plain: "p",
    constructor: "c",
    prototype: "t",
    "": "e",
  });
});

Deno.test("sensitiveVaultReferences: names the references at key-list and JSON places", () => {
  const data = {
    tokens: { "eu.west": "${{ vault.get('v', 'a') }}" },
    services: [{ port: "${{ vault.get('v', 'b') }}" }],
  };
  assertEquals(
    sensitiveVaultReferences(data, [
      ["tokens", "eu.west"],
      { keys: ["services", 0, "port"], json: true },
    ]),
    [{ vaultName: "v", key: "a" }, { vaultName: "v", key: "b" }],
  );
});

Deno.test("resolveSensitiveVaultRefsLeavingUnread: a failing read at a key-list or JSON place is recorded and left as stored", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "port", "8080");
  const missing = "${{ vault.get('test-vault', 'missing') }}";
  const data: Record<string, unknown> = {
    tokens: { "eu.west": missing },
    services: [{ port: "${{ vault.get('test-vault', 'port') }}" }, {
      port: missing,
    }],
  };
  const sink = recordingSink();

  await resolveSensitiveVaultRefsLeavingUnread(
    data,
    [
      ["tokens", "eu.west"],
      { keys: ["services", 0, "port"], json: true },
      { keys: ["services", 1, "port"], json: true },
    ],
    vaultService,
    sink,
  );

  assertEquals(data, {
    tokens: { "eu.west": missing },
    services: [{ port: 8080 }, { port: missing }],
  });
  assertEquals(sink.unread.map((r) => r.fieldPath), [
    "tokens.eu.west",
    "services.1.port",
  ]);
});

Deno.test("createResourceReader: a sensitive container holding sensitive fields reads back as an object of those fields, at any depth, as before swamp-club#3038", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true, vaultKey: "prod-api-key" }),
        region: z.string(),
        db: z.object({
          host: z.string(),
          password: z.string().meta({ sensitive: true }),
        }),
      }).meta({ sensitive: true }),
      plain: z.object({ token: z.string() }).meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  const handle = await writeResource("creds", "main", {
    credentials: {
      apiKey: "key-value",
      region: "us-east-1",
      db: { host: "db.internal", password: "db-pass" },
    },
    plain: { token: "tok" },
  });
  assertEquals(JSON.parse(handle.tags[SENSITIVE_FIELDS_TAG]), [
    "credentials",
    "credentials.apiKey",
    "credentials.db.password",
    "plain",
  ]);
  assertEquals(handle.tags[SENSITIVE_FIELD_JSON_TAG], undefined);
  // The declared key keeps getting the current value, and the container's
  // own key holds all of it.
  assertEquals(
    await vaultService.get("test-vault", "prod-api-key"),
    "key-value",
  );
  assertEquals(
    JSON.parse(
      await vaultService.get("test-vault", `${elementKeyPrefix}-credentials`),
    ).db,
    { host: "db.internal", password: "db-pass" },
  );

  const encoded = new TextEncoder().encode(JSON.stringify(handle.attributes));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(createMockDataEntity(handle.tags)),
  };
  const redactor = new SecretRedactor();
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
    redactor,
  );
  const prior = await readResource("main");
  assertEquals(prior?.credentials, {
    apiKey: "key-value",
    db: { password: "db-pass" },
  });
  // A container holding no stored field reads back as JSON text, as it
  // always has (swamp-club#3480).
  assertEquals(prior?.plain, '{"token":"tok"}');
  assertEquals(
    redactor.redact("key-value db-pass us-east-1 db.internal"),
    "*** *** us-east-1 db.internal",
  );
});

Deno.test("createResourceReader: a record written before swamp-club#3038 with an object of a container's field references still reads", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "k-api", "key-value");
  const data = {
    credentials: { apiKey: "${{ vault.get('test-vault', 'k-api') }}" },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () =>
      Promise.resolve(createMockDataEntity({
        [SENSITIVE_FIELDS_TAG]: '["credentials","credentials.apiKey"]',
      })),
  };
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  assertEquals((await readResource("main"))?.credentials, {
    apiKey: "key-value",
  });
});

Deno.test("createResourceReader: reference-shaped text written in a marked field inside a restored container reads back as written, never from a vault", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      credentials: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }).meta({ sensitive: true }),
      services: z.array(z.object({
        image: z.object({
          token: z.string().meta({ sensitive: true }),
        }).meta({ sensitive: true }),
      })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "planted", "planted-secret");
  const planted = "${{ vault.get('test-vault', 'planted') }}";
  const { writeResource } = createResourceWriter(
    createMockRepo(),
    modelType,
    modelId,
    { creds: spec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  const handle = await writeResource("creds", "main", {
    credentials: { apiKey: planted, region: "us-east-1" },
    services: [{ image: { token: planted } }],
  });
  const encoded = new TextEncoder().encode(JSON.stringify(handle.attributes));
  const repo = {
    ...createMockRepo(),
    getContent: () => Promise.resolve(encoded),
    findByName: () => Promise.resolve(createMockDataEntity(handle.tags)),
  };
  const readResource = createResourceReader(
    repo,
    modelType,
    modelId,
    vaultService,
  );
  const prior = await readResource("main");
  // The field's own reference is resolved, to the text that was written.
  assertEquals(prior?.credentials, { apiKey: planted });
  assertEquals(prior?.services, [{ image: { token: planted } }]);
});

Deno.test("resolveSensitiveVaultRefs: a field tagged beside its container is resolved once, whichever comes first in the tag", async () => {
  const vaultService = createTestVaultService();
  await vaultService.put("test-vault", "planted", "planted-secret");
  const planted = "${{ vault.get('test-vault', 'planted') }}";
  await vaultService.put("test-vault", "k-api", planted);
  for (
    const tag of [
      ["credentials", "credentials.apiKey"],
      ["credentials.apiKey", "credentials"],
    ]
  ) {
    const data: Record<string, unknown> = {
      credentials: { apiKey: "${{ vault.get('test-vault', 'k-api') }}" },
    };
    await resolveSensitiveVaultRefs(data, tag, vaultService);
    // The value read from the vault is the text that was written, never a
    // reference to read again.
    assertEquals(data.credentials, { apiKey: planted }, tag.join(","));
  }
});

Deno.test("processSensitiveResourceData: record keys that differ only in case get vault keys a case-insensitive vault keeps apart", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      env: z.record(z.string(), z.string().meta({ sensitive: true })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const data: Record<string, unknown> = {
    env: { Token: "alpha", token: "beta", TOKEN: "gamma" },
  };
  const vaultService = createTestVaultService();
  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );
  const keys = await storedKeys(vaultService);
  assertEquals(keys.length, 3);
  // Folded to lowercase, as Azure Key Vault or a case-insensitive file
  // system stores them, the keys are still three.
  assertEquals(new Set(keys.map((key) => key.toLowerCase())).size, 3);
  // A lowercase key is kept as written.
  assert(keys.includes(`${elementKeyPrefix}-env.token`));
});

Deno.test("createResourceWriter: an update that reads its prior state and writes it back keeps an unmarked value that an element object marked as a whole also holds", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      stage: z.string(),
      services: z.array(z.object({
        port: z.number(),
        env: z.record(z.string(), z.string()).meta({ sensitive: true }),
      })),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };
  const vaultService = createTestVaultService();
  const written: string[] = [];
  const repo: UnifiedDataRepository = {
    ...createMockRepo(),
    save: (_type, _modelId, _data, content) => {
      written.push(new TextDecoder().decode(content));
      return Promise.resolve({ version: 1 });
    },
  };
  const writerFor = (redactor: SecretRedactor) =>
    createResourceWriter(
      repo,
      modelType,
      modelId,
      { app: spec },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vaultService,
      "update",
      undefined,
      redactor,
    );
  const first = await writerFor(new SecretRedactor()).writeResource(
    "app",
    "main",
    {
      stage: "production",
      services: [{
        port: 8080,
        env: { NODE_ENV: "production", API_KEY: "sk-live-123" },
      }],
    },
  );

  // The next run reads its prior state ...
  const redactor = new SecretRedactor();
  const prior = structuredClone(first.attributes) as Record<string, unknown>;
  await resolveSensitiveVaultRefs(
    prior,
    parseSensitiveFieldsTag(first.tags) as SensitiveFieldPathList,
    vaultService,
    redactor,
  );
  const services = prior.services as Record<string, unknown>[];
  assertEquals(services[0].env, {
    NODE_ENV: "production",
    API_KEY: "sk-live-123",
  });
  // ... and writes it back with one change.
  services[0].port = 9090;
  await writerFor(redactor).writeResource("app", "main", prior);

  const persisted = JSON.parse(written.at(-1)!);
  assertEquals(persisted.stage, "production");
  assertEquals(persisted.services[0].port, 9090);
  assertStringIncludes(persisted.services[0].env, "vault.get");
  assertEquals(
    redactor.redact("deploying stage production"),
    "deploying stage production",
  );
});

// --- Durable streamed content (swamp-club#4017) ---

/**
 * A repository that allocates a real temp file, reports `durable`, and
 * records the options each finalize is given.
 */
async function withDurableAllocation(
  durable: boolean | undefined,
  fn: (
    repo: UnifiedDataRepository,
    finalized: ({ contentSynced?: boolean } | undefined)[],
  ) => Promise<void>,
  syncContent?: (file: Deno.FsFile) => Promise<void>,
): Promise<void> {
  const tmpFile = await Deno.makeTempFile();
  const finalized: ({ contentSynced?: boolean } | undefined)[] = [];
  try {
    const repo: UnifiedDataRepository = {
      ...createMockRepo(),
      allocateVersion: () =>
        Promise.resolve({
          version: 1,
          contentPath: tmpFile,
          priorVersions: [],
          ...(durable === undefined ? {} : { durable }),
          ...(syncContent === undefined ? {} : { syncContent }),
        }),
      finalizeVersion: (_type, _id, _data, _version, _prior, options) => {
        finalized.push(options);
        return Promise.resolve({ size: 0, checksum: "mock-checksum" });
      },
    };
    await fn(repo, finalized);
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

Deno.test("DataWriter.writeStream: on a durable allocation, syncs its own handle and tells finalize", async () => {
  await withDurableAllocation(true, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    await createFileWriter("log", "test-log").writeStream(
      streamOf("a\n", "b\n"),
    );
    assertEquals(finalized, [{ contentSynced: true }]);
  });
});

Deno.test("DataWriter.writeStream: syncs through the allocation's syncContent when it has one (swamp-club#4032)", async () => {
  let synced = 0;
  await withDurableAllocation(true, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    await createFileWriter("log", "test-log").writeStream(streamOf("a\n"));
    assertEquals(synced, 1);
    assertEquals(finalized, [{ contentSynced: true }]);
  }, () => {
    synced++;
    return Promise.resolve();
  });
});

Deno.test("DataWriter.writeStream: a failed syncContent names the content path once", async () => {
  await withDurableAllocation(true, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    const error = await assertRejects(() =>
      createFileWriter("log", "test-log").writeStream(streamOf("a\n"))
    );
    assert(error instanceof Error);
    assertEquals(error.message.match(/Could not sync/g)?.length, 1);
    assertStringIncludes(error.message, "EIO");
    assertEquals(finalized, []);
  }, () => Promise.reject(new Error("EIO")));
});

Deno.test("DataWriter.writeStream: without a durable allocation, does not claim the content is synced", async () => {
  await withDurableAllocation(undefined, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    await createFileWriter("log", "test-log").writeStream(streamOf("a\n"));
    assertEquals(finalized, [{ contentSynced: false }]);
  });
});

Deno.test("DataWriter.writeLine and getFilePath: leave the content for finalize to sync", async () => {
  await withDurableAllocation(true, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    const lines = createFileWriter("log", "lines");
    await lines.writeLine("one");
    await lines.finalize();
    const subprocess = createFileWriter("log", "subprocess");
    await Deno.writeTextFile(await subprocess.getFilePath(), "out");
    await subprocess.finalize();
    assertEquals(finalized, [{ contentSynced: false }, {
      contentSynced: false,
    }]);
  });
});

Deno.test("DataWriter.writeStream: a stream error is not hidden by the sync, and nothing is finalized", async () => {
  await withDurableAllocation(true, async (repo, finalized) => {
    const { createFileWriter } = createFileWriterFactory(
      repo,
      modelType,
      modelId,
      testFiles,
    );
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("upstream closed"));
      },
    });
    await assertRejects(
      () => createFileWriter("log", "test-log").writeStream(failing),
      Error,
      "upstream closed",
    );
    assertEquals(finalized, []);
  });
});
