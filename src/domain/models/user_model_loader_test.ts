import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserModelLoader } from "./user_model_loader.ts";
import { modelRegistry } from "./model.ts";
import { ModelResource } from "./model_resource.ts";
import { ModelData } from "./model_data.ts";
import { ModelInput } from "./model_input.ts";

// Import models barrel to ensure swamp/echo is registered for duplicate test
import "./models.ts";

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

Deno.test("UserModelLoader loads valid model with dataAttributesSchema", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

const DataSchema = z.object({
  message: z.string(),
  processedAt: z.string(),
});

export const model = {
  type: "test/data-model-${Date.now()}",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    process: {
      description: "Process the message",
      execute: async (input, _context) => {
        return {
          data: {
            id: input.id,
            attributes: {
              message: input.attributes.message,
              processedAt: new Date().toISOString(),
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
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "data_model.ts");
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader loads valid model with resourceAttributesSchema", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  name: z.string(),
});

const ResourceSchema = z.object({
  resourceId: z.string(),
  status: z.string(),
});

export const model = {
  type: "test/resource-model-${Date.now()}",
  version: 1,
  inputAttributesSchema: InputSchema,
  resourceAttributesSchema: ResourceSchema,
  methods: {
    create: {
      description: "Create a resource",
      execute: async (input, _context) => {
        return {
          resource: {
            id: input.id,
            attributes: {
              resourceId: "res-123",
              status: "created",
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
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "resource_model.ts");
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader rejects model with neither schema", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "test/invalid-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    process: {
      description: "Process something",
      execute: async () => ({}),
    },
  },
};
`;

  await withTempModels({ "invalid_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "invalid_model.ts");
    assertStringIncludes(
      result.failed[0].error,
      "Model must have at least one of resourceAttributesSchema or dataAttributesSchema",
    );
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
  dataAttributesSchema: z.object({ result: z.string() }),
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ data: { id: crypto.randomUUID(), attributes: { result: "ok" } } }),
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
  dataAttributesSchema: z.object({ message: z.string() }),
  methods: {
    write: {
      description: "Write message",
      execute: async () => ({}),
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

Deno.test("UserModelLoader converts plain resource objects to ModelResource", async () => {
  const typeId = `test/convert-resource-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  name: z.string(),
});

const ResourceSchema = z.object({
  id: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  resourceAttributesSchema: ResourceSchema,
  methods: {
    create: {
      description: "Create a resource",
      execute: async (input, _context) => {
        // Return a plain object, not a ModelResource instance
        return {
          resource: {
            id: input.id,
            attributes: {
              id: "resource-" + input.id,
            },
          },
        };
      },
    },
  },
};
`;

  await withTempModels({ "convert_resource.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    // Get the registered model and execute its method
    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const input = ModelInput.create({
      name: "test-input",
      attributes: { name: "test" },
    });
    const methodResult = await modelDef!.methods.create.execute(input, {
      repoDir: "/tmp",
    });

    // Verify the resource was converted to a ModelResource instance
    assertEquals(methodResult.resource instanceof ModelResource, true);
    assertEquals(String(methodResult.resource?.id), String(input.id));
  });
});

Deno.test("UserModelLoader converts plain data objects to ModelData", async () => {
  const typeId = `test/convert-data-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  value: z.string(),
});

const DataSchema = z.object({
  processedValue: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    process: {
      description: "Process data",
      execute: async (input, _context) => {
        // Return a plain object, not a ModelData instance
        return {
          data: {
            id: input.id,
            attributes: {
              processedValue: input.attributes.value.toUpperCase(),
            },
          },
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

    const input = ModelInput.create({
      name: "test-input",
      attributes: { value: "hello" },
    });
    const methodResult = await modelDef!.methods.process.execute(input, {
      repoDir: "/tmp",
    });

    // Verify the data was converted to a ModelData instance
    assertEquals(methodResult.data instanceof ModelData, true);
    assertEquals(String(methodResult.data?.id), String(input.id));
    assertEquals(methodResult.data?.attributes.processedValue, "HELLO");
  });
});

Deno.test("UserModelLoader uses model inputAttributesSchema when method lacks one", async () => {
  const typeId = `test/method-inherits-schema-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

const DataSchema = z.object({
  result: z.string(),
});

export const model = {
  type: "${typeId}",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    run: {
      description: "Run without own schema",
      // No inputAttributesSchema here - should inherit from model
      execute: async (input, _context) => {
        return {
          data: {
            id: input.id,
            attributes: {
              result: "processed",
            },
          },
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
  dataAttributesSchema: z.object({ a: z.string() }),
  methods: {
    run: { description: "Run A", execute: async (i) => ({ data: { id: i.id, attributes: { a: "a" } } }) },
  },
};
`;

  const model2 = `
import { z } from "npm:zod@4";
export const model = {
  type: "test/multi-b-${Date.now()}",
  version: 1,
  inputAttributesSchema: z.object({ b: z.string() }),
  dataAttributesSchema: z.object({ b: z.string() }),
  methods: {
    run: { description: "Run B", execute: async (i) => ({ data: { id: i.id, attributes: { b: "b" } } }) },
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
