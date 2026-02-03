import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { createDefinitionId, Definition } from "../definitions/definition.ts";
import { ModelType } from "./model_type.ts";
import { echoModel } from "./echo/echo_model.ts";
import type {
  DataOutput,
  MethodContext,
  MethodResult,
  ModelDefinition,
} from "./model.ts";
import { z } from "zod";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { generateDataId } from "../data/data_id.ts";

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
function createTestContext(overrides?: Partial<MethodContext>): MethodContext {
  return {
    repoDir: ".",
    modelType: ModelType.create("swamp/echo"),
    modelId: crypto.randomUUID(),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    ...overrides,
  };
}

Deno.test("execute with valid definition returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: "Hello, world!" },
  });

  const context = createTestContext();
  const result = await service.execute(
    definition,
    echoModel.methods.write,
    context,
  );

  // Echo model now returns data artifacts
  assertEquals(result.dataOutputs?.length, 1);
  const dataOutput = result.dataOutputs![0];
  const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
  assertEquals(content.message, "Hello, world!");
  assertEquals(typeof content.timestamp, "string");
});

Deno.test("execute with missing required attribute throws error", () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: {}, // Missing required 'message'
  });

  const context = createTestContext();
  assertThrows(
    () =>
      service.execute(
        definition,
        echoModel.methods.write,
        context,
      ),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: 123 }, // Should be string
  });

  const context = createTestContext();
  assertThrows(
    () =>
      service.execute(
        definition,
        echoModel.methods.write,
        context,
      ),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute with empty message throws error", () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { message: "" }, // Empty message fails min(1) validation
  });

  const context = createTestContext();
  assertThrows(
    () =>
      service.execute(
        definition,
        echoModel.methods.write,
        context,
      ),
    Error,
    "Definition validation failed",
  );
});

Deno.test("execute error message includes Zod details", () => {
  const service = new DefaultMethodExecutionService();
  const definition = Definition.create({
    name: "test-definition",
    attributes: { wrongField: "value" },
  });

  const context = createTestContext();
  try {
    service.execute(
      definition,
      echoModel.methods.write,
      context,
    );
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
 * Helper to create a DataOutput with given attributes.
 */
function createTestDataOutput(
  name: string,
  attributes: Record<string, unknown>,
): DataOutput {
  return {
    name,
    content: new TextEncoder().encode(JSON.stringify(attributes)),
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "data" },
      ownerDefinition: {
        definitionHash: "test-hash",
        ownerType: "model-method",
        ownerRef: "test",
      },
    },
  };
}

/**
 * Creates a test model with configurable behavior for workflow testing.
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
    version: 1,
    inputAttributesSchema: schema,
    methods: {
      start: {
        description: "Start method for testing",
        inputAttributesSchema: schema,
        execute: options.executeImpl ??
          ((_definition) =>
            Promise.resolve({
              dataOutputs: [createTestDataOutput("data", { value: "started" })],
            })),
      },
      followUp: {
        description: "Follow-up method for testing",
        inputAttributesSchema: schema,
        execute: options.followUpImpl ??
          ((_definition) =>
            Promise.resolve({
              dataOutputs: [
                createTestDataOutput("data", { value: "followed-up" }),
              ],
            })),
      },
    },
  };
}

/**
 * Helper to get attributes from a DataOutput.
 */
function getDataOutputAttributes(
  result: MethodResult,
  index = 0,
): Record<string, unknown> | undefined {
  if (!result.dataOutputs || result.dataOutputs.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(result.dataOutputs[index].content);
  return JSON.parse(content);
}

Deno.test("executeWorkflow - basic execution without follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  const attrs = getDataOutputAttributes(result);
  assertEquals(attrs?.value, "started");
});

Deno.test("executeWorkflow - throws error for unknown method", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        model,
        "nonexistent",
        context,
      ),
    Error,
    "Method 'nonexistent' not found in model",
  );
});

Deno.test("executeWorkflow - processes follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: (_definition) =>
      Promise.resolve({
        dataOutputs: [
          createTestDataOutput("data", { value: "started", counter: 1 }),
        ],
        followUpActions: [{ methodName: "followUp" }],
      }),
    followUpImpl: (_definition) =>
      Promise.resolve({
        dataOutputs: [
          createTestDataOutput("data", { value: "completed", counter: 2 }),
        ],
      }),
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  const attrs = getDataOutputAttributes(result);
  assertEquals(attrs?.value, "completed");
  assertEquals(attrs?.counter, 2);
});

Deno.test("executeWorkflow - respects continueCondition", async () => {
  const service = new DefaultMethodExecutionService();
  let followUpCallCount = 0;

  const model = createTestModel({
    executeImpl: (_definition) =>
      Promise.resolve({
        dataOutputs: [
          createTestDataOutput("data", { value: "started", counter: 0 }),
        ],
        followUpActions: [
          {
            methodName: "followUp",
            // Only continue if counter is less than 0 (never true after start)
            continueCondition: (dataOutputs: DataOutput[]) => {
              const attrs = JSON.parse(
                new TextDecoder().decode(dataOutputs[0].content),
              );
              return (attrs.counter as number) < 0;
            },
          },
        ],
      }),
    followUpImpl: (_definition) => {
      followUpCallCount++;
      return Promise.resolve({
        dataOutputs: [
          createTestDataOutput("data", { value: "should-not-reach" }),
        ],
      });
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
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
  const attrs = getDataOutputAttributes(result);
  assertEquals(attrs?.value, "started");
});

Deno.test("executeWorkflow - retries on failure with maxRetries", async () => {
  const service = new DefaultMethodExecutionService();
  let attemptCount = 0;

  const model = createTestModel({
    executeImpl: (_definition) =>
      Promise.resolve({
        dataOutputs: [createTestDataOutput("data", { value: "started" })],
        followUpActions: [{ methodName: "followUp", maxRetries: 2 }],
      }),
    followUpImpl: (_definition) => {
      attemptCount++;
      if (attemptCount < 3) {
        return Promise.reject(new Error("Simulated failure"));
      }
      return Promise.resolve({
        dataOutputs: [
          createTestDataOutput("data", { value: "succeeded-on-retry" }),
        ],
      });
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
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
  const attrs = getDataOutputAttributes(result);
  assertEquals(attrs?.value, "succeeded-on-retry");
});

Deno.test("executeWorkflow - fails after exhausting maxRetries", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: (_definition) =>
      Promise.resolve({
        dataOutputs: [createTestDataOutput("data", { value: "started" })],
        followUpActions: [{ methodName: "followUp", maxRetries: 1 }],
      }),
    followUpImpl: () => Promise.reject(new Error("Always fails")),
  });

  const definition = Definition.create({
    name: "test-definition",
    attributes: { value: "test" },
  });

  const context = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        model,
        "start",
        context,
      ),
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
    version: 1,
    inputAttributesSchema: schema,
    methods: {
      start: {
        description: "Start method",
        inputAttributesSchema: schema,
        execute: (_definition) => {
          callSequence.push("start");
          currentStep = 1;
          return Promise.resolve({
            dataOutputs: [createTestDataOutput("data", { step: 1 })],
            followUpActions: [{ methodName: "increment" }],
          });
        },
      },
      increment: {
        description: "Increment method that may recurse",
        inputAttributesSchema: schema,
        execute: (_definition) => {
          callSequence.push(`increment-${currentStep}`);

          currentStep++;

          // Only recurse if step < 3
          if (currentStep < 3) {
            return Promise.resolve({
              dataOutputs: [
                createTestDataOutput("data", { step: currentStep }),
              ],
              followUpActions: [{ methodName: "increment" }],
            });
          }

          return Promise.resolve({
            dataOutputs: [createTestDataOutput("data", { step: currentStep })],
          });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { step: 0 },
  });

  const context = createTestContext({
    modelType: model.type,
  });
  const result = await service.executeWorkflow(
    definition,
    model,
    "start",
    context,
  );

  assertEquals(callSequence, ["start", "increment-1", "increment-2"]);
  const attrs = getDataOutputAttributes(result);
  assertEquals(attrs?.step, 3);
});

Deno.test("executeWorkflow - throws on max depth exceeded", async () => {
  const service = new DefaultMethodExecutionService();
  let counter = 0;

  // Create model that infinitely recurses
  const schema = z.object({ counter: z.number().optional() });

  const model: ModelDefinition = {
    type: ModelType.create("test/infinite"),
    version: 1,
    inputAttributesSchema: schema,
    methods: {
      start: {
        description: "Start infinite loop",
        inputAttributesSchema: schema,
        execute: (_definition) => {
          counter++;
          return Promise.resolve({
            dataOutputs: [createTestDataOutput("data", { counter })],
            followUpActions: [{ methodName: "start" }],
          });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { counter: 0 },
  });

  const context = createTestContext({
    modelType: model.type,
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        definition,
        model,
        "start",
        context,
      ),
    Error,
    "Maximum follow-up action depth (100) exceeded",
  );
});

Deno.test("executeWorkflow - follow-up receives same definition and can use continueCondition", async () => {
  const service = new DefaultMethodExecutionService();
  let receivedDefinitionName = "";
  let previousDataOutputsInCondition: DataOutput[] | undefined = undefined;

  // This test demonstrates that:
  // - Follow-up methods receive the same definition
  // - continueCondition receives the dataOutputs from the previous method
  const schema = z.object({
    RequestToken: z.string().optional(),
    OperationStatus: z.string().optional(),
    OriginalValue: z.string().optional(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/token-passing"),
    version: 1,
    inputAttributesSchema: schema,
    methods: {
      create: {
        description: "Create method that returns RequestToken in data output",
        inputAttributesSchema: schema,
        execute: (_definition) => {
          return Promise.resolve({
            dataOutputs: [
              createTestDataOutput("data", {
                RequestToken: "test-request-token-123",
                OperationStatus: "IN_PROGRESS",
              }),
            ],
            followUpActions: [
              {
                methodName: "sync",
                continueCondition: (dataOutputs: DataOutput[]) => {
                  previousDataOutputsInCondition = dataOutputs;
                  return true;
                },
              },
            ],
          });
        },
      },
      sync: {
        description: "Sync method that uses definition",
        inputAttributesSchema: schema,
        execute: (definition) => {
          // Capture the definition name to verify it's the same definition
          receivedDefinitionName = definition.name;

          return Promise.resolve({
            dataOutputs: [
              createTestDataOutput("data", {
                RequestToken: "test-request-token-123",
                OperationStatus: "SUCCESS",
              }),
            ],
          });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-definition",
    attributes: { OriginalValue: "from-yaml" },
  });

  const context = createTestContext({
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

  // Verify continueCondition received the data outputs from create
  assertEquals(previousDataOutputsInCondition !== undefined, true);
  const conditionDataOutputs = previousDataOutputsInCondition!;
  assertEquals(conditionDataOutputs.length, 1);
  const conditionAttrs = JSON.parse(
    new TextDecoder().decode(conditionDataOutputs[0].content),
  );
  assertEquals(conditionAttrs.RequestToken, "test-request-token-123");
  assertEquals(conditionAttrs.OperationStatus, "IN_PROGRESS");

  // Verify final result
  const finalAttrs = getDataOutputAttributes(result);
  assertEquals(finalAttrs?.OperationStatus, "SUCCESS");
});
