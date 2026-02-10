import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { UserModelLoader } from "./user_model_loader.ts";
import { modelRegistry } from "./model.ts";
import { Definition } from "../definitions/definition.ts";
import { normalizeSpecType } from "./model.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterFactory,
  MethodContext,
  SpecBasedWriterOptions,
} from "./model.ts";
import type { ModelType } from "./model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import { getLogger } from "@logtape/logtape";

// Import models barrel to ensure swamp/echo is registered for duplicate test
import "./models.ts";

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates a mock DataWriterFactory that stores written content in memory.
 */
function createMockDataWriterFactory(): {
  factory: DataWriterFactory;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const factory: DataWriterFactory = (
    options: SpecBasedWriterOptions,
  ): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name: options.name,
      specType: normalizeSpecType(options.specType),
      dataId,
      version: 1,
      size: content.length,
      tags: { ...(options.tags ?? {}) },
      metadata: {
        contentType: options.contentType ?? "application/json",
        lifetime: options.lifetime ?? "infinite",
        garbageCollection: options.garbageCollection ?? 10,
        streaming: options.streaming ?? false,
        tags: { ...(options.tags ?? {}) },
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name: options.name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { factory, getResults };
}

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
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
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
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
function createTestContext(
  modelType: ModelType,
): { context: MethodContext; getResults: () => MockWriterResult[] } {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: "/tmp",
    modelType,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
  };
  return { context, getResults };
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

Deno.test("UserModelLoader loads valid model with dataHandles", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "@user/data-model-${Date.now()}",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    process: {
      description: "Process the message",
      execute: async (definition, context) => {
        const writer = context.createDataWriter({
          name: definition.name + "-data",
          specType: "data",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "data" },
        });
        const handle = await writer.writeText(JSON.stringify({
          message: definition.attributes.message,
          processedAt: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
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
  type: "@user/invalid",
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
  type: "@user/regular-${Date.now()}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ msg: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
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
  // Test that two models with the same type fail on the second one
  const ts = Date.now();
  const typeId = `@user/duplicate-${ts}`;
  const model1 = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write message",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const model2 = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.2",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels(
    { "aaa_first.ts": model1, "zzz_second.ts": model2 },
    async (dir) => {
      const loader = new UserModelLoader();
      const result = await loader.loadModels(dir);

      // First model should load, second should fail as duplicate
      assertEquals(result.loaded.length, 1);
      assertEquals(result.failed.length, 1);
      assertEquals(result.failed[0].file, "zzz_second.ts");
      assertStringIncludes(result.failed[0].error, "already registered");
    },
  );
});

Deno.test("UserModelLoader passes through dataHandles from user execute", async () => {
  const typeId = `@user/passthrough-handles-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  name: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    create: {
      description: "Create a resource",
      execute: async (definition, context) => {
        // Use context.createDataWriter to write data
        const writer = context.createDataWriter({
          name: definition.name + "-data",
          specType: "data",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "data" },
        });
        const handle = await writer.writeText(JSON.stringify({
          id: "resource-123",
          status: "created",
        }));
        return { dataHandles: [handle] };
      },
    },
  },
};
`;

  await withTempModels({ "passthrough_data.ts": modelCode }, async (dir) => {
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

    const { context, getResults } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.create.execute(
      definition,
      context,
    );

    // Verify the dataHandles are passed through
    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 1);

    const handle = methodResult.dataHandles![0];
    assertEquals(handle.name, "test-input-data");

    // Verify content was written via mock writer
    const results = getResults();
    assertEquals(results.length, 1);
    const content = JSON.parse(new TextDecoder().decode(results[0].content));
    assertEquals(content.id, "resource-123");
    assertEquals(content.status, "created");
  });
});

Deno.test("UserModelLoader uses model inputAttributesSchema when method lacks one", async () => {
  const typeId = `@user/method-inherits-schema-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run without own schema",
      // No inputAttributesSchema here - should inherit from model
      execute: async () => ({ dataHandles: [] }),
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
  type: "@user/multi-a-${Date.now()}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ a: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run A",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const model2 = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/multi-b-${Date.now()}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ b: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run B",
      execute: async () => ({ dataHandles: [] }),
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

Deno.test("UserModelLoader user method returns empty dataHandles", async () => {
  const typeId = `@user/empty-handles-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  testInput: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    execute: {
      description: "Test method that returns empty dataHandles",
      execute: async (_definition, _context) => {
        return { dataHandles: [] };
      },
    },
  },
};
`;

  await withTempModels({ "empty_handles.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const definition = Definition.create({
      name: "test-resource",
      attributes: { testInput: "Hello World" },
    });

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.execute.execute(
      definition,
      context,
    );

    // Verify empty dataHandles are passed through
    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 0);
  });
});

Deno.test("UserModelLoader user method without dataHandles returns undefined", async () => {
  const typeId = `@user/no-handles-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  query: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    fetch: {
      description: "Test method that returns no dataHandles",
      execute: async (_definition, _context) => {
        return {};
      },
    },
  },
};
`;

  await withTempModels({ "no_handles.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const definition = Definition.create({
      name: "test-data",
      attributes: { query: "SELECT *" },
    });

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.fetch.execute(
      definition,
      context,
    );

    // Verify dataHandles is undefined when not provided
    assertEquals(methodResult.dataHandles, undefined);
  });
});

// --- Recursive discovery tests ---

Deno.test("UserModelLoader discovers nested files with correct relative paths", async () => {
  const ts = Date.now();
  const modelA = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/nested-a-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ a: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run A",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const modelB = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/nested-b-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ b: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run B",
      execute: async () => ({ dataHandles: [] }),
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
  type: "@user/subdir-notest-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ x: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: { description: "Run", execute: async () => ({ dataHandles: [] }) },
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
  type: "@user/deep-nested-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ x: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: { description: "Run", execute: async () => ({ dataHandles: [] }) },
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
  type: "@user/ext-single-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/ext-single-${ts}",
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async () => ({ dataHandles: [] }),
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
      const modelDef = modelRegistry.get(`@user/ext-single-${ts}`);
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
  type: "@user/ext-multi-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/ext-multi-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataHandles: [] }),
    },
    verify: {
      description: "Verify",
      execute: async () => ({ dataHandles: [] }),
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

      const modelDef = modelRegistry.get(`@user/ext-multi-${ts}`);
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
  type: "@user/nonexistent-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataHandles: [] }),
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
  type: "@user/ext-conflict-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/ext-conflict-${ts}",
  methods: [{
    write: {
      description: "Duplicate write",
      execute: async () => ({ dataHandles: [] }),
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
  type: "@user/ext-dup-methods-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  // Two array elements with same method name
  const extCode = `
export const extension = {
  type: "@user/ext-dup-methods-${ts}",
  methods: [
    {
      audit: {
        description: "Audit v1",
        execute: async () => ({ dataHandles: [] }),
      },
    },
    {
      audit: {
        description: "Audit v2",
        execute: async () => ({ dataHandles: [] }),
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
  type: "@user/ext-inherit-schema-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/ext-inherit-schema-${ts}",
  methods: [{
    audit: {
      description: "Audit without own schema",
      execute: async () => ({ dataHandles: [] }),
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

      const modelDef = modelRegistry.get(`@user/ext-inherit-schema-${ts}`);
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
      execute: async () => ({ dataHandles: [] }),
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
  type: "@user/multi-ext-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const ext1 = `
export const extension = {
  type: "@user/multi-ext-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;
  const ext2 = `
export const extension = {
  type: "@user/multi-ext-${ts}",
  methods: [{
    verify: {
      description: "Verify",
      execute: async () => ({ dataHandles: [] }),
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

      const modelDef = modelRegistry.get(`@user/multi-ext-${ts}`);
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
  type: "@user/two-pass-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/two-pass-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async () => ({ dataHandles: [] }),
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

      const modelDef = modelRegistry.get(`@user/two-pass-${ts}`);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader extension method execute passes through dataHandles", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/ext-execute-${ts}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    write: {
      description: "Write",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
export const extension = {
  type: "@user/ext-execute-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      execute: async (definition, context) => {
        const writer = context.createDataWriter({
          name: "audit-result",
          specType: "data",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "data" },
        });
        const handle = await writer.writeText(JSON.stringify({
          audited: true,
          msg: definition.attributes.message,
        }));
        return { dataHandles: [handle] };
      },
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

      const modelDef = modelRegistry.get(`@user/ext-execute-${ts}`);
      const definition = Definition.create({
        name: "test-audit",
        attributes: { message: "hello" },
      });
      const { context, getResults } = createTestContext(modelDef!.type);

      const methodResult = await modelDef!.methods.audit.execute(
        definition,
        context,
      );

      assertEquals(methodResult.dataHandles !== undefined, true);
      assertEquals(methodResult.dataHandles!.length, 1);

      const handle = methodResult.dataHandles![0];
      assertEquals(handle.name, "audit-result");

      // Verify content written via mock writer
      const results = getResults();
      assertEquals(results.length, 1);
      const content = JSON.parse(
        new TextDecoder().decode(results[0].content),
      );
      assertEquals(content.audited, true);
      assertEquals(content.msg, "hello");
    },
  );
});

// --- dataOutputSpecs validation tests ---

Deno.test("UserModelLoader rejects model without dataOutputSpecs", async () => {
  const typeId = `@user/no-specs-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "no_specs.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "dataOutputSpecs");
  });
});

Deno.test("UserModelLoader registers user-declared dataOutputSpecs", async () => {
  const typeId = `@user/custom-specs-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Custom data spec",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "metrics": {
      specType: "metrics",
      description: "Metrics output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "metrics" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
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

    // User "data" spec overrides default, "metrics" added
    assertEquals(
      modelDef!.dataOutputSpecs["data"].description,
      "Custom data spec",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["data"].contentType,
      "text/plain",
    );
    assertEquals(
      modelDef!.dataOutputSpecs["metrics"].specType.value,
      "metrics",
    );
  });
});

// --- Namespace validation tests ---

Deno.test("UserModelLoader rejects model without @ prefix", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "mycompany/mymodel",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "no_at_prefix.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "must use '@' prefix");
  });
});

Deno.test("UserModelLoader rejects model with only namespace segment (@user)", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "only_namespace.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "at least 2 segments");
  });
});

Deno.test("UserModelLoader rejects model with only namespace segment (@myorg)", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@myorg",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "only_myorg.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "at least 2 segments");
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @adam/mymodel", async () => {
  const typeId = `@adam/mymodel-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "custom_namespace.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @stack72/name", async () => {
  const typeId = `@stack72/my-model-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "stack72_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @keeb/name", async () => {
  const typeId = `@keeb/keyboard-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "keeb_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts valid @user/name format", async () => {
  const typeId = `@user/valid-model-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "valid_user_model.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts valid @user/foo/bar format with 3 segments", async () => {
  const typeId = `@user/category/model-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "valid_nested.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader rejects reserved namespace swamp/*", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "swamp/mymodel",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "reserved_swamp.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "reserved namespace");
  });
});

Deno.test("UserModelLoader rejects reserved namespace si/*", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "si/mymodel",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "reserved_si.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "reserved namespace");
  });
});

Deno.test("UserModelLoader rejects reserved namespace @swamp/*", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@swamp/mymodel",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "reserved_at_swamp.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "reserved namespace");
  });
});

Deno.test("UserModelLoader rejects reserved namespace @si/*", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@si/mymodel",
  version: "2026.02.09.1",
  inputAttributesSchema: z.object({ message: z.string() }),
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Data output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Run",
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "reserved_at_si.ts": modelCode }, async (dir) => {
    const loader = new UserModelLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "reserved namespace");
  });
});
