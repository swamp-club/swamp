/**
 * Integration tests for data output specs.
 *
 * Tests verify that models properly declare and use data output specifications.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  type DataWriterFactory,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { createDataWriterFactory } from "../src/domain/models/data_writer.ts";
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

Deno.test("Data output specs - echo model declares message spec", () => {
  const echoModelType = ModelType.create("swamp/echo");
  const model = modelRegistry.get(echoModelType);

  assertEquals(model !== undefined, true);
  assertEquals(Object.keys(model!.dataOutputSpecs).length, 1);
  assertEquals(model!.dataOutputSpecs["message"] !== undefined, true);
  assertEquals(model!.dataOutputSpecs["message"].specType.value, "message");
  assertEquals(
    model!.dataOutputSpecs["message"].description,
    "Echo message with timestamp",
  );
});

Deno.test("Data output specs - curl model declares metadata and file specs", () => {
  const curlModelType = ModelType.create("command/curl");
  const model = modelRegistry.get(curlModelType);

  assertEquals(model !== undefined, true);
  assertEquals(Object.keys(model!.dataOutputSpecs).length, 2);
  assertEquals(model!.dataOutputSpecs["metadata"] !== undefined, true);
  assertEquals(model!.dataOutputSpecs["file"] !== undefined, true);
  assertEquals(model!.dataOutputSpecs["metadata"].specType.value, "metadata");
  assertEquals(model!.dataOutputSpecs["file"].specType.value, "file");
});

Deno.test("Data output specs - echo model execution produces valid spec type", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const modelType = ModelType.create("swamp/echo");

    // Create echo definition
    const definition = Definition.create({
      name: "test-echo",
      attributes: {
        message: "Hello, data specs!",
      },
    });

    await definitionRepo.save(modelType, definition);

    // Get model definition
    const model = modelRegistry.get(modelType);
    const writeMethod = model!.methods.write;

    // Create DataWriterFactory for the context
    const { factory: createDataWriter } = createDataWriterFactory(
      dataRepo,
      modelType,
      definition.id,
      await definition.computeHash(),
      model!.dataOutputSpecs,
    );

    // Execute the method
    const result = await executionService.execute(
      definition,
      writeMethod,
      {
        repoDir,
        modelType,
        modelId: definition.id,
        logger: getLogger(["test"]),
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        modelDefinition: model,
        createDataWriter,
      },
    );

    // Verify data output has correct spec type (now using dataHandles API)
    assertEquals(result.dataHandles?.length, 1);
    assertEquals(result.dataHandles![0].specType.value, "message");
    assertEquals(result.dataHandles![0].name, "test-echo-message");

    // Verify defaults were applied
    assertEquals(
      result.dataHandles![0].metadata.contentType,
      "application/json",
    );
    assertEquals(result.dataHandles![0].metadata.lifetime, "ephemeral");
    assertEquals(result.dataHandles![0].metadata.garbageCollection, 10);
  });
});

Deno.test("Data output specs - undeclared spec type fails at writer creation", async () => {
  // In the new API, spec type validation happens when createDataWriter is called.
  // The DataWriterFactory throws if the spec type isn't declared.
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      attributes: { message: "Test" },
    });

    // Create DataWriterFactory for the echo model (which only has "message" spec)
    const { factory: createDataWriter } = createDataWriterFactory(
      dataRepo,
      echoModelType,
      definition.id,
      await definition.computeHash(),
      model!.dataOutputSpecs,
    );

    // Create a method that tries to use an undeclared spec type
    const badMethod = {
      description: "Bad method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async (
        _def: Definition,
        ctx: { createDataWriter?: DataWriterFactory },
      ) => {
        // This should throw because "undeclared" is not in echo model's dataOutputSpecs
        const writer = ctx.createDataWriter!({
          name: "bad-output",
          specType: "undeclared",
        });
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
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          modelDefinition: model,
          createDataWriter,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // The error should come from the DataWriterFactory
    assertStringIncludes(errorMessage, "Undeclared spec type 'undeclared'");
    assertStringIncludes(errorMessage, "Declared spec types: message");
  });
});

Deno.test("Data output specs - multiple instances of same spec type", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      attributes: { message: "Test" },
    });

    // Create DataWriterFactory
    const { factory: createDataWriter } = createDataWriterFactory(
      dataRepo,
      echoModelType,
      definition.id,
      await definition.computeHash(),
      model!.dataOutputSpecs,
    );

    // Create a method that produces multiple message instances using the new API
    const multiMessageMethod = {
      description: "Multi message method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async (
        _def: Definition,
        ctx: { createDataWriter?: DataWriterFactory },
      ) => {
        const writer1 = ctx.createDataWriter!({
          name: "message-1",
          specType: "message",
        });
        const handle1 = await writer1.writeText(
          JSON.stringify({
            message: "First",
            timestamp: new Date().toISOString(),
          }),
        );

        const writer2 = ctx.createDataWriter!({
          name: "message-2",
          specType: "message",
        });
        const handle2 = await writer2.writeText(
          JSON.stringify({
            message: "Second",
            timestamp: new Date().toISOString(),
          }),
        );

        return { dataHandles: [handle1, handle2] };
      },
    };

    const result = await executionService.execute(
      definition,
      multiMessageMethod,
      {
        repoDir,
        modelType: echoModelType,
        modelId: definition.id,
        logger: getLogger(["test"]),
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        modelDefinition: model,
        createDataWriter,
      },
    );

    // Verify both outputs reference the same spec type
    assertEquals(result.dataHandles?.length, 2);
    assertEquals(result.dataHandles![0].specType.value, "message");
    assertEquals(result.dataHandles![1].specType.value, "message");
    assertEquals(result.dataHandles![0].name, "message-1");
    assertEquals(result.dataHandles![1].name, "message-2");
  });
});

Deno.test("Data output specs - validation detects duplicate instance names", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      attributes: { message: "Test" },
    });

    // Create DataWriterFactory
    const { factory: createDataWriter } = createDataWriterFactory(
      dataRepo,
      echoModelType,
      definition.id,
      await definition.computeHash(),
      model!.dataOutputSpecs,
    );

    // Create a method that returns handles with duplicate names
    const duplicateNamesMethod = {
      description: "Duplicate names method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async (
        _def: Definition,
        ctx: { createDataWriter?: DataWriterFactory },
      ) => {
        const writer1 = ctx.createDataWriter!({
          name: "duplicate",
          specType: "message",
        });
        const handle1 = await writer1.writeText("first");

        const writer2 = ctx.createDataWriter!({
          name: "duplicate",
          specType: "message",
        });
        const handle2 = await writer2.writeText("second");

        return { dataHandles: [handle1, handle2] };
      },
    };

    let errorMessage = "";
    try {
      await executionService.execute(
        definition,
        duplicateNamesMethod,
        {
          repoDir,
          modelType: echoModelType,
          modelId: definition.id,
          logger: getLogger(["test"]),
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          modelDefinition: model,
          createDataWriter,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    assertStringIncludes(
      errorMessage,
      "Duplicate data instance name 'duplicate'",
    );
  });
});
