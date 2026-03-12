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
 * Integration tests for data output specs.
 *
 * Tests verify that models properly declare and use resource/file output specifications.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  type MethodContext,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  createFileWriterFactory,
  createResourceWriter,
} from "../src/domain/models/data_writer.ts";
// Import shell model to trigger registration
import "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-integration-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const modelType = ModelType.create("command/shell");

    // Create shell definition
    const definition = Definition.create({
      name: "test-shell",
      methods: {
        execute: { arguments: { run: "echo 'Hello, data specs!'" } },
      },
    });

    await definitionRepo.save(modelType, definition);

    // Get model definition
    const model = modelRegistry.get(modelType);
    const executeMethod = model!.methods.execute;

    // Create writeResource and createFileWriter for the context
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

    // Execute the method
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
      },
    );

    // Verify data output has correct spec names and kinds
    assertEquals(result.dataHandles?.length, 2); // result resource + log file

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

    // Verify defaults were applied
    assertEquals(resultHandle!.metadata.contentType, "application/json");
    assertEquals(resultHandle!.metadata.lifetime, "infinite");
    assertEquals(resultHandle!.metadata.garbageCollection, 10);
  });
});

Deno.test("Data output specs - undeclared resource spec fails at writeResource", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const shellModelType = ModelType.create("command/shell");
    const model = modelRegistry.get(shellModelType);

    const definition = Definition.create({
      name: "test-shell",
      methods: { execute: { arguments: { run: "echo test" } } },
    });

    // Create writeResource with the shell model's resources
    const { writeResource } = createResourceWriter(
      dataRepo,
      shellModelType,
      definition.id,
      model!.resources ?? {},
    );

    // Create a method that tries to use an undeclared spec name
    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.execute.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        // This should throw because "undeclared" is not in shell model's resources
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
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // The error should come from the writeResource function
    assertStringIncludes(errorMessage, "Undeclared resource spec 'undeclared'");
    assertStringIncludes(errorMessage, "Declared resource specs: result");
  });
});

Deno.test("Data output specs - undeclared file spec fails at createFileWriter", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const shellModelType = ModelType.create("command/shell");
    const model = modelRegistry.get(shellModelType);

    const definition = Definition.create({
      name: "test-shell",
      methods: { execute: { arguments: { run: "echo test" } } },
    });

    // Create createFileWriter with the shell model's files
    const { createFileWriter } = createFileWriterFactory(
      dataRepo,
      shellModelType,
      definition.id,
      model!.files ?? {},
    );

    // Create a method that tries to use an undeclared file spec
    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.execute.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        // This should throw because "undeclared" is not in shell model's files
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
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // The error should come from the createFileWriter function
    assertStringIncludes(errorMessage, "Undeclared file spec 'undeclared'");
  });
});
