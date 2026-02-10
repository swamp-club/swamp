import { assertEquals, assertRejects } from "@std/assert";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { createDefinitionId, Definition } from "../definitions/definition.ts";
import { ModelType } from "./model_type.ts";
import { echoModel } from "./echo/echo_model.ts";
import {
  type DataHandle,
  DataSpecType,
  type DataWriter,
  type DataWriterFactory,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
  normalizeSpecType,
  type SpecBasedWriterOptions,
} from "./model.ts";
import { z } from "zod";
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
      tags: options.tags ?? {},
      metadata: {
        contentType: options.contentType ?? "application/json",
        lifetime: options.lifetime ?? "infinite",
        garbageCollection: options.garbageCollection ?? 10,
        streaming: options.streaming ?? false,
        tags: options.tags ?? {},
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
  overrides?: Partial<MethodContext>,
): { context: MethodContext; getResults: () => MockWriterResult[] } {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: ".",
    modelType: ModelType.create("swamp/echo"),
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
    ...overrides,
  };
  return { context, getResults };
}

Deno.test("execute with valid definition returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: "Hello, world!" },
  });

  const { context, getResults } = createTestContext();
  const result = await service.execute(
    definition,
    echoModel.methods.write,
    context,
  );

  // Echo model now returns data handles
  assertEquals(result.dataHandles?.length, 1);

  // Content is in the mock writer results
  const writerResults = getResults();
  assertEquals(writerResults.length, 1);
  const content = JSON.parse(
    new TextDecoder().decode(writerResults[0].content),
  );
  assertEquals(content.message, "Hello, world!");
  assertEquals(typeof content.timestamp, "string");
});

Deno.test("execute with missing required attribute throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: {}, // Missing required 'message'
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, echoModel.methods.write, context),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: 123 }, // Should be string
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, echoModel.methods.write, context),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute with empty message throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: "" }, // Empty message fails min(1) validation
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, echoModel.methods.write, context),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute error message includes Zod details", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { wrongField: "value" },
  });

  const { context } = createTestContext();
  try {
    await service.execute(definition, echoModel.methods.write, context);
    throw new Error("Expected error to be thrown");
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(message.startsWith("Definition validation failed:"), true);
    // Should mention the missing 'message' field
    assertEquals(message.includes("message"), true);
  }
});

// ---------- Workflow Tests ----------

/**
 * Helper to write data via context.createDataWriter and return a DataHandle.
 */
async function writeTestData(
  context: MethodContext,
  name: string,
  attributes: Record<string, unknown>,
): Promise<DataHandle> {
  const writer = context.createDataWriter!({
    name,
    specType: "data",
  });
  return await writer.writeText(JSON.stringify(attributes));
}

/**
 * Creates a test model with configurable behavior for workflow testing.
 * Mock methods use context.createDataWriter to write data and return dataHandles.
 */
function createTestModel(options: {
  executeImpl?: (
    definition: Definition,
    context: MethodContext,
  ) => Promise<MethodResult>;
  followUpImpl?: (
    definition: Definition,
    context: MethodContext,
  ) => Promise<MethodResult>;
}): ModelDefinition {
  const schema = z.object({
    counter: z.number().optional(),
    maxIterations: z.number().optional(),
    value: z.string().optional(),
  });

  return {
    type: ModelType.create("test/workflow"),
    version: "2026.02.09.1",
    inputAttributesSchema: schema,
    dataOutputSpecs: {
      "data": {
        specType: DataSpecType.create("data"),
        description: "Test data",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start method for testing",
        inputAttributesSchema: schema,
        execute: options.executeImpl ??
          (async (_definition, context) => {
            const handle = await writeTestData(context, "data", {
              value: "started",
            });
            return { dataHandles: [handle] };
          }),
      },
      followUp: {
        description: "Follow-up method for testing",
        inputAttributesSchema: schema,
        execute: options.followUpImpl ??
          (async (_definition, context) => {
            const handle = await writeTestData(context, "data", {
              value: "followed-up",
            });
            return { dataHandles: [handle] };
          }),
      },
    },
  };
}

Deno.test(
  "executeWorkflow - basic execution without follow-up actions",
  async () => {
    const service = new DefaultMethodExecutionService();
    const model = createTestModel({});

    const definition = Definition.create({
      name: "test-definition",
      attributes: { value: "test" },
    });

    const { context } = createTestContext({
      modelType: model.type,
    });
    const result = await service.executeWorkflow(
      definition,
      model,
      "start",
      context,
    );

    assertEquals(result.dataHandles !== undefined, true);
    assertEquals(result.dataHandles!.length >= 1, true);
  },
);

Deno.test("executeWorkflow - throws error for unknown method", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "nonexistent", context),
    Error,
    "Method 'nonexistent' not found in model",
  );
});

Deno.test("executeWorkflow - processes follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: async (_definition, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
        counter: 1,
      });
      return {
        dataHandles: [handle],
        followUpActions: [{ methodName: "followUp" }],
      };
    },
    followUpImpl: async (_definition, context) => {
      const handle = await writeTestData(context, "data", {
        value: "completed",
        counter: 2,
      });
      return { dataHandles: [handle] };
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length >= 1, true);
});

Deno.test("executeWorkflow - respects continueCondition", async () => {
  const service = new DefaultMethodExecutionService();
  let followUpCallCount = 0;

  const model = createTestModel({
    executeImpl: async (_definition, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
        counter: 0,
      });
      return {
        dataHandles: [handle],
        followUpActions: [
          {
            methodName: "followUp",
            // Only continue if counter is less than 0 (never true after start)
            continueCondition: (_dataHandles: DataHandle[]) => {
              return false; // Never continue
            },
          },
        ],
      };
    },
    followUpImpl: async (_definition, context) => {
      followUpCallCount++;
      const handle = await writeTestData(context, "data", {
        value: "should-not-reach",
      });
      return { dataHandles: [handle] };
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  // Follow-up should not be called because condition was false
  assertEquals(followUpCallCount, 0);
  assertEquals(result.dataHandles !== undefined, true);
});

Deno.test("executeWorkflow - retries on failure with maxRetries", async () => {
  const service = new DefaultMethodExecutionService();
  let attemptCount = 0;

  const model = createTestModel({
    executeImpl: async (_definition, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
      });
      return {
        dataHandles: [handle],
        followUpActions: [{ methodName: "followUp", maxRetries: 2 }],
      };
    },
    followUpImpl: async (_definition, context) => {
      attemptCount++;
      if (attemptCount < 3) {
        return Promise.reject(new Error("Simulated failure"));
      }
      const handle = await writeTestData(context, "data", {
        value: "succeeded-on-retry",
      });
      return { dataHandles: [handle] };
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  // Should have succeeded on the 3rd attempt (1 initial + 2 retries)
  assertEquals(attemptCount, 3);
  assertEquals(result.dataHandles !== undefined, true);
});

Deno.test("executeWorkflow - fails after exhausting maxRetries", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: async (_definition, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
      });
      return {
        dataHandles: [handle],
        followUpActions: [{ methodName: "followUp", maxRetries: 1 }],
      };
    },
    followUpImpl: () => Promise.reject(new Error("Always fails")),
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "start", context),
    Error,
    "Follow-up action 'followUp' failed after 1 retries",
  );
});

Deno.test("executeWorkflow - handles recursive follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();
  const callSequence: string[] = [];
  let currentStep = 0;

  // Create model where "start" calls "increment", which recursively calls itself
  const schema = z.object({
    step: z.number().optional(),
    value: z.string().optional(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/recursive"),
    version: "2026.02.09.1",
    inputAttributesSchema: schema,
    dataOutputSpecs: {
      "data": {
        specType: DataSpecType.create("data"),
        description: "Test data",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start method",
        inputAttributesSchema: schema,
        execute: async (_definition, context) => {
          callSequence.push("start");
          currentStep = 1;
          const handle = await writeTestData(context, "data", { step: 1 });
          return {
            dataHandles: [handle],
            followUpActions: [{ methodName: "increment" }],
          };
        },
      },
      increment: {
        description: "Increment method that may recurse",
        inputAttributesSchema: schema,
        execute: async (_definition, context) => {
          callSequence.push(`increment-${currentStep}`);

          currentStep++;

          // Only recurse if step < 3
          if (currentStep < 3) {
            const handle = await writeTestData(context, "data", {
              step: currentStep,
            });
            return {
              dataHandles: [handle],
              followUpActions: [{ methodName: "increment" }],
            };
          }

          const handle = await writeTestData(context, "data", {
            step: currentStep,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { step: 0 },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  assertEquals(callSequence, ["start", "increment-1", "increment-2"]);
  assertEquals(result.dataHandles !== undefined, true);
});

Deno.test("executeWorkflow - throws on max depth exceeded", async () => {
  const service = new DefaultMethodExecutionService();
  let counter = 0;

  // Create model that infinitely recurses
  const schema = z.object({ counter: z.number().optional() });

  const model: ModelDefinition = {
    type: ModelType.create("test/infinite"),
    version: "2026.02.09.1",
    inputAttributesSchema: schema,
    dataOutputSpecs: {
      "data": {
        specType: DataSpecType.create("data"),
        description: "Test data",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start infinite loop",
        inputAttributesSchema: schema,
        execute: async (_definition, context) => {
          counter++;
          const handle = await writeTestData(context, "data", { counter });
          return {
            dataHandles: [handle],
            followUpActions: [{ methodName: "start" }],
          };
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { counter: 0 },
  });

  const { context } = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () => service.executeWorkflow(definition, model, "start", context),
    Error,
    "Maximum follow-up action depth (100) exceeded",
  );
});

Deno.test(
  "executeWorkflow - follow-up receives same definition and can use continueCondition",
  async () => {
    const service = new DefaultMethodExecutionService();
    let receivedDefinitionName = "";
    let previousDataHandlesInCondition: DataHandle[] | undefined = undefined;

    // This test demonstrates that:
    // - Follow-up methods receive the same definition
    // - continueCondition receives the dataHandles from the previous method
    const schema = z.object({
      RequestToken: z.string().optional(),
      OperationStatus: z.string().optional(),
      OriginalValue: z.string().optional(),
    });

    const model: ModelDefinition = {
      type: ModelType.create("test/token-passing"),
      version: "2026.02.09.1",
      inputAttributesSchema: schema,
      dataOutputSpecs: {
        "data": {
          specType: DataSpecType.create("data"),
          description: "Test data",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "data" },
        },
      },
      methods: {
        create: {
          description: "Create method that returns RequestToken in data handle",
          inputAttributesSchema: schema,
          execute: async (_definition, context) => {
            const handle = await writeTestData(context, "data", {
              RequestToken: "test-request-token-123",
              OperationStatus: "IN_PROGRESS",
            });
            return {
              dataHandles: [handle],
              followUpActions: [
                {
                  methodName: "sync",
                  continueCondition: (dataHandles: DataHandle[]) => {
                    previousDataHandlesInCondition = dataHandles;
                    return true;
                  },
                },
              ],
            };
          },
        },
        sync: {
          description: "Sync method that uses definition",
          inputAttributesSchema: schema,
          execute: async (definition, context) => {
            // Capture the definition name to verify it's the same definition
            receivedDefinitionName = definition.name;

            const handle = await writeTestData(context, "data", {
              RequestToken: "test-request-token-123",
              OperationStatus: "SUCCESS",
            });
            return { dataHandles: [handle] };
          },
        },
      },
    };

    const definition = Definition.create({
      name: "test-definition",
      attributes: { OriginalValue: "from-yaml" },
    });

    const { context } = createTestContext({
      modelType: model.type,
    });
    const result = await service.executeWorkflow(
      definition,
      model,
      "create",
      context,
    );

    // Verify sync received the same definition
    assertEquals(receivedDefinitionName, "test-definition");

    // Verify continueCondition received the data handles from create
    assertEquals(previousDataHandlesInCondition !== undefined, true);
    const conditionHandles = previousDataHandlesInCondition!;
    assertEquals(conditionHandles.length, 1);

    // Verify final result has data handles
    assertEquals(result.dataHandles !== undefined, true);
    assertEquals(result.dataHandles!.length >= 1, true);
  },
);

Deno.test("execute passes logger in context to method", async () => {
  const service = new DefaultMethodExecutionService();
  let capturedLogger: unknown = undefined;

  const schema = z.object({ value: z.string().optional() });
  const model: ModelDefinition = {
    type: ModelType.create("test/logger-check"),
    version: "1",
    inputAttributesSchema: schema,
    dataOutputSpecs: {},
    methods: {
      run: {
        description: "Method that captures the logger from context",
        inputAttributesSchema: schema,
        execute: (_definition, context) => {
          capturedLogger = context.logger;
          // Verify logger methods are callable (no-op in test env)
          context.logger.trace`trace message`;
          context.logger.debug`debug message`;
          context.logger.info`info message`;
          context.logger.warning`warning message`;
          context.logger.error`error message`;
          context.logger.fatal`fatal message`;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "run", context);

  assertEquals(capturedLogger !== undefined, true);
  assertEquals(typeof (capturedLogger as { info: unknown }).info, "function");
});
