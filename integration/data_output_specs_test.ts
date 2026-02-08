import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { UserModelLoader } from "../src/domain/models/user_model_loader.ts";
import { generateDataId } from "../src/domain/data/data_id.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import type { UnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../src/domain/definitions/repositories.ts";
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

    // Execute the method
    const result = await executionService.execute(
      definition,
      writeMethod,
      {
        repoDir,
        modelType,
        modelId: definition.id,
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        modelDefinition: model,
      },
    );

    // Verify data output has correct spec type
    assertEquals(result.dataOutputs?.length, 1);
    assertEquals(result.dataOutputs![0].specType.value, "message");
    assertEquals(result.dataOutputs![0].name, "test-echo-message");

    // Verify defaults were applied
    assertEquals(
      result.dataOutputs![0].metadata.contentType,
      "application/json",
    );
    assertEquals(result.dataOutputs![0].metadata.lifetime, "ephemeral");
    assertEquals(result.dataOutputs![0].metadata.garbageCollection, 10);
  });
});

Deno.test("Data output specs - validation fails for undeclared spec type", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    // Get echo model
    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    // Create a definition
    const definition = Definition.create({
      name: "test-echo",
      attributes: {
        message: "Test",
      },
    });

    // Create a mock method that produces undeclared spec type
    const badMethod = {
      description: "Bad method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async () => {
        const { DataSpecType } = await import("../src/domain/models/model.ts");
        return {
          dataOutputs: [{
            name: "bad-output",
            specType: DataSpecType.create("undeclared"),
            content: new Uint8Array(),
            metadata: {
              contentType: "application/json",
              lifetime: "infinite" as const,
              garbageCollection: 10,
              streaming: false,
              tags: { type: "data" },
              ownerDefinition: {
                definitionHash: "hash",
                ownerType: "model-method" as const,
                ownerRef: "bad",
              },
            },
          }],
        };
      },
    };

    // Execute the bad method
    let errorMessage = "";
    try {
      await executionService.execute(
        definition,
        badMethod,
        {
          repoDir,
          modelType: echoModelType,
          modelId: definition.id,
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          modelDefinition: model,
        },
      );
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    // Verify validation error
    assertStringIncludes(errorMessage, "Data output validation failed");
    assertStringIncludes(errorMessage, "undeclared spec type 'undeclared'");
    assertStringIncludes(errorMessage, "Declared spec types: message");
  });
});

Deno.test("Data output specs - multiple instances of same spec type", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const executionService = new DefaultMethodExecutionService();

    // Get echo model
    const echoModelType = ModelType.create("swamp/echo");
    const model = modelRegistry.get(echoModelType);

    const definition = Definition.create({
      name: "test-echo",
      attributes: {
        message: "Test",
      },
    });

    // Create a method that produces multiple message instances
    const multiMessageMethod = {
      description: "Multi message method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async () => {
        const { DataSpecType } = await import("../src/domain/models/model.ts");

        return {
          dataOutputs: [
            {
              name: "message-1",
              specType: DataSpecType.create("message"),
              content: new TextEncoder().encode(
                JSON.stringify({
                  message: "First",
                  timestamp: new Date().toISOString(),
                }),
              ),
              metadata: {
                contentType: "application/json",
                lifetime: "ephemeral" as const,
                garbageCollection: 10,
                streaming: false,
                tags: { type: "data" },
                ownerDefinition: {
                  definitionHash: "hash",
                  ownerType: "model-method" as const,
                  ownerRef: "multi",
                },
              },
            },
            {
              name: "message-2",
              specType: DataSpecType.create("message"),
              content: new TextEncoder().encode(
                JSON.stringify({
                  message: "Second",
                  timestamp: new Date().toISOString(),
                }),
              ),
              metadata: {
                contentType: "application/json",
                lifetime: "ephemeral" as const,
                garbageCollection: 10,
                streaming: false,
                tags: { type: "data" },
                ownerDefinition: {
                  definitionHash: "hash",
                  ownerType: "model-method" as const,
                  ownerRef: "multi",
                },
              },
            },
          ],
        };
      },
    };

    // Execute the method
    const result = await executionService.execute(
      definition,
      multiMessageMethod,
      {
        repoDir,
        modelType: echoModelType,
        modelId: definition.id,
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        modelDefinition: model,
      },
    );

    // Verify both outputs reference the same spec type
    assertEquals(result.dataOutputs?.length, 2);
    assertEquals(result.dataOutputs![0].specType.value, "message");
    assertEquals(result.dataOutputs![1].specType.value, "message");
    assertEquals(result.dataOutputs![0].name, "message-1");
    assertEquals(result.dataOutputs![1].name, "message-2");
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
      attributes: {
        message: "Test",
      },
    });

    // Create a method with duplicate names
    const duplicateNamesMethod = {
      description: "Duplicate names method",
      inputAttributesSchema: model!.inputAttributesSchema,
      execute: async () => {
        const { DataSpecType } = await import("../src/domain/models/model.ts");
        return {
          dataOutputs: [
            {
              name: "duplicate",
              specType: DataSpecType.create("message"),
              content: new Uint8Array(),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite" as const,
                garbageCollection: 10,
                streaming: false,
                tags: { type: "data" },
                ownerDefinition: {
                  definitionHash: "hash",
                  ownerType: "model-method" as const,
                  ownerRef: "dup",
                },
              },
            },
            {
              name: "duplicate",
              specType: DataSpecType.create("message"),
              content: new Uint8Array(),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite" as const,
                garbageCollection: 10,
                streaming: false,
                tags: { type: "data" },
                ownerDefinition: {
                  definitionHash: "hash",
                  ownerType: "model-method" as const,
                  ownerRef: "dup",
                },
              },
            },
          ],
        };
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
          dataRepository: dataRepo,
          definitionRepository: definitionRepo,
          modelDefinition: model,
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

// --- User model integration tests ---

function createMockDataRepo(): UnifiedDataRepository {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
  };
}

function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

async function withTempModels(
  models: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_integ_models_" });
  try {
    for (const [filename, content] of Object.entries(models)) {
      const fullPath = join(tempDir, filename);
      const dir = dirname(fullPath);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    }
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("Data output specs - user model with data output passes validation", async () => {
  const ts = Date.now();
  const typeId = `test/integ-data-output-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    process: {
      description: "Process and return data",
      execute: async (definition, _context) => {
        return {
          data: {
            attributes: {
              processed: true,
              message: definition.attributes.message,
            },
          },
        };
      },
    },
  },
};
`;

  await withTempModels({ "data_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const loadResult = await loader.loadModels(dir);

    assertEquals(loadResult.loaded.length, 1);
    assertEquals(loadResult.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // Execute the method through the execution service (includes validation)
    const executionService = new DefaultMethodExecutionService();
    const definition = Definition.create({
      name: "test-input",
      attributes: { message: "Hello" },
    });

    const modelType = ModelType.create(typeId);

    // This should NOT throw — the default "data" spec type covers the output
    const result = await executionService.execute(
      definition,
      modelDef!.methods.process,
      {
        repoDir: "/tmp",
        modelType,
        modelId: definition.id,
        dataRepository: createMockDataRepo(),
        definitionRepository: createMockDefinitionRepo(),
        modelDefinition: modelDef,
      },
    );

    assertEquals(result.dataOutputs?.length, 1);
    assertEquals(result.dataOutputs![0].specType.value, "data");
    assertEquals(result.dataOutputs![0].name, "data");
  });
});

Deno.test("Data output specs - user model with resource output passes validation", async () => {
  const ts = Date.now();
  const typeId = `test/integ-resource-output-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: z.object({ name: z.string() }),
  methods: {
    create: {
      description: "Create a resource",
      execute: async (definition, _context) => {
        return {
          resource: {
            attributes: {
              id: "res-123",
              name: definition.attributes.name,
            },
          },
        };
      },
    },
  },
};
`;

  await withTempModels({ "resource_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const loadResult = await loader.loadModels(dir);

    assertEquals(loadResult.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const executionService = new DefaultMethodExecutionService();
    const definition = Definition.create({
      name: "test-resource",
      attributes: { name: "my-resource" },
    });

    const modelType = ModelType.create(typeId);

    // This should NOT throw — the default "resource" spec type covers the output
    const result = await executionService.execute(
      definition,
      modelDef!.methods.create,
      {
        repoDir: "/tmp",
        modelType,
        modelId: definition.id,
        dataRepository: createMockDataRepo(),
        definitionRepository: createMockDefinitionRepo(),
        modelDefinition: modelDef,
      },
    );

    assertEquals(result.dataOutputs?.length, 1);
    assertEquals(result.dataOutputs![0].specType.value, "resource");
    assertEquals(result.dataOutputs![0].name, "resource");
  });
});
