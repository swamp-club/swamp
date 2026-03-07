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

import { assertEquals, assertRejects } from "@std/assert";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { createDefinitionId, Definition } from "../definitions/definition.ts";
import { ModelType } from "./model_type.ts";
import type {
  DataHandle,
  DataWriter,
  MethodContext,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import { z } from "zod";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { type DataId, generateDataId } from "../data/data_id.ts";
import { Data } from "../data/data.ts";
import { UserError } from "../errors.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Test model that mimics the echo model's write method.
 * Used for testing method execution without depending on deleted models.
 */
const TEST_ECHO_MODEL_TYPE = ModelType.create("test/echo");
const testEchoModel: ModelDefinition = {
  type: TEST_ECHO_MODEL_TYPE,
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string().min(1) }),
  resources: {
    "message": {
      description: "Test echo message",
      schema: z.object({ message: z.string(), timestamp: z.string() }),
      lifetime: "ephemeral",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write a test message",
      arguments: z.object({ message: z.string().min(1) }),
      execute: async (args: Record<string, unknown>, context) => {
        const data = {
          message: args.message as string,
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource!("message", "message", data);
        return { dataHandles: [handle] };
      },
    },
  },
};

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
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
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
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    repoDir: ".",
    modelType: ModelType.create("swamp/echo"),
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "write",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
    ...overrides,
  };
  return { context, getResults };
}

Deno.test("execute with valid definition returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "Hello, world!" },
    methods: { write: { arguments: { message: "Hello, world!" } } },
  });

  const { context, getResults } = createTestContext();
  const result = await service.execute(
    definition,
    testEchoModel.methods.write,
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
    globalArguments: {},
    methods: { write: { arguments: {} } }, // Missing required 'message'
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: 123 },
    methods: { write: { arguments: { message: 123 } } }, // Should be string
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute with empty message throws error", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "" },
    methods: { write: { arguments: { message: "" } } }, // Empty message fails min(1) validation
  });

  const { context } = createTestContext();
  await assertRejects(
    () => service.execute(definition, testEchoModel.methods.write, context),
    Error,
    "Method arguments validation failed",
  );
});

Deno.test("execute error message includes Zod details", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { wrongField: "value" },
    methods: { write: { arguments: { wrongField: "value" } } },
  });

  const { context } = createTestContext();
  try {
    await service.execute(definition, testEchoModel.methods.write, context);
    throw new Error("Expected error to be thrown");
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(
      message.startsWith("Method arguments validation failed:"),
      true,
    );
    // Should mention the missing 'message' field
    assertEquals(message.includes("message"), true);
  }
});

// ---------- Workflow Tests ----------

/**
 * Helper to write data via context.writeResource and return a DataHandle.
 */
async function writeTestData(
  context: MethodContext,
  specName: string,
  attributes: Record<string, unknown>,
): Promise<DataHandle> {
  return await context.writeResource!(specName, specName, attributes);
}

/**
 * Creates a test model with configurable behavior for workflow testing.
 * Mock methods use context.writeResource to write data and return dataHandles.
 */
function createTestModel(options: {
  executeImpl?: (
    args: Record<string, unknown>,
    context: MethodContext,
  ) => Promise<MethodResult>;
  followUpImpl?: (
    args: Record<string, unknown>,
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
    globalArguments: schema,
    resources: {
      "data": {
        description: "Test data",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start method for testing",
        arguments: schema,
        execute: options.executeImpl ??
          (async (_args, context) => {
            const handle = await writeTestData(context, "data", {
              value: "started",
            });
            return { dataHandles: [handle] };
          }),
      },
      followUp: {
        description: "Follow-up method for testing",
        arguments: schema,
        execute: options.followUpImpl ??
          (async (_args, context) => {
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
      globalArguments: { value: "test" },
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
    globalArguments: { value: "test" },
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
    executeImpl: async (_args, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
        counter: 1,
      });
      return {
        dataHandles: [handle],
        followUpActions: [{ methodName: "followUp" }],
      };
    },
    followUpImpl: async (_args, context) => {
      const handle = await writeTestData(context, "data", {
        value: "completed",
        counter: 2,
      });
      return { dataHandles: [handle] };
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { value: "test" },
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
    executeImpl: async (_args, context) => {
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
    followUpImpl: async (_args, context) => {
      followUpCallCount++;
      const handle = await writeTestData(context, "data", {
        value: "should-not-reach",
      });
      return { dataHandles: [handle] };
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { value: "test" },
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
    executeImpl: async (_args, context) => {
      const handle = await writeTestData(context, "data", {
        value: "started",
      });
      return {
        dataHandles: [handle],
        followUpActions: [{ methodName: "followUp", maxRetries: 2 }],
      };
    },
    followUpImpl: async (_args, context) => {
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
    globalArguments: { value: "test" },
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
    executeImpl: async (_args, context) => {
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
    globalArguments: { value: "test" },
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
    globalArguments: schema,
    resources: {
      "data": {
        description: "Test data",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start method",
        arguments: schema,
        execute: async (_args, context) => {
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
        arguments: schema,
        execute: async (_args, context) => {
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
    globalArguments: { step: 0 },
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
    globalArguments: schema,
    resources: {
      "data": {
        description: "Test data",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
    },
    methods: {
      start: {
        description: "Start infinite loop",
        arguments: schema,
        execute: async (_args, context) => {
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
    globalArguments: { counter: 0 },
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
      globalArguments: schema,
      resources: {
        "data": {
          description: "Test data",
          schema: z.object({}),
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "data" },
        },
      },
      methods: {
        create: {
          description: "Create method that returns RequestToken in data handle",
          arguments: schema,
          execute: async (_args, context) => {
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
          arguments: schema,
          execute: async (_args, context) => {
            // Capture the definition name to verify it's the same definition
            receivedDefinitionName = context.definition.name;

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
      globalArguments: { OriginalValue: "from-yaml" },
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
    globalArguments: schema,
    methods: {
      run: {
        description: "Method that captures the logger from context",
        arguments: schema,
        execute: (_args, context) => {
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
    globalArguments: { value: "test" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.executeWorkflow(definition, model, "run", context);

  assertEquals(capturedLogger !== undefined, true);
  assertEquals(typeof (capturedLogger as { info: unknown }).info, "function");
});

// ---------- Zod Type Coercion Tests ----------

Deno.test("execute coerces string boolean and number args before validation", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    deleteOrphans: z.boolean().default(false),
    maxCount: z.number().optional(),
    name: z.string(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/coercion"),
    version: "1",
    globalArguments: z.object({}),
    methods: {
      run: {
        description: "Test method with boolean and number args",
        arguments: schema,
        execute: (args: Record<string, unknown>) => {
          // Verify the args were coerced to the correct types
          assertEquals(args.deleteOrphans, true);
          assertEquals(args.maxCount, 5);
          assertEquals(args.name, "test");
          return Promise.resolve({});
        },
      },
    },
  };

  // Simulate CLI passing all values as strings
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: {
      run: {
        arguments: {
          deleteOrphans: "true",
          maxCount: "5",
          name: "test",
        },
      },
    },
  });

  const { context } = createTestContext({
    modelType: model.type,
    methodName: "run",
  });
  // Should not throw — coercion converts "true" → true and "5" → 5
  await service.execute(definition, model.methods.run, context);
});

Deno.test("executeWorkflow coerces string globalArguments before validation", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    enabled: z.boolean(),
    port: z.number(),
  });

  let receivedGlobalArgs: Record<string, unknown> = {};

  const model: ModelDefinition = {
    type: ModelType.create("test/global-coercion"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedGlobalArgs = context.globalArgs;
          return Promise.resolve({});
        },
      },
    },
  };

  // Global args come in as strings from CLI
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { enabled: "true", port: "8080" },
  });

  const { context } = createTestContext({ modelType: model.type });
  // Should not throw — coercion converts strings to correct types
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  assertEquals(result !== undefined, true);
  // Verify the method received coerced types, not strings
  assertEquals(receivedGlobalArgs.enabled, true);
  assertEquals(receivedGlobalArgs.port, 8080);
});

// ---------- globalArguments Validation Tests ----------

Deno.test("executeWorkflow - rejects invalid globalArguments after resolution", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    host: z.string(),
    port: z.number(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/global-args-validation"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  // Port is a string instead of a number — should fail validation
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { host: "localhost", port: "not-a-number" },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.executeWorkflow(definition, model, "run", context),
    Error,
    "Global arguments validation failed",
  );
});

Deno.test("executeWorkflow - passes with valid globalArguments", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    host: z.string(),
    port: z.number(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/global-args-valid"),
    version: "1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { host: "localhost", port: 5432 },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  // Should succeed without error
  assertEquals(result !== undefined, true);
});

Deno.test("executeWorkflow - skips validation when model has no globalArguments schema", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/no-global-args"),
    version: "1",
    // No globalArguments schema
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { anything: "goes" },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "run",
    context,
  );
  // Should succeed without error
  assertEquals(result !== undefined, true);
});

// ---------- Resource Deletion Tracking Tests ----------

/**
 * Creates a mock DataRepo that returns specific data for findAllForModel.
 */
function createMockDataRepoWithData(
  existingData: Data[],
): UnifiedDataRepository & {
  savedData: Array<{ data: Data; content: Uint8Array }>;
} {
  const savedData: Array<{ data: Data; content: Uint8Array }> = [];
  return {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve(existingData),
    save: (
      _type: ModelType,
      _modelId: string,
      data: Data,
      content: Uint8Array,
    ) => {
      savedData.push({ data, content });
      return Promise.resolve({ version: data.version });
    },
    getContent: () => Promise.resolve(null),
    savedData,
  };
}

Deno.test("executeWorkflow - delete method writes deletion markers for existing resources", async () => {
  const service = new DefaultMethodExecutionService();

  const existingData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    version: 3,
  });

  const mockRepo = createMockDataRepoWithData([existingData]);

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-marker"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Should have saved a deletion marker
  assertEquals(mockRepo.savedData.length, 1);
  const saved = mockRepo.savedData[0];
  assertEquals(saved.data.lifecycle, "deleted");
  assertEquals(saved.data.version, 4); // existingData.version + 1
  assertEquals(saved.data.contentType, "application/json");

  // Check the marker content
  const content = JSON.parse(new TextDecoder().decode(saved.content));
  assertEquals(typeof content.deletedAt, "string");
  assertEquals(content.deletedByMethod, "delete");
});

Deno.test("executeWorkflow - read after delete throws UserError", async () => {
  const service = new DefaultMethodExecutionService();

  const deletedData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const markerContent = new TextEncoder().encode(JSON.stringify({
    deletedAt: "2026-03-06T12:00:00.000Z",
    deletedByMethod: "delete",
  }));

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([deletedData]),
    getContent: () => Promise.resolve(markerContent),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/read-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      get: {
        description: "Get the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await assertRejects(
    () => service.executeWorkflow(definition, model, "get", contextWithRepo),
    UserError,
    "was deleted at 2026-03-06T12:00:00.000Z",
  );
});

Deno.test("executeWorkflow - update after delete throws UserError", async () => {
  const service = new DefaultMethodExecutionService();

  const deletedData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const mockRepo = {
    ...createMockDataRepo(),
    findAllForModel: () => Promise.resolve([deletedData]),
    getContent: () => Promise.resolve(null),
  };

  const model: ModelDefinition = {
    type: ModelType.create("test/update-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      update: {
        description: "Update the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        model,
        "update",
        contextWithRepo,
      ),
    UserError,
    "was deleted at",
  );
});

Deno.test("executeWorkflow - create after delete succeeds (clears deletion state)", async () => {
  const service = new DefaultMethodExecutionService();

  // The create method writes a new resource via writeResource, which defaults to lifecycle: "active"
  // The fast-fail only applies to read/update, not create — so create should succeed
  const model: ModelDefinition = {
    type: ModelType.create("test/create-after-delete"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({ value: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      create: {
        description: "Create the resource",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!(
            "my-resource",
            "my-resource",
            { value: "new" },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  // Should succeed — create is not blocked by deleted resources
  const result = await service.executeWorkflow(
    definition,
    model,
    "create",
    context,
  );
  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length, 1);
});

Deno.test("executeWorkflow - delete skips already-deleted resources", async () => {
  const service = new DefaultMethodExecutionService();

  // Resource already has lifecycle: deleted
  const alreadyDeleted = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
    lifecycle: "deleted",
  });

  const mockRepo = createMockDataRepoWithData([alreadyDeleted]);

  const model: ModelDefinition = {
    type: ModelType.create("test/delete-skip-deleted"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "delete",
    contextWithRepo,
  );

  // Should NOT have written any new deletion markers
  assertEquals(mockRepo.savedData.length, 0);
});

Deno.test("executeWorkflow - explicit kind overrides name inference for deletion check", async () => {
  const service = new DefaultMethodExecutionService();

  // Method named "remove" but kind: "action" — should NOT trigger deletion markers
  const existingData = Data.create({
    name: "my-resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "test/model:create",
    },
  });

  const mockRepo = createMockDataRepoWithData([existingData]);

  const model: ModelDefinition = {
    type: ModelType.create("test/kind-override"),
    version: "1",
    resources: {
      "my-resource": {
        description: "A resource",
        schema: z.object({}),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      remove: {
        description: "Remove (but kind is action, not delete)",
        kind: "action",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
  });

  const { context } = createTestContext({ modelType: model.type });
  const contextWithRepo: MethodContext = {
    ...context,
    dataRepository: mockRepo,
  };

  await service.executeWorkflow(
    definition,
    model,
    "remove",
    contextWithRepo,
  );

  // kind: "action" should NOT trigger deletion markers
  assertEquals(mockRepo.savedData.length, 0);
});

// ---------- Unresolved Expression Tests ----------

Deno.test("execute - Proxy throws for any unresolved expression in globalArgs", async () => {
  const service = new DefaultMethodExecutionService();

  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-expr"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          // Access the unresolved field — should throw
          const _val = context.globalArgs.ssh_keys;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ string(model["test-ssh-key"].resource.state.key.attributes.id) }}',
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await assertRejects(
    () => service.execute(definition, model.methods.run, context),
    Error,
    "Unresolved expression in globalArguments.ssh_keys",
  );
});

Deno.test("execute - Proxy allows access to resolved globalArgs fields", async () => {
  const service = new DefaultMethodExecutionService();

  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/resolved-expr"),
    version: "1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ string(model["test-ssh-key"].resource.state.key.attributes.id) }}',
    },
    methods: { run: { arguments: {} } },
  });

  const { context } = createTestContext({ modelType: model.type });
  await service.execute(definition, model.methods.run, context);
  assertEquals(receivedName, "my-server");
});

Deno.test("executeWorkflow - skips validation for globalArgs with unresolved model resource expressions", async () => {
  const service = new DefaultMethodExecutionService();

  const schema = z.object({
    name: z.string(),
    ssh_keys: z.array(z.string()),
  });

  let receivedName = "";
  const model: ModelDefinition = {
    type: ModelType.create("test/unresolved-resource-expr"),
    version: "1",
    globalArguments: schema,
    methods: {
      update: {
        description: "Update method",
        arguments: z.object({}),
        execute: (_args: Record<string, unknown>, context) => {
          receivedName = context.globalArgs.name as string;
          return Promise.resolve({});
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      name: "my-server",
      ssh_keys:
        '${{ [string(model["test-ssh-key"].resource.state.key.attributes.id)] }}',
    },
  });

  const { context } = createTestContext({ modelType: model.type });
  const result = await service.executeWorkflow(
    definition,
    model,
    "update",
    context,
  );
  assertEquals(result !== undefined, true);
  assertEquals(receivedName, "my-server");
});
