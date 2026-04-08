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
 * Integration tests for cross-model data access via DataAccessService.
 *
 * Tests the full flow with real file-backed repositories:
 * 1. Model A writes data
 * 2. DataAccessService reads Model A's data by name
 * 3. Spec name filtering works
 * 4. Non-existent model returns empty array
 * 5. Model with no data returns empty array
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

import { Data } from "../src/domain/data/data.ts";
import { DataAccessService } from "../src/domain/data/data_access_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { computeDefinitionHash } from "../src/domain/models/model_output.ts";

// Import models barrel to trigger self-registration
import "../src/domain/models/models.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-access-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
  await ensureDir(join(dir, "vaults"));
}

async function writeData(
  dataRepo: FileSystemUnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  name: string,
  content: Record<string, unknown>,
  tags: Record<string, string> = {},
): Promise<Data> {
  const definitionHash = await computeDefinitionHash({
    type: "model-method",
    ref: `${modelId}:create`,
  });
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", ...tags },
    ownerDefinition: {
      definitionHash,
      ownerType: "model-method",
      ownerRef: `${modelId}:create`,
    },
  });
  const encoded = new TextEncoder().encode(JSON.stringify(content));
  await dataRepo.save(modelType, modelId, data, encoded);
  return data;
}

Deno.test("cross-model data access: read another model's data by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const sourceType = ModelType.create("test/source");

    // Create source model definition
    const sourceDef = Definition.create({
      name: "anime-source",
      globalArguments: { url: "https://api.example.com" },
    });
    await defRepo.save(sourceType, sourceDef);

    // Write data to source model
    await writeData(
      dataRepo,
      sourceType,
      sourceDef.id,
      "episode-list",
      { title: "Episode 1", number: 1 },
      { specName: "episode" },
    );

    // Read from a different model's perspective using DataAccessService
    const service = new DataAccessService(defRepo, dataRepo);
    const records = await service.readModelData("anime-source");

    assertEquals(records.length, 1);
    assertEquals(records[0].name, "episode-list");
    assertEquals(records[0].attributes, { title: "Episode 1", number: 1 });
    assertEquals(records[0].tags["specName"], "episode");
  });
});

Deno.test("cross-model data access: filter by specName", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const sourceType = ModelType.create("test/source");

    const sourceDef = Definition.create({
      name: "multi-output",
      globalArguments: {},
    });
    await defRepo.save(sourceType, sourceDef);

    // Write two data items with different spec names
    await writeData(
      dataRepo,
      sourceType,
      sourceDef.id,
      "episode-data",
      { title: "Episode 1" },
      { specName: "episode" },
    );
    await writeData(
      dataRepo,
      sourceType,
      sourceDef.id,
      "metadata",
      { source: "api", version: "v2" },
      { specName: "meta" },
    );

    const service = new DataAccessService(defRepo, dataRepo);

    // Filter by "episode" spec
    const episodes = await service.readModelData("multi-output", "episode");
    assertEquals(episodes.length, 1);
    assertEquals(episodes[0].name, "episode-data");
    assertEquals(episodes[0].attributes, { title: "Episode 1" });

    // Filter by "meta" spec
    const meta = await service.readModelData("multi-output", "meta");
    assertEquals(meta.length, 1);
    assertEquals(meta[0].attributes, { source: "api", version: "v2" });

    // No filter returns both
    const all = await service.readModelData("multi-output");
    assertEquals(all.length, 2);
  });
});

Deno.test("cross-model data access: non-existent model returns empty array", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);

    const service = new DataAccessService(defRepo, dataRepo);
    const records = await service.readModelData("nonexistent-model");

    assertEquals(records, []);
  });
});

Deno.test("cross-model data access: model with no data returns empty array", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const sourceType = ModelType.create("test/empty");

    // Create model but don't write any data
    const emptyDef = Definition.create({
      name: "empty-model",
      globalArguments: {},
    });
    await defRepo.save(sourceType, emptyDef);

    const service = new DataAccessService(defRepo, dataRepo);
    const records = await service.readModelData("empty-model");

    assertEquals(records, []);
  });
});

Deno.test("cross-model data access: workflowRunId scoping returns only matching data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const sourceType = ModelType.create("test/source");

    const sourceDef = Definition.create({
      name: "scoped-source",
      globalArguments: {},
    });
    await defRepo.save(sourceType, sourceDef);

    const runId1 = crypto.randomUUID();
    const runId2 = crypto.randomUUID();
    const definitionHash = await computeDefinitionHash({
      type: "model-method",
      ref: `${sourceDef.id}:create`,
    });

    // Write data scoped to workflow run 1
    const data1 = Data.create({
      name: "episode-run1",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", specName: "episode", workflowRunId: runId1 },
      ownerDefinition: {
        definitionHash,
        ownerType: "model-method",
        ownerRef: sourceDef.id,
        workflowRunId: runId1,
      },
    });
    await dataRepo.save(
      sourceType,
      sourceDef.id,
      data1,
      new TextEncoder().encode(JSON.stringify({ title: "from run 1" })),
    );

    // Write data scoped to workflow run 2
    const data2 = Data.create({
      name: "episode-run2",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", specName: "episode", workflowRunId: runId2 },
      ownerDefinition: {
        definitionHash,
        ownerType: "model-method",
        ownerRef: sourceDef.id,
        workflowRunId: runId2,
      },
    });
    await dataRepo.save(
      sourceType,
      sourceDef.id,
      data2,
      new TextEncoder().encode(JSON.stringify({ title: "from run 2" })),
    );

    const service = new DataAccessService(defRepo, dataRepo);

    // readModelData no longer accepts workflowRunId — verify all data is returned
    const allRecords = await service.readModelData("scoped-source", "episode");
    assertEquals(allRecords.length, 2);

    // Verify both runs' data is present
    const titles = allRecords.map((r) => r.attributes.title).sort();
    assertEquals(titles, ["from run 1", "from run 2"]);
  });
});

Deno.test("cross-model data access: orphan recovery reads content from old UUID path", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const defRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const sourceType = ModelType.create("test/orphan");

    // Step 1: Create original model and write data
    const originalDef = Definition.create({
      name: "orphan-test",
      globalArguments: {},
    });
    await defRepo.save(sourceType, originalDef);
    await writeData(
      dataRepo,
      sourceType,
      originalDef.id,
      "important-data",
      { value: "from-old-uuid" },
      { specName: "result", modelName: "orphan-test" },
    );

    // Step 2: Delete original definition and create a new one (new UUID)
    await defRepo.delete(sourceType, originalDef.id);
    const newDef = Definition.create({
      name: "orphan-test",
      globalArguments: {},
    });
    await defRepo.save(sourceType, newDef);

    // Data is still on disk under originalDef.id, but the definition now
    // has newDef.id. DataAccessService should find the orphan data.
    const service = new DataAccessService(defRepo, dataRepo);
    const records = await service.readModelData("orphan-test");

    assertEquals(records.length, 1);
    assertEquals(records[0].name, "important-data");
    assertEquals(records[0].attributes, { value: "from-old-uuid" });
  });
});
