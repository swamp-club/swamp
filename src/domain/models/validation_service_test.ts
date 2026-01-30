import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  DefaultModelValidationService,
  ValidationResult,
} from "./validation_service.ts";
import { ModelInput } from "./model_input.ts";
import { ModelResource } from "./model_resource.ts";
import { echoModel } from "./echo/echo_model.ts";
import type { InputRepository } from "./repositories.ts";
import { ModelType } from "./model_type.ts";
import type { ModelInputId } from "./model_input.ts";
import { type ModelDefinition, modelRegistry } from "./model.ts";

/**
 * Test model with resource attributes schema for validation tests.
 * This simulates models that produce persistent resources (like AWS models).
 */
const testResourceModel: ModelDefinition = {
  type: ModelType.create("test/resource"),
  version: 1,
  inputAttributesSchema: z.object({
    message: z.string().min(1),
  }),
  resourceAttributesSchema: z.object({
    message: z.string(),
    timestamp: z.string().datetime(),
  }),
  methods: {},
};

// Register the test model if not already registered
if (!modelRegistry.has(testResourceModel.type)) {
  modelRegistry.register(testResourceModel);
}

// ValidationResult value object tests

Deno.test("ValidationResult.pass creates passing result", () => {
  const result = ValidationResult.pass("Test validation");
  assertEquals(result.name, "Test validation");
  assertEquals(result.passed, true);
  assertEquals(result.error, undefined);
});

Deno.test("ValidationResult.fail creates failing result with error", () => {
  const result = ValidationResult.fail(
    "Test validation",
    "Something went wrong",
  );
  assertEquals(result.name, "Test validation");
  assertEquals(result.passed, false);
  assertEquals(result.error, "Something went wrong");
});

Deno.test("ValidationResult.equals returns true for identical results", () => {
  const result1 = ValidationResult.pass("Test");
  const result2 = ValidationResult.pass("Test");
  assertEquals(result1.equals(result2), true);
});

Deno.test("ValidationResult.equals returns true for identical failing results", () => {
  const result1 = ValidationResult.fail("Test", "error");
  const result2 = ValidationResult.fail("Test", "error");
  assertEquals(result1.equals(result2), true);
});

Deno.test("ValidationResult.equals returns false for different names", () => {
  const result1 = ValidationResult.pass("Test1");
  const result2 = ValidationResult.pass("Test2");
  assertEquals(result1.equals(result2), false);
});

Deno.test("ValidationResult.equals returns false for different passed status", () => {
  const result1 = ValidationResult.pass("Test");
  const result2 = ValidationResult.fail("Test", "error");
  assertEquals(result1.equals(result2), false);
});

Deno.test("ValidationResult.equals returns false for different errors", () => {
  const result1 = ValidationResult.fail("Test", "error1");
  const result2 = ValidationResult.fail("Test", "error2");
  assertEquals(result1.equals(result2), false);
});

// DefaultModelValidationService tests

Deno.test("validateModel with valid input and no resource returns 2 passing results", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "hello" },
  });

  const results = await service.validateModel(input, echoModel, null);

  assertEquals(results.length, 2);
  assertEquals(results[0].name, "Input schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[1].name, "Input attributes");
  assertEquals(results[1].passed, true);
});

Deno.test("validateModel with valid input and valid resource returns 4 passing results", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "hello" },
  });
  const resource = ModelResource.create({
    id: input.id,
    attributes: {
      message: "hello",
      timestamp: new Date().toISOString(),
    },
  });

  // Use testResourceModel which has resourceAttributesSchema
  const results = await service.validateModel(
    input,
    testResourceModel,
    resource,
  );

  assertEquals(results.length, 4);
  assertEquals(results[0].name, "Input schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[1].name, "Input attributes");
  assertEquals(results[1].passed, true);
  assertEquals(results[2].name, "Resource schema");
  assertEquals(results[2].passed, true);
  assertEquals(results[3].name, "Resource attributes");
  assertEquals(results[3].passed, true);
});

Deno.test("validateModel with invalid input attributes returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { wrongAttribute: "hello" }, // Missing required 'message'
  });

  const results = await service.validateModel(input, echoModel, null);

  assertEquals(results.length, 2);
  assertEquals(results[0].name, "Input schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[1].name, "Input attributes");
  assertEquals(results[1].passed, false);
  assertEquals(typeof results[1].error, "string");
});

Deno.test("validateModel with empty message returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "" }, // Empty message fails min(1) validation
  });

  const results = await service.validateModel(input, echoModel, null);

  assertEquals(results.length, 2);
  assertEquals(results[0].passed, true);
  assertEquals(results[1].passed, false);
  assertEquals(results[1].error !== undefined, true);
});

Deno.test("validateModel with invalid resource attributes returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "hello" },
  });
  const resource = ModelResource.create({
    id: input.id,
    attributes: {
      message: 123, // Should be string
      timestamp: new Date().toISOString(),
    },
  });

  const results = await service.validateModel(input, echoModel, resource);

  assertEquals(results.length, 4);
  assertEquals(results[0].passed, true); // Input schema
  assertEquals(results[1].passed, true); // Input attributes
  assertEquals(results[2].passed, true); // Resource schema
  assertEquals(results[3].name, "Resource attributes");
  assertEquals(results[3].passed, false);
  assertEquals(typeof results[3].error, "string");
});

Deno.test("validateModel with missing resource timestamp returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "hello" },
  });
  const resource = ModelResource.create({
    id: input.id,
    attributes: {
      message: "hello",
      // Missing timestamp
    },
  });

  const results = await service.validateModel(input, echoModel, resource);

  assertEquals(results.length, 4);
  assertEquals(results[3].name, "Resource attributes");
  assertEquals(results[3].passed, false);
});

Deno.test("validateModel runs validations in parallel", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "hello" },
  });
  const resource = ModelResource.create({
    id: input.id,
    attributes: {
      message: "hello",
      timestamp: new Date().toISOString(),
    },
  });

  // Run multiple times to verify parallel execution doesn't cause issues
  // Use testResourceModel which has resourceAttributesSchema
  const promises = Array.from(
    { length: 10 },
    () => service.validateModel(input, testResourceModel, resource),
  );

  const allResults = await Promise.all(promises);

  for (const results of allResults) {
    assertEquals(results.length, 4);
    assertEquals(results.every((r) => r.passed), true);
  }
});

// Expression path validation tests

/**
 * Creates a mock input repository for testing expression path validation.
 */
function createMockInputRepo(
  models: { name: string; type: string; input: ModelInput }[],
): InputRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: (name: string) => {
      const found = models.find((m) => m.name === name);
      if (found) {
        return Promise.resolve({
          input: found.input,
          type: ModelType.create(found.type),
        });
      }
      return Promise.resolve(null);
    },
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as ModelInputId,
    getPath: () => "",
  };
}

Deno.test("validateModel with expression paths passes for valid path", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.target-model.input.attributes.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetInput },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with expression paths fails for invalid attribute", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.target-model.input.attributes.nonExistent }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetInput },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nonExistent");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel with expression paths fails for non-existent model", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.missing-model.input.attributes.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "missing-model");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel with expression paths validates self references", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "${{ self.name }}" },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with expression paths fails for invalid self attribute", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "${{ self.attributes.nonExistent }}" },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nonExistent");
});

Deno.test("validateModel with expression paths fails for invalid self segment", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "${{ self.wrongSegment }}" },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "wrongSegment");
});

Deno.test("validateModel with expression paths provides typo suggestion", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // "mesage" is a typo for "message"
      message: "${{ model.target-model.input.attributes.mesage }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetInput },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "message");
});

Deno.test("validateModel without inputRepo skips expression validation", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.missing.input.attributes.foo }}",
    },
  });

  // No inputRepo provided - expression validation should be skipped
  const results = await service.validateModel(input, echoModel, null);

  // Should only have input schema and input attributes validations
  assertEquals(results.length, 2);
  assertEquals(results.every((r) => r.name !== "Expression paths"), true);
});

Deno.test("validateModel with no expressions passes validation", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: { message: "plain string with no expressions" },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// Malformed expression detection tests

Deno.test("validateModel detects malformed expression with missing $ prefix", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Missing $ prefix - should be ${{ ... }}
      message: "{{my-vpc.VpcId}}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "{{my-vpc.VpcId}}");
  assertStringIncludes(exprResult?.error ?? "", "instead of ${{");
});

Deno.test("validateModel detects malformed expression with single braces", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Single braces - should be ${{ ... }}
      message: "${model.my-vpc.resource.attributes.VpcId}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "${model.my-vpc");
  assertStringIncludes(exprResult?.error ?? "", "double braces");
});

Deno.test("validateModel detects malformed expression in nested attributes", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "valid",
      nested: {
        value: "{{invalid-expression}}",
      },
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nested.value");
});

Deno.test("validateModel detects incomplete model reference like my-vpc.VpcId", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Missing "model." prefix and ".resource.attributes" path
      message: "${{my-vpc.VpcId}}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "my-vpc.VpcId");
  assertStringIncludes(exprResult?.error ?? "", "model.");
});

Deno.test("validateModel detects simple identifier expression", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Just a model name without any path
      message: "${{ my-vpc }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "my-vpc");
});

// Resource path reference tests

Deno.test("validateModel with resource path passes for valid path", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.target-model.resource.attributes.message }}",
    },
  });

  // Use test/resource type which has resourceAttributesSchema
  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "test/resource", input: targetInput },
    { name: "test-input", type: "test/resource", input },
  ]);

  const results = await service.validateModel(
    input,
    testResourceModel,
    null,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with resource path fails for invalid attribute", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.target-model.resource.attributes.wrongAttr }}",
    },
  });

  // Use test/resource type which has resourceAttributesSchema
  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "test/resource", input: targetInput },
    { name: "test-input", type: "test/resource", input },
  ]);

  const results = await service.validateModel(
    input,
    testResourceModel,
    null,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "wrongAttr");
});

// Invalid path segment tests

Deno.test("validateModel fails for missing .attributes segment", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Missing .attributes - directly accessing .message
      message: "${{ model.target-model.input.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetInput },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  // Should mention that "message" is not valid, expecting "attributes"
  assertStringIncludes(exprResult?.error ?? "", "message");
});

Deno.test("validateModel fails for 'attribute' instead of 'attributes'", async () => {
  const service = new DefaultModelValidationService();
  const targetInput = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Common typo: "attribute" instead of "attributes"
      message: "${{ model.target-model.resource.attribute.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetInput },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "attribute");
  // Should suggest "attributes"
  assertStringIncludes(exprResult?.error ?? "", "attributes");
});

// Mixed expression tests

Deno.test("validateModel validates multiple model references in same expression", async () => {
  const service = new DefaultModelValidationService();
  const model1 = ModelInput.create({
    name: "model-1",
    attributes: { message: "hello" },
  });
  const model2 = ModelInput.create({
    name: "model-2",
    attributes: { message: "world" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message:
        "${{ model.model-1.input.attributes.message + model.model-2.input.attributes.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "model-1", type: "swamp/echo", input: model1 },
    { name: "model-2", type: "swamp/echo", input: model2 },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel fails when one of multiple model references is invalid", async () => {
  const service = new DefaultModelValidationService();
  const model1 = ModelInput.create({
    name: "model-1",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // model-1 is valid, model-2 doesn't exist
      message:
        "${{ model.model-1.input.attributes.message + model.model-2.input.attributes.message }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "model-1", type: "swamp/echo", input: model1 },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "model-2");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel validates mixed model and self references", async () => {
  const service = new DefaultModelValidationService();
  const targetModel = ModelInput.create({
    name: "target-model",
    attributes: { message: "hello" },
  });
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ model.target-model.input.attributes.message + self.name }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "target-model", type: "swamp/echo", input: targetModel },
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// Edge case: valid ${{ }} without references (CEL literals)

Deno.test("validateModel passes for CEL literal expressions", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      // Valid CEL literal - should not be flagged as invalid
      message: "${{ 'hello world' }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel passes for CEL numeric expressions", async () => {
  const service = new DefaultModelValidationService();
  const input = ModelInput.create({
    name: "test-input",
    attributes: {
      message: "${{ 42 }}",
    },
  });

  const mockRepo = createMockInputRepo([
    { name: "test-input", type: "swamp/echo", input },
  ]);

  const results = await service.validateModel(input, echoModel, null, mockRepo);

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});
