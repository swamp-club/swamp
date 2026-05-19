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

// Integration test for ctx.createCelEnvironment(): wires the factory through
// the production MethodContext construction site (buildMethodContext) into a
// synthetic extension's execute, and verifies CEL evaluation works
// end-to-end. A regression in the factory, the field declaration, or the
// build factory would surface here. See lab issue #376.

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
import { ModelType } from "../src/domain/models/model_type.ts";
import type {
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import type { ExecutionRequest } from "../src/domain/drivers/execution_driver.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";

const TEST_MODEL_TYPE = ModelType.create("test/cel_env_ctx");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-celctx-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
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
    modelId: "def-cel-env-ctx",
    methodName: "run",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: {
      id: "def-cel-env-ctx",
      name: "cel-env-ctx-model",
      version: 1,
      tags: {},
    },
  };
}

Deno.test("createCelEnvironment chain: factory + driver expose a working Environment to extension execute", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

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

      // Build a minimal execution target: one method that uses ctx.createCelEnvironment.
      const definition = Definition.create({
        name: "cel-env-ctx-model",
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

      // The synthetic extension's execute exercises the full extension-facing
      // surface: pull the factory off ctx, parse, register a custom function,
      // evaluate, and assert the result via captured variables.
      let arithmeticResult: unknown;
      let customResult: unknown;
      let secondInstanceSawCustom = true;
      const executor: MethodExecutor = {
        execute: async (_def, _m, context) => {
          const env = context.createCelEnvironment();

          // Arithmetic overload baseline (double + int).
          arithmeticResult = env.evaluate("a + 2", { a: 1.5 });

          // Custom function registration.
          env.registerFunction(
            "matchesRegex(string, string): bool",
            (value: string, pattern: string) => new RegExp(pattern).test(value),
          );
          customResult = env.evaluate('matchesRegex("us-east-1", "^us-.*")');

          // Isolation: a second createCelEnvironment call must NOT see the
          // function we just registered on `env`.
          const env2 = context.createCelEnvironment();
          try {
            env2.evaluate("matchesRegex('x', 'y')");
          } catch {
            secondInstanceSawCustom = false;
          }

          return await Promise.resolve({});
        },
      };

      const context: MethodContext = buildMethodContext(
        {
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          createCelEnvironment: createExtensionCelEnvironment,
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
          logger: getLogger(["test", "celctx"]),
        },
      );

      assertExists(context.createCelEnvironment);

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
      assertEquals(arithmeticResult, 3.5);
      assertEquals(customResult, true);
      assertEquals(
        secondInstanceSawCustom,
        false,
        "fresh Environment from a second createCelEnvironment call must NOT carry registrations from the first",
      );
    } finally {
      catalogStore.close();
    }
  });
});
