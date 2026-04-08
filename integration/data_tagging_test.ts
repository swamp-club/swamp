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
 * Integration tests for data tagging and tag-based queries.
 *
 * Tests the full flow:
 * 1. Create data with various tags
 * 2. Verify logical views organize by tags
 * 3. Query data by tag filters
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
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-tagging-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
}

function createOwner(ref: string): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: ref,
  };
}

// ============================================================================
// Basic Tagging
// ============================================================================

Deno.test("Data Tagging: create data with required type tag", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:tag-test");

    const data = Data.create({
      name: "tagged-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ value: 1 })),
    );

    const loaded = await repo.findByName(type, modelId, "tagged-data");
    assertExists(loaded);
    assertEquals(loaded.tags.type, "resource");
  });
});

Deno.test("Data Tagging: create data with multiple tags", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:multi-tag");

    const data = Data.create({
      name: "multi-tagged",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "state",
        environment: "production",
        region: "us-east-1",
        tier: "critical",
        owner: "platform-team",
      },
      ownerDefinition: owner,
    });

    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ state: "active" })),
    );

    const loaded = await repo.findByName(type, modelId, "multi-tagged");
    assertExists(loaded);
    assertEquals(loaded.tags.type, "state");
    assertEquals(loaded.tags.environment, "production");
    assertEquals(loaded.tags.region, "us-east-1");
    assertEquals(loaded.tags.tier, "critical");
    assertEquals(loaded.tags.owner, "platform-team");
  });
});

Deno.test("Data Tagging: tags persist across versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:tag-persist");

    const data = Data.create({
      name: "persistent-tags",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "log",
        level: "info",
        source: "api",
      },
      ownerDefinition: owner,
    });

    // Write multiple versions
    for (let i = 1; i <= 3; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`log entry ${i}`),
      );
    }

    // Check tags on each version
    for (let v = 1; v <= 3; v++) {
      const loaded = await repo.findByName(type, modelId, "persistent-tags", v);
      assertExists(loaded);
      assertEquals(loaded.tags.type, "log");
      assertEquals(loaded.tags.level, "info");
      assertEquals(loaded.tags.source, "api");
    }
  });
});

// ============================================================================
// Query Data by Tags
// ============================================================================

Deno.test("Data Tagging: findByTag returns matching records", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:find-tag");

    // Create multiple models with different data types
    const models = [
      { name: "vpc-model", dataName: "vpc-state", type: "resource" },
      { name: "subnet-model", dataName: "subnet-state", type: "resource" },
      { name: "log-model", dataName: "execution-log", type: "log" },
      { name: "config-model", dataName: "app-config", type: "config" },
    ];

    for (const model of models) {
      const definition = Definition.create({
        name: model.name,
        tags: {},
        globalArguments: {},
      });
      await definitionRepo.save(type, definition);

      const data = Data.create({
        name: model.dataName,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: model.type },
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ model: model.name })),
      );
    }

    // Build context and query by tags
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // Find all resources
      const resources = await context.data.findByTag("type", "resource");
      assertEquals(resources.length, 2);
      assertEquals(resources.every((r) => r.tags.type === "resource"), true);

      // Find all logs
      const logs = await context.data.findByTag("type", "log");
      assertEquals(logs.length, 1);
      assertEquals(logs[0].tags.type, "log");

      // Find all configs
      const configs = await context.data.findByTag("type", "config");
      assertEquals(configs.length, 1);
      assertEquals(configs[0].tags.type, "config");

      // Non-matching tag returns empty
      const nonexistent = await context.data.findByTag("type", "nonexistent");
      assertEquals(nonexistent.length, 0);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Data Tagging: findByTag with custom tags", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:custom-tags");

    // Create models with different environments
    const environments = ["production", "staging", "development"];

    for (const env of environments) {
      const definition = Definition.create({
        name: `${env}-model`,
        tags: {},
        globalArguments: {},
      });
      await definitionRepo.save(type, definition);

      const data = Data.create({
        name: "state",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "state", environment: env },
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ env })),
      );
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // Find by environment
      const prodData = await context.data.findByTag(
        "environment",
        "production",
      );
      assertEquals(prodData.length, 1);
      assertEquals(prodData[0].tags.environment, "production");

      const stagingData = await context.data.findByTag(
        "environment",
        "staging",
      );
      assertEquals(stagingData.length, 1);
      assertEquals(stagingData[0].tags.environment, "staging");

      // Find all state types (all 3)
      const allStates = await context.data.findByTag("type", "state");
      assertEquals(allStates.length, 3);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Data Tagging: findByTag returns only latest version with matching tag", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:latest-only");

    const definition = Definition.create({
      name: "versioned-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const data = Data.create({
      name: "versioned-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "versioned" },
      ownerDefinition: owner,
    });

    // Write 5 versions
    for (let i = 1; i <= 5; i++) {
      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ version: i })),
      );
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // findByTag returns only the latest version, not all versions
      const results = await context.data.findByTag("type", "versioned");
      assertEquals(results.length, 1);

      // Verify it's the latest version
      assertEquals(results[0].version, 5);
    } finally {
      catalog.close();
    }
  });
});

// ============================================================================
// Tag Categories
// ============================================================================

Deno.test("Data Tagging: different type categories", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:categories");

    // Create data with different type categories
    const categories = [
      { name: "resource", description: "Cloud resources" },
      { name: "log", description: "Execution logs" },
      { name: "state", description: "State data" },
      { name: "config", description: "Configuration" },
      { name: "output", description: "Model outputs" },
    ];

    for (const category of categories) {
      const definition = Definition.create({
        name: `${category.name}-model`,
        tags: {},
        globalArguments: {},
      });
      await definitionRepo.save(type, definition);

      const data = Data.create({
        name: `${category.name}-data`,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: category.name, description: category.description },
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ category: category.name })),
      );
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // Verify each category can be found
      for (const category of categories) {
        const results = await context.data.findByTag("type", category.name);
        assertEquals(results.length, 1);
        assertEquals(results[0].tags.type, category.name);
      }
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Data Tagging: workflow and step tags", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:workflow-tags");

    // Simulate workflow step outputs with workflow/step tags
    const workflows = [
      { workflow: "deploy", steps: ["build", "test", "deploy"] },
      { workflow: "ci", steps: ["lint", "test"] },
    ];

    for (const wf of workflows) {
      for (const step of wf.steps) {
        const definition = Definition.create({
          name: `${wf.workflow}-${step}`,
          tags: {},
          globalArguments: {},
        });
        await definitionRepo.save(type, definition);

        const data = Data.create({
          name: "output",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 5,
          tags: {
            type: "resource",
            source: "step-output",
            workflow: wf.workflow,
            step: step,
          },
          ownerDefinition: owner,
        });

        await dataRepo.save(
          type,
          definition.id,
          data,
          new TextEncoder().encode(
            JSON.stringify({ workflow: wf.workflow, step }),
          ),
        );
      }
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // Find all step outputs
      const allStepOutputs = await context.data.findByTag(
        "source",
        "step-output",
      );
      assertEquals(allStepOutputs.length, 5);

      // Find by workflow
      const deploySteps = await context.data.findByTag("workflow", "deploy");
      assertEquals(deploySteps.length, 3);

      const ciSteps = await context.data.findByTag("workflow", "ci");
      assertEquals(ciSteps.length, 2);

      // Find by step
      const testSteps = await context.data.findByTag("step", "test");
      assertEquals(testSteps.length, 2);
    } finally {
      catalog.close();
    }
  });
});

// ============================================================================
// Tag Access in CEL Expressions
// ============================================================================

Deno.test("Data Tagging: access tags via model.X.resource.specName.tags", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:tag-access");

    const definition = Definition.create({
      name: "my-vpc",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const data = Data.create({
      name: "vpc-state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "resource",
        provider: "aws",
        region: "us-west-2",
      },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      data,
      new TextEncoder().encode(JSON.stringify({ vpcId: "vpc-123" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Access tags directly via resource namespace (specName → instanceName → record)
    const modelData = context.model["my-vpc"];
    assertExists(modelData);
    assertExists(modelData.resource);
    const resourceInstances = modelData.resource!["vpc-state"];
    assertExists(resourceInstances);
    const dataRecord = resourceInstances["vpc-state"] as {
      tags: Record<string, string>;
    };
    assertEquals(dataRecord.tags.type, "resource");
    assertEquals(dataRecord.tags.provider, "aws");
    assertEquals(dataRecord.tags.region, "us-west-2");
  });
});

// ============================================================================
// Multiple Data Items Per Model
// ============================================================================

Deno.test("Data Tagging: multiple resource items with different tags", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:multi-data");

    const definition = Definition.create({
      name: "multi-output-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    // Create multiple resource data items with different custom tags
    const dataItems: Array<{
      name: string;
      tags: Record<string, string>;
      content: string;
    }> = [
      {
        name: "stdout",
        tags: { type: "resource", stream: "stdout" },
        content: JSON.stringify({ output: "standard output" }),
      },
      {
        name: "stderr",
        tags: { type: "resource", stream: "stderr" },
        content: JSON.stringify({ output: "error output" }),
      },
      {
        name: "exit-code",
        tags: { type: "resource", category: "status" },
        content: JSON.stringify({ code: 0 }),
      },
      {
        name: "timing",
        tags: { type: "resource", category: "performance" },
        content: JSON.stringify({ duration: 1234 }),
      },
    ];

    for (const item of dataItems) {
      const data = Data.create({
        name: item.name,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: item.tags,
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(item.content),
      );
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      // Access all resource data from model (resource is a map of specName -> instanceName -> DataRecord)
      const modelData = context.model["multi-output-model"];
      assertExists(modelData);
      assertExists(modelData.resource);
      const resourceMap = modelData.resource as Record<
        string,
        Record<string, { tags: Record<string, string> }>
      >;
      assertExists(resourceMap["stdout"]);
      assertExists(resourceMap["stderr"]);
      assertExists(resourceMap["exit-code"]);
      assertExists(resourceMap["timing"]);

      // Verify custom tags (access via specName -> instanceName)
      assertEquals(resourceMap["stdout"]["stdout"].tags.stream, "stdout");
      assertEquals(resourceMap["stderr"]["stderr"].tags.stream, "stderr");
      assertEquals(
        resourceMap["timing"]["timing"].tags.category,
        "performance",
      );

      // Query by tags
      assertExists(context.data);

      const resources = await context.data.findByTag("type", "resource");
      assertEquals(resources.length, 4);

      const perfItems = await context.data.findByTag(
        "category",
        "performance",
      );
      assertEquals(perfItems.length, 1);
    } finally {
      catalog.close();
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Data Tagging: empty findByTag results", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    // Query in empty repo
    const results = await context.data.findByTag("type", "anything");
    assertEquals(results, []);
  });
});

Deno.test("Data Tagging: special characters in tag values", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:special-tags");

    const definition = Definition.create({
      name: "special-tags-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const data = Data.create({
      name: "special-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "resource",
        "aws:region": "us-east-1",
        "k8s.io/name": "my-pod",
        "version": "1.2.3-beta",
      },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      definition.id,
      data,
      new TextEncoder().encode(JSON.stringify({ special: true })),
    );

    const loaded = await dataRepo.findByName(
      type,
      definition.id,
      "special-data",
    );
    assertExists(loaded);
    assertEquals(loaded.tags["aws:region"], "us-east-1");
    assertEquals(loaded.tags["k8s.io/name"], "my-pod");
    assertEquals(loaded.tags["version"], "1.2.3-beta");
  });
});

Deno.test("Data Tagging: tag-based organization in findAllForModel", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:find-all");

    // Create data with different types
    const dataItems = [
      { name: "data-1", type: "resource" },
      { name: "data-2", type: "resource" },
      { name: "data-3", type: "log" },
      { name: "data-4", type: "config" },
    ];

    for (const item of dataItems) {
      const data = Data.create({
        name: item.name,
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: item.type },
        ownerDefinition: owner,
      });

      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`content for ${item.name}`),
      );
    }

    const allData = await repo.findAllForModel(type, modelId);
    assertEquals(allData.length, 4);

    // Organize by type tag
    const byType: Record<string, typeof allData> = {};
    for (const d of allData) {
      const t = d.tags.type;
      if (!byType[t]) byType[t] = [];
      byType[t].push(d);
    }

    assertEquals(byType["resource"].length, 2);
    assertEquals(byType["log"].length, 1);
    assertEquals(byType["config"].length, 1);
  });
});
