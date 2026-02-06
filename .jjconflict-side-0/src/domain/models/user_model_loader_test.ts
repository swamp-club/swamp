import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
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

// Helper to create a temporary directory with model files.
// Supports nested paths like "aws/ec2_start.ts" — parent dirs are created as needed.
async function withTempModels(
  models: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_test_models_" });
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
    assertEquals(
      result.failed[0].error,
      "No 'model' or 'extension' export found",
    );
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

Deno.test("UserModelLoader converts resource return format to dataOutputs", async () => {
  const typeId = `test/resource-format-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  testInput: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    execute: {
      description: "Test method that returns resource format",
      execute: async (definition, _context) => {
        return {
          resource: {
            id: definition.id,
            attributes: {
              testOutput: "Processed: " + definition.attributes.testInput,
              executedAt: "2024-01-01T00:00:00Z",
            },
          },
        };
      },
    },
  },
};
`;

  await withTempModels({ "resource_format.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const definition = Definition.create({
      name: "test-resource",
      attributes: { testInput: "Hello World" },
    });

    const context = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.execute.execute(
      definition,
      context,
    );

    // Verify resource was converted to dataOutputs
    assertEquals(methodResult.dataOutputs !== undefined, true);
    assertEquals(methodResult.dataOutputs!.length, 1);

    const dataOutput = methodResult.dataOutputs![0];
    assertEquals(dataOutput.name, "resource");
    assertEquals(dataOutput.metadata.contentType, "application/json");
    assertEquals(dataOutput.metadata.tags.type, "resource");

    // Verify the content contains the resource attributes
    const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
    assertEquals(content.testOutput, "Processed: Hello World");
    assertEquals(content.executedAt, "2024-01-01T00:00:00Z");
  });
});

Deno.test("UserModelLoader converts data return format to dataOutputs", async () => {
  const typeId = `test/data-format-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  query: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    fetch: {
      description: "Test method that returns data format",
      execute: async (definition, _context) => {
        return {
          data: {
            attributes: {
              result: "Query result for: " + definition.attributes.query,
              count: 42,
            },
            name: "query-result",
            tags: { source: "test" },
          },
        };
      },
    },
  },
};
`;

  await withTempModels({ "data_format.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const definition = Definition.create({
      name: "test-data",
      attributes: { query: "SELECT *" },
    });

    const context = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.fetch.execute(
      definition,
      context,
    );

    // Verify data was converted to dataOutputs
    assertEquals(methodResult.dataOutputs !== undefined, true);
    assertEquals(methodResult.dataOutputs!.length, 1);

    const dataOutput = methodResult.dataOutputs![0];
    assertEquals(dataOutput.name, "query-result");
    assertEquals(dataOutput.metadata.contentType, "application/json");
    assertEquals(dataOutput.metadata.tags.source, "test");

    // Verify the content contains the data attributes
    const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
    assertEquals(content.result, "Query result for: SELECT *");
    assertEquals(content.count, 42);
  });
});

// --- Recursive discovery tests ---

Deno.test("UserModelLoader discovers nested files with correct relative paths", async () => {
  const ts = Date.now();
  const modelA = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/nested-a-${ts}",
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
  const modelB = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/nested-b-${ts}",
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
    { "aws/ec2_start.ts": modelA, "echo_audit.ts": modelB },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 2);
      assertEquals(result.failed.length, 0);
      // Sorted alphabetically: "aws/ec2_start.ts" < "echo_audit.ts"
      assertEquals(result.loaded[0], join("aws", "ec2_start.ts"));
      assertEquals(result.loaded[1], "echo_audit.ts");
    },
  );
});

Deno.test("UserModelLoader excludes _test.ts in subdirectories", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/subdir-notest-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ x: z.string() }),
  methods: {
    run: { description: "Run", execute: async () => ({ dataOutputs: [] }) },
  },
};
`;
  const testFile = `export const model = { type: "test/should-skip" };`;

  await withTempModels(
    { "sub/model.ts": modelCode, "sub/model_test.ts": testFile },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], join("sub", "model.ts"));
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader handles deeply nested directories (3+ levels)", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/deep-nested-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ x: z.string() }),
  methods: {
    run: { description: "Run", execute: async () => ({ dataOutputs: [] }) },
  },
};
`;

  await withTempModels(
    { "a/b/c/deep_model.ts": modelCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(
        result.loaded[0],
        join("a", "b", "c", "deep_model.ts"),
      );
    },
  );
});

// --- Extension tests ---

Deno.test("UserModelLoader loads extension with single method in array", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-single-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/ext-single-${ts}",
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async (definition, _context) => ({
        data: {
          attributes: { audited: true, name: definition.name },
          name: "audit-result",
        },
      }),
    },
  }],
};
`;

  await withTempModels(
    { "base_model.ts": modelCode, "ext_audit.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.extended[0], "ext_audit.ts");
      assertEquals(result.failed.length, 0);

      // Verify the method was added
      const modelDef = modelRegistry.get(`test/ext-single-${ts}`);
      assertEquals(modelDef !== undefined, true);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader loads extension with multiple methods in array", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-multi-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/ext-multi-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ data: { attributes: { audited: true } } }),
    },
    verify: {
      description: "Verify",
      execute: async () => ({ data: { attributes: { verified: true } } }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`test/ext-multi-${ts}`);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
      assertEquals("verify" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader extension targeting unregistered type fails gracefully", async () => {
  const ts = Date.now();
  const extCode = `
export const extension = {
  type: "test/nonexistent-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataOutputs: [] }),
    },
  }],
};
`;

  await withTempModels({ "ext_bad.ts": extCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.extended.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "Cannot extend unregistered");
  });
});

Deno.test("UserModelLoader extension with method name conflict fails gracefully", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-conflict-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/ext-conflict-${ts}",
  methods: [{
    write: {
      description: "Duplicate write",
      execute: async () => ({ dataOutputs: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_conflict.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 0);
      assertEquals(result.failed.length, 1);
      assertStringIncludes(result.failed[0].error, "already exists");
    },
  );
});

Deno.test("UserModelLoader extension with duplicate method names within array fails", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-dup-methods-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  // Two array elements with same method name
  const extCode = `
export const extension = {
  type: "test/ext-dup-methods-${ts}",
  methods: [
    {
      audit: {
        description: "Audit v1",
        execute: async () => ({ dataOutputs: [] }),
      },
    },
    {
      audit: {
        description: "Audit v2",
        execute: async () => ({ dataOutputs: [] }),
      },
    },
  ],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_dup.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 0);
      assertEquals(result.failed.length, 1);
      assertStringIncludes(
        result.failed[0].error,
        "Duplicate method name 'audit'",
      );
    },
  );
});

Deno.test("UserModelLoader extension methods inherit target model's inputAttributesSchema", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-inherit-schema-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/ext-inherit-schema-${ts}",
  methods: [{
    audit: {
      description: "Audit without own schema",
      execute: async () => ({ dataOutputs: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`test/ext-inherit-schema-${ts}`);
      // Extension method should have inputAttributesSchema inherited from target model
      assertEquals(
        modelDef!.methods.audit.inputAttributesSchema !== undefined,
        true,
      );
    },
  );
});

Deno.test("UserModelLoader extension of built-in swamp/echo type works", async () => {
  // swamp/echo is registered via the models barrel import at the top
  const extCode = `
export const extension = {
  type: "swamp/echo",
  methods: [{
    audit_ext_test_${Date.now()}: {
      description: "Audit the echo",
      execute: async (definition, _context) => ({
        data: { attributes: { audited: true, name: definition.name } },
      }),
    },
  }],
};
`;

  await withTempModels({ "echo_ext.ts": extCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.extended.length, 1);
    assertEquals(result.failed.length, 0);

    // The built-in swamp/echo should still have its original methods
    const echoDef = modelRegistry.get("swamp/echo");
    assertEquals(echoDef !== undefined, true);
    assertEquals("write" in echoDef!.methods, true);
  });
});

Deno.test("UserModelLoader multiple extensions targeting same type", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/multi-ext-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const ext1 = `
export const extension = {
  type: "test/multi-ext-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ data: { attributes: { audited: true } } }),
    },
  }],
};
`;
  const ext2 = `
export const extension = {
  type: "test/multi-ext-${ts}",
  methods: [{
    verify: {
      description: "Verify",
      execute: async () => ({ data: { attributes: { verified: true } } }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_audit.ts": ext1, "ext_verify.ts": ext2 },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 2);
      assertEquals(result.failed.length, 0);

      const modelDef = modelRegistry.get(`test/multi-ext-${ts}`);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
      assertEquals("verify" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader two-pass ordering: user model registered before extension targets it", async () => {
  const ts = Date.now();
  // Extension file sorts before model file alphabetically,
  // but two-pass loading should process models first
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/two-pass-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/two-pass-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataOutputs: [] }),
    },
  }],
};
`;

  // "aaa_ext.ts" sorts before "zzz_model.ts" to prove ordering doesn't matter
  await withTempModels(
    { "zzz_model.ts": modelCode, "aaa_ext.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.failed.length, 0);

      const modelDef = modelRegistry.get(`test/two-pass-${ts}`);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader extension method execute produces proper DataOutput", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/ext-execute-${ts}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "test/ext-execute-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async (definition, _context) => ({
        data: {
          attributes: { audited: true, msg: definition.attributes.message },
          name: "audit-result",
        },
      }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`test/ext-execute-${ts}`);
      const definition = Definition.create({
        name: "test-audit",
        attributes: { message: "hello" },
      });
      const context = createTestContext(modelDef!.type);

      const methodResult = await modelDef!.methods.audit.execute(
        definition,
        context,
      );

      assertEquals(methodResult.dataOutputs !== undefined, true);
      assertEquals(methodResult.dataOutputs!.length, 1);

      const dataOutput = methodResult.dataOutputs![0];
      assertEquals(dataOutput.name, "audit-result");
      assertEquals(dataOutput.metadata.contentType, "application/json");
      assertEquals(dataOutput.metadata.ownerDefinition.ownerRef, "audit");

      const content = JSON.parse(
        new TextDecoder().decode(dataOutput.content),
      );
      assertEquals(content.audited, true);
      assertEquals(content.msg, "hello");
    },
  );
});

// --- Default dataOutputSpecs tests ---

Deno.test("UserModelLoader provides default data and resource spec types", async () => {
  const typeId = `test/default-specs-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;

  await withTempModels({ "default_specs.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // Verify default "data" and "resource" spec types are present
    assertEquals(Object.keys(modelDef!.dataOutputSpecs).length, 2);
    assertEquals(modelDef!.dataOutputSpecs["data"] !== undefined, true);
    assertEquals(modelDef!.dataOutputSpecs["resource"] !== undefined, true);
    assertEquals(modelDef!.dataOutputSpecs["data"].specType.value, "data");
    assertEquals(
      modelDef!.dataOutputSpecs["resource"].specType.value,
      "resource",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["data"].contentType,
      "application/json",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["resource"].contentType,
      "application/json",
    );
  });
});

Deno.test("UserModelLoader user-declared dataOutputSpecs override defaults", async () => {
  const typeId = `test/custom-specs-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Custom data spec",
      contentType: "text/plain",
    },
    "metrics": {
      specType: "metrics",
      description: "Metrics output",
      contentType: "application/json",
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataOutputs: [] }),
    },
  },
};
`;

  await withTempModels({ "custom_specs.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // User "data" spec overrides default, "resource" default preserved, "metrics" added
    assertEquals(Object.keys(modelDef!.dataOutputSpecs).length, 3);
    assertEquals(
      modelDef!.dataOutputSpecs["data"].description,
      "Custom data spec",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["data"].contentType,
      "text/plain",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["resource"].specType.value,
      "resource",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["metrics"].specType.value,
      "metrics",
    );
  });
});
