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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  type MethodContext,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  createFileWriterFactory,
  createResourceWriter,
} from "../src/domain/models/data_writer.ts";
import "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-integration-" });
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

Deno.test("Data output specs - shell model declares result resource spec", () => {
  const shellModelType = ModelType.create("command/shell");
  const model = modelRegistry.get(shellModelType);

  assertEquals(model !== undefined, true);
  assertEquals(model!.resources !== undefined, true);
  assertEquals(model!.resources!["result"] !== undefined, true);
  assertEquals(
    model!.resources!["result"].description,
    "Shell command execution result (exit code, timing, command)",
  );
});

Deno.test("Data output specs - shell model declares log file spec", () => {
  const shellModelType = ModelType.create("command/shell");
  const model = modelRegistry.get(shellModelType);

  assertEquals(model !== undefined, true);
  assertEquals(model!.files !== undefined, true);
  assertEquals(model!.files!["log"] !== undefined, true);
  assertEquals(
    model!.files!["log"].description,
    "Shell command output (stdout and stderr)",
  );
});

Deno.test("Data output specs - shell model execution produces valid resource handle", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const executionService = new DefaultMethodExecutionService();

    const modelType = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "test-shell",
      methods: {
        execute: { arguments: { run: "echo 'Hello, data specs!'" } },
      },
    });

    await definitionRepo.save(modelType, definition);

    const model = modelRegistry.get(modelType);
    const executeMethod = model!.methods.execute;

    const { writeResource } = createResourceWriter(
      dataRepo,
      modelType,
      definition.id,
      model!.resources ?? {},
    );
    const { createFileWriter } = createFileWriterFactory(
      dataRepo,
      modelType,
      definition.id,
      model!.files ?? {},
    );

    const result = await executionService.execute(
      definition,
      executeMethod,
      {
        repoDir,
        modelType,
        modelId: definition.id,
        globalArgs: definition.globalArguments,
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
        },
        methodName: "execute",
        logger: getLogger(["test"]),
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        writeResource,
        createFileWriter,
        signal: new AbortController().signal,
        extensionFile: () => {
          throw new Error("extensionFile not stubbed in this test");
        },
        createCelEnvironment: createExtensionCelEnvironment,
      },
    );

    assertEquals(result.dataHandles?.length, 2);

    const resultHandle = result.dataHandles!.find((h) =>
      h.specName === "result"
    );
    const logHandle = result.dataHandles!.find((h) => h.specName === "log");

    assertEquals(resultHandle !== undefined, true);
    assertEquals(resultHandle!.kind, "resource");
    assertEquals(resultHandle!.name, "result");

    assertEquals(logHandle !== undefined, true);
    assertEquals(logHandle!.kind, "file");
    assertEquals(logHandle!.name, "log");

    assertEquals(resultHandle!.metadata.contentType, "application/json");
    assertEquals(resultHandle!.metadata.lifetime, "infinite");
    assertEquals(resultHandle!.metadata.garbageCollection, 10);
  });
});

Deno.test("Data output specs - undeclared resource spec fails at writeResource", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const executionService = new DefaultMethodExecutionService();

    const shellModelType = ModelType.create("command/shell");
    const model = modelRegistry.get(shellModelType);

    const definition = Definition.create({
      name: "test-shell",
      methods: { execute: { arguments: { run: "echo test" } } },
    });

    const { writeResource } = createResourceWriter(
      dataRepo,
      shellModelType,
      definition.id,
      model!.resources ?? {},
    );

    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.execute.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        const handle = await ctx.writeResource!("undeclared", "undeclared", {
          test: "data",
        });
        return { dataHandles: [handle] };
      },
    };

    let errorMessage = "";
    try {
      await executionService.execute(
        definition,
        badMethod,
        {
          repoDir,
          modelType: shellModelType,
          modelId: definition.id,
          globalArgs: definition.globalArguments,
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "execute",
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          writeResource,
          signal: new AbortController().signal,
          extensionFile: () => {
            throw new Error("extensionFile not stubbed in this test");
          },
          createCelEnvironment: createExtensionCelEnvironment,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    assertStringIncludes(errorMessage, "Undeclared resource spec 'undeclared'");
    assertStringIncludes(errorMessage, "Declared resource specs: result");
  });
});

Deno.test("Data output specs - undeclared file spec fails at createFileWriter", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const executionService = new DefaultMethodExecutionService();

    const shellModelType = ModelType.create("command/shell");
    const model = modelRegistry.get(shellModelType);

    const definition = Definition.create({
      name: "test-shell",
      methods: { execute: { arguments: { run: "echo test" } } },
    });

    const { createFileWriter } = createFileWriterFactory(
      dataRepo,
      shellModelType,
      definition.id,
      model!.files ?? {},
    );

    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.execute.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        const writer = ctx.createFileWriter!("undeclared", "undeclared");
        const handle = await writer.writeText("test");
        return { dataHandles: [handle] };
      },
    };

    let errorMessage = "";
    try {
      await executionService.execute(
        definition,
        badMethod,
        {
          repoDir,
          modelType: shellModelType,
          modelId: definition.id,
          globalArgs: definition.globalArguments,
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "execute",
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          createFileWriter,
          signal: new AbortController().signal,
          extensionFile: () => {
            throw new Error("extensionFile not stubbed in this test");
          },
          createCelEnvironment: createExtensionCelEnvironment,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    assertStringIncludes(errorMessage, "Undeclared file spec 'undeclared'");
  });
});
