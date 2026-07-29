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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { InProcessExecutor } from "../src/domain/models/in_process_executor.ts";
import type { MethodExecutor } from "../src/domain/models/in_process_executor.ts";
import type { ExecutionRequest } from "../src/domain/models/execution_envelope.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type {
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import type { DefinitionRepository } from "../src/domain/definitions/repositories.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";

const MODEL_TYPE = ModelType.create("test/rollback-on-failure");

const MarkerSchema = z.object({
  marker: z.string(),
  writtenAt: z.string(),
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-rollback-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function createModelDef(): ModelDefinition {
  return {
    type: MODEL_TYPE,
    version: "2026.01.01.1",
    resources: {
      first: {
        description: "First resource",
        schema: MarkerSchema,
        lifetime: "infinite",
        garbageCollection: 20,
      },
      second: {
        description: "Second resource",
        schema: MarkerSchema,
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    files: {
      log: {
        description: "Log file",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {},
  };
}

function createExecutor(): MethodExecutor {
  return {
    execute: (_definition, method, context) => method.execute({}, context),
  };
}

function createContext(
  repoDir: string,
  dataRepo: FileSystemUnifiedDataRepository,
  definitionId: string,
): MethodContext {
  return {
    repoDir,
    modelType: MODEL_TYPE,
    modelId: definitionId,
    globalArgs: {},
    definition: {
      id: definitionId,
      name: "test-rollback",
      version: 1,
      tags: {},
    },
    methodName: "test",
    logger: getLogger(["test"]),
    dataRepository: dataRepo,
    definitionRepository: {} as DefinitionRepository,
    signal: new AbortController().signal,
    extensionFile: () => {
      throw new Error("extensionFile not stubbed");
    },
    createCelEnvironment: createExtensionCelEnvironment,
  } as MethodContext;
}

Deno.test("rollbackOnFailure: success commits all writes", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description: "Writes two resources and succeeds",
      rollbackOnFailure: true,
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        await ctx.writeResource!("first", "a", {
          marker: "from-success",
          writtenAt: new Date().toISOString(),
        });
        await ctx.writeResource!("second", "b", {
          marker: "from-success",
          writtenAt: new Date().toISOString(),
        });
        return {};
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 2);

    const contentA = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "a",
    );
    assertEquals(contentA !== null, true);

    const contentB = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "b",
    );
    assertEquals(contentB !== null, true);
  });
});

Deno.test("rollbackOnFailure: failure rolls back all writes", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description: "Writes one resource then fails",
      rollbackOnFailure: true,
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        await ctx.writeResource!("first", "a", {
          marker: "from-failure",
          writtenAt: new Date().toISOString(),
        });
        throw new Error("deliberate failure after the first write");
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "error");
    assertEquals(result.outputs.length, 0);

    const contentA = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "a",
    );
    assertEquals(contentA, null);
  });
});

Deno.test("rollbackOnFailure: default path preserves writes on failure", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description:
        "Writes one resource then fails (default path — no rollback)",
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        await ctx.writeResource!("first", "a", {
          marker: "from-default-failure",
          writtenAt: new Date().toISOString(),
        });
        throw new Error("deliberate failure after the first write");
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "error");
    assertEquals(result.outputs.length, 1);

    const contentA = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "a",
    );
    assertEquals(contentA !== null, true);
  });
});

Deno.test("rollbackOnFailure: file writer rollback on failure", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description: "Uses createFileWriter then fails",
      rollbackOnFailure: true,
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        const writer = ctx.createFileWriter!("log", "execution-log");
        await writer.writeLine("line 1");
        await writer.writeLine("line 2");
        const handle = await writer.finalize();
        await ctx.writeResource!("first", "a", {
          marker: "from-file-test",
          writtenAt: new Date().toISOString(),
        });
        throw new Error(
          `deliberate failure after finalize and writeResource (handle v${handle.version})`,
        );
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "error");
    assertEquals(result.outputs.length, 0);

    const logContent = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "execution-log",
    );
    assertEquals(logContent, null);

    const resourceContent = await dataRepo.getContent(
      MODEL_TYPE,
      definition.id,
      "a",
    );
    assertEquals(resourceContent, null);
  });
});

Deno.test("rollbackOnFailure: unfinalized file writer cleaned up on failure", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description: "Starts a file writer but fails before finalize",
      rollbackOnFailure: true,
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        const writer = ctx.createFileWriter!("log", "partial-log");
        await writer.writeLine("line 1");
        throw new Error("deliberate failure before finalize");
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "error");
    assertEquals(result.outputs.length, 0);

    const versions = await dataRepo.listVersions(
      MODEL_TYPE,
      definition.id,
      "partial-log",
    );
    assertEquals(versions.length, 0);
  });
});

Deno.test("rollbackOnFailure: multi-resource rollback (96-well scenario)", async () => {
  await withTempDir(async (repoDir) => {
    const catalogDb = join(repoDir, ".swamp", "catalog.db");
    await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
    const catalogStore = new CatalogStore(catalogDb);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const definition = Definition.create({
      name: "test-rollback",
      methods: { test: { arguments: {} } },
    });

    const method: MethodDefinition = {
      description: "Writes 10 resources then fails at resource 11",
      rollbackOnFailure: true,
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.writeResource!("first", `well-${i}`, {
            marker: `reading-${i}`,
            writtenAt: new Date().toISOString(),
          });
        }
        throw new Error("instrument failure at well 11");
      },
    };

    const modelDef = createModelDef();
    const context = createContext(repoDir, dataRepo, definition.id);

    const executor = new InProcessExecutor(
      createExecutor(),
      definition,
      method,
      modelDef,
      context,
      "test",
    );

    const request: ExecutionRequest = {
      protocolVersion: 1,
      modelType: MODEL_TYPE.normalized,
      modelId: definition.id,
      methodName: "test",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: {
        id: definition.id,
        name: "test-rollback",
        version: 1,
        tags: {},
      },
    };

    const result = await executor.execute(request);

    assertEquals(result.status, "error");
    assertEquals(result.outputs.length, 0);

    for (let i = 0; i < 10; i++) {
      const content = await dataRepo.getContent(
        MODEL_TYPE,
        definition.id,
        `well-${i}`,
      );
      assertEquals(content, null, `well-${i} should have been rolled back`);
    }
  });
});
