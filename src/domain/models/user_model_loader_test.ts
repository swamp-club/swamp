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

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { createExtensionCelEnvironment } from "../../infrastructure/cel/cel_evaluator.ts";
import { ExtensionLoader } from "../extensions/extension_loader.ts";
import {
  clearAttachedExtensions,
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "../extensions/model_kind_adapter.ts";
import { modelRegistry } from "./model.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { withMockedCommand } from "@swamp-club/swamp-testing";

function makeRepoForCatalog(
  catalog: ExtensionCatalogStore,
  repoRoot: string,
): ExtensionRepository {
  return new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      {},
    ),
    repoRoot,
  });
}
import type { DataHandle, DataWriter, MethodContext } from "./model.ts";
import { ModelType } from "./model_type.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { SOLO_NAMESPACE } from "../data/namespace.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import { configure, getLogger, type LogRecord, reset } from "@logtape/logtape";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

import "./models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

function createTestLoader(): ExtensionLoader {
  return new ExtensionLoader(testDenoRuntime, modelKindAdapter);
}

interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

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

function createMockDataRepo(): UnifiedDataRepository {
  return {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findAllForType: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    iterateForModel: async function* () {
      yield* [];
    },
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    ensureContentLocal: () => Promise.resolve("current" as const),
    isContentAcceptedSync: () => true,
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({
        version: 1,
        contentPath: "/tmp/mock",
        priorVersions: [],
      }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    findByTaggedName: () => Promise.resolve([]),
    rename: () => {
      throw new Error("not implemented");
    },
    saveDeferred: () =>
      Promise.resolve({
        type: ModelType.create("test"),
        modelId: "",
        dataName: "",
        version: 1,
      }),
    finalizeVersionDeferred: () =>
      Promise.resolve({
        receipt: {
          type: ModelType.create("test"),
          modelId: "",
          dataName: "",
          version: 1,
        },
        size: 0,
        checksum: "",
      }),
    advanceLatestMarkers: () => Promise.resolve(),
    rollbackVersions: () => Promise.resolve(),
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
    createCelEnvironment: createExtensionCelEnvironment,
  };
  return { context, getResults };
}

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
  type: "@user/data-model-${crypto.randomUUID().slice(0, 8)}",
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
    const result = await loader.load(dir);

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
    const result = await loader.load(dir);

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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "invalid_structure.ts");
  });
});

Deno.test("UserModelLoader handles non-existent directory", async () => {
  const loader = createTestLoader();
  const result = await loader.load("/nonexistent/path/to/models");

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
  type: "@user/regular-${crypto.randomUUID().slice(0, 8)}",
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], "model.ts");
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader prevents duplicate type registration", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.failed.length, 1);
      assertEquals(result.failed[0].file, "zzz_second.ts");
      assertStringIncludes(result.failed[0].error, "already registered");
    },
  );
});

Deno.test("UserModelLoader passes through dataHandles from user execute", async () => {
  const typeId = `@user/passthrough-handles-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context, getResults } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.create.execute(
      { name: "test" },
      context,
    );

    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 1);

    const handle = methodResult.dataHandles![0];
    assertEquals(handle.name, "data");

    const results = getResults();
    assertEquals(results.length, 1);
    const content = JSON.parse(new TextDecoder().decode(results[0].content));
    assertEquals(content.id, "resource-123");
    assertEquals(content.status, "created");
  });
});

Deno.test("UserModelLoader uses model globalArguments when method lacks own arguments schema", async () => {
  const typeId = `@user/method-inherits-schema-${
    crypto.randomUUID().slice(0, 8)
  }`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

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
  type: "@user/multi-a-${crypto.randomUUID().slice(0, 8)}",
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
  type: "@user/multi-b-${crypto.randomUUID().slice(0, 8)}",
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 2);
      assertEquals(result.failed.length, 0);
      assertEquals(result.loaded[0], "model_a.ts");
      assertEquals(result.loaded[1], "model_b.ts");
    },
  );
});

Deno.test("UserModelLoader user method returns empty dataHandles", async () => {
  const typeId = `@user/empty-handles-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.execute.execute(
      { testInput: "Hello World" },
      context,
    );

    assertEquals(methodResult.dataHandles !== undefined, true);
    assertEquals(methodResult.dataHandles!.length, 0);
  });
});

Deno.test("UserModelLoader user method without dataHandles returns undefined", async () => {
  const typeId = `@user/no-handles-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    const { context } = createTestContext(modelDef!.type);
    const methodResult = await modelDef!.methods.fetch.execute(
      { query: "SELECT *" },
      context,
    );

    assertEquals(methodResult.dataHandles, undefined);
  });
});

Deno.test("UserModelLoader discovers nested files with correct relative paths", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 2);
      assertEquals(result.failed.length, 0);
      assertEquals(result.loaded[0], join("aws", "ec2_start.ts"));
      assertEquals(result.loaded[1], "echo_audit.ts");
    },
  );
});

Deno.test("UserModelLoader excludes _test.ts in subdirectories", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], join("sub", "model.ts"));
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader handles deeply nested directories (3+ levels)", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(
        result.loaded[0],
        join("a", "b", "c", "deep_model.ts"),
      );
    },
  );
});

Deno.test("UserModelLoader loads extension with single method in array", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.extended[0], "ext_audit.ts");
      assertEquals(result.failed.length, 0);

      const modelDef = modelRegistry.get(`@user/ext-single-${ts}`);
      assertEquals(modelDef !== undefined, true);
      assertEquals("write" in modelDef!.methods, true);
      assertEquals("audit" in modelDef!.methods, true);
    },
  );
});

Deno.test("UserModelLoader loads extension with multiple methods in array", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

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
  const ts = crypto.randomUUID().slice(0, 8);
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.extended.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "Cannot extend unregistered");
  });
});

Deno.test("UserModelLoader extension with method name conflict fails gracefully", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader extension with duplicate method names within array fails", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

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
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.extended.length, 1);

      const modelDef = modelRegistry.get(`@user/ext-inherit-schema-${ts}`);
      assertEquals(
        modelDef!.methods.audit.arguments !== undefined,
        true,
      );
    },
  );
});

Deno.test("UserModelLoader extension of built-in command/shell type works", async () => {
  const extCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "command/shell",
  methods: [{
    audit_ext_test_${crypto.randomUUID().slice(0, 8)}: {
      description: "Audit the shell command",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  await withTempModels({ "shell_ext.ts": extCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

    assertEquals(result.extended.length, 1);
    assertEquals(result.failed.length, 0);

    const shellDef = modelRegistry.get("command/shell");
    assertEquals(shellDef !== undefined, true);
    assertEquals("execute" in shellDef!.methods, true);
  });
});

Deno.test("UserModelLoader multiple extensions targeting same type", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

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
  const ts = crypto.randomUUID().slice(0, 8);
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

  await withTempModels(
    { "zzz_model.ts": modelCode, "aaa_ext.ts": extCode },
    async (dir) => {
      const loader = createTestLoader();
      const result = await loader.load(dir);

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
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

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

Deno.test("UserModelLoader extension with resources merges into target model", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/ext-resources-${ts}",
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
  type: "@user/ext-resources-${ts}",
  resources: {
    "audit": {
      description: "Audit results",
      schema: z.object({ findings: z.array(z.string()) }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: [{
    audit: {
      description: "Audit",
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.failed.length, 0);

      const modelDef = modelRegistry.get(`@user/ext-resources-${ts}`);
      assertEquals(modelDef !== undefined, true);
      assertEquals("data" in modelDef!.resources!, true);
      assertEquals("audit" in modelDef!.resources!, true);
      assertEquals(modelDef!.resources!["audit"].description, "Audit results");
      assertEquals(modelDef!.resources!["audit"].garbageCollection, 5);
    },
  );
});

Deno.test("UserModelLoader extension with conflicting resource spec fails gracefully", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const modelCode = `
import { z } from "npm:zod@4";
export const model = {
  type: "@user/ext-res-conflict-${ts}",
  version: "2026.02.09.1",
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
  type: "@user/ext-res-conflict-${ts}",
  resources: {
    "data": {
      description: "Conflicting data",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: [{
    audit: {
      description: "Audit",
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.extended.length, 1);
      assertEquals(result.failed.length, 0);
    },
  );
});

Deno.test("UserModelLoader registers user-declared resources", async () => {
  const typeId = `@user/custom-specs-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);

    assertEquals(
      modelDef!.resources!["data"].description,
      "Custom data spec",
    );
    assertEquals(
      modelDef!.resources!["metrics"].description,
      "Metrics output",
    );
  });
});

Deno.test("UserModelLoader accepts non-@ prefixed model", async () => {
  const typeId = `mycompany/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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

  await withTempModels({ "no_at_prefix.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

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
    const result = await loader.load(dir);

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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "at least 2 segments");
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @adam/mymodel", async () => {
  const typeId = `@adam/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @stack72/name", async () => {
  const typeId = `@stack72/my-model-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts model with custom namespace @keeb/name", async () => {
  const typeId = `@keeb/keyboard-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts valid @user/name format", async () => {
  const typeId = `@user/valid-model-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
  });
});

Deno.test("UserModelLoader accepts valid @user/foo/bar format with 3 segments", async () => {
  const typeId = `@user/category/model-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader allows swamp/* namespace for local models", async () => {
  const typeId = `swamp/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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

  await withTempModels({ "swamp_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader allows si/* namespace for local models", async () => {
  const typeId = `si/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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

  await withTempModels({ "si_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader accepts non-@ model like digitalocean/app-platform", async () => {
  const typeId = `digitalocean/app-platform-${crypto.randomUUID().slice(0, 8)}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
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
    const result = await loader.load(dir);

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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "at least 2 segments");
  });
});

Deno.test("UserModelLoader allows @swamp/* namespace for local models", async () => {
  const typeId = `@swamp/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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

  await withTempModels({ "swamp_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

    assertEquals(result.failed.length, 0);
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "swamp_model.ts");
  });
});

Deno.test("UserModelLoader allows @si/* namespace for local models", async () => {
  const typeId = `@si/mymodel-${crypto.randomUUID().slice(0, 8)}`;
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

  await withTempModels({ "si_model.ts": modelCode }, async (dir) => {
    const loader = createTestLoader();
    const result = await loader.load(dir);

    assertEquals(result.failed.length, 0);
    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "si_model.ts");
  });
});

Deno.test("UserModelLoader silently skips library files without model exports", async () => {
  const validModelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@test/skip-test-${crypto.randomUUID().slice(0, 8)}",
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], join("models", "server.ts"));

    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader silently skips type-only .ts files in subdirectories", async () => {
  const validModelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "@test/type-only-skip-${crypto.randomUUID().slice(0, 8)}",
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], join("models", "my_model", "mod.ts"));

    assertEquals(result.failed.length, 0);
  });
});

Deno.test("UserModelLoader invalidates bundle cache when dependency changes", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
    await Deno.writeTextFile(join(modelsDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
    );
    await loader1.load(modelsDir);

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    await Deno.writeTextFile(
      join(modelsDir, "helper.ts"),
      `export const greeting = "goodbye";`,
    );
    // bump mtime past the cached bundle's 1s-granularity timestamp instead of
    // sleeping
    const bumped = new Date(Date.now() + 5_000);
    await Deno.utime(join(modelsDir, "helper.ts"), bumped, bumped);

    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
    );
    await loader2.load(modelsDir);

    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertEquals(cachedBundle1 !== cachedBundle2, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader loads model with TypeScript-specific syntax", async () => {
  const typeId = `@user/ts-syntax-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "ts_syntax_model.ts");
    assertEquals(result.failed.length, 0);

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

Deno.test("UserModelLoader propagates method kind from model definition", async () => {
  const typeId = `@user/kind-model-${crypto.randomUUID().slice(0, 8)}`;
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
    const result = await loader.load(dir);

    assertEquals(result.loaded.length, 1);

    const modelDef = modelRegistry.get(typeId);
    assertEquals(modelDef !== undefined, true);
    assertEquals(modelDef!.methods.create.kind, "create");
    assertEquals(modelDef!.methods.remove.kind, "delete");
    assertEquals(modelDef!.methods.run.kind, undefined);
  });
});

Deno.test("UserModelLoader skips _-prefixed directories in discoverFiles", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
      const result = await loader.load(dir);

      assertEquals(result.loaded.length, 1);
      assertEquals(result.loaded[0], "entry.ts");

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
  const ts = crypto.randomUUID().slice(0, 8);
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
    await Deno.writeTextFile(join(modelsDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    await Deno.writeTextFile(
      join(modelsDir, "helper.ts"),
      `export const greeting = "goodbye";`,
    );
    // bump mtime past the cached bundle's 1s-granularity timestamp instead of
    // sleeping
    const bumped = new Date(Date.now() + 5_000);
    await Deno.utime(join(modelsDir, "helper.ts"), bumped, bumped);

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    const result = await loader2.buildIndex(modelsDir);
    catalog2.close();

    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertNotEquals(
      cachedBundle1,
      cachedBundle2,
      "Bundle should be regenerated when transitive dependency changes",
    );
    assertEquals(result.loaded.length > 0, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("UserModelLoader buildIndex rebundles when source content changes with preserved mtime (#125)", async () => {
  // atomic-rename saves and rsync --times can leave a source mtime not newer
  // than the cached bundle, so freshness must come from a content fingerprint,
  // not mtime
  const ts = crypto.randomUUID().slice(0, 8);
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

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(
      v1Bundle.includes("V1"),
      true,
      "V1 marker should be present in initial bundle",
    );

    const origMtime = (await Deno.stat(sourcePath)).mtime!;

    // restoring the original mtime keeps source mtime <= bundle mtime without
    // sleeping
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

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    const result = await loader2.buildIndex(modelsDir);
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
  const ts = crypto.randomUUID().slice(0, 8);
  // an npm: import that cannot resolve, not a bare specifier, so
  // isExpectedBundleFailure returns false and this is an unexpected failure
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
    await Deno.writeTextFile(join(modelsDir, "model.ts"), validModelCode);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
    );
    await loader1.load(modelsDir);

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    await Deno.writeTextFile(join(modelsDir, "model.ts"), brokenModelCode);
    // bump mtime past the cached bundle's 1s-granularity timestamp instead of
    // sleeping, so the loader attempts a rebundle
    const bumped = new Date(Date.now() + 5_000);
    await Deno.utime(join(modelsDir, "model.ts"), bumped, bumped);

    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
    );
    await loader2.load(modelsDir);

    const cachedBundle2 = await Deno.readTextFile(bundlePath);

    assertEquals(
      cachedBundle1,
      cachedBundle2,
      "Bundle content should be preserved on unexpected failure",
    );
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

/**
 * runs buildIndex twice so the second pass takes the reconcile path; every deno
 * bundle attempt fails through a mocked Deno.Command, so no process is spawned
 */
async function reconcileAfterSourceChange(args: {
  pulled: boolean;
  addBareImport: boolean;
}): Promise<{
  records: LogRecord[];
  failed: string[];
  bundleCalls: number;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
}> {
  const ts = crypto.randomUUID().slice(0, 8);
  const v1 = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/reconcile-${ts}",
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
  const v2 = args.addBareImport
    ? `import { helper } from "bare-helper-${ts}";\n${v1}`
    : `${v1}// changed\n`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2354_repo_" });
  const modelsDir = args.pulled
    ? join(repoDir, ".swamp", "pulled-extensions", "@test", "ext", "models")
    : join(repoDir, "extensions", "models");
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  const sourcePath = join(modelsDir, "model.ts");
  const records: LogRecord[] = [];
  const failBundle = () => ({
    stdout: "",
    stderr: "simulated bundle failure",
    code: 1,
  });

  try {
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(sourcePath, v1);
    const bundleDir = join(
      repoDir,
      ".swamp",
      "bundles",
      bundleNamespace(modelsDir, repoDir),
    );
    await Deno.mkdir(bundleDir, { recursive: true });
    await Deno.writeTextFile(join(bundleDir, "model.js"), v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      makeRepoForCatalog(catalog1, repoDir),
    );
    await withMockedCommand(failBundle, () => loader1.buildIndex(modelsDir));
    const fingerprintBefore = catalog1.findBySourcePath(sourcePath)
      ?.source_fingerprint;
    catalog1.close();

    await Deno.writeTextFile(sourcePath, v2);

    await configure({
      sinks: { capture: (record: LogRecord) => records.push(record) },
      loggers: [
        {
          category: ["swamp", "model", "loader"],
          lowestLevel: "debug",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
      ],
      reset: true,
    });

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      makeRepoForCatalog(catalog2, repoDir),
    );
    const { result, calls } = await withMockedCommand(
      failBundle,
      () => loader2.buildIndex(modelsDir),
    );
    const fingerprintAfter = catalog2.findBySourcePath(sourcePath)
      ?.source_fingerprint;
    catalog2.close();

    return {
      records,
      failed: result.failed.map((f) => f.file),
      bundleCalls: calls.length,
      fingerprintBefore,
      fingerprintAfter,
    };
  } finally {
    await reset();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function warningTexts(records: LogRecord[]): string[] {
  return records
    .filter((r) => r.level === "warning")
    .map((r) => r.message.map(String).join(""));
}

Deno.test("UserModelLoader buildIndex: pulled extension reusing its bundle after a source change logs no warning (swamp-club#2354)", async () => {
  const run = await reconcileAfterSourceChange({
    pulled: true,
    addBareImport: true,
  });

  assertEquals(run.failed, []);
  assertEquals(run.bundleCalls, 0, "no rebundle is attempted");
  assertNotEquals(run.fingerprintBefore, undefined);
  assertEquals(run.fingerprintAfter, run.fingerprintBefore);
  assertEquals(warningTexts(run.records), []);
  const preserved = run.records.filter((r) =>
    r.message.map(String).join("").includes("source fingerprint preserved")
  );
  assertEquals(preserved.map((r) => r.level), ["debug"]);
});

Deno.test("UserModelLoader buildIndex: unexpected rebundle failure warns once, with the error (swamp-club#2354)", async () => {
  const run = await reconcileAfterSourceChange({
    pulled: false,
    addBareImport: false,
  });

  assertEquals(run.failed, []);
  assertEquals(run.bundleCalls, 1);
  assertNotEquals(run.fingerprintBefore, undefined);
  assertEquals(run.fingerprintAfter, run.fingerprintBefore);
  const warnings = warningTexts(run.records);
  assertEquals(warnings.length, 1, "exactly one warning per failed rebundle");
  assertStringIncludes(warnings[0], "Rebundle failed for");
  assertStringIncludes(warnings[0], "simulated bundle failure");
});

Deno.test("UserModelLoader buildIndex: expected rebundle failure warns once that the bundle could not be regenerated (swamp-club#2354)", async () => {
  const run = await reconcileAfterSourceChange({
    pulled: false,
    addBareImport: true,
  });

  assertEquals(run.failed, []);
  assertEquals(run.bundleCalls, 1);
  assertNotEquals(run.fingerprintBefore, undefined);
  assertEquals(run.fingerprintAfter, run.fingerprintBefore);
  const warnings = warningTexts(run.records);
  assertEquals(warnings.length, 1, "exactly one warning per failed rebundle");
  assertStringIncludes(warnings[0], "could not be regenerated");
  assertStringIncludes(warnings[0], "will retry on next command");
});

Deno.test("UserModelLoader buildIndex: unchanged content does not rebundle even with new mtime", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    const cachedBundle = await Deno.readTextFile(bundlePath);
    const bundleMtimeBefore = (await Deno.stat(bundlePath)).mtime!.getTime();

    // identical content with an advanced mtime, bumped past the bundle's
    // 1s-granularity timestamp instead of sleeping
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);
    const bumped = new Date(Date.now() + 5_000);
    await Deno.utime(join(modelsDir, "model.ts"), bumped, bumped);

    const catalog2 = new ExtensionCatalogStore(dbPath);

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    const result = await loader2.buildIndex(modelsDir);
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

  const loaderWithResolver = new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    "/repo",
    mockResolver,
  );
  assertNotEquals(loaderWithResolver, undefined);

  const loaderWithoutResolver = new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    "/repo",
  );
  assertNotEquals(loaderWithoutResolver, undefined);
});

Deno.test("buildIndex: invalidates catalog when source dirs change (#1107)", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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
    await Deno.writeTextFile(join(modelsDir, "model_a.ts"), modelCodeA);
    await Deno.writeTextFile(join(sourceDirB, "model_b.ts"), modelCodeB);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

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

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    const result = await loader2.buildIndex(modelsDir, {
      additionalDirs: [sourceDirB],
    });
    catalog2.close();

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
  const ts = crypto.randomUUID().slice(0, 8);
  // a decoy type: literal in a helper before the real model export guards
  // against type extraction that takes the first type: it sees
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

    const catalog = new ExtensionCatalogStore(dbPath);
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    const result = await loader.buildIndex(modelsDir);

    assertEquals(result.failed.length, 0);

    const entry = catalog.findByType(`@test/real-${ts}`, "model");
    assertNotEquals(
      entry,
      undefined,
      "Catalog should contain @test/real-" + ts + ", not the decoy type",
    );
    assertEquals(entry!.version, "2026.04.06.1");

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

function makePendingAttachFixture(typeSlug: string) {
  const ts = crypto.randomUUID().slice(0, 8);
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

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(modelsDir);
    const base = modelRegistry.get(typeId);
    if (base) delete base.methods.pending;
    removeAttachedExtensionsForType(typeId);
    assertEquals("pending" in modelRegistry.get(typeId)!.methods, false);

    await loader.attachPendingExtensionsForType(typeId);

    assertEquals("pending" in modelRegistry.get(typeId)!.methods, true);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("attachPendingExtensionsForType: attaches multiple extensions on same base", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
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

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(modelsDir);

    const base = modelRegistry.get(typeId);
    if (base) {
      delete base.methods.alpha;
      delete base.methods.beta;
    }
    removeAttachedExtensionsForType(typeId);

    await loader.attachPendingExtensionsForType(typeId);

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
  const ts = crypto.randomUUID().slice(0, 8);
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

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(modelsDir);

    const before = Object.keys(modelRegistry.get(typeId)!.methods).sort();
    await loader.attachPendingExtensionsForType(typeId);
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

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(modelsDir);
    assertEquals("pending" in modelRegistry.get(typeId)!.methods, true);

    await loader.attachPendingExtensionsForType(typeId);
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
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.attachPendingExtensionsForType(
      "@user/apeft-missing-base",
    );
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

Deno.test("buildIndex post-loop attach: extension attaches after model file rebundles (order model-first)", async () => {
  // findStaleFiles order is filesystem-dependent; a stale model processed
  // before its stale extension finds no catalog row in-loop, so only the
  // post-loop attach succeeds
  const ts = crypto.randomUUID().slice(0, 8);
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
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_bidx_models_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "a_base.ts"), modelCode("V1"));
    await Deno.writeTextFile(join(modelsDir, "b_ext.ts"), extCode("V1"));

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

    await Deno.writeTextFile(join(modelsDir, "a_base.ts"), modelCode("V2"));
    await Deno.writeTextFile(join(modelsDir, "b_ext.ts"), extCode("V2"));

    const base = modelRegistry.get(typeId);
    if (base) delete base.methods.attached;

    const catalog2 = new ExtensionCatalogStore(dbPath);

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(modelsDir);
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

Deno.test("UserModelLoader: registerLazyFromCatalog skips ValidationFailed rows (swamp-club#209)", async () => {
  // drives registration from a seeded catalog because Deno's per-process import
  // cache masks a rewritten source in buildIndex; the filter on state must keep
  // broken rows out of the registry
  const ts = crypto.randomUUID().slice(0, 8);
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

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);

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
      state: "ValidationFailed",
    });
    catalog1.close();

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const allRows = catalog2.findByKind("model");
    const broken = allRows.find((r) =>
      r.source_path === canonicalizePath(brokenSourcePath)
    );
    const healthyRow = allRows.find((r) =>
      r.type_normalized === `@user/issue209-healthy-${ts}`
    );
    assertNotEquals(broken, undefined, "Broken row must be in findByKind");
    assertEquals(broken?.state, "ValidationFailed");
    assertNotEquals(healthyRow, undefined, "Healthy row must be in findByKind");
    assertEquals(healthyRow?.state, "Indexed");

    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(modelsDir);

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
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("UserModelLoader buildIndex: missing cached bundle is detected and recreated (swamp-club#212)", async () => {
  // Deno's per-process import cache serves the old module on re-import, so this
  // asserts only that recovery happened (no throw, bundle restored), not the
  // module contents
  const ts = crypto.randomUUID().slice(0, 8);
  const typeId = `@user/missing-bundle-${ts}`;
  const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.05.02.1",
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
    prefix: "swamp_212_repo_",
  });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_212_models_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.writeTextFile(join(modelsDir, "model.ts"), modelCode);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(modelsDir);
    catalog1.close();

    const ns = bundleNamespace(modelsDir, repoDir);
    const bundlePath = join(repoDir, ".swamp", "bundles", ns, "model.js");
    assertEquals(
      await Deno.stat(bundlePath).then(() => true).catch(() => false),
      true,
      "Cold-start must write the bundle to disk",
    );

    await Deno.remove(bundlePath);

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    const result = await loader2.buildIndex(modelsDir);
    catalog2.close();

    assertEquals(
      await Deno.stat(bundlePath).then(() => true).catch(() => false),
      true,
      "Bundle file must be recreated after the missing-bundle recovery",
    );
    assertEquals(
      result.loaded.length > 0,
      true,
      "Stale-files loop must report the recovered file as loaded",
    );
    assertEquals(
      result.failed.length,
      0,
      "Recovery must complete without surfacing failures",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(modelsDir, { recursive: true });
  }
});

// bundleAndIndexOne must not upsert catalog rows: install writes them through
// repository.save(extension), where the repository invariant fires

Deno.test(
  "UserModelLoader.bundleAndIndexOne: returns model metadata without writing catalog rows (Pin 1)",
  async () => {
    const ts = crypto.randomUUID().slice(0, 8);
    const typeId = `@user/pin1-model-${ts}`;
    const modelCode = `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

    const repoDir = await Deno.makeTempDir({ prefix: "swamp_pin1_model_r_" });
    const modelsDir = await Deno.makeTempDir({ prefix: "swamp_pin1_model_m_" });
    const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
    await Deno.mkdir(dirname(dbPath), { recursive: true });

    try {
      await Deno.writeTextFile(join(modelsDir, "noop.ts"), modelCode);

      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);
      const loader = new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const before = catalog.findAll().length;
      assertEquals(before, 0, "test pre-condition: catalog empty");

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(modelsDir, "noop.ts"),
        relativePath: "noop.ts",
        baseDir: modelsDir,
      });

      const after = catalog.findAll().length;
      assertEquals(
        after,
        before,
        "Pin 1: bundleAndIndexOne must NOT write catalog rows",
      );

      assertNotEquals(result, null);
      assertEquals(result?.kind, "model");
      assertEquals(result?.typeNormalized, typeId.toLowerCase());
      assertEquals(typeof result?.bundlePath, "string");
      assertEquals(typeof result?.fingerprint, "string");

      catalog.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  },
);

Deno.test(
  "UserModelLoader.bundleAndIndexOne: returns null for files without a model/extension export",
  async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp_pin1_null_r_" });
    const modelsDir = await Deno.makeTempDir({ prefix: "swamp_pin1_null_m_" });
    const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
    await Deno.mkdir(dirname(dbPath), { recursive: true });

    try {
      await Deno.writeTextFile(
        join(modelsDir, "helper.ts"),
        `export const greeting = "hello";`,
      );

      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);
      const loader = new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(modelsDir, "helper.ts"),
        relativePath: "helper.ts",
        baseDir: modelsDir,
      });

      assertEquals(result, null);
      assertEquals(
        catalog.findAll().length,
        0,
        "Pin 1: null-return path must also not write catalog rows",
      );

      catalog.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  },
);

Deno.test(
  "loadSingleType: promotes lazy entry to fully loaded definition",
  async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp_lazy_promo_r_" });
    const modelsDir = await Deno.makeTempDir({
      prefix: "swamp_lazy_promo_m_",
    });

    try {
      await Deno.writeTextFile(
        join(modelsDir, "model.ts"),
        `import { z } from "npm:zod@4";
export const model = {
  type: "@test/lazy-promo",
  version: "2026.01.01.1",
  methods: {
    run: {
      description: "test",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};`,
      );

      const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);

      const loader = new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const sourcePath = join(modelsDir, "model.ts");
      const result = await loader.bundleAndIndexOne({
        absolutePath: sourcePath,
        relativePath: "model.ts",
        baseDir: modelsDir,
      });
      assertNotEquals(result, null);

      catalog.upsert({
        type_normalized: result!.typeNormalized,
        kind: "model",
        bundle_path: result!.bundlePath,
        source_path: sourcePath,
        version: "2026.01.01.1",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: result!.fingerprint,
      });

      modelRegistry.registerLazy({
        type: ModelType.create(result!.typeNormalized),
        bundlePath: result!.bundlePath,
        sourcePath,
        version: "2026.01.01.1",
      });

      assertEquals(
        modelRegistry.get(result!.typeNormalized),
        undefined,
        "lazy entry should not be fully loaded",
      );
      assertEquals(
        modelRegistry.isLazy(result!.typeNormalized),
        true,
        "type should be registered as lazy",
      );

      // hasType is true for lazy entries but isFullyLoaded is false, so
      // importAndRegisterBundle does not return early before the bundle is
      // imported
      assertEquals(
        modelKindAdapter.hasType(result!.typeNormalized),
        true,
        "hasType must return true for lazy entries",
      );
      assertEquals(
        modelKindAdapter.isFullyLoaded(result!.typeNormalized),
        false,
        "isFullyLoaded must return false for lazy entries",
      );

      await loader.loadSingleType(result!.typeNormalized);
      const promoted = modelRegistry.get(result!.typeNormalized);
      assertNotEquals(
        promoted,
        undefined,
        "loadSingleType must promote lazy entry to fully loaded",
      );

      assertEquals(
        modelKindAdapter.isFullyLoaded(result!.typeNormalized),
        true,
        "isFullyLoaded must return true after promotion",
      );

      catalog.close();
    } finally {
      modelRegistry.invalidateType("@test/lazy-promo");
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
        await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
        await Deno.remove(modelsDir, { recursive: true });
      }
    }
  },
);

Deno.test("attachPendingExtensionsForType: idempotent across two code paths (issue #123 regression)", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const typeId = `@user/issue123-cross-path-${ts}`;
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
    extra: {
      description: "Extra method from extension",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_issue123_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_issue123_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    clearAttachedExtensions();
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext.ts"), extCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );

    await loader.buildIndex(modelsDir);
    assertEquals(
      "extra" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must be attached after buildIndex",
    );

    await loader.attachPendingExtensionsForType(typeId);
    assertEquals(
      "extra" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must remain attached after second attachment call",
    );

    const methods = Object.keys(modelRegistry.get(typeId)!.methods);
    assertEquals(
      methods.filter((m) => m === "extra").length,
      1,
      "Method 'extra' must appear exactly once (no duplicates)",
    );

    catalog.close();
  } finally {
    clearAttachedExtensions();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  }
});

Deno.test("attachPendingExtensionsForType: load-then-attach cross-path produces no failures (hotLoadModels scenario)", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const typeId = `@user/issue318-hotload-${ts}`;
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
    hotloaded: {
      description: "Hot-loaded extension method",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_hotload_r_" });
  const modelsDir = await Deno.makeTempDir({ prefix: "swamp_hotload_m_" });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    clearAttachedExtensions();
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext.ts"), extCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );

    const loadResult = await loader.load(modelsDir);
    assertEquals(loadResult.failed.length, 0, "load must not fail");
    assertEquals(
      "hotloaded" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must be attached after load",
    );

    await loader.buildIndex(modelsDir);

    await loader.attachPendingExtensionsForType(typeId);

    assertEquals(
      "hotloaded" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must remain attached",
    );

    catalog.close();
  } finally {
    clearAttachedExtensions();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  }
});

Deno.test("attachPendingExtensionsForType: attaches new extension B while skipping already-attached A", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const typeId = `@user/issue318-ab-${ts}`;
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
  const extACode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    alpha: {
      description: "Extension A",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;
  const extBCode = `
import { z } from "npm:zod@4";
export const extension = {
  type: "${typeId}",
  methods: [{
    beta: {
      description: "Extension B",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_issue318_ab_r_" });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_issue318_ab_m_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    clearAttachedExtensions();
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext_a.ts"), extACode);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository1,
    );

    await loader1.buildIndex(modelsDir);
    assertEquals(
      "alpha" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension A must be attached",
    );
    catalog1.close();

    // only ext_b.ts is stale, yet buildIndex must still attach for the target
    // type because a stale secondary export was processed
    await Deno.writeTextFile(join(modelsDir, "ext_b.ts"), extBCode);

    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository2,
    );

    await loader2.buildIndex(modelsDir);

    const model = modelRegistry.get(typeId)!;
    assertEquals(
      "alpha" in model.methods,
      true,
      "Extension A must still be attached",
    );
    assertEquals(
      "beta" in model.methods,
      true,
      "Extension B must be attached after second buildIndex",
    );

    catalog2.close();
  } finally {
    clearAttachedExtensions();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  }
});

Deno.test("attachPendingExtensionsForType: resetLoadedFlag does not break tracking (ADV-2)", async () => {
  const ts = crypto.randomUUID().slice(0, 8);
  const typeId = `@user/issue318-reset-${ts}`;
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
    tracked: {
      description: "Tracked extension method",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "swamp_issue318_rst_r_" });
  const modelsDir = await Deno.makeTempDir({
    prefix: "swamp_issue318_rst_m_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    clearAttachedExtensions();
    await Deno.writeTextFile(join(modelsDir, "base.ts"), modelCode);
    await Deno.writeTextFile(join(modelsDir, "ext.ts"), extCode);

    const catalog = new ExtensionCatalogStore(dbPath);
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );

    await loader.buildIndex(modelsDir);
    assertEquals(
      "tracked" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must be attached after buildIndex",
    );

    modelRegistry.resetLoadedFlag();

    await loader.attachPendingExtensionsForType(typeId);
    assertEquals(
      "tracked" in modelRegistry.get(typeId)!.methods,
      true,
      "Extension must remain attached after resetLoadedFlag + re-attach",
    );

    catalog.close();
  } finally {
    clearAttachedExtensions();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      await Deno.remove(modelsDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(modelsDir, { recursive: true });
    }
  }
});
