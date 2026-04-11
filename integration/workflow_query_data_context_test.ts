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

// Integration test for the full queryData chain on the workflow path:
// buildMethodContext -> RawExecutionDriver -> derived queryData ->
// real DataQueryService -> real CatalogStore. A regression in any of these
// layers would surface here. See lab issue #35.

import { assertEquals, assertExists } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import { buildMethodContext } from "../src/domain/models/method_context.ts";
import {
  type MethodExecutor,
  RawExecutionDriver,
} from "../src/domain/drivers/raw_execution_driver.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type {
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import type { ExecutionRequest } from "../src/domain/drivers/execution_driver.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";

const TEST_MODEL_TYPE = ModelType.create("test/query_data_ctx");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-queryctx-" });
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

function createMockRequest(): ExecutionRequest {
  return {
    protocolVersion: 1,
    modelType: TEST_MODEL_TYPE.normalized,
    modelId: "def-query-ctx",
    methodName: "run",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: {
      id: "def-query-ctx",
      name: "query-ctx-model",
      version: 1,
      tags: {},
    },
  };
}

Deno.test("queryData chain: factory + driver derive working queryData from dataQueryService", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Real infrastructure: catalog store, data repo, query service.
    const catalogStore = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalogStore,
      );
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const dataQueryService = new DataQueryService(catalogStore, dataRepo);

      // Seed one data record the query should match.
      const seedModel = Definition.create({
        name: "seed_source",
        type: TEST_MODEL_TYPE.normalized,
      });
      await definitionRepo.save(TEST_MODEL_TYPE, seedModel);
      const seedData = Data.create({
        name: "seeded_row",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource" },
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: `${TEST_MODEL_TYPE.normalized}:seed`,
        },
      });
      await dataRepo.save(
        TEST_MODEL_TYPE,
        seedModel.id,
        seedData,
        new TextEncoder().encode(JSON.stringify({ sentinel: "expected" })),
      );

      // Build a minimal execution target: one method that calls queryData.
      const definition = Definition.create({
        name: "query-ctx-model",
        type: TEST_MODEL_TYPE.normalized,
      });
      const method: MethodDefinition = {
        description: "run",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      };
      const modelDef: ModelDefinition = {
        type: TEST_MODEL_TYPE,
        version: "2026.01.01.1",
        globalArguments: z.object({}),
        resources: {},
        methods: { run: method },
      };

      // Exercises the fix: context.queryData must exist and return seeded rows.
      let queryResult: DataRecord[] | unknown[] | undefined;
      const executor: MethodExecutor = {
        execute: async (_def, _m, context) => {
          queryResult = await context.queryData!(
            'attributes.sentinel == "expected"',
            undefined,
          );
          return {};
        },
      };

      const context: MethodContext = buildMethodContext(
        {
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          dataQueryService,
        },
        {
          signal: new AbortController().signal,
          repoDir,
          modelType: TEST_MODEL_TYPE,
          modelId: definition.id,
          globalArgs: {},
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "run",
          logger: getLogger(["test", "queryctx"]),
        },
      );

      // The factory alone does not populate queryData — the driver derives it.
      assertEquals(context.queryData, undefined);
      assertExists(context.dataQueryService);

      const driver = new RawExecutionDriver(
        executor,
        definition,
        method,
        modelDef,
        context,
        "run",
      );
      const result = await driver.execute(createMockRequest());

      assertEquals(result.status, "success");
      assertExists(queryResult);
      assertEquals(
        (queryResult as DataRecord[]).length >= 1,
        true,
        "expected seeded row to be returned by context.queryData",
      );
      const seededRow = (queryResult as DataRecord[]).find(
        (r) => r.name === "seeded_row",
      );
      assertExists(seededRow);
      assertEquals(seededRow.attributes.sentinel, "expected");
    } finally {
      catalogStore.close();
    }
  });
});
