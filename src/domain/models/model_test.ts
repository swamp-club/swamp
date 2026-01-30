import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { defineModel, type ModelDefinition, ModelRegistry } from "./model.ts";
import { ModelType } from "./model_type.ts";
import { ModelInput } from "./model_input.ts";
import { ModelResource } from "./model_resource.ts";

function createTestModel(typeString: string): ModelDefinition {
  return {
    type: ModelType.create(typeString),
    version: 1,
    inputAttributesSchema: z.object({ message: z.string() }),
    resourceAttributesSchema: z.object({
      message: z.string(),
      timestamp: z.string(),
    }),
    methods: {
      write: {
        description: "Write message to resource",
        inputAttributesSchema: z.object({ message: z.string() }),
        execute: (input: ModelInput) => {
          const resource = ModelResource.create({
            id: input.id,
            attributes: {
              message: input.attributes.message,
              timestamp: new Date().toISOString(),
            },
          });
          return Promise.resolve({ resource });
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
  assertEquals(retrieved?.version, 1);
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
  const input = ModelInput.create({
    name: "test",
    attributes: { message: "hello world" },
  });

  const result = await model.methods.write.execute(input, { repoDir: "/tmp" });
  assertEquals(result.resource?.attributes.message, "hello world");
  assertEquals(typeof result.resource?.attributes.timestamp, "string");
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
