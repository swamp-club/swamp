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

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { UserModelLoader } from "./user_model_loader.ts";
import { modelRegistry } from "./model.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DataHandle, DataWriter, MethodContext } from "./model.ts";
import type { ModelType } from "./model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import { getLogger } from "@logtape/logtape";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

// Import models barrel to ensure command/shell is registered for extension test
import "./models.ts";

/** Test DenoRuntime that returns the current deno binary path. */
const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

/** Creates a UserModelLoader configured for tests. */
function createTestLoader(): UserModelLoader {
  return new UserModelLoader(testDenoRuntime);
}

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates mock writeResource and createFileWriter functions that store written content in memory.
 */
function createMockWriters(): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  createFileWriter: (specName: string, name: string) => DataWriter;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle> => {
    const dataId = `mock-data-${nextId++}` as DataId;
    const content = new TextEncoder().encode(JSON.stringify(data));
    const handle: DataHandle = {
      name,
      specName,
      kind: "resource",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    };
    results.push({ handle, content });
    return Promise.resolve(handle);
  };

  const createFileWriter = (specName: string, name: string): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name,
      specName,
      kind: "file",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "application/octet-stream",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name,
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

  return { writeResource, createFileWriter, getResults };
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
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    rename: () => {
      throw new Error("not implemented");
    },
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
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    signal: new AbortController().signal,
    repoDir: "/tmp",
    modelType,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "execute",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
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
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({ message: z.string(), processedAt: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    process: {
      description: "Process the message",
      arguments: InputSchema,
      execute: async (args, context) => {
        const handle = await context.writeResource("data", "data", {
          message: args.message,
          processedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
`;

  await withTempModels({ "data_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "data_model.ts");
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader silently skips files without model or extension export", async () => {
  const modelCode = `
export const notAModel = { foo: "bar" };
`;

  await withTempModels({ "no_export.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    // Files without model/extension exports are now silently skipped
    assertEquals(result.loaded.length, 0);
    assertEquals(result.extended.length, 0);
    assertEquals(result.failed.length, 0);
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
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "invalid_structure.ts");
  });
});

Deno.test("UserModelLoader handles non-existent directory", async () => {
  const loader = createTestLoader();
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
  globalArguments: z.object({ msg: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels(
    { "model_test.ts": testFile, "model.ts": regularFile },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write message",
      arguments: z.object({}),
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels(
    { "aaa_first.ts": model1, "zzz_second.ts": model2 },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({ id: z.string(), status: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a resource",
      arguments: InputSchema,
      execute: async (args, context) => {
        const handle = await context.writeResource("data", "data", {
          id: "resource-123",
          status: "created",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
`;

  await withTempModels({ "passthrough_data.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    // Get the registered model and execute its method
    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context, getResults } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.create.execute(
      { name: "test" },
      context,
    );

    // Verify the dataHandles are passed through
    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 1);

    const handle = methodResult.dataHandles![0];
    assertEquals(handle.name, "data");

    // Verify content was written via mock writer
    const results = getResults();
    assertEquals(results.length, 1);
    const content = JSON.parse(new TextDecoder().decode(results[0].content));
    assertEquals(content.id, "resource-123");
    assertEquals(content.status, "created");
  });
});

Deno.test("UserModelLoader uses model globalArguments when method lacks own arguments schema", async () => {
  const typeId = `@user/method-inherits-schema-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run without own schema",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "inherit_schema.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // Verify the method has an arguments schema (inherited from model)
    assertEquals(
      modelDef!.methods.run.arguments !== undefined,
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
  globalArguments: z.object({ a: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run A",
      arguments: z.object({}),
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
  globalArguments: z.object({ b: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run B",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels(
    { "model_a.ts": model1, "model_b.ts": model2 },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    execute: {
      description: "Test method that returns empty dataHandles",
      arguments: InputSchema,
      execute: async (_args, _context) => {
        return { dataHandles: [] };
      },
    },
  },
};
`;

  await withTempModels({ "empty_handles.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.execute.execute(
      { testInput: "Hello World" },
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
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    fetch: {
      description: "Test method that returns no dataHandles",
      arguments: InputSchema,
      execute: async (_args, _context) => {
        return {};
      },
    },
  },
};
`;

  await withTempModels({ "no_handles.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.fetch.execute(
      { query: "SELECT *" },
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
  globalArguments: z.object({ a: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run A",
      arguments: z.object({}),
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
  globalArguments: z.object({ b: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run B",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels(
    { "aws/ec2_start.ts": modelA, "echo_audit.ts": modelB },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ x: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: { description: "Run", arguments: z.object({}), execute: async () => ({ dataHandles: [] }) },
  },
};
`;
  const testFile = `export const model = { type: "test/should-skip" };`;

  await withTempModels(
    { "sub/model.ts": modelCode, "sub/model_test.ts": testFile },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ x: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: { description: "Run", arguments: z.object({}), execute: async () => ({ dataHandles: [] }) },
  },
};
`;

  await withTempModels(
    { "a/b/c/deep_model.ts": modelCode },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-single-${ts}",
  methods: [{
    audit: {
      description: "Audit the echo message",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base_model.ts": modelCode, "ext_audit.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-multi-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
    verify: {
      description: "Verify",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
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
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/nonexistent-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels({ "ext_bad.ts": extCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-conflict-${ts}",
  methods: [{
    write: {
      description: "Duplicate write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_conflict.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  // Two array elements with same method name
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-dup-methods-${ts}",
  methods: [
    {
      audit: {
        description: "Audit v1",
        arguments: z.object({}),
        execute: async () => ({ dataHandles: [] }),
      },
    },
    {
      audit: {
        description: "Audit v2",
        arguments: z.object({}),
        execute: async () => ({ dataHandles: [] }),
      },
    },
  ],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_dup.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
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

Deno.test("UserModelLoader extension methods inherit target model's arguments schema", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/ext-inherit-schema-${ts}",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-inherit-schema-${ts}",
  methods: [{
    audit: {
      description: "Audit without own schema",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`@user/ext-inherit-schema-${ts}`);
      // Extension method should have arguments schema inherited from target model
      assertEquals(
        modelDef!.methods.audit.arguments !== undefined,
        true,
      );
    },
  );
});

Deno.test("UserModelLoader extension of built-in command/shell type works", async () => {
  // command/shell is registered via the models barrel import at the top
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "command/shell",
  methods: [{
    audit_ext_test_${Date.now()}: {
      description: "Audit the shell command",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels({ "shell_ext.ts": extCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.extended.length, 1);
    assertEquals(result.failed.length, 0);

    // The built-in command/shell should still have its original methods
    const shellDef = modelRegistry.get("command/shell");
    assertEquals(shellDef !== undefined, true);
    assertEquals("execute" in shellDef!.methods, true);
  });
});

Deno.test("UserModelLoader multiple extensions targeting same type", async () => {
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/multi-ext-${ts}",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const ext1 = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/multi-ext-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;
  const ext2 = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/multi-ext-${ts}",
  methods: [{
    verify: {
      description: "Verify",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext_audit.ts": ext1, "ext_verify.ts": ext2 },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/two-pass-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  // "aaa_ext.ts" sorts before "zzz_model.ts" to prove ordering doesn't matter
  await withTempModels(
    { "zzz_model.ts": modelCode, "aaa_ext.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "@user/ext-execute-${ts}",
  methods: [{
    audit: {
      description: "Audit",
      arguments: z.object({ message: z.string() }),
      execute: async (args, context) => {
        const handle = await context.writeResource("data", "data", {
          audited: true,
          msg: args.message,
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
`;

  await withTempModels(
    { "base.ts": modelCode, "ext.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
      const result = await loader.loadModels(dir);

      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`@user/ext-execute-${ts}`);
      const { context, getResults } = createTestContext(modelDef!.type);

      const methodResult = await modelDef!.methods.audit.execute(
        { message: "hello" },
        context,
      );

      assertEquals(methodResult.dataHandles !== undefined, true);
      assertEquals(methodResult.dataHandles!.length, 1);

      const handle = methodResult.dataHandles![0];
      assertEquals(handle.name, "data");

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

// --- resources/files validation tests ---

Deno.test("UserModelLoader registers user-declared resources", async () => {
  const typeId = `@user/custom-specs-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Custom data spec",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "metrics": {
      description: "Metrics output",
      schema: z.object({ count: z.number() }),
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "metrics" },
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "custom_specs.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    // User "data" resource spec is registered
    assertEquals(
      modelDef!.resources!["data"].description,
      "Custom data spec",
    );
    // "metrics" resource is also registered
    assertEquals(
      modelDef!.resources!["metrics"].description,
      "Metrics output",
    );
  });
});

// --- Namespace validation tests ---

Deno.test("UserModelLoader accepts non-@ prefixed model", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "mycompany/mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "no_at_prefix.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader rejects model with only namespace segment (@user)", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "only_namespace.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "only_myorg.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "custom_namespace.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "stack72_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "keeb_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "valid_user_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
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
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "valid_nested.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader allows swamp/* namespace for local models", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "swamp/mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "swamp_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader allows si/* namespace for local models", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "si/mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "si_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader accepts non-@ model like digitalocean/app-platform", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "digitalocean/app-platform",
  version: "2026.02.09.1",
  globalArguments: z.object({ token: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "app_platform.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader rejects single-segment non-@ model type", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "single_segment.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "at least 2 segments");
  });
});

Deno.test("UserModelLoader allows @swamp/* namespace for local models", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@swamp/mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "swamp_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.failed.length, 0);
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "swamp_model.ts");
  });
});

Deno.test("UserModelLoader allows @si/* namespace for local models", async () => {
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@si/mymodel",
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "si_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.failed.length, 0);
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "si_model.ts");
  });
});

Deno.test("UserModelLoader silently skips library files without model exports", async () => {
  const validModelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@test/skip-test-${Date.now()}",
  version: "2026.02.11.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const libCode = `
// Library file with no model or extension export
export function sshConnect(host: string) {
  return \`ssh \${host}\`;
}

export class ProxmoxClient {
  constructor(public url: string) {}
}
`;

  await withTempModels({
    "models/server.ts": validModelCode,
    "lib/ssh.ts": libCode,
    "lib/proxmox.ts": libCode,
    "utils/helpers.ts": libCode,
  }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    // Should load only the valid model
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], join("models", "server.ts"));

    // Library files should be silently skipped (not in failed list)
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader silently skips type-only .ts files in subdirectories", async () => {
  const validModelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@test/type-only-skip-${Date.now()}",
  version: "2026.02.11.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const typeOnlyCode = `
// Type-only file — all declarations erased at compile time.
export interface ServerConfig {
  host: string;
  port: number;
}

export type Status = "running" | "stopped" | "error";
`;

  await withTempModels({
    "models/my_model/mod.ts": validModelCode,
    "models/my_model/types.ts": typeOnlyCode,
  }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    // Should load only the valid model
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], join("models", "my_model", "mod.ts"));

    // Type-only files should be silently skipped (not in failed list)
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader invalidates bundle cache when dependency changes", async () => {
  const ts = Date.now();
  const helperCode = `export const greeting = "hello";`;
  const modelCode = `
import { z } from "npm:zod@4";
import { greeting } from "./helper.ts";

export const model = {
  type: "@user/cache-dep-${ts}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_cache_test_repo_" });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_cache_test_models_",
  });
  try {
    // Write initial files
    await Deno.writeTextFile(join(modelsDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    // First load — populates cache
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.loadModels(modelsDir);

    // Read the cached bundle content (namespaced by baseDir hash)
    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    // Wait so mtime differs
    await new Promise((r) => setTimeout(r, 1100));

    // Modify only the dependency (not the entry point)
    await Deno.writeTextFile(
      join(modelsDir, "helper.ts"),
      `export const greeting = "goodbye";`,
    );

    // Second load — should detect dependency change and rebundle
    // (registration will fail since type is already registered, but
    //  bundleWithCache runs before registration, so the bundle updates)
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader2.loadModels(modelsDir);

    // The bundle should have been regenerated with the new dependency content
    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertEquals(cachedBundle1 !== cachedBundle2, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader loads model with TypeScript-specific syntax", async () => {
  const typeId = `@user/ts-syntax-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

// TypeScript interface
interface ModelConfig {
  name: string;
  retries?: number;
}

// Generic function
function withDefault<T extends ModelConfig>(config: T): T {
  return { ...config, retries: config.retries ?? 3 };
}

// Type annotation and optional parameter
function formatName(name: string, prefix?: string): string {
  return prefix ? prefix + "/" + name : name;
}

const config: ModelConfig = withDefault({ name: "ts-test" });
const displayName: string = formatName(config.name, "@user");

const InputSchema = z.object({
  message: z.string(),
});

export const model = {
  type: "${typeId}",
  version: "2026.02.24.1",
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({ name: z.string(), retries: z.number() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run with TypeScript features",
      arguments: InputSchema,
      execute: async (args, context) => {
        const handle = await context.writeResource("data", "data", {
          name: displayName,
          retries: config.retries,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
`;

  await withTempModels({ "ts_syntax_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "ts_syntax_model.ts");
    assertEquals(result.failed.length, 0);

    // Verify the model actually works by executing it
    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context, getResults } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.run.execute(
      { message: "hello" },
      context,
    );

    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 1);

    const results = getResults();
    const content = JSON.parse(new TextDecoder().decode(results[0].content));
    assertEquals(content.name, "@user/ts-test");
    assertEquals(content.retries, 3);
  });
});

// --- kind propagation tests ---

Deno.test("UserModelLoader propagates method kind from model definition", async () => {
  const typeId = `@user/kind-model-${Date.now()}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.03.06.1",
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create the resource",
      kind: "create",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
    remove: {
      description: "Remove (explicit delete kind)",
      kind: "delete",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
    run: {
      description: "Run without kind",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  await withTempModels({ "kind_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.loadModels(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
    assertEquals(modelDef!.methods.create.kind, "create");
    assertEquals(modelDef!.methods.remove.kind, "delete");
    assertEquals(modelDef!.methods.run.kind, undefined);
  });
});

Deno.test("UserModelLoader skips _-prefixed directories in discoverFiles", async () => {
  const ts = Date.now();
  const validModel = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/skip-underscore-${ts}",
  version: "2026.03.18.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "Data output",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const helperCode = `
export function helper() { return "helper"; }
`;

  await withTempModels(
    {
      "entry.ts": validModel,
      "_lib/helper.ts": helperCode,
    },
    async (dir) => {
      const loader = createTestLoader();
      const result = await loader.loadModels(dir);

      // The entry model should load successfully
      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], "entry.ts");

      // _lib/helper.ts should NOT appear in failed or loaded
      for (const failure of result.failed) {
        assertEquals(
          failure.file.includes("_lib"),
          false,
          `_lib file should not appear in failed: ${failure.file}`,
        );
      }
      for (const loaded of result.loaded) {
        assertEquals(
          loaded.includes("_lib"),
          false,
          `_lib file should not appear in loaded: ${loaded}`,
        );
      }
    },
  );
});

Deno.test("UserModelLoader buildIndex detects transitive dependency changes", async () => {
  const ts = Date.now();
  const helperCode = `export const greeting = "hello";`;
  const modelCode = `
import { z } from "npm:zod@4";
import { greeting } from "./helper.ts";

export const model = {
  type: "@user/dep-stale-${ts}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_stale_dep_repo_" });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_stale_dep_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    // Write initial files
    await Deno.writeTextFile(join(modelsDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    // First buildIndex — bootstraps the catalog from a full import
    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);
    catalog1.close();

    // Read the cached bundle content
    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    // Wait so mtime differs
    await new Promise((r) => setTimeout(r, 1100));

    // Modify only the dependency (not the entry point)
    await Deno.writeTextFile(
      join(modelsDir, "helper.ts"),
      `export const greeting = "goodbye";`,
    );

    // Second buildIndex — catalog is populated, should detect dep change
    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    const result = await loader2.buildIndex(modelsDir, catalog2);
    catalog2.close();

    // The bundle should have been regenerated with the new dependency content
    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertNotEquals(
      cachedBundle1,
      cachedBundle2,
      "Bundle should be regenerated when transitive dependency changes",
    );
    // model.ts should appear in the loaded list (it was rebundled)
    assertEquals(result.loaded.length > 0, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader buildIndex rebundles when source content changes with preserved mtime (#125)", async () => {
  // Issue #125 — under atomic-rename saves, rsync --times, and some editors
  // the source file ends up with an mtime that does NOT strictly exceed the
  // cached bundle's mtime, so the old mtime-based freshness check served a
  // stale bundle. This test exercises exactly that sequence with Deno.utime
  // (cross-platform equivalent of `touch -t`) and verifies the
  // content-fingerprint freshness check catches it.
  const ts = Date.now();
  const typeId = `@user/preserved-mtime-${ts}`;
  const v1 = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], marker: "V1" }),
    },
  },
};
`;
  const v2 = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], marker: "V2" }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const sourcePath = join(modelsDir, "model.ts");
    await Deno.writeTextFile(sourcePath, v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(
      v1Bundle.includes("V1"),
      true,
      "V1 marker should be present in initial bundle",
    );

    // Capture the original source mtime before the edit.
    const origMtime = (await Deno.stat(sourcePath)).mtime!;

    // Advance wall clock so any mtime-based comparison would notice a
    // rebundle moment, making the test deterministic.
    await new Promise((r) => setTimeout(r, 1100));

    // Swap content, then restore the original mtime — the #125 trigger.
    await Deno.writeTextFile(sourcePath, v2);
    await Deno.utime(sourcePath, origMtime, origMtime);

    const srcStatAfterRestore = await Deno.stat(sourcePath);
    const bundleStatBeforeRun2 = await Deno.stat(bundlePath);
    assertEquals(
      srcStatAfterRestore.mtime!.getTime() <=
        bundleStatBeforeRun2.mtime!.getTime(),
      true,
      "Precondition — source mtime must be <= bundle mtime to exercise the bug",
    );

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    const result = await loader2.buildIndex(modelsDir, catalog2);
    catalog2.close();

    const v2Bundle = await Deno.readTextFile(bundlePath);
    assertNotEquals(
      v1Bundle,
      v2Bundle,
      "Bundle must be regenerated when source content changes, even with preserved mtime",
    );
    assertEquals(
      v2Bundle.includes("V2"),
      true,
      "V2 marker must be present in the regenerated bundle",
    );
    assertEquals(
      result.loaded.length > 0,
      true,
      "model.ts must appear in the rebundled set",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader bundleWithCache preserves cached bundle on unexpected failure", async () => {
  const ts = Date.now();
  // Model that imports a nonexistent npm package — will fail to bundle.
  // Uses npm: prefix (not a bare specifier) so isExpectedBundleFailure
  // returns false — this is an "unexpected" failure path.
  const brokenModelCode = `
import { z } from "npm:zod@4";
import { something } from "npm:nonexistent-package-xyz-swamp-test-${ts}@999";

export const model = {
  type: "@user/broken-${ts}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  // A valid model to produce the initial cached bundle
  const validModelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/broken-${ts}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_mtime_test_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_mtime_test_models_",
  });

  try {
    // Write valid model, load to produce cached bundle
    await Deno.writeTextFile(join(modelsDir, "model.ts"), validModelCode);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.loadModels(modelsDir);

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    // Wait so mtime differs
    await new Promise((r) => setTimeout(r, 1100));

    // Replace with broken model (no bare specifiers, no deno.json →
    // unexpected failure)
    await Deno.writeTextFile(join(modelsDir, "model.ts"), brokenModelCode);

    // Load again — should fall back to cached bundle.
    // The broken code should NOT appear in the bundle.
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader2.loadModels(modelsDir);

    const cachedBundle2 = await Deno.readTextFile(bundlePath);

    // The bundle content should be preserved (old valid bundle, not broken)
    assertEquals(
      cachedBundle1,
      cachedBundle2,
      "Bundle content should be preserved on unexpected failure",
    );
    // Verify the bundle doesn't contain the broken import
    assertEquals(
      cachedBundle2.includes("nonexistent-package"),
      false,
      "Bundle should not contain broken import from failed rebundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader buildIndex: unchanged content does not rebundle even with new mtime", async () => {
  // Prior to #125 the freshness rule was mtime-only, so writing identical
  // content with a new mtime would trigger a spurious rebundle. After the
  // switch to content fingerprints, rewriting the source with the same
  // bytes must NOT change the cached bundle even when mtime advances.
  const ts = Date.now();
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/unchanged-content-${ts}",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_unchanged_content_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_unchanged_content_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);
    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle = await Deno.readTextFile(bundlePath);
    const bundleMtimeBefore = (await Deno.stat(bundlePath)).mtime!.getTime();

    // Rewrite the source with identical content but advance its mtime
    // (simulates touch or save-without-changes).
    await new Promise((r) => setTimeout(r, 1100));
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    const result = await loader2.buildIndex(modelsDir, catalog2);
    catalog2.close();

    const bundleAfter = await Deno.readTextFile(bundlePath);
    const bundleMtimeAfter = (await Deno.stat(bundlePath)).mtime!.getTime();

    assertEquals(
      cachedBundle,
      bundleAfter,
      "Bundle content should be unchanged when source content is unchanged",
    );
    assertEquals(
      bundleMtimeAfter,
      bundleMtimeBefore,
      "Bundle mtime should be unchanged — no rebundle occurred",
    );
    assertEquals(
      result.loaded.length,
      0,
      "No files should be flagged as stale when content is unchanged",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader: accepts optional DatastorePathResolver", () => {
  // Verify the constructor accepts a resolver without errors
  const mockResolver = {
    localPath: (...segments: string[]) => join("/repo/.swamp", ...segments),
    datastorePath: (...segments: string[]) => join("/cache/path", ...segments),
    isDatastoreSubdir: (_subdir: string) => true,
    isExcluded: (_path: string) => false,
    resolvePath: (subdir: string, ...rest: string[]) =>
      join("/cache/path", subdir, ...rest),
    config: () => ({
      type: "s3" as const,
      config: { bucket: "test" },
      datastorePath: "/cache/path",
      cachePath: "/cache/path",
    }),
  };

  // Should construct without error with resolver
  const loaderWithResolver = new UserModelLoader(
    testDenoRuntime,
    "/repo",
    mockResolver,
  );
  assertNotEquals(loaderWithResolver, undefined);

  // Should construct without error without resolver (backward compat)
  const loaderWithoutResolver = new UserModelLoader(testDenoRuntime, "/repo");
  assertNotEquals(loaderWithoutResolver, undefined);
});

Deno.test("buildIndex: invalidates catalog when source dirs change (#1107)", async () => {
  const ts = Date.now();
  const modelCodeA = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/source-a-${ts}",
  version: "2026.04.05.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const modelCodeB = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/source-b-${ts}",
  version: "2026.04.05.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_source_dirs_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_source_dirs_models_",
  });
  const sourceDirB = await Deno.makeTempDir({
    prefix: "swamp_source_dirs_extra_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    // Write model A in the primary dir, model B in the extra source dir
    await Deno.writeTextFile(join(modelsDir, "model_a.ts"), modelCodeA);
    await Deno.writeTextFile(join(sourceDirB, "model_b.ts"), modelCodeB);

    // First buildIndex — only primary dir, no additional sources
    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);
    catalog1.close();

    // Model A should be registered, model B should not
    assertEquals(
      modelRegistry.has(`@user/source-a-${ts}`),
      true,
      "model A should be registered after first buildIndex",
    );
    assertEquals(
      modelRegistry.has(`@user/source-b-${ts}`),
      false,
      "model B should NOT be registered (not in any source dir yet)",
    );

    // Second buildIndex — now include the extra source dir
    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    const result = await loader2.buildIndex(modelsDir, catalog2, {
      additionalDirs: [sourceDirB],
    });
    catalog2.close();

    // Model B should now be discovered and registered
    assertEquals(
      modelRegistry.has(`@user/source-b-${ts}`),
      true,
      "model B should be registered after source dir was added",
    );
    assertEquals(
      result.failed.length,
      0,
      `expected no failures, got: ${JSON.stringify(result.failed)}`,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
    await Deno.remove(sourceDirB, { recursive: true });
  }
});

Deno.test("UserModelLoader buildIndex: catalog extracts type from export block, not from decoy properties", async () => {
  const ts = Date.now();
  // Model with a decoy `type: "decoy"` in a helper call BEFORE the
  // actual `export const model = { type: "@test/real-..." }`.
  // Guards against naive type-extraction that picks the first `type:` literal
  // instead of the one inside the real `export const model` object.
  const modelCode = `
import { z } from "npm:zod@4";

function helper() {
  return { type: "decoy-${ts}", version: "0.0.0" };
}

export const model = {
  type: "@test/real-${ts}",
  version: "2026.04.06.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_catalog_type_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_catalog_type_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "decoy_model.ts"), modelCode);

    // First buildIndex bootstraps the catalog
    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    const result = await loader.buildIndex(modelsDir, catalog);

    assertEquals(result.failed.length, 0);

    // Verify the catalog stored the REAL type, not the decoy
    const entry = catalog.findByType(`@test/real-${ts}`, "model");
    assertNotEquals(
      entry,
      undefined,
      "Catalog should contain @test/real-" + ts + ", not the decoy type",
    );
    assertEquals(entry!.version, "2026.04.06.1");

    // Verify the decoy type is NOT in the catalog
    const decoyEntry = catalog.findByType(`decoy-${ts}`, "model");
    assertEquals(
      decoyEntry,
      undefined,
      "Catalog should NOT contain the decoy type from the helper function",
    );

    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

// Tests for attachPendingExtensionsForType and the buildIndex post-loop
// retry (issue 123). The primitive and its two call sites close the gap
// between code paths that eagerly-register a base type and the
// loadSingleType/importAndExtendBundle flow that would otherwise attach
// extensions targeting it.

function makePendingAttachFixture(typeSlug: string) {
  const ts = Date.now();
  const typeId = `@user/${typeSlug}-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  methods: {
    seed: {
      description: "Seed",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    pending: {
      description: "Pending attach",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;
  return { typeId, modelCode, extCode };
}

Deno.test("attachPendingExtensionsForType: attaches a single pending extension", async () => {
  const { typeId, modelCode, extCode } = makePendingAttachFixture(
    "apeft-single",
  );

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_apeft_single_r_" });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_apeft_single_m_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext.ts"), extCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    await loader.buildIndex(modelsDir, catalog);
    const base = modelRegistry.get(typeId);
    if (base) delete base.methods.pending;
    assertEquals("pending" in modelRegistry.get(typeId)!.methods, false);

    await loader.attachPendingExtensionsForType(typeId, catalog);

    assertEquals("pending" in modelRegistry.get(typeId)!.methods, true);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("attachPendingExtensionsForType: attaches multiple extensions on same base", async () => {
  const ts = Date.now();
  const typeId = `@user/apeft-multi-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  methods: {
    seed: {
      description: "Seed",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
  const extA = `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    alpha: {
      description: "A",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;
  const extB = `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    beta: {
      description: "B",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_apeft_multi_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_apeft_multi_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext_a.ts"), extA);
    await Deno.writeTextFile(join(modelsDir, "ext_b.ts"), extB);

    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    await loader.buildIndex(modelsDir, catalog);

    const base = modelRegistry.get(typeId);
    if (base) {
      delete base.methods.alpha;
      delete base.methods.beta;
    }

    await loader.attachPendingExtensionsForType(typeId, catalog);

    const attached = modelRegistry.get(typeId)!.methods;
    assertEquals("alpha" in attached, true);
    assertEquals("beta" in attached, true);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("attachPendingExtensionsForType: zero pending extensions is a no-op", async () => {
  const ts = Date.now();
  const typeId = `@user/apeft-zero-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "${typeId}",
  version: "2026.02.09.1",
  methods: {
    only: {
      description: "Only",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_apeft_zero_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_apeft_zero_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    await loader.buildIndex(modelsDir, catalog);

    const before = Object.keys(modelRegistry.get(typeId)!.methods).sort();
    await loader.attachPendingExtensionsForType(typeId, catalog);
    const after = Object.keys(modelRegistry.get(typeId)!.methods).sort();
    assertEquals(before, after);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("attachPendingExtensionsForType: is idempotent when all methods already attached", async () => {
  const { typeId, modelCode, extCode } = makePendingAttachFixture("apeft-idem");

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_apeft_idem_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_apeft_idem_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext.ts"), extCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    await loader.buildIndex(modelsDir, catalog);
    // loadModels Pass 2 inside buildIndex already attached "pending".
    assertEquals("pending" in modelRegistry.get(typeId)!.methods, true);

    await loader.attachPendingExtensionsForType(typeId, catalog);
    assertEquals("pending" in modelRegistry.get(typeId)!.methods, true);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("attachPendingExtensionsForType: no-op when base is not registered", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_apeft_miss_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_apeft_miss_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  try {
    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserModelLoader(testDenoRuntime, repoDir);
    await loader.attachPendingExtensionsForType(
      "@user/apeft-missing-base",
      catalog,
    );
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("buildIndex post-loop attach: extension attaches after model file rebundles (order model-first)", async () => {
  // The order that findStaleFiles returns files is filesystem-dependent.
  // This test pins down the case where a stale model file is processed
  // BEFORE its stale extension file — the in-loop attach would find no
  // catalog row for the extension, but the post-loop attach succeeds
  // because every catalog row exists by the time it runs.
  const ts = Date.now();
  const typeId = `@user/buildindex-order-${ts}`;
  const modelCode = (marker: string) => `
import { z } from "npm:zod@4";
export const model = {
  type: "${typeId}",
  version: "2026.02.09.${marker === "V1" ? "1" : "2"}",
  methods: {
    seed: {
      description: "Seed ${marker}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], marker: "${marker}" }),
    },
  },
};
`;
  const extCode = (marker: string) => `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    attached: {
      description: "Attached ${marker}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_bidx_repo_" });
  // a_base.ts sorts before b_ext.ts so the stale-files walk hits the
  // model first. This lets the test reproduce the order-dependent bug
  // the post-loop attach was built to fix.
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_bidx_models_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "a_base.ts"), modelCode("V1"));
    await Deno.writeTextFile(join(modelsDir, "b_ext.ts"), extCode("V1"));

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);
    catalog1.close();

    await Deno.writeTextFile(join(modelsDir, "a_base.ts"), modelCode("V2"));
    await Deno.writeTextFile(join(modelsDir, "b_ext.ts"), extCode("V2"));

    const base = modelRegistry.get(typeId);
    if (base) delete base.methods.attached;

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader2.buildIndex(modelsDir, catalog2);
    catalog2.close();

    assertEquals(
      "attached" in modelRegistry.get(typeId)!.methods,
      true,
      "Post-loop attach must re-attach the extension after the model " +
        "branch of rebundleAndUpdateCatalog eagerly-registered the base",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader: registerLazyFromCatalog skips validation_failed rows (swamp-club#209)", async () => {
  // After a schema-invalid extension goes through rebundleAndUpdateCatalog,
  // the catalog row carries validation_failed=true with empty
  // type_normalized. The fingerprint match terminates the rebundle loop
  // (verified at the catalog/freshness layer), but the registry must
  // not be polluted with the broken row — registerLazyFromCatalog has
  // to filter on validation_failed.
  //
  // Drives the registration path directly via a seeded catalog rather
  // than going through buildIndex. The buildIndex path bumps into
  // Deno's per-process import cache: rewriting the source file on
  // disk and re-importing the same bundlePath returns the previously
  // cached module, masking the parse failure inside a single test
  // process. Production runs are fresh subprocesses without that cache,
  // which is why the bug manifests there but not via in-process
  // integration tests. The fix's actual surface is the catalog row
  // shape + the registration filter — both unit-testable.
  const ts = Date.now();
  const healthy = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/issue209-healthy-${ts}",
  version: "2026.05.01.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_lazy_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_lazy_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "healthy.ts"), healthy);

    // Cold-start populates the catalog with the healthy model.
    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(modelsDir, catalog1);

    // Inject a validation-failed row to simulate what
    // markCatalogValidationFailed would write after a schema break.
    const ns = bundleNamespace(modelsDir, repoDir);
    const brokenSourcePath = join(modelsDir, "broken.ts");
    catalog1.upsert({
      source_path: brokenSourcePath,
      type_normalized: "",
      kind: "model",
      bundle_path: join(repoDir, ".swamp", "bundles", ns, "broken.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "2026-05-01T12:00:00.000Z",
      source_fingerprint: "deadbeef-broken-state",
      validation_failed: true,
    });
    catalog1.close();

    // Re-open and find both rows. findByKind must return BOTH —
    // ADV-1 invariant: findStaleFiles needs to see the broken row to
    // terminate the rebundle loop on a stable broken source.
    const catalog2 = new ExtensionCatalogStore(dbPath);
    const allRows = catalog2.findByKind("model");
    const broken = allRows.find((r) => r.source_path === brokenSourcePath);
    const healthyRow = allRows.find((r) =>
      r.type_normalized === `@user/issue209-healthy-${ts}`
    );
    assertNotEquals(broken, undefined, "Broken row must be in findByKind");
    assertEquals(broken?.validation_failed, true);
    assertNotEquals(healthyRow, undefined, "Healthy row must be in findByKind");
    assertEquals(healthyRow?.validation_failed, false);

    // Drive registerLazyFromCatalog. The healthy type registers; the
    // broken row (empty type_normalized + validation_failed=true) must
    // NOT register. Use a fresh loader so the lazy registration path
    // runs against a clean registry view of the populated catalog.
    const loader2 = new UserModelLoader(testDenoRuntime, repoDir);
    await loader2.buildIndex(modelsDir, catalog2);

    // After buildIndex, the healthy type is registered. The empty
    // type_normalized of the broken row never reaches the registry —
    // ModelType.create("") would throw, but the filter prevents that.
    const healthyTypeName = `@user/issue209-healthy-${ts}`;
    assertNotEquals(
      modelRegistry.has(healthyTypeName)
        ? modelRegistry.get(healthyTypeName)
        : undefined,
      undefined,
      "Healthy type must be registered",
    );
    catalog2.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});
