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

import { assertEquals } from "@std/assert";
import { DataAccessService } from "./data_access_service.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import { Definition } from "../definitions/definition.ts";
import { computeDefinitionHash } from "../models/model_output.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { VaultService } from "../vaults/vault_service.ts";

// Import models barrel to trigger self-registration
import "../models/models.ts";

const TEST_MODEL_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_MODEL_TYPE = ModelType.create("test/source");
const TEST_MODEL_NAME = "anime-source";

async function createTestData(
  name: string,
  tags: Record<string, string> = { type: "resource" },
): Promise<Data> {
  const definitionHash = await computeDefinitionHash({
    type: "model-method",
    ref: "test:create",
  });
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags,
    ownerDefinition: {
      definitionHash,
      ownerType: "model-method",
      ownerRef: "test:create",
    },
  });
}

function createTestDefinition(
  id: string = TEST_MODEL_ID,
  name: string = TEST_MODEL_NAME,
): Definition {
  return Definition.create({
    id,
    name,
    version: 1,
    tags: {},
    globalArguments: {},
  });
}

function createMockDefinitionRepo(
  definitions: Array<{ definition: Definition; type: ModelType }> = [],
): DefinitionRepository {
  return {
    findByNameGlobal: (name: string) => {
      const found = definitions.find((d) => d.definition.name === name);
      return Promise.resolve(found ?? null);
    },
    findAll: (type: ModelType) => {
      return Promise.resolve(
        definitions
          .filter((d) => d.type.normalized === type.normalized)
          .map((d) => d.definition),
      );
    },
    findAllGlobal: () => Promise.resolve(definitions),
  } as unknown as DefinitionRepository;
}

function createMockDataRepo(
  modelData: Map<string, Data[]> = new Map(),
  contentMap: Map<string, Uint8Array> = new Map(),
  globalData: Array<
    { data: Data; modelType: ModelType; modelId: string }
  > = [],
): UnifiedDataRepository {
  return {
    findAllForModel: (_type: ModelType, modelId: string) => {
      return Promise.resolve(modelData.get(modelId) ?? []);
    },
    getContent: (
      _type: ModelType,
      modelId: string,
      dataName: string,
    ) => {
      // Key on (modelId, dataName) to catch bugs where wrong modelId is used
      return Promise.resolve(
        contentMap.get(`${modelId}:${dataName}`) ??
          contentMap.get(dataName) ??
          null,
      );
    },
    findAllGlobal: () => Promise.resolve(globalData),
  } as unknown as UnifiedDataRepository;
}

Deno.test("DataAccessService.readModelData: returns data records for existing model", async () => {
  const def = createTestDefinition();
  const data = await createTestData("episode-list", {
    type: "resource",
    specName: "episode",
  });
  const content = new TextEncoder().encode(
    JSON.stringify({ title: "Episode 1", number: 1 }),
  );

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[TEST_MODEL_ID, [data]]]),
    new Map([["episode-list", content]]),
  );

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME);

  assertEquals(records.length, 1);
  assertEquals(records[0].name, "episode-list");
  assertEquals(records[0].attributes, { title: "Episode 1", number: 1 });
  assertEquals(records[0].tags["specName"], "episode");
});

Deno.test("DataAccessService.readModelData: filters by specName", async () => {
  const def = createTestDefinition();
  const episodeData = await createTestData("episode-list", {
    type: "resource",
    specName: "episode",
  });
  const metaData = await createTestData("meta-info", {
    type: "resource",
    specName: "metadata",
  });
  const episodeContent = new TextEncoder().encode(
    JSON.stringify({ title: "Episode 1" }),
  );
  const metaContent = new TextEncoder().encode(
    JSON.stringify({ source: "api" }),
  );

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[TEST_MODEL_ID, [episodeData, metaData]]]),
    new Map([["episode-list", episodeContent], ["meta-info", metaContent]]),
  );

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME, "episode");

  assertEquals(records.length, 1);
  assertEquals(records[0].name, "episode-list");
  assertEquals(records[0].attributes, { title: "Episode 1" });
});

Deno.test("DataAccessService.readModelData: returns empty array for non-existent model", async () => {
  const defRepo = createMockDefinitionRepo([]);
  const dataRepo = createMockDataRepo();

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData("nonexistent-model");

  assertEquals(records, []);
});

Deno.test("DataAccessService.readModelData: returns empty array when model has no data", async () => {
  const def = createTestDefinition();
  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(new Map([[TEST_MODEL_ID, []]]));

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME);

  assertEquals(records, []);
});

Deno.test("DataAccessService.readModelData: skips renamed data entries", async () => {
  const def = createTestDefinition();
  // Create a normal data item, then make a rename marker from it
  const originalData = await createTestData("old-name", {
    type: "resource",
    specName: "episode",
  });
  const renamedData = originalData.withRenameMarker({
    version: 2,
    renamedTo: "new-name",
  });
  const activeData = await createTestData("new-name", {
    type: "resource",
    specName: "episode",
  });
  const content = new TextEncoder().encode(JSON.stringify({ active: true }));

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[TEST_MODEL_ID, [renamedData, activeData]]]),
    new Map([["new-name", content]]),
  );

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME);

  assertEquals(records.length, 1);
  assertEquals(records[0].name, "new-name");
});

Deno.test("DataAccessService.readModelData: resolves vault references when vault service available", async () => {
  const def = createTestDefinition();
  const data = await createTestData("secrets-data", {
    type: "resource",
    specName: "config",
  });
  const content = new TextEncoder().encode(
    JSON.stringify({ apiKey: "${{ vault.get('default', 'api-key') }}" }),
  );

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[TEST_MODEL_ID, [data]]]),
    new Map([["secrets-data", content]]),
  );

  const mockVault = {
    get: (_vaultName: string, _key: string) =>
      Promise.resolve("secret-value-123"),
  } as unknown as VaultService;

  const service = new DataAccessService(defRepo, dataRepo, mockVault);
  const records = await service.readModelData(TEST_MODEL_NAME);

  assertEquals(records.length, 1);
  assertEquals(records[0].attributes["apiKey"], "secret-value-123");
});

Deno.test("DataAccessService.readModelData: handles non-JSON content gracefully", async () => {
  const def = createTestDefinition();
  const data = await createTestData("binary-data", {
    type: "file",
    specName: "log",
  });
  // Override contentType to non-JSON by creating data manually
  const definitionHash = await computeDefinitionHash({
    type: "model-method",
    ref: "test:create",
  });
  const fileData = Data.create({
    name: "log-file",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "file", specName: "log" },
    ownerDefinition: {
      definitionHash,
      ownerType: "model-method",
      ownerRef: "test:create",
    },
  });

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[TEST_MODEL_ID, [fileData, data]]]),
    new Map([["log-file", new TextEncoder().encode("plain text log")]]),
  );

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME, "log");

  // text/plain file should have empty attributes (not parsed as JSON)
  const logRecord = records.find((r) => r.name === "log-file");
  assertEquals(logRecord?.attributes, {});
});

Deno.test("DataAccessService.resolveModel: returns model info for existing model", async () => {
  const def = createTestDefinition();
  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo();

  const service = new DataAccessService(defRepo, dataRepo);
  const result = await service.resolveModel(TEST_MODEL_NAME);

  assertEquals(result?.modelId, TEST_MODEL_ID);
  assertEquals(result?.modelName, TEST_MODEL_NAME);
  assertEquals(result?.modelType.normalized, TEST_MODEL_TYPE.normalized);
});

Deno.test("DataAccessService.resolveModel: returns null for non-existent model", async () => {
  const defRepo = createMockDefinitionRepo([]);
  const dataRepo = createMockDataRepo();

  const service = new DataAccessService(defRepo, dataRepo);
  const result = await service.resolveModel("nonexistent");

  assertEquals(result, null);
});

Deno.test("DataAccessService.readModelData: recovers orphan data via modelName tag", async () => {
  const currentId = "550e8400-e29b-41d4-a716-446655440011";
  const oldId = "550e8400-e29b-41d4-a716-446655440022";
  const def = createTestDefinition(currentId, TEST_MODEL_NAME);

  const orphanData = await createTestData("orphan-episode", {
    type: "resource",
    specName: "episode",
    modelName: TEST_MODEL_NAME,
  });
  const orphanContent = new TextEncoder().encode(
    JSON.stringify({ title: "Orphan Episode" }),
  );

  const defRepo = createMockDefinitionRepo([
    { definition: def, type: TEST_MODEL_TYPE },
  ]);
  const dataRepo = createMockDataRepo(
    new Map([[currentId, []]]),
    // Content keyed on oldId — verifies DataAccessService uses the orphan's
    // modelId (not the current definition's ID) for content lookup
    new Map([[`${oldId}:orphan-episode`, orphanContent]]),
    // Global data includes orphan under old UUID
    [{ data: orphanData, modelType: TEST_MODEL_TYPE, modelId: oldId }],
  );

  const service = new DataAccessService(defRepo, dataRepo);
  const records = await service.readModelData(TEST_MODEL_NAME);

  assertEquals(records.length, 1);
  assertEquals(records[0].name, "orphan-episode");
  assertEquals(records[0].attributes, { title: "Orphan Episode" });
});
