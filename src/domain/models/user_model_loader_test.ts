import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserModelLoader } from "./user_model_loader.ts";
import { modelRegistry } from "./model.ts";
import { Definition } from "../definitions/definition.ts";
import type { MethodContext } from "./model.ts";
import type { ModelType } from "./model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";

// Import models barrel to ensure swamp/echo is registered for duplicate test
import "./models.ts";

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
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

/**
 * Creates a mock DefinitionRepository for testing.
 */
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

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(modelType: ModelType): MethodContext {
  return {
    repoDir: "/tmp",
    modelType,
    modelId: crypto.randomUUID(),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

// Helper to create a temporary directory with model files
async function withTempModels(
  models: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_test_models_" });
  try {
    for (const [filename, content] of Object.entries(models)) {
      await Deno.writeTextFile(join(tempDir, filename), content);
    }
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("UserModelLoader loads valid model with dataOutputs", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "test/data-model-${Date.now()}",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    process: {
      description: "Process the message",
      execute: async (definition, _context) => {
        return {
          dataOutputs: [{
            name: definition.name + "-data",
            content: JSON.stringify({
              message: definition.attributes.message,
              processedAt: new Date().toISOString(),
            }),
          }],
        };
      },
    },
  },
};
`;

  await withTempModels({ "data_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "data_model.ts");
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader handles missing model export", async () => {
  const modelCode = `
export const notAModel = { foo: "bar" };
`;

  await withTempModels({ "no_export.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "no_export.ts");
    assertEquals(result.failed[0].error, "No 'model' export found");
  });
});

Deno.test("UserModelLoader handles invalid model structure", async () => {
  const modelCode = `
export const model = {
  type: "test/invalid",
  // Missing required fields
};
`;

  await withTempModels({ "invalid_structure.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "invalid_structure.ts");
  });
});

Deno.test("UserModelLoader handles non-existent directory", async () => {
  const loader = new UserModelLoader();
  const result = await loader.loadModels("/nonexistent/path/to/models");

  assertEquals(result.loaded.length, 0);
  assertEquals(result.failed.length, 0);
});

Deno.test("UserModelLoader skips test files", async () => {
  const testFile = `
export const model = { type: "test/should-skip" };
`;
  const regularFile = `
import { z } from "npm:zod@4";

export const model = {
  type: "test/regular-${Date.now()}",
  version: 1,
  inputAttributesSchema: z.object({ msg: z.string() }),
  methods: {
    run: {
      description: "Run",
      execute: async (definition) => ({
        dataOutputs: [{
          name: definition.name + "-result",
          content: JSON.stringify({ result: "ok" }),
        }],
      }),
    },
  },
};
`;

  await withTempModels(
    { "model_test.ts": testFile, "model.ts": regularFile },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], "model.ts");
      // Test file should not appear in failed either
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader prevents duplicate type registration", async () => {
  // First, ensure swamp/echo is registered (it's already in the global registry)
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "swamp/echo",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write message",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;

  await withTempModels({ "duplicate.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "duplicate.ts");
    assertStringIncludes(result.failed[0].error, "already registered");
  });
});

Deno.test("UserModelLoader converts plain dataOutputs to proper DataOutput format", async () => {
  const typeId = `test/convert-data-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  name: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    create: {
      description: "Create a resource",
      execute: async (definition, _context) => {
        // Return plain objects - the loader should add proper metadata
        return {
          dataOutputs: [{
            name: definition.name + "-data",
            content: JSON.stringify({
              id: "resource-123",
              status: "created",
            }),
          }],
        };
      },
    },
  },
};
`;

  await withTempModels({ "convert_data.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    // Get the registered model and execute its method
    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const definition = Definition.create({
      name: "test-input",
      attributes: { name: "test" },
    });

    const context = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.create.execute(
      definition,
      context,
    );

    // Verify the dataOutputs have proper structure
    assertEquals(methodResult.dataOutputs !== undefined, true);
    assertEquals(methodResult.dataOutputs!.length, 1);

    const dataOutput = methodResult.dataOutputs![0];
    assertEquals(dataOutput.name, "test-input-data");
    assertEquals(dataOutput.metadata !== undefined, true);
    assertEquals(dataOutput.metadata.contentType, "application/octet-stream");
    assertEquals(dataOutput.metadata.lifetime, "infinite");
    assertEquals(dataOutput.metadata.ownerDefinition !== undefined, true);
    assertEquals(dataOutput.metadata.ownerDefinition.ownerType, "model-method");
    assertEquals(dataOutput.metadata.ownerDefinition.ownerRef, "create");

    // Verify the content
    const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
    assertEquals(content.id, "resource-123");
    assertEquals(content.status, "created");
  });
});

Deno.test("UserModelLoader uses model inputAttributesSchema when method lacks one", async () => {
  const typeId = `test/method-inherits-schema-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Run without own schema",
      // No inputAttributesSchema here - should inherit from model
      execute: async (definition, _context) => {
        return {
          dataOutputs: [{
            name: definition.name + "-result",
            content: JSON.stringify({ result: "processed" }),
          }],
        };
      },
    },
  },
};
`;

  await withTempModels({ "inherit_schema.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // Verify the method has an inputAttributesSchema (inherited from model)
    assertEquals(
      modelDef!.methods.run.inputAttributesSchema !== undefined,
      true,
    );
  });
});

Deno.test("UserModelLoader loads multiple models from directory", async () => {
  const model1 = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/multi-a-${Date.now()}",
  version: 1,
  inputAttributesSchema: z.object({ a: z.string() }),
  methods: {
    run: {
      description: "Run A",
      execute: async (d) => ({ dataOutputs: [{ name: d.name + "-a", content: JSON.stringify({ a: "a" }) }] }),
    },
  },
};
`;

  const model2 = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/multi-b-${Date.now()}",
  version: 1,
  inputAttributesSchema: z.object({ b: z.string() }),
  methods: {
    run: {
      description: "Run B",
      execute: async (d) => ({ dataOutputs: [{ name: d.name + "-b", content: JSON.stringify({ b: "b" }) }] }),
    },
  },
};
`;

  await withTempModels(
    { "model_a.ts": model1, "model_b.ts": model2 },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 2);
      assertEquals(result.failed.length, 0);
      // Files should be sorted alphabetically
      assertEquals(result.loaded[0], "model_a.ts");
      assertEquals(result.loaded[1], "model_b.ts");
    },
  );
});
