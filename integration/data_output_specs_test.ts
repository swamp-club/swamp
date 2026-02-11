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
// Import specific models to trigger registration (without AWS models that require env access)
import "../src/domain/models/echo/echo_model.ts";
import "../src/domain/models/command/curl/curl_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-integration-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Data output specs - echo model declares message resource spec", () => {
  const echoModelType = ModelType.create("swamp/echo");
  const model = modelRegistry.get(echoModelType);

  assertEquals(model !== undefined, true);
  assertEquals(model!.resources !== undefined, true);
  assertEquals(Object.keys(model!.resources!).length, 1);
  assertEquals(model!.resources!["message"] !== undefined, true);
  assertEquals(
    model!.resources!["message"].description,
    "Echo message with timestamp",
  );
});

Deno.test("Data output specs - curl model declares metadata and file specs", () => {
  const curlModelType = ModelType.create("command/curl");
  const model = modelRegistry.get(curlModelType);

  assertEquals(model !== undefined, true);
  // Curl model should have resources and/or files
  const totalSpecs = Object.keys(model!.resources ?? {}).length +
    Object.keys(model!.files ?? {}).length;
  assertEquals(totalSpecs, 2);
});

Deno.test("Data output specs - echo model execution produces valid resource handle", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const modelType = ModelType.create("swamp/echo");

    // Create echo definition
    const definition = Definition.create({
      name: "test-echo",
      methods: {
        write: { arguments: { message: "Hello, data specs!" } },
      },
    });

    await definitionRepo.save(modelType, definition);

    // Get model definition
    const model = modelRegistry.get(modelType);
    const writeMethod = model!.methods.write;

    // Create writeResource and createFileWriter for the context
    const { writeResource } = createResourceWriter(
      dataRepo,
      modelType,
      definition.id,
      model!.resources ?? {},
    );

    // Execute the method
    const result = await executionService.execute(
      definition,
      writeMethod,
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
        methodName: "write",
        logger: getLogger(["test"]),
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        writeResource,
      },
    );

    // Verify data output has correct spec name and kind
    assertEquals(result.dataHandles?.length, 1);
    assertEquals(result.dataHandles![0].specName, "message");
    assertEquals(result.dataHandles![0].kind, "resource");
    assertEquals(result.dataHandles![0].name, "message");

    // Verify defaults were applied
    assertEquals(
      result.dataHandles![0].metadata.contentType,
      "application/json",
    );
    assertEquals(result.dataHandles![0].metadata.lifetime, "ephemeral");
    assertEquals(result.dataHandles![0].metadata.garbageCollection, 10);
  });
});

Deno.test("Data output specs - undeclared resource spec fails at writeResource", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      methods: { write: { arguments: { message: "Test" } } },
    });

    // Create writeResource with the echo model's resources (which only has "message" spec)
    const { writeResource } = createResourceWriter(
      dataRepo,
      echoModelType,
      definition.id,
      model!.resources ?? {},
    );

    // Create a method that tries to use an undeclared spec name
    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.write.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        // This should throw because "undeclared" is not in echo model's resources
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
          modelType: echoModelType,
          modelId: definition.id,
          globalArgs: definition.globalArguments,
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "write",
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          writeResource,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // The error should come from the writeResource function
    assertStringIncludes(errorMessage, "Undeclared resource spec 'undeclared'");
    assertStringIncludes(errorMessage, "Declared resource specs: message");
  });
});

Deno.test("Data output specs - undeclared file spec fails at createFileWriter", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      methods: { write: { arguments: { message: "Test" } } },
    });

    // Create createFileWriter with the echo model's files (empty)
    const { createFileWriter } = createFileWriterFactory(
      dataRepo,
      echoModelType,
      definition.id,
      model!.files ?? {},
    );

    // Create a method that tries to use an undeclared file spec
    const badMethod = {
      description: "Bad method",
      arguments: model!.methods.write.arguments,
      execute: async (
        _args: Record<string, unknown>,
        ctx: MethodContext,
      ) => {
        // This should throw because echo model has no file specs
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
          modelType: echoModelType,
          modelId: definition.id,
          globalArgs: definition.globalArguments,
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "write",
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          createFileWriter,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // The error should come from the createFileWriter function
    assertStringIncludes(errorMessage, "Undeclared file spec 'undeclared'");
  });
});
