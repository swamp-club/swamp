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
import type { MethodContext } from "../model.ts";
import type { UnifiedDataRepository } from "../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../definitions/repositories.ts";
import { generateDataId } from "../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
function createTestContext(): MethodContext {
  return {
    repoDir: "/tmp",
    modelType: ECHO_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

/**
 * Helper to get attributes from a DataOutput.
 */
function getDataOutputAttributes(
  dataOutputs: { content: Uint8Array }[] | undefined,
  index = 0,
): Record<string, unknown> | undefined {
  if (!dataOutputs || dataOutputs.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(dataOutputs[index].content);
  const parsed = JSON.parse(content);
  // Handle wrapped attributes format
  return parsed.attributes ?? parsed;
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

  const context = createTestContext();
  const result = await echoModel.methods.write.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs);
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

  const context = createTestContext();
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

  const context = createTestContext();
  let error: Error | null = null;
  try {
    await echoModel.methods.write.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});
