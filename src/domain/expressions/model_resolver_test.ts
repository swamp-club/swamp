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

import { RunSensitiveValues, SecretRedactor } from "../secrets/mod.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  type CelArgEvaluator,
  type ExpressionContext,
  ModelResolver,
} from "./model_resolver.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import { MockVaultProvider } from "../vaults/mock_vault_provider.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import { Definition } from "../definitions/definition.ts";
import { Data } from "../data/data.ts";
import { ModelType } from "../models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../data/data_query_service.ts";
import type { DataRecord } from "../data/data_record.ts";
import type { Namespace } from "../data/namespace.ts";
import {
  createEphemeralStore,
  wrapWithEphemeral,
} from "../../infrastructure/persistence/ephemeral_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolver-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
  await ensureDir(join(dir, "vaults"));
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
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", modelName: "my-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: 42 })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const result = await ctx.data.latest("my-model", "info");
    assertExists(result);
    assertEquals(result.attributes.value, 42);
    catalog.close();
  });
});

// ============================================================================
// data.latest() sees data written after buildContext()
// ============================================================================

Deno.test("data.latest() sees data written after buildContext()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", modelName: "fresh-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ step: 1 })),
    );

    // Build context
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    // Write new data AFTER context was built
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ step: 2 })),
    );

    // Re-populate catalog so latest() picks up the new version
    catalog.invalidate();
    await dqs.query('name == ""');

    // data.latest() should see the fresh version
    assertExists(ctx.data);
    const result = await ctx.data.latest("fresh-model", "state");
    assertExists(result);
    assertEquals(result.attributes.step, 2);
    assertEquals(result.version, 2);
    catalog.close();
  });
});

// ============================================================================
// data.version() reads specific version from disk
// ============================================================================

Deno.test("data.version() reads specific version from disk", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
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
      tags: { type: "resource", modelName: "versioned" },
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

    const dqs = new DataQueryService(catalogStore, dataRepo);
    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const v2 = await ctx.data.version("versioned", "history", 2);
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
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
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
      tags: { type: "log", modelName: "list-model" },
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

    const dqs = new DataQueryService(catalogStore, dataRepo);
    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

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
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", env: "prod", modelName: "tag-model" },
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
      tags: { type: "resource", env: "staging", modelName: "tag-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      otherData,
      new TextEncoder().encode(JSON.stringify({ key: "other" })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const prodResults = await ctx.data.findByTag("env", "prod");
    assertEquals(prodResults.length, 1);
    assertEquals(prodResults[0].name, "resource-item");

    const stagingResults = await ctx.data.findByTag("env", "staging");
    assertEquals(stagingResults.length, 1);
    assertEquals(stagingResults[0].name, "other-item");

    const noResults = await ctx.data.findByTag("env", "dev");
    assertEquals(noResults.length, 0);
    catalog.close();
  });
});

// ============================================================================
// data.findByTag() deduplicates across coordinate sets
// ============================================================================

Deno.test("data.findByTag() deduplicates when data exists under orphan coordinates", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);

    // findByTag should return the record only once, not duplicated
    const results = await ctx.data.findByTag("env", "prod");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "tagged-item");
    catalog.close();
  });
});

Deno.test("data.findByTag() deduplicates when both old and new UUIDs have data for same name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    // Step 1: Create model and save data under its UUID
    const originalModel = Definition.create({
      name: "dup-model",
      globalArguments: {},
    });
    await defRepo.save(type, originalModel);

    const dataV1 = Data.create({
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
      dataV1,
      new TextEncoder().encode(JSON.stringify({ v: 1 })),
    );

    // Step 2: Delete and recreate model with new UUID
    await defRepo.delete(type, originalModel.id);
    const recreatedModel = Definition.create({
      name: "dup-model",
      globalArguments: {},
    });
    await defRepo.save(type, recreatedModel);

    // Step 3: Save data with same name under new UUID
    const dataV2 = Data.create({
      name: "tagged-item",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", env: "prod", modelName: "dup-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      recreatedModel.id,
      dataV2,
      new TextEncoder().encode(JSON.stringify({ v: 2 })),
    );

    // Step 4: Build context — both UUIDs have data for "tagged-item"
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);

    // Both old and new UUID entries exist in the catalog; deduplication
    // keeps only the most recently created record for each data name.
    const results = await ctx.data.findByTag("env", "prod");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "tagged-item");
    catalog.close();
  });
});

// ============================================================================
// data.findBySpec() returns records matching specName tag
// ============================================================================

Deno.test("data.findBySpec() returns records matching specName tag", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", specName: "subnet", modelName: "spec-model" },
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
      tags: { type: "resource", specName: "subnet", modelName: "spec-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      subnetB,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.2.0/24" })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const results = await ctx.data.findBySpec("spec-model", "subnet");
    assertEquals(results.length, 2);
    assertEquals(results.some((r) => r.name === "subnet-a"), true);
    assertEquals(results.some((r) => r.name === "subnet-b"), true);
    catalog.close();
  });
});

Deno.test("data.findBySpec() deduplicates when both old and new UUIDs have data for same name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    // Step 1: Create model and save data under its UUID
    const originalModel = Definition.create({
      name: "spec-model",
      globalArguments: {},
    });
    await defRepo.save(type, originalModel);

    const dataV1 = Data.create({
      name: "subnet-a",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "subnet", modelName: "spec-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      originalModel.id,
      dataV1,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.1.0/24" })),
    );

    // Step 2: Delete and recreate model with new UUID
    await defRepo.delete(type, originalModel.id);
    const recreatedModel = Definition.create({
      name: "spec-model",
      globalArguments: {},
    });
    await defRepo.save(type, recreatedModel);

    // Step 3: Save data with same name under new UUID
    const dataV2 = Data.create({
      name: "subnet-a",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "subnet", modelName: "spec-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      recreatedModel.id,
      dataV2,
      new TextEncoder().encode(JSON.stringify({ cidr: "10.0.1.0/24-v2" })),
    );

    // Step 4: Build context — both UUIDs have data for "subnet-a"
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);

    // Both old and new UUID entries exist in the catalog; deduplication
    // keeps only the most recently created record for each data name.
    const results = await ctx.data.findBySpec("spec-model", "subnet");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "subnet-a");
    catalog.close();
  });
});

Deno.test("data.findBySpec() returns only latest version when multiple versions exist", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", specName: "subnet", modelName: "spec-model" },
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
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const results = await ctx.data.findBySpec("spec-model", "subnet");
    // Should return only 1 record (the latest version), not 3
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "subnet-versioned");
    catalog.close();
  });
});

Deno.test("data.findByTag() returns only latest version when multiple versions exist", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "resource", env: "staging", modelName: "tag-model" },
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
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const results = await ctx.data.findByTag("env", "staging");
    // Should return only 1 record (the latest version), not 3
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "tagged-versioned");
    catalog.close();
  });
});

// ============================================================================
// Graceful handling of missing models/data
// ============================================================================

Deno.test("data.* returns null/empty for missing model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    assertEquals(await ctx.data.latest("nonexistent", "data"), null);
    assertEquals(await ctx.data.version("nonexistent", "data", 1), null);
    assertEquals(ctx.data.listVersions("nonexistent", "data"), []);
    assertEquals(await ctx.data.findByTag("key", "value"), []);
    assertEquals(await ctx.data.findBySpec("nonexistent", "spec"), []);
  });
});

Deno.test("data.* returns null/empty for missing data name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "empty-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    assertEquals(await ctx.data.latest("empty-model", "nonexistent"), null);
    assertEquals(await ctx.data.version("empty-model", "nonexistent", 1), null);
    assertEquals(ctx.data.listVersions("empty-model", "nonexistent"), []);
  });
});

// ============================================================================
// data.findBySpec() run-scoping via workflowRunId
// ============================================================================

Deno.test("findBySpec: returns all data regardless of workflowRunId", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "dedup-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Data from run-1
    const episodeA = Data.create({
      name: "episode-a",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "episode",
        modelName: "dedup-model",
        workflowRunId: "run-1",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      episodeA,
      new TextEncoder().encode(JSON.stringify({ title: "Episode A" })),
    );

    // Data from run-2
    const episodeB = Data.create({
      name: "episode-b",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "episode",
        modelName: "dedup-model",
        workflowRunId: "run-2",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      episodeB,
      new TextEncoder().encode(JSON.stringify({ title: "Episode B" })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    // findBySpec no longer scopes by workflowRunId — returns all data
    const allResults = await ctx.data.findBySpec("dedup-model", "episode");
    assertEquals(allResults.length, 2);
    assertEquals(allResults.some((r) => r.name === "episode-a"), true);
    assertEquals(allResults.some((r) => r.name === "episode-b"), true);

    // Even with workflowRunId set, findBySpec returns ALL data
    ctx.workflowRunId = "run-1";
    const run1Results = await ctx.data.findBySpec("dedup-model", "episode");
    assertEquals(run1Results.length, 2);
    catalog.close();
  });
});

Deno.test("findBySpec: returns all data when workflowRunId is not set", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "global-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    // Data with no workflowRunId tag (e.g., written outside a workflow)
    const dataNoRun = Data.create({
      name: "item-standalone",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "item", modelName: "global-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      dataNoRun,
      new TextEncoder().encode(JSON.stringify({ value: 1 })),
    );

    // Data with a workflowRunId tag
    const dataWithRun = Data.create({
      name: "item-from-workflow",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "item",
        modelName: "global-model",
        workflowRunId: "run-abc",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      dataWithRun,
      new TextEncoder().encode(JSON.stringify({ value: 2 })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    // No workflowRunId set — returns all data regardless of tags
    const allResults = await ctx.data.findBySpec("global-model", "item");
    assertEquals(allResults.length, 2);
    catalog.close();
  });
});

// ============================================================================
// data.findBySpec() returns distinct records from different workflow steps
// ============================================================================

Deno.test("findBySpec: returns both records when same data name written by different steps", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "probe",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const resultA = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "result", modelName: "probe" },
      ownerDefinition: {
        ...owner,
        stepName: "run-good",
      },
    });
    await dataRepo.save(
      type,
      model.id,
      resultA,
      new TextEncoder().encode(JSON.stringify({ exitCode: 0 })),
    );

    const resultB = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "result", modelName: "probe" },
      ownerDefinition: {
        ...owner,
        stepName: "run-bad",
      },
    });
    await dataRepo.save(
      type,
      model.id,
      resultB,
      new TextEncoder().encode(JSON.stringify({ exitCode: 7 })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    const results = await ctx.data.findBySpec("probe", "result");
    assertEquals(results.length, 2);

    const exitCodes = results.map(
      (r) => (r.attributes as { exitCode: number }).exitCode,
    ).sort();
    assertEquals(exitCodes, [0, 7]);
    catalog.close();
  });
});

/**
 * Writes `result` for model `probe` from two workflow steps, run-good
 * (exitCode 0) then run-bad (exitCode 7), and returns a resolver context.
 */
async function buildTwoStepContext(repoDir: string) {
  await setupRepoDir(repoDir);
  const defRepo = new YamlDefinitionRepository(repoDir);
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    catalog,
  );
  const type = ModelType.create("test/model");
  const model = Definition.create({ name: "probe", globalArguments: {} });
  await defRepo.save(type, model);

  for (const [stepName, exitCode] of [["run-good", 0], ["run-bad", 7]]) {
    const data = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "result",
        modelName: "probe",
        suite: "smoke",
      },
      ownerDefinition: { ...owner, stepName: stepName as string },
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ exitCode })),
    );
  }

  const dqs = new DataQueryService(catalog, dataRepo);
  await dqs.query('name == ""');
  const resolver = new ModelResolver(defRepo, {
    repoDir,
    dataRepo,
    dataQueryService: dqs,
  });
  const ctx = await resolver.buildContext(new RunSensitiveValues());
  assertExists(ctx.data);
  return { ctx, data: ctx.data, catalog };
}

Deno.test("findByTag: returns each step's latest when steps wrote the same data name", async () => {
  await withTempDir(async (repoDir) => {
    const { data, catalog } = await buildTwoStepContext(repoDir);

    const results = await data.findByTag("suite", "smoke");
    const exitCodes = results.map(
      (r) => (r.attributes as { exitCode: number }).exitCode,
    ).sort();
    assertEquals(exitCodes, [0, 7]);
    catalog.close();
  });
});

Deno.test("data.query and data.latest return only the newest version when steps wrote the same name (swamp-club#2520)", async () => {
  await withTempDir(async (repoDir) => {
    const { data, catalog } = await buildTwoStepContext(repoDir);

    const queried = await data.query(
      'modelName == "probe" && name == "result"',
    ) as DataRecord[];
    assertEquals(queried.length, 1);
    assertEquals(queried[0].version, 2);
    assertEquals(queried[0].isLatest, true);

    // The data name equals its spec name: two latest rows used to make
    // this lookup ambiguous.
    const latest = await data.latest("probe", "result");
    assertEquals(
      (latest?.attributes as { exitCode: number }).exitCode,
      7,
    );
    const wildcard = await data.latest("*:probe", "result");
    assertEquals(wildcard?.version, 2);

    const bySpec = await data.findBySpec("probe", "result");
    const older = bySpec.find((r) => r.version === 1);
    assertEquals(older?.isLatest, false);
    catalog.close();
  });
});

Deno.test("findBySpec: deduplicates same-step same-name to latest version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "probe",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const stepOwner = { ...owner, stepName: "run-good" };

    const v1 = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "result", modelName: "probe" },
      ownerDefinition: stepOwner,
    });
    await dataRepo.save(
      type,
      model.id,
      v1,
      new TextEncoder().encode(JSON.stringify({ attempt: 1 })),
    );

    const v2 = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "result", modelName: "probe" },
      ownerDefinition: stepOwner,
    });
    await dataRepo.save(
      type,
      model.id,
      v2,
      new TextEncoder().encode(JSON.stringify({ attempt: 2 })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    const results = await ctx.data.findBySpec("probe", "result");
    assertEquals(results.length, 1);
    assertEquals(
      (results[0].attributes as { attempt: number }).attempt,
      2,
    );
    catalog.close();
  });
});

// ============================================================================
// workers.connected() returns only non-disconnected workers
// ============================================================================

Deno.test("workers.connected() returns only non-disconnected workers", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const workerType = ModelType.create("swamp/worker");

    const worker1 = Definition.create({
      name: "worker-01",
      globalArguments: {},
    });
    await defRepo.save(workerType, worker1);

    const worker2 = Definition.create({
      name: "worker-02",
      globalArguments: {},
    });
    await defRepo.save(workerType, worker2);

    const worker3 = Definition.create({
      name: "worker-03",
      globalArguments: {},
    });
    await defRepo.save(workerType, worker3);

    const workerState = (name: string, status: string) =>
      JSON.stringify({
        name,
        instanceUuid: `uuid-${name}`,
        tokenName: "tok",
        status,
        labels: {},
        platform: "linux",
        arch: "x86_64",
        swampVersion: "1.0.0",
        protocolVersion: 1,
        enrolledAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        capacity: 1,
        activeDispatchIds: [],
      });

    for (
      const [def, status] of [
        [worker1, "idle"],
        [worker2, "disconnected"],
        [worker3, "busy"],
      ] as const
    ) {
      const data = Data.create({
        name: "state-main",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: {
          type: "resource",
          specName: "state",
          modelName: def.name,
        },
        ownerDefinition: owner,
      });
      await dataRepo.save(
        workerType,
        def.id,
        data,
        new TextEncoder().encode(workerState(def.name, status)),
      );
    }

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.workers);
    const connected = await ctx.workers.connected();
    assertEquals(connected.length, 2);
    const names = connected.map((r) => r.attributes.name).sort();
    assertEquals(names, ["worker-01", "worker-03"]);
    catalog.close();
  });
});

Deno.test("workers.connected() returns empty array when all workers disconnected", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const workerType = ModelType.create("swamp/worker");

    const worker1 = Definition.create({
      name: "stale-worker",
      globalArguments: {},
    });
    await defRepo.save(workerType, worker1);

    const data = Data.create({
      name: "state-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: {
        type: "resource",
        specName: "state",
        modelName: "stale-worker",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      workerType,
      worker1.id,
      data,
      new TextEncoder().encode(JSON.stringify({
        name: "stale-worker",
        instanceUuid: "uuid-stale",
        tokenName: "tok",
        status: "disconnected",
        labels: {},
        platform: "linux",
        arch: "x86_64",
        swampVersion: "1.0.0",
        protocolVersion: 1,
        enrolledAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        capacity: 1,
        activeDispatchIds: [],
      })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.workers);
    const connected = await ctx.workers.connected();
    assertEquals(connected.length, 0);
    catalog.close();
  });
});

// ============================================================================
// latest() always returns fresh data from disk (no caching)
// ============================================================================

Deno.test("latest: returns fresh data after intervening write", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "live-model",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "live-model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: "old" })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    const first = await ctx.data.latest("live-model", "result");
    assertExists(first);
    assertEquals(first.attributes.value, "old");

    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: "new" })),
    );

    const fresh = await ctx.data.latest("live-model", "result");
    assertExists(fresh);
    assertEquals(fresh.attributes.value, "new");
    catalog.close();
  });
});

Deno.test("latest: returns data written after initial miss", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "late-writer",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    const miss = await ctx.data.latest("late-writer", "result");
    assertEquals(miss, null);

    const data = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "late-writer" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ appeared: true })),
    );

    const found = await ctx.data.latest("late-writer", "result");
    assertExists(found);
    assertEquals(found.attributes.appeared, true);
    catalog.close();
  });
});

// ============================================================================
// data.latest() throws on ambiguous specName matches
// ============================================================================

Deno.test("data.latest() throws on ambiguous specName matches", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "fleet",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data1 = Data.create({
      name: "run-exec-thinkpad",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "runResult", modelName: "fleet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data1,
      new TextEncoder().encode(JSON.stringify({ hostname: "thinkpad" })),
    );

    const data2 = Data.create({
      name: "run-exec-clara",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "runResult", modelName: "fleet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data2,
      new TextEncoder().encode(JSON.stringify({ hostname: "clara" })),
    );

    const data3 = Data.create({
      name: "runResult",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "runResult", modelName: "fleet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data3,
      new TextEncoder().encode(JSON.stringify({ hostname: "default" })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const data = ctx.data;
    await assertRejects(
      () => data.latest("fleet", "runResult"),
      Error,
      "Ambiguous data.latest() match",
    );
    catalog.close();
  });
});

Deno.test("data.latest() passes when specName is unique", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "fleet",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data1 = Data.create({
      name: "scan-result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "scanResult", modelName: "fleet" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data1,
      new TextEncoder().encode(JSON.stringify({ status: "ok" })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const result = await ctx.data.latest("fleet", "scan-result");
    assertExists(result);
    assertEquals(result.attributes.status, "ok");
    catalog.close();
  });
});

Deno.test("data.latest() returns the current type's record of a model retyped in place (swamp-club#2501)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const oldType = ModelType.create("test/alpha");
    const currentType = ModelType.create("test/beta");

    // The definition file stays under the old type's directory with its
    // type field changed, as an in-place edit leaves it. save() stamps the
    // type it is given, so save under the current type and move the file.
    const model = Definition.create({ name: "m1", globalArguments: {} });
    await new YamlDefinitionRepository(repoDir).save(currentType, model);
    const modelsDir = join(repoDir, "models");
    await Deno.mkdir(join(modelsDir, oldType.toDirectoryPath()), {
      recursive: true,
    });
    await Deno.rename(
      join(modelsDir, currentType.toDirectoryPath(), "m1.yaml"),
      join(modelsDir, oldType.toDirectoryPath(), "m1.yaml"),
    );

    for (
      const [type, value] of [[oldType, "alpha"], [
        currentType,
        "beta",
      ]] as const
    ) {
      await dataRepo.save(
        type,
        model.id,
        Data.create({
          name: "foo",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", specName: "foo", modelName: "m1" },
          ownerDefinition: owner,
        }),
        new TextEncoder().encode(JSON.stringify({ v: value })),
      );
    }

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const result = await ctx.data.latest("m1", "foo");
    assertExists(result);
    assertEquals(result.attributes.v, "beta");
    catalog.close();
  });
});

Deno.test("data.latest() with exact data name skips specName ambiguity check (swamp-club#1838)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "node-provisioner",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    const data1 = Data.create({
      name: "hs",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "state",
        modelName: "node-provisioner",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data1,
      new TextEncoder().encode(JSON.stringify({ ipv4: "10.0.0.1" })),
    );

    const data2 = Data.create({
      name: "learning",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        specName: "state",
        modelName: "node-provisioner",
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data2,
      new TextEncoder().encode(JSON.stringify({ ipv4: "10.0.0.2" })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data);
    const result = await ctx.data.latest("node-provisioner", "hs");
    assertExists(result);
    assertEquals(result.attributes.ipv4, "10.0.0.1");
    catalog.close();
  });
});

// ============================================================================
// resolveVaultExpressions — dynamic CEL argument resolution
// ============================================================================

function createVaultResolver(
  secrets: Record<string, Record<string, string>>,
): ModelResolver {
  // Build a stub VaultService whose get() delegates to MockVaultProviders.
  // We can't use the real VaultService.registerVault() because it calls
  // createVaultProvider() which requires a registered vault type. Instead
  // we create a minimal duck-typed service that satisfies the ModelResolver.
  const providers = new Map<string, MockVaultProvider>();
  for (const [vaultName, vaultSecrets] of Object.entries(secrets)) {
    providers.set(vaultName, new MockVaultProvider(vaultName, vaultSecrets));
  }
  const vaultService = {
    async get(
      vaultName: string,
      secretKey: string,
    ): Promise<string> {
      const provider = providers.get(vaultName);
      if (!provider) {
        throw new Error(`Vault '${vaultName}' not found in test setup`);
      }
      return await provider.get(secretKey);
    },
  } as unknown as VaultService;

  const defRepo = {
    findAllGlobal: () => Promise.resolve([]),
  } as unknown as YamlDefinitionRepository;
  return new ModelResolver(defRepo, { vaultService });
}

function makeCelOptions(
  inputs: Record<string, unknown>,
): { celEvaluator: CelArgEvaluator; context: ExpressionContext } {
  return {
    celEvaluator: new CelEvaluator(),
    context: {
      model: {},
      env: {},
      inputs,
    },
  };
}

Deno.test("resolveVaultExpressions: quoted args used verbatim (existing behaviour)", async () => {
  const resolver = createVaultResolver({
    "my-vault": { "api-key": "secret-123" },
  });
  const secretBag = new VaultSecretBag();
  const result = await resolver.resolveVaultExpressions(
    `vault.get('my-vault', 'api-key')`,
    undefined,
    secretBag,
  );
  assertEquals(result.startsWith('"__SWAMP_VSEC_'), true);
  assertEquals(secretBag.resolveRaw(result.slice(1, -1)), "secret-123");
});

Deno.test("resolveVaultExpressions: bare-token args CEL-evaluated from inputs", async () => {
  const resolver = createVaultResolver({
    "prod-vault": { "db-password": "prod-pass-42" },
  });
  const secretBag = new VaultSecretBag();
  const celOptions = makeCelOptions({
    vaultName: "prod-vault",
    secretKey: "db-password",
  });
  const result = await resolver.resolveVaultExpressions(
    `vault.get(inputs.vaultName, inputs.secretKey)`,
    undefined,
    secretBag,
    celOptions,
  );
  assertEquals(result.startsWith('"__SWAMP_VSEC_'), true);
  assertEquals(secretBag.resolveRaw(result.slice(1, -1)), "prod-pass-42");
});

Deno.test("resolveVaultExpressions: mixed literal/dynamic args", async () => {
  const resolver = createVaultResolver({
    "infra": { "prod-key": "infra-secret" },
  });
  const secretBag = new VaultSecretBag();
  const celOptions = makeCelOptions({ secretKey: "prod-key" });
  const result = await resolver.resolveVaultExpressions(
    `vault.get('infra', inputs.secretKey)`,
    undefined,
    secretBag,
    celOptions,
  );
  assertEquals(result.startsWith('"__SWAMP_VSEC_'), true);
  assertEquals(secretBag.resolveRaw(result.slice(1, -1)), "infra-secret");
});

Deno.test("resolveVaultExpressions: bare-token fallback for non-CEL tokens", async () => {
  const resolver = createVaultResolver({
    "my-vault": { "my-key": "fallback-secret" },
  });
  const secretBag = new VaultSecretBag();
  const celOptions = makeCelOptions({});
  // "my-vault" contains a hyphen — not valid CEL — should fall back to verbatim
  const result = await resolver.resolveVaultExpressions(
    `vault.get(my-vault, my-key)`,
    undefined,
    secretBag,
    celOptions,
  );
  assertEquals(result.startsWith('"__SWAMP_VSEC_'), true);
  assertEquals(secretBag.resolveRaw(result.slice(1, -1)), "fallback-secret");
});

Deno.test("resolveVaultExpressions: hard error for valid CEL with missing input", async () => {
  const resolver = createVaultResolver({
    "any-vault": { "any-key": "value" },
  });
  const secretBag = new VaultSecretBag();
  const celOptions = makeCelOptions({});
  await assertRejects(
    () =>
      resolver.resolveVaultExpressions(
        `vault.get(inputs.missingVault, 'key')`,
        undefined,
        secretBag,
        celOptions,
      ),
    Error,
    "Failed to resolve dynamic vault name",
  );
});

Deno.test("resolveVaultExpressions: non-string CEL result throws", async () => {
  const resolver = createVaultResolver({
    "any-vault": { "any-key": "value" },
  });
  const secretBag = new VaultSecretBag();
  const celOptions = makeCelOptions({ vaultNum: 42 });
  await assertRejects(
    () =>
      resolver.resolveVaultExpressions(
        `vault.get(inputs.vaultNum, 'key')`,
        undefined,
        secretBag,
        celOptions,
      ),
    Error,
    "must resolve to a string",
  );
});

Deno.test("resolveVaultExpressions: without celOptions bare tokens used verbatim", async () => {
  const resolver = createVaultResolver({
    "my-vault": { "my-key": "plain-secret" },
  });
  const secretBag = new VaultSecretBag();
  // No celOptions — bare tokens should be used verbatim (backwards compat)
  const result = await resolver.resolveVaultExpressions(
    `vault.get(my-vault, my-key)`,
    undefined,
    secretBag,
  );
  assertEquals(result.startsWith('"__SWAMP_VSEC_'), true);
  assertEquals(secretBag.resolveRaw(result.slice(1, -1)), "plain-secret");
});

// --- resolveModel gates its exact-ID fallback on UUID syntax ---
//
// After a name miss, the fallback walked every definition in the repository
// (findAllGlobal) and compared IDs with strict equality — work a non-UUID ref
// can never benefit from. The outcome must be identical either way.
Deno.test("ModelResolver.resolveModel resolves a model by name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({ name: "by-name" });
    await repo.save(type, definition);

    const resolved = await new ModelResolver(repo).resolveModel("by-name");

    assertEquals(resolved.definition.id, definition.id);
    assertEquals(resolved.type.normalized, type.normalized);
  });
});

Deno.test("ModelResolver.resolveModel resolves a model by UUID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    const definition = Definition.create({ name: "by-uuid" });
    await repo.save(type, definition);

    const resolved = await new ModelResolver(repo).resolveModel(definition.id);

    assertEquals(resolved.definition.id, definition.id);
    assertEquals(resolved.type.normalized, type.normalized);
  });
});

Deno.test("ModelResolver.resolveModel throws ModelNotFoundError for a non-UUID miss", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    await repo.save(type, Definition.create({ name: "resident" }));

    // Gating the ID fallback must not change the failure the caller sees.
    await assertRejects(
      () => new ModelResolver(repo).resolveModel("missing-model-name"),
      Error,
      "missing-model-name",
    );
  });
});

Deno.test("ModelResolver.resolveModel throws ModelNotFoundError for a UUID miss", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("command/shell");
    await repo.save(type, Definition.create({ name: "resident" }));

    const absent = "550e8400-e29b-41d4-a716-446655440000";
    await assertRejects(
      () => new ModelResolver(repo).resolveModel(absent),
      Error,
      absent,
    );
  });
});

// ============================================================================
// buildContext / buildLightContext — definition scanning (swamp-club#2123)
// ============================================================================

Deno.test("buildContext reuses definitions supplied by the caller", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "supplied-model",
      globalArguments: { region: "us-east-1" },
    });
    await defRepo.save(type, model);
    const definitions = await defRepo.findAllGlobal();

    let walks = 0;
    const countingRepo = {
      findAllGlobal: () => {
        walks++;
        return Promise.resolve(definitions);
      },
    } as unknown as YamlDefinitionRepository;

    const resolver = new ModelResolver(countingRepo, { repoDir });
    const ctx = await resolver.buildContext(
      new RunSensitiveValues(),
      undefined,
      undefined,
      undefined,
      definitions,
    );

    assertEquals(walks, 0);
    assertEquals(
      ctx.model["supplied-model"].definition?.globalArguments.region,
      "us-east-1",
    );
  });
});

Deno.test("buildLightContext resolves data.latest for ephemeral data (swamp-club#2188)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const persistentRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const ephemeral = createEphemeralStore();
    try {
      const { dataRepo, dataQueryService } = wrapWithEphemeral(
        persistentRepo,
        catalog,
        ephemeral,
      );
      const type = ModelType.create("test/model");
      const model = Definition.create({ name: "differ" });
      await defRepo.save(type, model);

      const data = Data.create({
        name: "diff",
        contentType: "application/json",
        lifetime: "ephemeral",
        garbageCollection: 10,
        tags: { type: "resource", modelName: "differ" },
        ownerDefinition: owner,
      });
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ files: ["a.ts"] })),
      );

      const resolver = new ModelResolver(defRepo, {
        repoDir,
        dataRepo,
        dataQueryService,
      });

      const record = await resolver.buildLightContext(new RunSensitiveValues())
        .data!.latest(
          "differ",
          "diff",
        );
      assertExists(record);
      assertEquals(record.attributes.files, ["a.ts"]);
    } finally {
      ephemeral.dispose();
    }
  });
});

Deno.test("buildLightContext resolves data.latest sensitive vault refs like buildContext", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({ name: "secret-holder" });
    await defRepo.save(type, model);

    const data = Data.create({
      name: "creds",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: {
        type: "resource",
        modelName: "secret-holder",
        "_swamp.sensitiveFields": JSON.stringify(["apiKey"]),
      },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({
        apiKey: "${{ vault.get('my-vault', 'api-key') }}",
        plain: "${{ vault.get('my-vault', 'api-key') }}",
      })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const vaultService = {
      get: (_vaultName: string, _secretKey: string) =>
        Promise.resolve("secret-123"),
    } as unknown as VaultService;

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
      vaultService,
    });

    // Both data.latest paths record what they resolve, with its vault
    // source, and forward it to the run redactor (swamp-club#2171).
    const lightRedactor = new SecretRedactor();
    const lightValues = new RunSensitiveValues(lightRedactor);
    const lightCtx = resolver.buildLightContext(lightValues);
    const lightRecord = await lightCtx.data!.latest("secret-holder", "creds");
    assertExists(lightRecord);
    assertEquals(lightRecord.attributes.apiKey, "secret-123");
    // Fields the schema did not mark sensitive stay unresolved.
    assertEquals(
      lightRecord.attributes.plain,
      "${{ vault.get('my-vault', 'api-key') }}",
    );

    const fullValues = new RunSensitiveValues();
    const fullCtx = await resolver.buildContext(fullValues);
    const fullRecord = await fullCtx.data!.latest("secret-holder", "creds");
    assertExists(fullRecord);
    assertEquals(fullRecord.attributes.apiKey, lightRecord.attributes.apiKey);
    assertEquals(fullRecord.attributes.plain, lightRecord.attributes.plain);

    const expected = [{
      value: "secret-123",
      source: { vaultName: "my-vault", key: "api-key" },
    }];
    assertEquals(lightValues.list(), expected);
    assertEquals(fullValues.list(), expected);
    assertEquals(lightRedactor.redact("key=secret-123"), "key=***");
  });
});

Deno.test("data.latest records sensitive vault refs resolved through the catalog fallback", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
      );
      const type = ModelType.create("test/model");

      // The definition is never saved, so the resolver has no coordinates for
      // "orphan-holder" and data.latest() has to go through getLatestRecord().
      const model = Definition.create({ name: "orphan-holder" });

      const data = Data.create({
        name: "creds",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: {
          type: "resource",
          modelName: "orphan-holder",
          "_swamp.sensitiveFields": JSON.stringify(["apiKey"]),
        },
        ownerDefinition: owner,
      });
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({
          apiKey: "${{ vault.get('my-vault', 'api-key') }}",
          plain: "${{ vault.get('my-vault', 'api-key') }}",
        })),
      );
      const dqs = new DataQueryService(catalog, dataRepo);
      await dqs.query('name == ""');

      const vaultService = {
        get: (_vaultName: string, _secretKey: string) =>
          Promise.resolve("secret-456"),
      } as unknown as VaultService;

      const resolver = new ModelResolver(defRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
        vaultService,
      });

      const redactor = new SecretRedactor();
      const values = new RunSensitiveValues(redactor);
      const record = await resolver.buildLightContext(values).data!.latest(
        "orphan-holder",
        "creds",
      );
      assertExists(record);
      assertEquals(record.attributes.apiKey, "secret-456");
      // Fields the schema did not mark sensitive stay unresolved.
      assertEquals(
        record.attributes.plain,
        "${{ vault.get('my-vault', 'api-key') }}",
      );
      assertEquals(values.list(), [{
        value: "secret-456",
        source: { vaultName: "my-vault", key: "api-key" },
      }]);
      assertEquals(redactor.redact("key=secret-456"), "key=***");
    } finally {
      catalog.close();
    }
  });
});

// ============================================================================
// DataRecord.path — local content path for CEL data.* results (swamp-club#2288)
// ============================================================================

type HydrateMode = "restore" | "absent" | "throw";

/**
 * Saves a text/plain file-kind data item for `producer`, then (when `evict`
 * is set) removes its raw file to mimic a lazy-hydration datastore that has
 * synced metadata only. The hydrate hook restores the bytes, reports the file
 * absent, or throws, per `mode`.
 */
async function setupPathFixture(
  repoDir: string,
  opts: { evict: boolean; mode?: HydrateMode },
) {
  await setupRepoDir(repoDir);
  const defRepo = new YamlDefinitionRepository(repoDir);
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  const hydrated: string[] = [];
  const bytes = new TextEncoder().encode("hello-from-producer\n");
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    catalog,
    undefined,
    async (absPath: string) => {
      hydrated.push(absPath);
      if (opts.mode === "throw") throw new Error("remote unreachable");
      if (opts.mode === "absent") return false;
      await Deno.writeFile(absPath, bytes);
      return true;
    },
  );
  const type = ModelType.create("test/model");
  const model = Definition.create({ name: "producer", globalArguments: {} });
  await defRepo.save(type, model);
  const data = Data.create({
    name: "log",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "file", specName: "log", modelName: "producer" },
    ownerDefinition: owner,
  });
  await dataRepo.save(type, model.id, data, bytes);
  const contentPath = dataRepo.getContentPath(type, model.id, "log", 1);
  if (opts.evict) await Deno.remove(contentPath);

  const dqs = new DataQueryService(catalog, dataRepo);
  await dqs.query('name == ""');
  const resolver = new ModelResolver(defRepo, {
    repoDir,
    dataRepo,
    dataQueryService: dqs,
  });
  return { resolver, catalog, contentPath, hydrated };
}

Deno.test("data.latest(): path names the stored content file", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, contentPath, hydrated } = await setupPathFixture(
      repoDir,
      { evict: false },
    );
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const record = await ctx.data!.latest("producer", "log");
    assertEquals(record?.path, contentPath);
    assertEquals(
      await Deno.readTextFile(record!.path),
      "hello-from-producer\n",
    );
    assertEquals(hydrated.length, 0);
    catalog.close();
  });
});

Deno.test("data.latest(): the catalog fallback path also sets path", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, contentPath } = await setupPathFixture(
      repoDir,
      { evict: false },
    );
    // The light context has no model coordinates, so latest() resolves
    // through DataQueryService.getLatestRecord.
    const ctx = resolver.buildLightContext(new RunSensitiveValues());
    const record = await ctx.data!.latest("producer", "log");
    assertEquals(record?.path, contentPath);
    catalog.close();
  });
});

Deno.test("data.version(): path names the stored content file", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, contentPath } = await setupPathFixture(
      repoDir,
      { evict: false },
    );
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const record = await ctx.data!.version("producer", "log", 1);
    assertEquals(record?.path, contentPath);
    catalog.close();
  });
});

Deno.test("data.latest(): hydrates a raw file that is not local yet", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, contentPath, hydrated } = await setupPathFixture(
      repoDir,
      { evict: true, mode: "restore" },
    );
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const record = await ctx.data!.latest("producer", "log");
    assertEquals(record?.path, contentPath);
    assertEquals(hydrated, [contentPath]);
    assertEquals(
      await Deno.readTextFile(contentPath),
      "hello-from-producer\n",
    );
    catalog.close();
  });
});

Deno.test("data.latest(): path is empty when the file cannot be hydrated", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, hydrated } = await setupPathFixture(repoDir, {
      evict: true,
      mode: "absent",
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const record = await ctx.data!.latest("producer", "log");
    assertExists(record);
    assertEquals(record.path, "");
    assertEquals(hydrated.length, 1);
    catalog.close();
  });
});

Deno.test("data.latest(): a failing hydrate clears path but still returns the record", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog } = await setupPathFixture(repoDir, {
      evict: true,
      mode: "throw",
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const record = await ctx.data!.latest("producer", "log");
    assertExists(record);
    assertEquals(record.name, "log");
    assertEquals(record.path, "");
    catalog.close();
  });
});

Deno.test("data.findBySpec(): clears a missing path without downloading", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, hydrated } = await setupPathFixture(repoDir, {
      evict: true,
      mode: "restore",
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const records = await ctx.data!.findBySpec("producer", "log");
    assertEquals(records.length, 1);
    assertEquals(records[0].path, "");
    assertEquals(hydrated.length, 0);
    catalog.close();
  });
});

Deno.test("data.query(): record results and path projections carry the path", async () => {
  await withTempDir(async (repoDir) => {
    const { resolver, catalog, contentPath } = await setupPathFixture(
      repoDir,
      { evict: false },
    );
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    const records = await ctx.data!.query('modelName == "producer"');
    assertEquals(
      (records as { path: string }[]).map((r) => r.path),
      [contentPath],
    );
    const projected = await ctx.data!.query(
      'modelName == "producer"',
      "path",
    );
    assertEquals(projected, [contentPath]);
    catalog.close();
  });
});

// ============================================================================
// data.specInstanceNames() lists the data names written under a spec
// ============================================================================

Deno.test("data.specInstanceNames() lists data names of a spec, scoped like latest()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "mirror",
      globalArguments: {},
    });
    await defRepo.save(type, model);

    await dataRepo.save(
      type,
      model.id,
      Data.create({
        name: "sync-2026-01-01",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", specName: "summary", modelName: "mirror" },
        ownerDefinition: owner,
      }),
      new TextEncoder().encode(JSON.stringify({ ok: true })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertExists(ctx.data?.specInstanceNames);
    assertEquals(ctx.data.specInstanceNames("mirror", "summary"), [
      "sync-2026-01-01",
    ]);
    assertEquals(ctx.data.specInstanceNames("*:mirror", "summary"), [
      "sync-2026-01-01",
    ]);
    assertEquals(ctx.data.specInstanceNames("infra:mirror", "summary"), []);
    assertEquals(ctx.data.specInstanceNames("mirror", "other"), []);
    catalog.close();
  });
});

Deno.test("data.specInstanceNames() returns no names without a data query service", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const resolver = new ModelResolver(defRepo, { repoDir, dataRepo });
    const ctx = await resolver.buildContext(new RunSensitiveValues());

    assertEquals(ctx.data?.specInstanceNames?.("mirror", "summary") ?? [], []);
    catalog.close();
  });
});

Deno.test("resolveVaultExpressions: vault.get text inside a literal() is left as text", async () => {
  const fetched: string[] = [];
  const resolver = createVaultResolver({
    "v": { "real": "secret-1", "decoy": "secret-2" },
  });
  const inner = resolver as unknown as {
    getVaultService: () => Promise<VaultService>;
  };
  const service = await inner.getVaultService();
  const get = service.get.bind(service);
  service.get = (vaultName: string, secretKey: string, ...rest: unknown[]) => {
    fetched.push(secretKey);
    return (get as (...a: unknown[]) => Promise<string>)(
      vaultName,
      secretKey,
      ...rest,
    );
  };
  const secretBag = new VaultSecretBag();
  const result = await resolver.resolveVaultExpressions(
    `literal('{{ vault.get("v", "decoy") }}') + vault.get('v', 'real')`,
    undefined,
    secretBag,
  );
  assertEquals(fetched, ["real"]);
  assertEquals(
    result.startsWith(
      `literal('{{ vault.get("v", "decoy") }}') + "__SWAMP_VSEC_`,
    ),
    true,
  );
});

Deno.test("resolveVaultExpressions: a call that starts inside a string does not swallow the real one", async () => {
  const resolver = createVaultResolver({ "a": { "b": "secret-b" } });
  const secretBag = new VaultSecretBag();
  const result = await resolver.resolveVaultExpressions(
    `literal('vault.get(') + vault.get('a','b')`,
    undefined,
    secretBag,
  );
  assertEquals(
    result.startsWith(`literal('vault.get(') + "__SWAMP_VSEC_`),
    true,
  );
});

Deno.test("resolveVaultExpressions: a vault form only a direct call resolves is reported", async () => {
  const resolver = createVaultResolver({ "a": { "b": "secret-b" } });
  await assertRejects(
    () =>
      resolver.resolveVaultExpressions(
        `cel.bind(v, vault, v.get('a', 'b'))`,
        undefined,
        new VaultSecretBag(),
      ),
    Error,
    "Unsupported vault expression",
  );
});

Deno.test("resolveVaultExpressions: ignores member access and comments", async () => {
  const resolver = createVaultResolver({ "a": { "b": "secret-b" } });
  const value = `self.vault.get('a', 'b') // vault.get('a', 'b')`;
  assertEquals(
    await resolver.resolveVaultExpressions(
      value,
      undefined,
      new VaultSecretBag(),
    ),
    value,
  );
});

Deno.test("resolveVaultExpressions: a member reached across whitespace is not the vault namespace", async () => {
  const resolver = createVaultResolver({ "a": { "b": "secret-b" } });
  const value = `self . vault.get('a', 'b')`;
  assertEquals(
    await resolver.resolveVaultExpressions(
      value,
      undefined,
      new VaultSecretBag(),
    ),
    value,
  );
});

Deno.test("resolveVaultExpressions: a call inside another call's argument is not resolved twice", async () => {
  const resolver = createVaultResolver({ "a": { "b": "secret-b" } });
  // The outer call's bare first argument covers the inner call; only the
  // outer one is a match, so the output is never spliced out of order.
  await assertRejects(
    () =>
      resolver.resolveVaultExpressions(
        `vault.get(vault.get('a','b'), 'c')`,
        undefined,
        new VaultSecretBag(),
      ),
    Error,
  );
});

// ============================================================================
// Control-plane records are never readable from expressions (swamp-club#2756)
// ============================================================================

Deno.test("buildContext: expressions never read control-plane records", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    // Serve writes control-plane definitions to .swamp/auto-definitions.
    const autoRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      join(repoDir, ".swamp", "auto-definitions"),
      false,
    );
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const grantType = ModelType.create("swamp/grant");
    const userType = ModelType.create("test/model");

    const grant = Definition.create({ name: "grant-abc", globalArguments: {} });
    await autoRepo.save(grantType, grant);
    // A user model named like the grant, with no data of its own, so
    // model.<name> falls back to data recorded under that model name.
    const sameName = Definition.create({
      name: "grant-abc",
      globalArguments: {},
    });
    await defRepo.save(userType, sameName);
    const mine = Definition.create({ name: "mine", globalArguments: {} });
    await defRepo.save(userType, mine);

    const record = (name: string, modelName: string, specName: string) =>
      Data.create({
        name,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", modelName, specName },
        ownerDefinition: owner,
      });
    await dataRepo.save(
      grantType,
      grant.id,
      record("grant-main", "grant-abc", "grant"),
      new TextEncoder().encode(JSON.stringify({ subject: "user:adam" })),
    );
    await dataRepo.save(
      userType,
      mine.id,
      record("info", "mine", "info"),
      new TextEncoder().encode(JSON.stringify({ value: 1 })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);

    assertEquals(await ctx.data.latest("grant-abc", "grant-main"), null);
    assertEquals(await ctx.data.latest("*:grant-abc", "grant-main"), null);
    assertEquals(await ctx.data.version("grant-abc", "grant-main", 1), null);
    assertEquals(ctx.data.listVersions("grant-abc", "grant-main"), []);
    assertEquals(ctx.data.listVersions("*:grant-abc", "grant-main"), []);
    assertEquals(await ctx.data.findBySpec("grant-abc", "grant"), []);
    assertEquals(await ctx.data.findByTag("specName", "grant"), []);
    assertEquals(ctx.data.specInstanceNames!("grant-abc", "grant"), []);
    assertEquals(await ctx.data.query('modelType == "swamp/grant"'), []);
    assertEquals(
      await ctx.data.query("true", "attributes"),
      [{ value: 1 }],
    );
    assertEquals(ctx.model[grant.id], undefined);
    assertEquals(ctx.model["grant-abc"].resource, undefined);

    const own = await ctx.data.latest("mine", "info");
    assertExists(own);
    assertEquals(own.attributes.value, 1);
    catalog.close();
  });
});

Deno.test("buildContext: control-plane records stored under an @-prefixed type are not readable either", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new YamlDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    // The access commands write grants as @swamp/grant; ModelType keeps the @.
    const grantType = ModelType.create("@swamp/grant");
    const grant = Definition.create({ name: "grant-at", globalArguments: {} });
    await dataRepo.save(
      grantType,
      grant.id,
      Data.create({
        name: "grant-main",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", modelName: "grant-at", specName: "grant" },
        ownerDefinition: owner,
      }),
      new TextEncoder().encode(JSON.stringify({ subject: "user:adam" })),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    // Without the exclusion the record is there under the @ type.
    assertEquals(
      (await dqs.query('modelType == "@swamp/grant"') as unknown[]).length,
      1,
    );

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const ctx = await resolver.buildContext(new RunSensitiveValues());
    assertExists(ctx.data);
    assertEquals(await ctx.data.query('modelType == "@swamp/grant"'), []);
    assertEquals(
      await ctx.data.query('modelType == "@swamp/grant"', "attributes"),
      [],
    );
    assertEquals(await ctx.data.latest("grant-at", "grant-main"), null);
    assertEquals(ctx.data.specInstanceNames!("grant-at", "grant"), []);
    catalog.close();
  });
});

// ============================================================================
// Model instance renames (swamp-club#3029)
// ============================================================================

/** Counts name lookups, the definition walks the light context may make. */
class CountingDefinitionRepository extends YamlDefinitionRepository {
  nameLookups = 0;

  override findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    this.nameLookups++;
    return super.findByNameGlobal(name);
  }
}

type ContextKind = "full" | "light";

interface RenameFixture {
  repoDir: string;
  defRepo: CountingDefinitionRepository;
  dataRepo: FileSystemUnifiedDataRepository;
  type: ModelType;
  /** The id the model kept when it was renamed from old-name to new-name. */
  modelId: string;
  /** Writes a version of `name` under `modelId` (or another id). */
  write: (
    name: string,
    specName: string,
    modelName: string,
    modelId?: string,
    createdAt?: string,
  ) => Promise<void>;
  /**
   * Builds a context of `kind` over a freshly populated catalog, from one
   * resolver shared by every call.
   */
  context: (kind: ContextKind) => Promise<ExpressionContext>;
}

/**
 * A model renamed from old-name to new-name: its definition is saved under
 * the new name, and data is written by the caller with whichever modelName
 * tag the write would have carried.
 */
async function withRenamedModel(
  fn: (fixture: RenameFixture) => Promise<void>,
  namespace?: Namespace,
): Promise<void> {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const defRepo = new CountingDefinitionRepository(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
        undefined,
        undefined,
        namespace,
      );
      const type = ModelType.create("test/model");
      const model = Definition.create({
        name: "new-name",
        globalArguments: {},
      });
      await defRepo.save(type, model);
      const dqs = new DataQueryService(catalog, dataRepo);
      const resolver = new ModelResolver(defRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      await fn({
        repoDir,
        defRepo,
        dataRepo,
        type,
        modelId: model.id,
        write: async (
          name,
          specName,
          modelName,
          modelId = model.id,
          createdAt,
        ) => {
          const { version } = await dataRepo.save(
            type,
            modelId,
            Data.create({
              name,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 10,
              tags: { type: "resource", modelName, specName },
              ownerDefinition: owner,
            }),
            new TextEncoder().encode(JSON.stringify({ modelName })),
          );
          if (createdAt === undefined) return;
          // save() stamps createdAt itself, so pin it in the metadata the
          // catalog is rebuilt from: Data.toData() writes it as a top-level
          // createdAt key.
          const metadataPath = dataRepo.getMetadataPath(
            type,
            modelId,
            name,
            version,
          );
          const metadata = await Deno.readTextFile(metadataPath);
          await Deno.writeTextFile(
            metadataPath,
            metadata.replace(
              /^createdAt: .*$/m,
              `createdAt: ${JSON.stringify(createdAt)}`,
            ),
          );
        },
        context: async (kind) => {
          catalog.invalidate();
          await dqs.query('name == ""');
          return kind === "full"
            ? await resolver.buildContext(new RunSensitiveValues())
            : resolver.buildLightContext(new RunSensitiveValues());
        },
      });
    } finally {
      catalog.close();
    }
  });
}

for (const kind of ["full", "light"] as const) {
  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors return data written before the model instance was renamed (swamp-club#3029)`, async () => {
    await withRenamedModel(async ({ write, context }) => {
      await write("result", "result", "old-name");
      await write("result", "result", "old-name");
      const ctx = await context(kind);
      assertExists(ctx.data);
      await ctx.data.resolveModelNames?.(
        'data.listVersions("new-name", "result")',
      );

      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => [r.name, r.version]), [["result", 2]]);
      assertEquals(ctx.data.listVersions("new-name", "result"), [1, 2]);
      assertEquals(
        (await ctx.data.version("new-name", "result", 1))?.version,
        1,
      );
      assertEquals((await ctx.data.latest("new-name", "result"))?.version, 2);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors return each version once when written under both names`, async () => {
    await withRenamedModel(async ({ write, context }) => {
      await write("result", "result", "old-name");
      await write("result", "result", "old-name");
      await write("result", "result", "new-name");
      const ctx = await context(kind);
      assertExists(ctx.data);
      await ctx.data.resolveModelNames?.(
        'data.listVersions("new-name", "result")',
      );

      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => [r.name, r.version]), [["result", 3]]);
      assertEquals(ctx.data.listVersions("new-name", "result"), [1, 2, 3]);
      assertEquals(
        (await ctx.data.version("new-name", "result", 1))?.version,
        1,
      );
      assertEquals(
        (await ctx.data.version("new-name", "result", 3))?.version,
        3,
      );
      assertEquals((await ctx.data.latest("new-name", "result"))?.version, 3);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors keep orphan data under an earlier id and exclude other models`, async () => {
    await withRenamedModel(async ({ defRepo, type, write, context }) => {
      const orphanId = crypto.randomUUID();
      await write("orphan", "result", "new-name", orphanId);
      await write("result", "result", "old-name");
      const other = Definition.create({ name: "other", globalArguments: {} });
      await defRepo.save(type, other);
      await write("theirs", "result", "other", other.id);
      const ctx = await context(kind);
      assertExists(ctx.data);

      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => r.name).sort(), ["orphan", "result"]);
      assertEquals(
        (await ctx.data.version("new-name", "orphan", 1))?.modelId,
        orphanId,
      );
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors a name with no definition reads by name tag only`, async () => {
    await withRenamedModel(async ({ write, context }) => {
      await write("result", "result", "old-name");
      const ctx = await context(kind);
      assertExists(ctx.data);

      // old-name has no definition now; its name tag still matches.
      const bySpec = await ctx.data.findBySpec("old-name", "result");
      assertEquals(bySpec.map((r) => r.name), ["result"]);
      assertEquals(ctx.data.listVersions("old-name", "result"), [1]);
      assertEquals(await ctx.data.findBySpec("ghost", "result"), []);
      assertEquals(await ctx.data.version("ghost", "result", 1), null);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors treat data under an earlier id of the same name as the name tag does`, async () => {
    await withRenamedModel(async ({ write, context }) => {
      // The definition was deleted and recreated under the same name: both
      // ids carry the new-name tag. Unchanged by identity reads.
      const earlierId = crypto.randomUUID();
      await write("result", "result", "new-name", earlierId);
      await write("result", "result", "new-name", earlierId);
      await write("result", "result", "new-name");
      const ctx = await context(kind);
      assertExists(ctx.data);
      await ctx.data.resolveModelNames?.(
        'data.listVersions("new-name", "result")',
      );

      assertEquals(ctx.data.listVersions("new-name", "result"), [1, 1, 2]);
      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => r.version), [1]);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors treat a renamed model's data like data under an earlier id of its new name`, async () => {
    await withRenamedModel(async ({ modelId, write, context }) => {
      // An earlier definition of new-name wrote result v1 and v2; the current
      // one wrote result v1 as tmp-name before it was renamed.
      const earlierId = crypto.randomUUID();
      await write("result", "result", "new-name", earlierId);
      await write("result", "result", "new-name", earlierId);
      await write("result", "result", "tmp-name");
      const ctx = await context(kind);
      assertExists(ctx.data);
      await ctx.data.resolveModelNames?.(
        'data.listVersions("new-name", "result")',
      );

      assertEquals(ctx.data.listVersions("new-name", "result"), [1, 1, 2]);
      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => r.modelId), [modelId]);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors prefer the current id's record when a renamed model's write ties an earlier id's (swamp-club#3043)`, async () => {
    await withRenamedModel(async ({ modelId, write, context }) => {
      const earlierId = crypto.randomUUID();
      const at = "2026-01-01T00:00:00.000Z";
      await write("result", "result", "new-name", earlierId, at);
      await write("result", "result", "new-name", earlierId, at);
      await write("result", "result", "tmp-name", undefined, at);
      const ctx = await context(kind);
      assertExists(ctx.data);

      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => [r.modelId, r.createdAt]), [[
        modelId,
        at,
      ]]);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors prefer the current id's record when an earlier id of the same name ties it (swamp-club#3043)`, async () => {
    await withRenamedModel(async ({ modelId, write, context }) => {
      const earlierId = crypto.randomUUID();
      const at = "2026-01-01T00:00:00.000Z";
      await write("result", "result", "new-name", earlierId, at);
      await write("result", "result", "new-name", earlierId, at);
      await write("result", "result", "new-name", undefined, at);
      const ctx = await context(kind);
      assertExists(ctx.data);

      const bySpec = await ctx.data.findBySpec("new-name", "result");
      assertEquals(bySpec.map((r) => [r.modelId, r.version, r.createdAt]), [
        [modelId, 1, at],
      ]);
    });
  });

  Deno.test(`ModelResolver.${kind === "full" ? "buildContext" : "buildLightContext"}: data accessors namespaced and wildcard names read by name tag only`, async () => {
    await withRenamedModel(async ({ dataRepo, write, context }) => {
      await write("result", "result", "old-name");
      await write("result", "result", "new-name");
      const ctx = await context(kind);
      assertExists(ctx.data);
      const named = `${dataRepo.namespace}:new-name`;
      await ctx.data.resolveModelNames?.(
        `data.listVersions("${named}", "result")`,
      );

      for (const ref of [named, "*:new-name"]) {
        assertEquals(ctx.data.listVersions(ref, "result"), [2]);
        assertEquals(await ctx.data.version(ref, "result", 1), null);
      }
    }, "team" as Namespace);
  });
}

Deno.test("ModelResolver.buildContext: data accessors make no definition lookup", async () => {
  await withRenamedModel(async ({ defRepo, write, context }) => {
    await write("result", "result", "old-name");
    const ctx = await context("full");
    assertExists(ctx.data);
    const before = defRepo.nameLookups;

    await ctx.data.resolveModelNames?.(
      'data.listVersions("new-name", "result") + data.latest("ghost", "x")',
    );
    await ctx.data.findBySpec("new-name", "result");
    await ctx.data.version("ghost", "result", 1);
    await ctx.data.latest("new-name", "result");
    ctx.data.listVersions("new-name", "result");
    assertEquals(defRepo.nameLookups, before);
  });
});

Deno.test("ModelResolver.buildLightContext: data accessors look each name up once per resolver, misses included", async () => {
  await withRenamedModel(async ({ defRepo, write, context }) => {
    await write("result", "result", "old-name");
    const ctx = await context("light");
    assertExists(ctx.data);
    assertEquals(defRepo.nameLookups, 0);

    await Promise.all([
      ctx.data.findBySpec("new-name", "result"),
      ctx.data.latest("new-name", "result"),
    ]);
    await ctx.data.version("new-name", "result", 1);
    await ctx.data.findBySpec("ghost", "result");
    await ctx.data.latest("ghost", "result");
    await ctx.data.resolveModelNames?.(
      'data.listVersions("new-name", "result") + data.listVersions("ghost", "x")',
    );
    assertEquals(defRepo.nameLookups, 2);

    // Another light context from the same resolver, as the next step of a run.
    const next = await context("light");
    assertExists(next.data);
    await next.data.findBySpec("ghost", "result");
    await next.data.latest("new-name", "result");
    assertEquals(defRepo.nameLookups, 2);
  });
});

Deno.test("ModelResolver.buildLightContext: data.listVersions reads by name tag only until the name is resolved", async () => {
  await withRenamedModel(async ({ write, context }) => {
    await write("result", "result", "old-name");
    const ctx = await context("light");
    assertExists(ctx.data);

    assertEquals(ctx.data.listVersions("new-name", "result"), []);
    await ctx.data.latest("new-name", "result");
    assertEquals(ctx.data.listVersions("new-name", "result"), [1]);
  });
});

Deno.test("ModelResolver.buildLightContext: data.listVersions async evaluation resolves the name first (swamp-club#3029)", async () => {
  await withRenamedModel(async ({ write, context }) => {
    await write("result", "result", "old-name");
    await write("result", "result", "old-name");
    const ctx = await context("light");

    const result = await new CelEvaluator().evaluateAsync(
      'data.listVersions("new-name", "result")',
      ctx as unknown as Record<string, unknown>,
    );
    assertEquals(result, [1, 2]);
  });
});

Deno.test("ModelResolver.buildLightContext: data accessors a name backed only by an auto-definition reads by name tag only", async () => {
  await withRenamedModel(async ({ repoDir, defRepo, type, write, context }) => {
    const autoRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
      false,
    );
    const auto = Definition.create({ name: "auto-model", globalArguments: {} });
    await autoRepo.save(type, auto);
    assertEquals(
      (await defRepo.findByNameGlobal("auto-model"))?.definition.id,
      auto.id,
    );
    await write("result", "result", "auto-old", auto.id);
    await write("tagged", "result", "auto-model", auto.id);
    const ctx = await context("light");
    assertExists(ctx.data);

    const bySpec = await ctx.data.findBySpec("auto-model", "result");
    assertEquals(bySpec.map((r) => r.name), ["tagged"]);
    assertEquals(await ctx.data.latest("auto-model", "result"), null);
  });
});

Deno.test("ModelResolver.buildLightContext: data accessors control-plane definitions are not read by identity", async () => {
  await withRenamedModel(async ({ defRepo, write, context }) => {
    const grantType = ModelType.create("@swamp/grant");
    const grant = Definition.create({ name: "grant-new", globalArguments: {} });
    await defRepo.save(grantType, grant);
    await write("grant-main", "grant", "grant-old", grant.id);
    const ctx = await context("light");
    assertExists(ctx.data);

    assertEquals(await ctx.data.findBySpec("grant-new", "grant"), []);
    assertEquals(await ctx.data.latest("grant-new", "grant-main"), null);
  });
});

/** Fails every name lookup, as an unreadable definitions directory would. */
class FailingDefinitionRepository extends CountingDefinitionRepository {
  override findByNameGlobal(
    _name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    this.nameLookups++;
    return Promise.reject(new Error("permission denied"));
  }
}

Deno.test("ModelResolver.buildLightContext: a failed definition lookup reads by name tag only", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
      );
      const type = ModelType.create("test/model");
      await dataRepo.save(
        type,
        crypto.randomUUID(),
        Data.create({
          name: "result",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", modelName: "tagged", specName: "result" },
          ownerDefinition: owner,
        }),
        new TextEncoder().encode(JSON.stringify({ ok: true })),
      );
      const dqs = new DataQueryService(catalog, dataRepo);
      await dqs.query('name == ""');
      const defRepo = new FailingDefinitionRepository(repoDir);
      const ctx = new ModelResolver(defRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      }).buildLightContext(new RunSensitiveValues());

      const result = await new CelEvaluator().evaluateAsync(
        'data.listVersions("tagged", "result").size() == 1 && ' +
          'data.findBySpec("tagged", "result").size() == 1 && ' +
          'data.latest("tagged", "result") != null',
        ctx as unknown as Record<string, unknown>,
      );
      assertEquals(result, true);
      assertEquals(defRepo.nameLookups, 1);
    } finally {
      catalog.close();
    }
  });
});
