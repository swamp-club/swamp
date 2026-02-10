import { assertEquals } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../definitions/definition.ts";
import {
  ECHO_MODEL_TYPE,
  EchoDataAttributesSchema,
  EchoInputAttributesSchema,
  echoModel,
} from "./echo_model.ts";
import { normalizeSpecType } from "../model.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterFactory,
  MethodContext,
  SpecBasedWriterOptions,
} from "../model.ts";
import type { UnifiedDataRepository } from "../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
 * Helper to get parsed JSON content from mock results by name.
 */
function getResultAttributes(
  results: MockWriterResult[],
  namePart: string,
): Record<string, unknown> {
  const result = results.find((r) => r.handle.name.includes(namePart));
  if (!result) {
    throw new Error(`No result found with name containing "${namePart}"`);
  }
  return JSON.parse(new TextDecoder().decode(result.content));
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
function createTestContext(): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: "/tmp",
    modelType: ECHO_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
  };
  return { context, getResults };
}

Deno.test("ECHO_MODEL_TYPE has correct normalized type", () => {
  assertEquals(ECHO_MODEL_TYPE.normalized, "swamp/echo");
});

Deno.test("echoModel has correct version", () => {
  assertEquals(echoModel.version, "2026.02.09.1");
});

Deno.test("echoModel.type equals ECHO_MODEL_TYPE", () => {
  assertEquals(echoModel.type.equals(ECHO_MODEL_TYPE), true);
});

Deno.test("EchoInputAttributesSchema validates message", () => {
  const result = EchoInputAttributesSchema.safeParse({ message: "hello" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.message, "hello");
  }
});

Deno.test("EchoInputAttributesSchema rejects empty message", () => {
  const result = EchoInputAttributesSchema.safeParse({ message: "" });
  assertEquals(result.success, false);
});

Deno.test("EchoInputAttributesSchema rejects missing message", () => {
  const result = EchoInputAttributesSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("EchoDataAttributesSchema validates correct data", () => {
  const result = EchoDataAttributesSchema.safeParse({
    message: "hello",
    timestamp: "2024-01-15T10:30:00.000Z",
  });
  assertEquals(result.success, true);
});

Deno.test("EchoDataAttributesSchema rejects invalid timestamp", () => {
  const result = EchoDataAttributesSchema.safeParse({
    message: "hello",
    timestamp: "not-a-date",
  });
  assertEquals(result.success, false);
});

Deno.test("echoModel has write method", () => {
  assertEquals("write" in echoModel.methods, true);
  assertEquals(
    echoModel.methods.write.description,
    "Write the definition message to a data artifact with a timestamp",
  );
});

Deno.test("echoModel.methods.write executes correctly", async () => {
  const definition = Definition.create({
    name: "test-echo",
    attributes: { message: "hello world" },
  });

  const { context, getResults } = createTestContext();
  const result = await echoModel.methods.write.execute(definition, context);

  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length, 1);

  const attrs = getResultAttributes(getResults(), "message");
  assertEquals(attrs?.message, "hello world");
  assertEquals(typeof attrs?.timestamp, "string");

  // Verify timestamp is valid ISO date
  const timestamp = new Date(attrs?.timestamp as string);
  assertEquals(isNaN(timestamp.getTime()), false);
});

Deno.test("echoModel.methods.write validates input attributes", async () => {
  const definition = Definition.create({
    name: "test-echo",
    attributes: { notAMessage: "value" },
  });

  const { context } = createTestContext();
  let error: Error | null = null;
  try {
    await echoModel.methods.write.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("echoModel.methods.write rejects empty message", async () => {
  const definition = Definition.create({
    name: "test-echo",
    attributes: { message: "" },
  });

  const { context } = createTestContext();
  let error: Error | null = null;
  try {
    await echoModel.methods.write.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});
