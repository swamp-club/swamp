/**
 * Integration tests for expression scoping rules.
 *
 * Tests the contract between model.*.resource (tag-filtered) and data.latest()
 * (tag-agnostic), and verifies dependency extraction behavior.
 *
 * Key scoping rules:
 * - model.*.resource is populated ONLY for data tagged type: "resource"
 * - Workflow execution tags data as type: "step-output", so it is excluded
 * - data.latest() reads from DataCache which contains ALL data regardless of tag
 * - extractResourceDependencies() only detects model.X.resource patterns
 * - extractDataFunctionDependencies() detects data.latest/version/etc patterns
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import type { DataRecord } from "../src/domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  extractDataFunctionDependencies,
  extractResourceDependencies,
} from "../src/domain/expressions/dependency_extractor.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-expr-scope-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, ".swamp", "definitions"));
}

function createOwner(ref: string): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: ref,
  };
}

// ============================================================================
// Section 1: model.*.resource Tag-Based Population
// ============================================================================

Deno.test("Integration: model.*.resource populated for type=resource data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      attributes: { cidr: "10.0.0.0/16" },
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "vpc-info",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ vpcId: "vpc-123" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // model.my-vpc.resource should be populated
    const modelData = context.model["my-vpc"];
    assertExists(modelData);
    assertExists(modelData.resource);
    const resourceRecord = modelData.resource!["vpc-info"];
    assertExists(resourceRecord);
    assertEquals(resourceRecord.attributes.vpcId, "vpc-123");

    // CEL expression should resolve
    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["my-vpc"].resource["vpc-info"].attributes.vpcId',
      context,
    );
    assertEquals(result, "vpc-123");
  });
});

Deno.test("Integration: model.*.resource NOT populated for type=step-output data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      attributes: { cidr: "10.0.0.0/16" },
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "vpc-state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "step-output",
        workflow: "deploy",
        step: "create-vpc",
      },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ vpcId: "vpc-456" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // model.my-vpc.resource should NOT be populated for step-output tagged data
    const modelData = context.model["my-vpc"];
    assertExists(modelData);
    assertEquals(modelData.resource, undefined);
  });
});

Deno.test("Integration: same model with both tag types — only resource populates model.*.resource", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      attributes: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");

    // Resource-tagged data
    const resourceData = Data.create({
      name: "vpc-info",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      resourceData,
      new TextEncoder().encode(JSON.stringify({ vpcId: "vpc-789" })),
    );

    // Step-output-tagged data
    const stepOutputData = Data.create({
      name: "deploy-log",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "step-output",
        workflow: "deploy",
        step: "create-vpc",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      stepOutputData,
      new TextEncoder().encode(JSON.stringify({ status: "created" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    const modelData = context.model["my-vpc"];
    assertExists(modelData);
    assertExists(modelData.resource);

    // Resource-tagged data IS in model.*.resource
    assertExists(modelData.resource!["vpc-info"]);
    assertEquals(modelData.resource!["vpc-info"].attributes.vpcId, "vpc-789");

    // Step-output-tagged data is NOT in model.*.resource
    assertEquals(modelData.resource!["deploy-log"], undefined);
  });
});

// ============================================================================
// Section 2: data.latest() Tag-Agnostic Access
// ============================================================================

Deno.test("Integration: data.latest() sees step-output tagged data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      attributes: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "vpc-state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "step-output",
        workflow: "deploy",
        step: "create-vpc",
      },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ vpcId: "vpc-abc" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // data.latest() bypasses the type tag filter
    assertExists(context.data);
    const latest = context.data.latest("my-vpc", "vpc-state");
    assertExists(latest);
    assertEquals(latest.attributes.vpcId, "vpc-abc");
    assertEquals(latest.tags.type, "step-output");
    assertEquals(latest.tags.workflow, "deploy");
  });
});

Deno.test("Integration: data.latest() is a snapshot at build time", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-model",
      tags: {},
      attributes: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    // Save version 1 and build context1
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ value: "before" })),
    );

    const resolver1 = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context1 = await resolver1.buildContext();

    // Save version 2 and build context2
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ value: "after" })),
    );

    const resolver2 = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context2 = await resolver2.buildContext();

    // context1 snapshot has version 1
    assertExists(context1.data);
    const snap1 = context1.data.latest("my-model", "state");
    assertExists(snap1);
    assertEquals(snap1.attributes.value, "before");
    assertEquals(snap1.version, 1);

    // context2 snapshot has version 2
    assertExists(context2.data);
    const snap2 = context2.data.latest("my-model", "state");
    assertExists(snap2);
    assertEquals(snap2.attributes.value, "after");
    assertEquals(snap2.version, 2);
  });
});

// ============================================================================
// Section 3: Cross-Workflow Scoping (the critical scenario)
// ============================================================================

Deno.test("Integration: cross-workflow model.* fails, data.latest() succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "vpc-model",
      tags: {},
      attributes: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");

    // Simulate workflow A output: data tagged as step-output
    const dataEntity = Data.create({
      name: "vpc-state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "step-output",
        workflow: "create-vpc",
        step: "create.create-vpc",
      },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(
        JSON.stringify({ vpcId: "vpc-cross", cidr: "10.0.0.0/16" }),
      ),
    );

    // Build fresh context (simulating workflow B starting)
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // model.*.resource is undefined — step-output data excluded from model context
    const modelData = context.model["vpc-model"];
    assertExists(modelData);
    assertEquals(modelData.resource, undefined);

    // data.latest() succeeds — DataCache contains ALL data regardless of tag
    assertExists(context.data);
    const latest = context.data.latest("vpc-model", "vpc-state");
    assertExists(latest);
    assertEquals(latest.attributes.vpcId, "vpc-cross");
    assertEquals(latest.attributes.cidr, "10.0.0.0/16");
    assertEquals(latest.tags.type, "step-output");
    assertEquals(latest.tags.workflow, "create-vpc");
  });
});

// ============================================================================
// Section 4: Implicit Dependency Extraction
// ============================================================================

Deno.test("Integration: extractResourceDependencies detects model.X.resource patterns", () => {
  const expr = 'model.other-model.resource["vpc-state"].attributes.vpcId';
  const deps = extractResourceDependencies(expr);
  assertEquals(deps, ["other-model"]);
});

Deno.test("Integration: extractResourceDependencies does NOT detect data.latest()", () => {
  const expr = 'data.latest("other-model", "vpc-state").attributes.vpcId';

  // extractResourceDependencies only sees model.X.resource patterns
  const resourceDeps = extractResourceDependencies(expr);
  assertEquals(resourceDeps, []);

  // extractDataFunctionDependencies DOES detect it
  const dataDeps = extractDataFunctionDependencies(expr);
  assertEquals(dataDeps, ["other-model"]);
});

Deno.test("Integration: multiple model.* refs in one expression detected", () => {
  const expr =
    'model.vpc-model.resource["vpc-state"].attributes.vpcId + "-" + model.subnet-model.resource["subnet-info"].attributes.subnetId';
  const deps = extractResourceDependencies(expr);
  assertEquals(deps.sort(), ["subnet-model", "vpc-model"]);
});

// ============================================================================
// Section 5: In-Memory Context Update (intra-workflow model.*)
// ============================================================================

Deno.test("Integration: direct context mutation makes step-output visible via model.*", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "vpc-model",
      tags: {},
      attributes: {},
    });
    await definitionRepo.save(type, definition);

    // Build context with no data — resource is undefined
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    const modelData = context.model["vpc-model"];
    assertExists(modelData);
    assertEquals(modelData.resource, undefined);

    // Simulate what execution_service.ts does: mutate context in-memory
    // This is how intra-workflow model.* access works — the execution service
    // directly populates the resource record after each step completes
    const record: DataRecord = {
      id: crypto.randomUUID(),
      name: "vpc-state",
      version: 1,
      createdAt: new Date().toISOString(),
      attributes: { vpcId: "vpc-inmem", cidr: "10.0.0.0/16" },
      tags: { type: "step-output", workflow: "deploy", step: "create-vpc" },
    };

    if (!modelData.resource) modelData.resource = {};
    modelData.resource["vpc-state"] = record;

    // Now CEL can access it via model.* despite the step-output tag
    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["vpc-model"].resource["vpc-state"].attributes.vpcId',
      context,
    );
    assertEquals(result, "vpc-inmem");
  });
});
