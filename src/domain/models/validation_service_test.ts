import { assertEquals } from "@std/assert";
import {
  DefaultModelValidationService,
  ValidationResult,
} from "./validation_service.ts";
import { ModelInput } from "./model_input.ts";
import { ModelResource } from "./model_resource.ts";
import { echoModel } from "./echo/echo_model.ts";

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
    inputId: input.id,
    attributes: {
      message: "hello",
      timestamp: new Date().toISOString(),
    },
  });

  const results = await service.validateModel(input, echoModel, resource);

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
    inputId: input.id,
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
    inputId: input.id,
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
    inputId: input.id,
    attributes: {
      message: "hello",
      timestamp: new Date().toISOString(),
    },
  });

  // Run multiple times to verify parallel execution doesn't cause issues
  const promises = Array.from(
    { length: 10 },
    () => service.validateModel(input, echoModel, resource),
  );

  const allResults = await Promise.all(promises);

  for (const results of allResults) {
    assertEquals(results.length, 4);
    assertEquals(results.every((r) => r.passed), true);
  }
});
