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
 * Integration tests for data versioning expressions.
 *
 * Tests the full flow:
 * 1. Create model definitions
 * 2. Emit versioned data
 * 3. Verify CEL expressions can access data via model.X.data.Y and data namespace functions
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
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-expr-" });
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
// Model Resource Namespace Access: model.<name>.resource.<specName>
// ============================================================================

Deno.test("Integration: model.X.resource.specName accesses latest version of resource", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create a model definition
    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      globalArguments: { cidr: "10.0.0.0/16" },
    });
    await definitionRepo.save(type, definition);

    // Create owner for data
    const owner = createOwner("test/model:create");

    // Emit data with multiple versions
    const dataEntity = Data.create({
      name: "vpc-info",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    // Version 1
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(
        JSON.stringify({ vpcId: "vpc-111", version: 1 }),
      ),
    );

    // Version 2 (latest)
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(
        JSON.stringify({ vpcId: "vpc-222", version: 2 }),
      ),
    );

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Verify model.my-vpc.resource.vpc-info.vpc-info exists and has latest version
    const modelData = context.model["my-vpc"];
    assertExists(modelData);
    assertExists(modelData.resource);
    const resourceInstances = modelData.resource!["vpc-info"];
    assertExists(resourceInstances);
    const resourceRecord = resourceInstances["vpc-info"];
    assertExists(resourceRecord);
    assertEquals(resourceRecord.version, 2);
    assertEquals(resourceRecord.attributes.vpcId, "vpc-222");

    // Evaluate CEL expression with new pattern: model.X.resource.specName.instanceName.attributes.field
    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["my-vpc"].resource["vpc-info"]["vpc-info"].attributes.vpcId',
      context,
    );
    assertEquals(result, "vpc-222");
  });
});

// ============================================================================
// Data Namespace Function: data.version()
// ============================================================================

Deno.test("Integration: data.version() retrieves specific version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create a model definition
    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    // Create owner for data
    const owner = createOwner("test/model:create");

    // Emit data with multiple versions
    const dataEntity = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "output" },
      ownerDefinition: owner,
    });

    // Create 3 versions
    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        definition.id,
        dataEntity,
        new TextEncoder().encode(JSON.stringify({ value: i * 10 })),
      );
    }

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Access specific versions via data.version()
    assertExists(context.data);

    const v1 = context.data.version("my-model", "result", 1);
    assertExists(v1);
    assertEquals(v1.version, 1);
    assertEquals(v1.attributes.value, 10);

    const v2 = context.data.version("my-model", "result", 2);
    assertExists(v2);
    assertEquals(v2.version, 2);
    assertEquals(v2.attributes.value, 20);

    const v3 = context.data.version("my-model", "result", 3);
    assertExists(v3);
    assertEquals(v3.version, 3);
    assertEquals(v3.attributes.value, 30);
  });
});

Deno.test("Integration: data.version() returns null for missing version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create a model definition
    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ value: 1 })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Try to access non-existent version
    assertExists(context.data);
    const result = context.data.version("my-model", "result", 99);
    assertEquals(result, null);
  });
});

// ============================================================================
// Data Namespace Function: data.latest()
// ============================================================================

Deno.test("Integration: data.latest() retrieves latest version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create a model definition
    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner,
    });

    // Create 3 versions
    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        definition.id,
        dataEntity,
        new TextEncoder().encode(JSON.stringify({ step: i })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);
    const latest = context.data.latest("my-model", "output");
    assertExists(latest);
    assertEquals(latest.version, 3);
    assertEquals(latest.attributes.step, 3);
  });
});

// ============================================================================
// Data Namespace Function: data.listVersions()
// ============================================================================

Deno.test("Integration: data.listVersions() returns sorted version numbers", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "log",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "log" },
      ownerDefinition: owner,
    });

    // Create several versions
    for (let i = 1; i <= 5; i++) {
      await dataRepo.save(
        type,
        definition.id,
        dataEntity,
        new TextEncoder().encode(JSON.stringify({ entry: i })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);
    const versions = context.data.listVersions("my-model", "log");
    assertEquals(versions, [1, 2, 3, 4, 5]);
  });
});

Deno.test("Integration: data.listVersions() returns empty array for missing data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);
    const versions = context.data.listVersions("my-model", "nonexistent");
    assertEquals(versions, []);
  });
});

// ============================================================================
// Data Namespace Function: data.findByTag()
// ============================================================================

Deno.test("Integration: data.findByTag() returns matching records", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create two model definitions
    const modelA = Definition.create({
      name: "model-a",
      tags: {},
      globalArguments: {},
    });
    const modelB = Definition.create({
      name: "model-b",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, modelA);
    await definitionRepo.save(type, modelB);

    const owner = createOwner("test/model:create");

    // Create log-type data for model A
    const logA = Data.create({
      name: "execution-log",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "log" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      modelA.id,
      logA,
      new TextEncoder().encode(JSON.stringify({ source: "A" })),
    );

    // Create log-type data for model B
    const logB = Data.create({
      name: "execution-log",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "log" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      modelB.id,
      logB,
      new TextEncoder().encode(JSON.stringify({ source: "B" })),
    );

    // Create output-type data for model A
    const outputA = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      modelA.id,
      outputA,
      new TextEncoder().encode(JSON.stringify({ value: 42 })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    // Find all logs
    const logs = context.data.findByTag("type", "log");
    assertEquals(logs.length, 2);
    assertEquals(logs.every((r) => r.tags.type === "log"), true);

    // Find all outputs
    const outputs = context.data.findByTag("type", "output");
    assertEquals(outputs.length, 1);
    assertEquals(outputs[0].tags.type, "output");

    // Non-matching tag
    const nonexistent = context.data.findByTag("type", "nonexistent");
    assertEquals(nonexistent.length, 0);
  });
});

// ============================================================================
// Multiple Data Items Per Model
// ============================================================================

Deno.test("Integration: model can have multiple named data items with mixed types", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-command",
      tags: {},
      globalArguments: { cmd: "echo hello" },
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");

    // Create resource data items
    const exitCode = Data.create({
      name: "exit-code",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      exitCode,
      new TextEncoder().encode(JSON.stringify({ code: 0 })),
    );

    // Create file data items
    const stdout = Data.create({
      name: "stdout",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "file" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      stdout,
      new TextEncoder().encode("hello world"),
    );

    const stderr = Data.create({
      name: "stderr",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "file" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      stderr,
      new TextEncoder().encode(""),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Resource items accessible via model.X.resource.specName.instanceName
    const modelData = context.model["my-command"];
    assertExists(modelData);
    assertExists(modelData.resource);
    assertExists(modelData.resource!["exit-code"]);
    assertExists(modelData.resource!["exit-code"]["exit-code"]);

    // File items accessible via model.X.file.specName.instanceName
    assertExists(modelData.file);
    assertExists(modelData.file!["stdout"]);
    assertExists(modelData.file!["stdout"]["stdout"]);
    assertExists(modelData.file!["stderr"]);
    assertExists(modelData.file!["stderr"]["stderr"]);

    // Also via data functions
    assertExists(context.data);
    assertEquals(context.data.listVersions("my-command", "stdout"), [1]);
    assertEquals(context.data.listVersions("my-command", "stderr"), [1]);
    assertEquals(context.data.listVersions("my-command", "exit-code"), [1]);
  });
});

// ============================================================================
// Hyphenated Model Names
// ============================================================================

Deno.test("Integration: handles hyphenated model names in data expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-hyphenated-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:create");
    const dataEntity = Data.create({
      name: "my-hyphenated-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      definition.id,
      dataEntity,
      new TextEncoder().encode(JSON.stringify({ key: "value" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Access via bracket notation (required for hyphenated names)
    assertExists(context.data);
    const latest = context.data.latest(
      "my-hyphenated-model",
      "my-hyphenated-data",
    );
    assertExists(latest);
    assertEquals(latest.attributes.key, "value");
  });
});

// ============================================================================
// Context Without Data Repository
// ============================================================================

Deno.test("Integration: buildContext works without dataRepo", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "my-model",
      tags: {},
      globalArguments: { key: "value" },
    });
    await definitionRepo.save(type, definition);

    // Build context without dataRepo
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      // No dataRepo
    });
    const context = await modelResolver.buildContext();

    // Model should still be accessible
    assertExists(context.model["my-model"]);
    assertEquals(context.model["my-model"].input.name, "my-model");

    // Data namespace should still exist but return empty results
    assertExists(context.data);
    assertEquals(context.data.listVersions("my-model", "anything"), []);
    assertEquals(context.data.findByTag("type", "any"), []);
  });
});
