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

import { assertEquals, assertExists } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { ModelResolver } from "./model_resolver.ts";
import { Definition } from "../definitions/definition.ts";
import { Data } from "../data/data.ts";
import { ModelType } from "../models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolver-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, ".swamp", "definitions"));
  await ensureDir(join(dir, ".swamp", "vault"));
}

const owner = {
  ownerType: "model-method" as const,
  ownerRef: "test/model:test",
};

// ============================================================================
// data.latest() reads from disk synchronously
// ============================================================================

Deno.test("data.latest() reads from disk synchronously", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "my-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data = Data.create({
      name: "info",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: 42 })),
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const result = ctx.data.latest("my-model", "info");
    assertExists(result);
    assertEquals(result.attributes.value, 42);
  });
});

// ============================================================================
// data.latest() sees data written after buildContext()
// ============================================================================

Deno.test("data.latest() sees data written after buildContext()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "fresh-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Write initial data
    const data = Data.create({
      name: "state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ step: 1 })),
    );

    // Build context
    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    // Write new data AFTER context was built
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ step: 2 })),
    );

    // data.latest() should see the fresh version (sync disk read)
    assertExists(ctx.data);
    const result = ctx.data.latest("fresh-model", "state");
    assertExists(result);
    assertEquals(result.attributes.step, 2);
    assertEquals(result.version, 2);
  });
});

// ============================================================================
// data.version() reads specific version from disk
// ============================================================================

Deno.test("data.version() reads specific version from disk", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "versioned",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data = Data.create({
      name: "history",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ step: i })),
      );
    }

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const v2 = ctx.data.version("versioned", "history", 2);
    assertExists(v2);
    assertEquals(v2.attributes.step, 2);
    assertEquals(v2.version, 2);
  });
});

// ============================================================================
// data.listVersions() returns sorted version numbers
// ============================================================================

Deno.test("data.listVersions() returns sorted version numbers", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "list-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data = Data.create({
      name: "logs",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "log" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 5; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(`entry ${i}`),
      );
    }

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const versions = ctx.data.listVersions("list-model", "logs");
    assertEquals(versions, [1, 2, 3, 4, 5]);
  });
});

// ============================================================================
// data.findByTag() returns matching records
// ============================================================================

Deno.test("data.findByTag() returns matching records from disk", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "tag-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Create resource data
    const resourceData = Data.create({
      name: "resource-item",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", env: "prod" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      resourceData,
      new TextEncoder().encode(JSON.stringify({ key: "value" })),
    );

    // Create non-matching data
    const otherData = Data.create({
      name: "other-item",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", env: "staging" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      otherData,
      new TextEncoder().encode(JSON.stringify({ key: "other" })),
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const prodResults = ctx.data.findByTag("env", "prod");
    assertEquals(prodResults.length, 1);
    assertEquals(prodResults[0].name, "resource-item");

    const stagingResults = ctx.data.findByTag("env", "staging");
    assertEquals(stagingResults.length, 1);
    assertEquals(stagingResults[0].name, "other-item");

    const noResults = ctx.data.findByTag("env", "dev");
    assertEquals(noResults.length, 0);
  });
});

// ============================================================================
// data.findByTag() deduplicates across coordinate sets
// ============================================================================

Deno.test("data.findByTag() deduplicates when data exists under orphan coordinates", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    // Step 1: Create model and save data under its UUID
    const originalModel = Definition.create({
      name: "dup-model",
      globalArguments: {},
    });
    await defRepo.save(type, originalModel);

    const data = Data.create({
      name: "tagged-item",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", env: "prod", modelName: "dup-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      originalModel.id,
      data,
      new TextEncoder().encode(JSON.stringify({ v: 1 })),
    );

    // Step 2: Delete and recreate model with new UUID
    await defRepo.delete(type, originalModel.id);
    const recreatedModel = Definition.create({
      name: "dup-model",
      globalArguments: {},
    });
    await defRepo.save(type, recreatedModel);

    // Step 3: Build context — orphan recovery maps old UUID data to new model name
    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);

    // findByTag should return the record only once, not duplicated
    const results = ctx.data.findByTag("env", "prod");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "tagged-item");
  });
});

// ============================================================================
// data.findBySpec() returns records matching specName tag
// ============================================================================

Deno.test("data.findBySpec() returns records matching specName tag", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "spec-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Create items with specName tag
    const subnetA = Data.create({
      name: "subnet-a",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "subnet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      subnetA,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.1.0/24" })),
    );

    const subnetB = Data.create({
      name: "subnet-b",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "subnet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      subnetB,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.2.0/24" })),
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const results = ctx.data.findBySpec("spec-model", "subnet");
    assertEquals(results.length, 2);
    assertEquals(results.some((r) => r.name === "subnet-a"), true);
    assertEquals(results.some((r) => r.name === "subnet-b"), true);
  });
});

Deno.test("data.findBySpec() returns only latest version when multiple versions exist", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "spec-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Create a data entry and save it multiple times to create multiple versions
    const subnet = Data.create({
      name: "subnet-versioned",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "subnet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      subnet,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.1.0/24" })),
    );
    await dataRepo.save(
      type,
      model.id,
      subnet,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.2.0/24" })),
    );
    await dataRepo.save(
      type,
      model.id,
      subnet,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.3.0/24" })),
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const results = ctx.data.findBySpec("spec-model", "subnet");
    // Should return only 1 record (the latest version), not 3
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "subnet-versioned");
  });
});

Deno.test("data.findByTag() returns only latest version when multiple versions exist", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "tag-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Create a data entry and save it multiple times to create multiple versions
    const item = Data.create({
      name: "tagged-versioned",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", env: "staging" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      item,
      new TextEncoder().encode(JSON.stringify({ v: 1 })),
    );
    await dataRepo.save(
      type,
      model.id,
      item,
      new TextEncoder().encode(JSON.stringify({ v: 2 })),
    );
    await dataRepo.save(
      type,
      model.id,
      item,
      new TextEncoder().encode(JSON.stringify({ v: 3 })),
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    const results = ctx.data.findByTag("env", "staging");
    // Should return only 1 record (the latest version), not 3
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "tagged-versioned");
  });
});

// ============================================================================
// Graceful handling of missing models/data
// ============================================================================

Deno.test("data.* returns null/empty for missing model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    assertEquals(ctx.data.latest("nonexistent", "data"), null);
    assertEquals(ctx.data.version("nonexistent", "data", 1), null);
    assertEquals(ctx.data.listVersions("nonexistent", "data"), []);
    assertEquals(ctx.data.findByTag("key", "value"), []);
    assertEquals(ctx.data.findBySpec("nonexistent", "spec"), []);
  });
});

Deno.test("data.* returns null/empty for missing data name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "empty-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext();

    assertExists(ctx.data);
    assertEquals(ctx.data.latest("empty-model", "nonexistent"), null);
    assertEquals(ctx.data.version("empty-model", "nonexistent", 1), null);
    assertEquals(ctx.data.listVersions("empty-model", "nonexistent"), []);
  });
});
