import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DefaultMethodExecutionService } from "./method_execution_service.ts";
import { ModelInput } from "./model_input.ts";
import { ModelResource } from "./model_resource.ts";
import { ModelType } from "./model_type.ts";
import { echoModel } from "./echo/echo_model.ts";
import type { MethodContext, MethodResult, ModelDefinition } from "./model.ts";
import { z } from "zod";

Deno.test("execute with valid input returns method result", async () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "Hello, world!" },
  });

  const result = await service.execute(
    input,
    echoModel.methods.write,
    { repoDir: "." },
  );

  // Echo model now returns data artifacts instead of resources
  assertEquals(result.data?.attributes.message, "Hello, world!");
  assertEquals(typeof result.data?.attributes.timestamp, "string");
});

Deno.test("execute with missing required attribute throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {}, // Missing required 'message'
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute with invalid attribute type throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: 123 }, // Should be string
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute with empty message throws error", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "" }, // Empty message fails min(1) validation
  });

  assertThrows(
    () =>
      service.execute(
        input,
        echoModel.methods.write,
        { repoDir: "." },
      ),
    Error,
    "Input validation failed",
  );
});

Deno.test("execute error message includes Zod details", () => {
  const service = new DefaultMethodExecutionService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { wrongField: "value" },
  });

  try {
    service.execute(
      input,
      echoModel.methods.write,
      { repoDir: "." },
    );
    throw new Error("Expected error to be thrown");
  } catch (error) {
    const message = (error as Error).message;
    assertEquals(message.startsWith("Input validation failed:"), true);
    // Should mention the missing 'message' field
    assertEquals(message.includes("message"), true);
  }
});

// ---------- Workflow Tests ----------

/**
 * Creates a test model with configurable behavior for workflow testing.
 */
function createTestModel(options: {
  executeImpl?: (
    input: ModelInput,
    context: MethodContext,
  ) => Promise<MethodResult>;
  followUpImpl?: (
    input: ModelInput,
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
    resourceAttributesSchema: schema,
    methods: {
      start: {
        description: "Start method for testing",
        inputAttributesSchema: schema,
        execute: options.executeImpl ??
          ((input) =>
            Promise.resolve({
              resource: ModelResource.create({
                id: input.id,
                attributes: { value: "started" },
              }),
            })),
      },
      followUp: {
        description: "Follow-up method for testing",
        inputAttributesSchema: schema,
        execute: options.followUpImpl ??
          ((input) =>
            Promise.resolve({
              resource: ModelResource.create({
                id: input.id,
                attributes: { value: "followed-up" },
              }),
            })),
      },
    },
  };
}

Deno.test("executeWorkflow - basic execution without follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "start",
    { repoDir: "." },
  );

  assertEquals(result.resource?.attributes.value, "started");
});

Deno.test("executeWorkflow - throws error for unknown method", async () => {
  const service = new DefaultMethodExecutionService();
  const model = createTestModel({});

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        input,
        model,
        "nonexistent",
        { repoDir: "." },
      ),
    Error,
    "Method 'nonexistent' not found in model",
  );
});

Deno.test("executeWorkflow - processes follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: (input) =>
      Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "started", counter: 1 },
        }),
        followUpActions: [{ methodName: "followUp" }],
      }),
    followUpImpl: (input) =>
      Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "completed", counter: 2 },
        }),
      }),
  });

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "start",
    { repoDir: "." },
  );

  assertEquals(result.resource?.attributes.value, "completed");
  assertEquals(result.resource?.attributes.counter, 2);
});

Deno.test("executeWorkflow - respects continueCondition", async () => {
  const service = new DefaultMethodExecutionService();
  let followUpCallCount = 0;

  const model = createTestModel({
    executeImpl: (input) =>
      Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "started", counter: 0 },
        }),
        followUpActions: [
          {
            methodName: "followUp",
            // Only continue if counter is less than 0 (never true after start)
            continueCondition: (resource) =>
              (resource.attributes.counter as number) < 0,
          },
        ],
      }),
    followUpImpl: (input) => {
      followUpCallCount++;
      return Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "should-not-reach" },
        }),
      });
    },
  });

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "start",
    { repoDir: "." },
  );

  // Follow-up should not be called because condition was false
  assertEquals(followUpCallCount, 0);
  assertEquals(result.resource?.attributes.value, "started");
});

Deno.test("executeWorkflow - retries on failure with maxRetries", async () => {
  const service = new DefaultMethodExecutionService();
  let attemptCount = 0;

  const model = createTestModel({
    executeImpl: (input) =>
      Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "started" },
        }),
        followUpActions: [{ methodName: "followUp", maxRetries: 2 }],
      }),
    followUpImpl: (input) => {
      attemptCount++;
      if (attemptCount < 3) {
        return Promise.reject(new Error("Simulated failure"));
      }
      return Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "succeeded-on-retry" },
        }),
      });
    },
  });

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "start",
    { repoDir: "." },
  );

  // Should have succeeded on the 3rd attempt (1 initial + 2 retries)
  assertEquals(attemptCount, 3);
  assertEquals(result.resource?.attributes.value, "succeeded-on-retry");
});

Deno.test("executeWorkflow - fails after exhausting maxRetries", async () => {
  const service = new DefaultMethodExecutionService();

  const model = createTestModel({
    executeImpl: (input) =>
      Promise.resolve({
        resource: ModelResource.create({
          id: input.id,
          attributes: { value: "started" },
        }),
        followUpActions: [{ methodName: "followUp", maxRetries: 1 }],
      }),
    followUpImpl: () => Promise.reject(new Error("Always fails")),
  });

  const input = ModelInput.create({
    name: "test-input",
    attributes: { value: "test" },
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        input,
        model,
        "start",
        { repoDir: "." },
      ),
    Error,
    "Follow-up action 'followUp' failed after 1 retries",
  );
});

Deno.test("executeWorkflow - handles recursive follow-up actions", async () => {
  const service = new DefaultMethodExecutionService();
  const callSequence: string[] = [];

  // Create model where "start" calls "followUp", which recursively calls itself once
  const schema = z.object({
    step: z.number().optional(),
    value: z.string().optional(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/recursive"),
    version: 1,
    inputAttributesSchema: schema,
    resourceAttributesSchema: schema,
    methods: {
      start: {
        description: "Start method",
        inputAttributesSchema: schema,
        execute: (input) => {
          callSequence.push("start");
          return Promise.resolve({
            resource: ModelResource.create({
              id: input.id,
              attributes: { step: 1 },
            }),
            followUpActions: [{ methodName: "increment" }],
          });
        },
      },
      increment: {
        description: "Increment method that may recurse",
        inputAttributesSchema: schema,
        execute: (input) => {
          const currentStep = (input.attributes.step as number) ?? 0;
          callSequence.push(`increment-${currentStep}`);

          const nextStep = currentStep + 1;
          const resource = ModelResource.create({
            id: input.id,
            attributes: { step: nextStep },
          });

          // Only recurse if step < 3
          if (nextStep < 3) {
            return Promise.resolve({
              resource,
              followUpActions: [{ methodName: "increment" }],
            });
          }

          return Promise.resolve({ resource });
        },
      },
    },
  };

  const input = ModelInput.create({
    name: "test-input",
    attributes: { step: 0 },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "start",
    { repoDir: "." },
  );

  assertEquals(callSequence, ["start", "increment-1", "increment-2"]);
  assertEquals(result.resource?.attributes.step, 3);
});

Deno.test("executeWorkflow - throws on max depth exceeded", async () => {
  const service = new DefaultMethodExecutionService();

  // Create model that infinitely recurses
  const schema = z.object({ counter: z.number().optional() });

  const model: ModelDefinition = {
    type: ModelType.create("test/infinite"),
    version: 1,
    inputAttributesSchema: schema,
    resourceAttributesSchema: schema,
    methods: {
      start: {
        description: "Start infinite loop",
        inputAttributesSchema: schema,
        execute: (input) => {
          const counter = (input.attributes.counter as number) ?? 0;
          return Promise.resolve({
            resource: ModelResource.create({
              id: input.id,
              attributes: { counter: counter + 1 },
            }),
            followUpActions: [{ methodName: "start" }],
          });
        },
      },
    },
  };

  const input = ModelInput.create({
    name: "test-input",
    attributes: { counter: 0 },
  });

  await assertRejects(
    () =>
      service.executeWorkflow(
        input,
        model,
        "start",
        { repoDir: "." },
      ),
    Error,
    "Maximum follow-up action depth (100) exceeded",
  );
});

Deno.test("executeWorkflow - follow-up receives resource attributes from previous method", async () => {
  const service = new DefaultMethodExecutionService();
  let receivedAttributes: Record<string, unknown> = {};

  // This test simulates the EC2 create -> sync flow:
  // - "create" returns a resource with a RequestToken
  // - "sync" should receive that RequestToken in its input attributes
  const schema = z.object({
    RequestToken: z.string().optional(),
    OperationStatus: z.string().optional(),
    OriginalValue: z.string().optional(),
  });

  const model: ModelDefinition = {
    type: ModelType.create("test/token-passing"),
    version: 1,
    inputAttributesSchema: schema,
    resourceAttributesSchema: schema,
    methods: {
      create: {
        description: "Create method that returns RequestToken",
        inputAttributesSchema: schema,
        execute: (input) => {
          return Promise.resolve({
            resource: ModelResource.create({
              id: input.id,
              attributes: {
                RequestToken: "test-request-token-123",
                OperationStatus: "IN_PROGRESS",
              },
            }),
            followUpActions: [{ methodName: "sync" }],
          });
        },
      },
      sync: {
        description: "Sync method that needs RequestToken",
        inputAttributesSchema: schema,
        execute: (input) => {
          // Capture what attributes were received
          receivedAttributes = { ...input.attributes };

          const requestToken = input.attributes.RequestToken as string;
          if (!requestToken) {
            return Promise.reject(
              new Error("No RequestToken in input attributes"),
            );
          }

          return Promise.resolve({
            resource: ModelResource.create({
              id: input.id,
              attributes: {
                RequestToken: requestToken,
                OperationStatus: "SUCCESS",
              },
            }),
          });
        },
      },
    },
  };

  const input = ModelInput.create({
    name: "test-input",
    attributes: { OriginalValue: "from-yaml" },
  });

  const result = await service.executeWorkflow(
    input,
    model,
    "create",
    { repoDir: "." },
  );

  // Verify sync received the RequestToken from create's resource
  assertEquals(receivedAttributes.RequestToken, "test-request-token-123");
  assertEquals(receivedAttributes.OperationStatus, "IN_PROGRESS");

  // Verify final result
  assertEquals(result.resource?.attributes.OperationStatus, "SUCCESS");
});
