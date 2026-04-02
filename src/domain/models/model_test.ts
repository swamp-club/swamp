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

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  type DataHandle,
  type DataWriter,
  defineModel,
  inferMethodKind,
  isMutatingKind,
  type LazyModelEntry,
  type MethodContext,
  type ModelDefinition,
  ModelRegistry,
} from "./model.ts";
import { ModelType } from "./model_type.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
function createTestContext(modelType: ModelType): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    signal: new AbortController().signal,
    repoDir: "/tmp",
    modelType,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "write",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
  };
  return { context, getResults };
}

/**
 * Helper to get parsed JSON content from mock results.
 */
function getResultAttributes(
  results: MockWriterResult[],
  index = 0,
): Record<string, unknown> | undefined {
  if (results.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(results[index].content);
  return JSON.parse(content);
}

function createTestModel(typeString: string): ModelDefinition {
  const type = ModelType.create(typeString);
  return {
    type,
    version: "2026.02.09.1",
    globalArguments: z.object({ message: z.string() }),
    resources: {
      "data": {
        description: "Test data",
        schema: z.object({
          message: z.string(),
          timestamp: z.string(),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      write: {
        description: "Write message to data",
        arguments: z.object({ message: z.string() }),
        execute: async (args: { message: string }, context: MethodContext) => {
          const handle = await context.writeResource!("data", "data", {
            message: args.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
  };
}

Deno.test("ModelRegistry.register adds model to registry", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/echo");

  registry.register(model);
  assertEquals(registry.has("swamp/echo"), true);
});

Deno.test("ModelRegistry.register throws on duplicate type", () => {
  const registry = new ModelRegistry();
  const model1 = createTestModel("swamp/echo");
  const model2 = createTestModel("swamp/echo");

  registry.register(model1);
  assertThrows(
    () => registry.register(model2),
    Error,
    "Model type already registered: swamp/echo",
  );
});

Deno.test("ModelRegistry.get returns registered model", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/echo");
  registry.register(model);

  const retrieved = registry.get("swamp/echo");
  assertEquals(retrieved?.type.normalized, "swamp/echo");
  assertEquals(retrieved?.version, "2026.02.09.1");
});

Deno.test("ModelRegistry.get accepts ModelType", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/echo");
  registry.register(model);

  const type = ModelType.create("swamp/echo");
  const retrieved = registry.get(type);
  assertEquals(retrieved?.type.normalized, "swamp/echo");
});

Deno.test("ModelRegistry.get returns undefined for unknown type", () => {
  const registry = new ModelRegistry();
  const retrieved = registry.get("unknown/type");
  assertEquals(retrieved, undefined);
});

Deno.test("ModelRegistry.get normalizes type strings", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("AWS::EC2::VPC");
  registry.register(model);

  const retrieved = registry.get("aws/ec2/vpc");
  assertEquals(retrieved?.type.raw, "AWS::EC2::VPC");
});

Deno.test("ModelRegistry.has returns true for registered types", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/echo");
  registry.register(model);

  assertEquals(registry.has("swamp/echo"), true);
});

Deno.test("ModelRegistry.has returns false for unregistered types", () => {
  const registry = new ModelRegistry();
  assertEquals(registry.has("swamp/echo"), false);
});

Deno.test("ModelRegistry.has normalizes type strings", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("AWS::EC2::VPC");
  registry.register(model);

  assertEquals(registry.has("aws/ec2/vpc"), true);
  assertEquals(registry.has("AWS::EC2::VPC"), true);
});

Deno.test("ModelRegistry.types returns all registered types", () => {
  const registry = new ModelRegistry();
  registry.register(createTestModel("swamp/echo"));
  registry.register(createTestModel("swamp/other"));

  const types = registry.types();
  assertEquals(types.length, 2);
  assertEquals(types.map((t) => t.normalized).sort(), [
    "swamp/echo",
    "swamp/other",
  ]);
});

Deno.test("ModelRegistry.types returns empty array when no models", () => {
  const registry = new ModelRegistry();
  assertEquals(registry.types(), []);
});

Deno.test("ModelDefinition method can execute", async () => {
  const model = createTestModel("swamp/echo");

  const { context, getResults } = createTestContext(model.type);
  const result = await model.methods.write.execute(
    { message: "hello world" },
    context,
  );

  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length, 1);

  const attrs = getResultAttributes(getResults());
  assertEquals(attrs?.message, "hello world");
  assertEquals(typeof attrs?.timestamp, "string");
});

// defineModel tests use unique type names to avoid conflicts with other tests
// since they use the global registry

Deno.test("defineModel registers model with global registry", async () => {
  // Dynamic import to get a fresh reference to the global registry
  const { modelRegistry } = await import("./model.ts");

  const model = createTestModel("test/define-model-registers");
  defineModel(model);

  assertEquals(modelRegistry.has("test/define-model-registers"), true);
});

Deno.test("defineModel returns the same definition passed in", () => {
  const model = createTestModel("test/define-model-returns");
  const result = defineModel(model);

  assertEquals(result, model);
});

Deno.test("defineModel is idempotent when called with same model", () => {
  const model = createTestModel("test/define-model-idempotent");

  // First call registers
  const result1 = defineModel(model);
  // Second call should not throw, just return the definition
  const result2 = defineModel(model);

  assertEquals(result1, model);
  assertEquals(result2, model);
});

// ModelRegistry.extend() tests

Deno.test("ModelRegistry.extend adds methods to existing model", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/extend-test");
  registry.register(model);

  registry.extend("swamp/extend-test", {
    read: {
      description: "Read the data",
      arguments: z.object({ message: z.string() }),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  });

  const extended = registry.get("swamp/extend-test");
  assertEquals(extended !== undefined, true);
  assertEquals("write" in extended!.methods, true);
  assertEquals("read" in extended!.methods, true);
});

Deno.test("ModelRegistry.extend throws on unregistered type", () => {
  const registry = new ModelRegistry();

  assertThrows(
    () =>
      registry.extend("swamp/nonexistent", {
        read: {
          description: "Read",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      }),
    Error,
    "Cannot extend unregistered model type: swamp/nonexistent",
  );
});

Deno.test("ModelRegistry.extend throws on method name conflict", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/conflict-test");
  registry.register(model);

  assertThrows(
    () =>
      registry.extend("swamp/conflict-test", {
        write: {
          description: "Duplicate write",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      }),
    Error,
    "Method 'write' already exists on model type 'swamp/conflict-test'",
  );
});

Deno.test("ModelRegistry.extend preserves original methods and schema", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/preserve-test");
  registry.register(model);

  const originalSchema = model.globalArguments;

  registry.extend("swamp/preserve-test", {
    read: {
      description: "Read the data",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  });

  const extended = registry.get("swamp/preserve-test");
  assertEquals(extended!.globalArguments, originalSchema);
  assertEquals(extended!.version, "2026.02.09.1");
  assertEquals(extended!.methods.write.description, "Write message to data");
});

Deno.test("ModelRegistry.extend - extended methods are callable", async () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/callable-test");
  registry.register(model);

  registry.extend("swamp/callable-test", {
    greet: {
      description: "Greet",
      arguments: z.object({ message: z.string() }),
      execute: async (args: { message: string }, context: MethodContext) => {
        const handle = await context.writeResource!("data", "data", {
          greeting: `Hello, ${args.message}`,
        });
        return { dataHandles: [handle] };
      },
    },
  });

  const extended = registry.get("swamp/callable-test")!;
  const { context, getResults } = createTestContext(extended.type);

  const result = await extended.methods.greet.execute(
    { message: "world" },
    context,
  );
  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length, 1);

  const attrs = getResultAttributes(getResults());
  assertEquals(attrs?.greeting, "Hello, world");
});

// --- CalVer validation tests ---

Deno.test("ModelRegistry.register rejects non-CalVer version string", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    type: ModelType.create("test/invalid-version"),
    version: "not-a-calver",
    methods: {},
  };

  assertThrows(
    () => registry.register(model),
    Error,
    'Invalid CalVer version "not-a-calver"',
  );
});

Deno.test("ModelRegistry.register accepts model with CalVer version and valid upgrade chain", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    type: ModelType.create("test/with-upgrades"),
    version: "2026.02.09.1",
    methods: {},
    upgrades: [
      {
        toVersion: "2025.06.01.1",
        description: "Add field",
        upgradeAttributes: (old) => ({ ...old, added: true }),
      },
      {
        toVersion: "2026.02.09.1",
        description: "Rename field",
        upgradeAttributes: (old) => old,
      },
    ],
  };

  registry.register(model);
  assertEquals(registry.has("test/with-upgrades"), true);
});

Deno.test("ModelRegistry.register rejects upgrades not in chronological order", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    type: ModelType.create("test/bad-order"),
    version: "2026.02.09.1",
    methods: {},
    upgrades: [
      {
        toVersion: "2026.02.09.1",
        description: "Later",
        upgradeAttributes: (old) => old,
      },
      {
        toVersion: "2025.06.01.1",
        description: "Earlier",
        upgradeAttributes: (old) => old,
      },
    ],
  };

  assertThrows(
    () => registry.register(model),
    Error,
    "not in chronological order",
  );
});

Deno.test("ModelRegistry.register rejects when last upgrade toVersion doesn't match model version", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    type: ModelType.create("test/mismatch-version"),
    version: "2026.02.09.1",
    methods: {},
    upgrades: [
      {
        toVersion: "2025.06.01.1",
        description: "Only upgrade",
        upgradeAttributes: (old) => old,
      },
    ],
  };

  assertThrows(
    () => registry.register(model),
    Error,
    'Last upgrade toVersion "2025.06.01.1" does not match model version "2026.02.09.1"',
  );
});

Deno.test("ModelRegistry.register accepts model with no upgrades", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    type: ModelType.create("test/no-upgrades"),
    version: "2026.02.09.1",
    methods: {},
  };

  registry.register(model);
  assertEquals(registry.has("test/no-upgrades"), true);
});

// --- inferMethodKind tests ---

Deno.test("inferMethodKind - returns explicit kind from definition", () => {
  assertEquals(inferMethodKind("run", { kind: "create" }), "create");
  assertEquals(inferMethodKind("do-something", { kind: "delete" }), "delete");
});

Deno.test("inferMethodKind - infers 'create' from method name", () => {
  assertEquals(inferMethodKind("create"), "create");
  assertEquals(inferMethodKind("Create"), "create");
  assertEquals(inferMethodKind("CREATE"), "create");
});

Deno.test("inferMethodKind - infers 'read' from method names", () => {
  assertEquals(inferMethodKind("get"), "read");
  assertEquals(inferMethodKind("read"), "read");
  assertEquals(inferMethodKind("describe"), "read");
  assertEquals(inferMethodKind("show"), "read");
  assertEquals(inferMethodKind("Get"), "read");
  assertEquals(inferMethodKind("DESCRIBE"), "read");
});

Deno.test("inferMethodKind - infers 'update' from method names", () => {
  assertEquals(inferMethodKind("update"), "update");
  assertEquals(inferMethodKind("patch"), "update");
  assertEquals(inferMethodKind("Update"), "update");
});

Deno.test("inferMethodKind - infers 'delete' from method names", () => {
  assertEquals(inferMethodKind("delete"), "delete");
  assertEquals(inferMethodKind("destroy"), "delete");
  assertEquals(inferMethodKind("remove"), "delete");
  assertEquals(inferMethodKind("Delete"), "delete");
});

Deno.test("inferMethodKind - infers 'list' from method names", () => {
  assertEquals(inferMethodKind("list"), "list");
  assertEquals(inferMethodKind("search"), "list");
  assertEquals(inferMethodKind("find"), "list");
  assertEquals(inferMethodKind("List"), "list");
});

Deno.test("inferMethodKind - returns undefined for unrecognized names", () => {
  assertEquals(inferMethodKind("run"), undefined);
  assertEquals(inferMethodKind("execute"), undefined);
  assertEquals(inferMethodKind("sync"), undefined);
  assertEquals(inferMethodKind("write"), undefined);
});

Deno.test("inferMethodKind - explicit kind overrides name inference", () => {
  assertEquals(inferMethodKind("delete", { kind: "action" }), "action");
  assertEquals(inferMethodKind("create", { kind: "read" }), "read");
});

// --- isMutatingKind tests ---

Deno.test("isMutatingKind - returns true for create/update/delete/action/undefined", () => {
  assertEquals(isMutatingKind("create"), true);
  assertEquals(isMutatingKind("update"), true);
  assertEquals(isMutatingKind("delete"), true);
  assertEquals(isMutatingKind("action"), true);
  assertEquals(isMutatingKind(undefined), true);
});

Deno.test("isMutatingKind - returns false for read/list", () => {
  assertEquals(isMutatingKind("read"), false);
  assertEquals(isMutatingKind("list"), false);
});

// --- ModelRegistry.extend() with checks tests ---

Deno.test("ModelRegistry.extend adds checks to existing model", () => {
  const registry = new ModelRegistry();
  const model = createTestModel("swamp/extend-checks-test");
  registry.register(model);

  registry.extend("swamp/extend-checks-test", {}, {
    "my-check": {
      description: "A test check",
      execute: () => Promise.resolve({ pass: true }),
    },
  });

  const extended = registry.get("swamp/extend-checks-test");
  assertEquals(extended?.checks !== undefined, true);
  assertEquals("my-check" in extended!.checks!, true);
});

Deno.test("ModelRegistry.extend throws on check name conflict", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    ...createTestModel("swamp/check-conflict"),
    checks: {
      "existing-check": {
        description: "Already exists",
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };
  registry.register(model);

  assertThrows(
    () =>
      registry.extend("swamp/check-conflict", {}, {
        "existing-check": {
          description: "Duplicate",
          execute: () => Promise.resolve({ pass: true }),
        },
      }),
    Error,
    "Check 'existing-check' already exists on model type 'swamp/check-conflict'",
  );
});

Deno.test("ModelRegistry.extend preserves existing checks when adding methods only", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    ...createTestModel("swamp/preserve-checks"),
    checks: {
      "original-check": {
        description: "Original",
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };
  registry.register(model);

  registry.extend("swamp/preserve-checks", {
    "new-method": {
      description: "A new method",
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    },
  });

  const extended = registry.get("swamp/preserve-checks");
  assertEquals("original-check" in extended!.checks!, true);
  assertEquals("new-method" in extended!.methods, true);
});

Deno.test("ModelRegistry.extend merges checks from extension with existing checks", () => {
  const registry = new ModelRegistry();
  const model: ModelDefinition = {
    ...createTestModel("swamp/merge-checks"),
    checks: {
      "check-a": {
        description: "Check A",
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };
  registry.register(model);

  registry.extend("swamp/merge-checks", {}, {
    "check-b": {
      description: "Check B",
      execute: () => Promise.resolve({ pass: true }),
    },
  });

  const extended = registry.get("swamp/merge-checks");
  assertEquals("check-a" in extended!.checks!, true);
  assertEquals("check-b" in extended!.checks!, true);
});

// --- Lazy entry tests ---

function createLazyEntry(typeString: string): LazyModelEntry {
  return {
    type: ModelType.create(typeString),
    bundlePath: `/repo/.swamp/bundles/${typeString}.js`,
    sourcePath: `/repo/extensions/models/${typeString}.ts`,
    version: "2026.01.15.1",
  };
}

Deno.test("ModelRegistry.registerLazy: adds lazy type to registry", () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  assertEquals(registry.has("@myorg/echo"), true);
  assertEquals(registry.isLazy("@myorg/echo"), true);
  assertEquals(registry.get("@myorg/echo"), undefined);
});

Deno.test("ModelRegistry.registerLazy: does not overwrite fully loaded type", () => {
  const registry = new ModelRegistry();
  registry.register(createTestModel("@myorg/loaded"));
  registry.registerLazy(createLazyEntry("@myorg/loaded"));

  assertEquals(registry.isLazy("@myorg/loaded"), false);
  assertEquals(registry.get("@myorg/loaded")?.version, "2026.02.09.1");
});

Deno.test("ModelRegistry.registerLazy: does not overwrite existing lazy entry", () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));
  registry.registerLazy({
    ...createLazyEntry("@myorg/echo"),
    version: "9999.01.01.1",
  });

  assertEquals(registry.isLazy("@myorg/echo"), true);
});

Deno.test("ModelRegistry.types: includes both loaded and lazy types", () => {
  const registry = new ModelRegistry();
  registry.register(createTestModel("@myorg/loaded"));
  registry.registerLazy(createLazyEntry("@myorg/lazy"));

  const types = registry.types().map((t) => t.normalized).sort();
  assertEquals(types, ["@myorg/lazy", "@myorg/loaded"]);
});

Deno.test("ModelRegistry.types: does not duplicate promoted lazy types", () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));
  registry.promoteFromLazy(createTestModel("@myorg/echo"));

  const types = registry.types().map((t) => t.normalized);
  assertEquals(types, ["@myorg/echo"]);
  assertEquals(registry.isLazy("@myorg/echo"), false);
  assertEquals(registry.get("@myorg/echo")?.version, "2026.02.09.1");
});

Deno.test("ModelRegistry.has: returns true for lazy types", () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  assertEquals(registry.has("@myorg/echo"), true);
  assertEquals(registry.has("@myorg/nonexistent"), false);
});

Deno.test("ModelRegistry.get: returns undefined for lazy types", () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  assertEquals(registry.get("@myorg/echo"), undefined);
});

Deno.test("ModelRegistry.ensureTypeLoaded: calls type loader for lazy types", async () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  let loadedType: string | null = null;
  registry.setTypeLoader((type) => {
    loadedType = type;
    registry.promoteFromLazy(createTestModel(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/echo");

  assertEquals(loadedType, "@myorg/echo");
  assertEquals(registry.isLazy("@myorg/echo"), false);
  assertEquals(registry.get("@myorg/echo")?.version, "2026.02.09.1");
});

Deno.test("ModelRegistry.ensureTypeLoaded: no-op for already loaded types", async () => {
  const registry = new ModelRegistry();
  registry.register(createTestModel("@myorg/loaded"));

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  assertEquals(called, false);
});

Deno.test("ModelRegistry.ensureTypeLoaded: no-op for unknown types", async () => {
  const registry = new ModelRegistry();

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/nonexistent");
  assertEquals(called, false);
});

Deno.test("ModelRegistry.ensureTypeLoaded: concurrent callers share same promise", async () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  let callCount = 0;
  registry.setTypeLoader(async (type) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.promoteFromLazy(createTestModel(type));
  });

  await Promise.all([
    registry.ensureTypeLoaded("@myorg/echo"),
    registry.ensureTypeLoaded("@myorg/echo"),
    registry.ensureTypeLoaded("@myorg/echo"),
  ]);

  assertEquals(callCount, 1);
  assertEquals(registry.get("@myorg/echo")?.version, "2026.02.09.1");
});

Deno.test("ModelRegistry.ensureTypeLoaded: retries after transient failure", async () => {
  const registry = new ModelRegistry();
  registry.registerLazy(createLazyEntry("@myorg/echo"));

  let callCount = 0;
  registry.setTypeLoader((type) => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error("transient I/O error"));
    }
    registry.promoteFromLazy(createTestModel(type));
    return Promise.resolve();
  });

  // First call fails
  let caught = false;
  try {
    await registry.ensureTypeLoaded("@myorg/echo");
  } catch {
    caught = true;
  }
  assertEquals(caught, true);
  assertEquals(callCount, 1);
  assertEquals(registry.get("@myorg/echo"), undefined);

  // Second call retries and succeeds
  await registry.ensureTypeLoaded("@myorg/echo");
  assertEquals(callCount, 2);
  assertEquals(registry.get("@myorg/echo")?.version, "2026.02.09.1");
});
