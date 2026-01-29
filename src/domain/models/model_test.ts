import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { type ModelDefinition, ModelRegistry } from "./model.ts";
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
            inputId: input.id,
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
  assertEquals(result.resource.inputId, input.id);
  assertEquals(result.resource.attributes.message, "hello world");
  assertEquals(typeof result.resource.attributes.timestamp, "string");
});
