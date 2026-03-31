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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  DefaultModelValidationService,
  ValidationResult,
} from "./validation_service.ts";
import { Definition, type DefinitionId } from "../definitions/definition.ts";
import { defineModel, type ModelDefinition } from "./model.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { ModelType } from "./model_type.ts";

/**
 * Test model with globalArguments schema for expression path validation tests.
 */
const TestGlobalArgsSchema = z.object({
  message: z.string(),
});
const TEST_EXPR_MODEL_TYPE = ModelType.create("test/expr-validation");
const testExprModel: ModelDefinition = defineModel({
  type: TEST_EXPR_MODEL_TYPE,
  version: "2026.02.09.1",
  globalArguments: TestGlobalArgsSchema,
  resources: {
    "message": {
      description: "Test output",
      schema: z.object({ message: z.string() }),
      lifetime: "ephemeral",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write test",
      arguments: z.object({ message: z.string() }),
      execute: async (_args, context) => {
        const handle = await context.writeResource!("message", "message", {});
        return { dataHandles: [handle] };
      },
    },
  },
});

/**
 * Creates a mock definition repository for testing expression path validation.
 */
function createMockDefinitionRepo(
  models: { name: string; type: string; definition: Definition }[],
): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: (name: string) => {
      const found = models.find((m) => m.name === name);
      if (found) {
        return Promise.resolve({
          definition: found.definition,
          type: ModelType.create(found.type),
        });
      }
      return Promise.resolve(null);
    },
    findAllGlobal: () =>
      Promise.resolve(
        models.map((m) => ({
          definition: m.definition,
          type: ModelType.create(m.type),
        })),
      ),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as DefinitionId,
    getPath: () => "",
  };
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

Deno.test("validateModel with valid definition returns 3 passing results", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 4);
  assertEquals(results[0].name, "Definition schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[1].name, "Global arguments");
  assertEquals(results[1].passed, true);
  assertEquals(results[2].name, "Method arguments");
  assertEquals(results[2].passed, true);
  assertEquals(results[3].name, "Check selection");
  assertEquals(results[3].passed, true);
});

Deno.test("validateModel with invalid method arguments returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { wrongAttribute: "hello" },
    methods: { write: { arguments: { wrongAttribute: "hello" } } }, // Missing required 'message'
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 4);
  assertEquals(results[0].name, "Definition schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[2].name, "Method arguments");
  assertEquals(results[2].passed, false);
  assertEquals(typeof results[2].error, "string");
});

Deno.test("validateModel with empty message passes when schema allows it", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "" },
    methods: { write: { arguments: { message: "" } } }, // Empty message is allowed by z.string()
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 4);
  assertEquals(results[0].passed, true);
  assertEquals(results[1].passed, true);
  assertEquals(results[2].passed, true);
  assertEquals(results[3].passed, true);
});

Deno.test("validateModel runs validations in parallel", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  // Run multiple times to verify parallel execution doesn't cause issues
  const promises = Array.from(
    { length: 10 },
    () => service.validateModel(definition, testExprModel),
  );

  const allResults = await Promise.all(promises);

  for (const outcome of allResults) {
    assertEquals(outcome.results.length, 4);
    assertEquals(outcome.results.every((r) => r.passed), true);
  }
});

// Expression path validation tests

Deno.test("validateModel with expression paths passes for valid path", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ model.target-model.input.globalArguments.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with expression paths fails for invalid attribute", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ model.target-model.input.globalArguments.nonExistent }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nonExistent");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel with expression paths fails for non-existent model", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ model.missing-model.input.globalArguments.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "missing-model");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel with expression paths validates self references", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ self.name }}" },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with expression paths fails for invalid self attribute", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ self.globalArguments.nonExistent }}" },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nonExistent");
});

Deno.test("validateModel with expression paths fails for invalid self segment", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ self.wrongSegment }}" },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "wrongSegment");
});

Deno.test("validateModel with expression paths provides typo suggestion", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // "mesage" is a typo for "message"
      message: "${{ model.target-model.input.globalArguments.mesage }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "message");
});

Deno.test("validateModel without definitionRepo skips expression validation", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ model.missing.input.globalArguments.foo }}",
    },
  });

  // No definitionRepo provided - expression validation should be skipped
  const { results } = await service.validateModel(definition, testExprModel);

  // Should only have definition schema, global arguments, method arguments, and check selection
  assertEquals(results.length, 4);
  assertEquals(results.every((r) => r.name !== "Expression paths"), true);
});

Deno.test("validateModel with no expressions passes validation", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "plain string with no expressions" },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// Malformed expression detection tests

Deno.test("validateModel detects malformed expression with missing $ prefix", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Missing $ prefix - should be ${{ ... }}
      message: "{{my-vpc.VpcId}}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "{{my-vpc.VpcId}}");
  assertStringIncludes(exprResult?.error ?? "", "instead of ${{");
});

Deno.test("validateModel detects malformed expression with single braces", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Single braces - should be ${{ ... }}
      message: "${model.my-vpc.resource.attributes.VpcId}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "${model.my-vpc");
  assertStringIncludes(exprResult?.error ?? "", "double braces");
});

Deno.test("validateModel detects malformed expression in nested attributes", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "valid",
      nested: {
        value: "{{invalid-expression}}",
      },
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "nested.value");
});

Deno.test("validateModel detects incomplete model reference like my-vpc.VpcId", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Missing "model." prefix and ".resource.attributes" path
      message: "${{my-vpc.VpcId}}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "my-vpc.VpcId");
  assertStringIncludes(exprResult?.error ?? "", "model.");
});

Deno.test("validateModel detects simple identifier expression", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Just a model name without any path
      message: "${{ my-vpc }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "my-vpc");
});

// Data path reference tests

Deno.test("validateModel with resource path passes for valid DataRecord field", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message:
        "${{ model.target-model.resource.message.message.attributes.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// Invalid path segment tests

Deno.test("validateModel fails for missing .attributes segment", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Missing .attributes - directly accessing .message
      message: "${{ model.target-model.input.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  // Should mention that "message" is not valid, expecting "attributes"
  assertStringIncludes(exprResult?.error ?? "", "message");
});

Deno.test("validateModel fails for invalid field in resource DataRecord access", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // "attribute" is not a valid DataRecord field, should be "attributes"
      message:
        "${{ model.target-model.resource.message.message.attribute.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "attribute");
});

Deno.test("validateModel with resource path passes for nested attributes in DataRecord access", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      msg:
        "${{ model.target-model.resource.message.message.attributes.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel with resource path passes for scalar DataRecord field", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      allData: "${{ model.target-model.resource.message.id }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel fails for invalid field in resource DataRecord access", async () => {
  const service = new DefaultModelValidationService();
  const targetDefinition = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      bad: "${{ model.target-model.resource.message.message.badfield }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetDefinition,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "badfield");
});

// Mixed expression tests

Deno.test("validateModel validates multiple model references in same expression", async () => {
  const service = new DefaultModelValidationService();
  const model1 = Definition.create({
    name: "model-1",
    globalArguments: { message: "hello" },
  });
  const model2 = Definition.create({
    name: "model-2",
    globalArguments: { message: "world" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message:
        "${{ model.model-1.input.globalArguments.message + model.model-2.input.globalArguments.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "model-1", type: "test/expr-validation", definition: model1 },
    { name: "model-2", type: "test/expr-validation", definition: model2 },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel fails when one of multiple model references is invalid", async () => {
  const service = new DefaultModelValidationService();
  const model1 = Definition.create({
    name: "model-1",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // model-1 is valid, model-2 doesn't exist
      message:
        "${{ model.model-1.input.globalArguments.message + model.model-2.input.globalArguments.message }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "model-1", type: "test/expr-validation", definition: model1 },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
  assertStringIncludes(exprResult?.error ?? "", "model-2");
  assertStringIncludes(exprResult?.error ?? "", "not found");
});

Deno.test("validateModel validates mixed model and self references", async () => {
  const service = new DefaultModelValidationService();
  const targetModel = Definition.create({
    name: "target-model",
    globalArguments: { message: "hello" },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message:
        "${{ model.target-model.input.globalArguments.message + self.name }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    {
      name: "target-model",
      type: "test/expr-validation",
      definition: targetModel,
    },
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// Edge case: valid ${{ }} without references (CEL literals)

Deno.test("validateModel passes for CEL literal expressions", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      // Valid CEL literal - should not be flagged as invalid
      message: "${{ 'hello world' }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel passes for CEL numeric expressions", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ 42 }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// file.contents() and data function expression tests

Deno.test("validateModel passes for file.contents expression", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ file.contents('my-model', 'report') }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

Deno.test("validateModel passes for data.latest expression", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      message: "${{ data.latest('my-model', 'output').attributes.id }}",
    },
  });

  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, true);
});

// ---------- Check Validation Tests ----------

import type { CheckValidationContext } from "./validation_service.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";

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
    removeLatestMarker: () => Promise.resolve(),
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
    findAllGlobalSync: () => [],
    rename: () => {
      throw new Error("not implemented");
    },
  };
}

function createCheckContext(
  overrides?: Partial<CheckValidationContext>,
): CheckValidationContext {
  return {
    repoDir: "/tmp",
    dataRepository: createMockDataRepo(),
    definitionRepository: {
      findById: () => Promise.resolve(null),
      findAll: () => Promise.resolve([]),
      findByName: () => Promise.resolve(null),
      findByNameGlobal: () => Promise.resolve(null),
      findAllGlobal: () => Promise.resolve([]),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      nextId: () => createDefinitionId(crypto.randomUUID()),
      getPath: () => "",
    },
    ...overrides,
  };
}

Deno.test("validateModel with no checks returns existing validations only", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const { results } = await service.validateModel(
    definition,
    testExprModel,
    undefined,
    createCheckContext(),
  );

  // testExprModel has no checks, so no Check: results
  assertEquals(results.filter((r) => r.name.startsWith("Check:")).length, 0);
});

const testModelWithChecks: ModelDefinition = {
  type: ModelType.create("test/with-checks"),
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  methods: {
    create: {
      description: "Create",
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    },
  },
  checks: {
    "always-pass": {
      description: "Always passes",
      labels: ["offline"],
      execute: () => Promise.resolve({ pass: true }),
    },
    "always-fail": {
      description: "Always fails",
      labels: ["api"],
      appliesTo: ["create"],
      execute: () =>
        Promise.resolve({ pass: false, errors: ["Something wrong"] }),
    },
  },
};

Deno.test("validateModel with passing check adds pass result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const model: ModelDefinition = {
    ...testModelWithChecks,
    checks: {
      "my-check": {
        description: "Always passes",
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };

  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  const checkResult = results.find((r) => r.name === "Check: my-check");
  assertEquals(checkResult?.passed, true);
});

Deno.test("validateModel with failing check adds fail result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const model: ModelDefinition = {
    ...testModelWithChecks,
    checks: {
      "bad-check": {
        description: "Always fails",
        execute: () =>
          Promise.resolve({ pass: false, errors: ["Error A", "Error B"] }),
      },
    },
  };

  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  const checkResult = results.find((r) => r.name === "Check: bad-check");
  assertEquals(checkResult?.passed, false);
  assertStringIncludes(checkResult?.error ?? "", "Error A");
  assertStringIncludes(checkResult?.error ?? "", "Error B");
});

Deno.test("validateModel check label filtering", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext({ labels: ["offline"] }),
  );

  const checkNames = results.filter((r) => r.name.startsWith("Check:")).map((
    r,
  ) => r.name);
  assertEquals(checkNames.includes("Check: always-pass"), true);
  assertEquals(checkNames.includes("Check: always-fail"), false);
});

Deno.test("validateModel check method filtering", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  // always-fail has appliesTo: ["create"], so filtering by "delete" should skip it
  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext({ method: "delete" }),
  );

  const checkNames = results.filter((r) => r.name.startsWith("Check:")).map((
    r,
  ) => r.name);
  assertEquals(checkNames.includes("Check: always-pass"), true);
  assertEquals(checkNames.includes("Check: always-fail"), false);
});

Deno.test("validateModel no checkContext provided skips checks", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  // No checkContext — checks should not run
  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const checkResults = results.filter((r) => r.name.startsWith("Check:"));
  assertEquals(checkResults.length, 0);
});

// ---------- Check Selection Validation Tests ----------

Deno.test("validateModel check selection passes when no selection set", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, true);
});

Deno.test("validateModel check selection passes for valid require list", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { require: ["always-pass"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, true);
});

Deno.test("validateModel check selection fails for nonexistent required check", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { require: ["nonexistent-check"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "nonexistent-check");
  assertStringIncludes(selResult?.error ?? "", "not found");
});

Deno.test("validateModel check selection fails for nonexistent skipped check", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { skip: ["nonexistent-check"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "nonexistent-check");
  assertStringIncludes(selResult?.error ?? "", "not found");
});

Deno.test("validateModel check selection warns on require+skip overlap", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { require: ["always-pass"], skip: ["always-pass"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "both require and skip");
});

Deno.test("validateModel check selection passes for valid skip list", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { skip: ["always-fail"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, true);
});

Deno.test("validateModel definition-level skip excludes check from validate run", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { skip: ["always-fail"] },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext(),
  );

  const checkNames = results.filter((r) => r.name.startsWith("Check:")).map((
    r,
  ) => r.name);
  // always-fail is skipped by definition, always-pass should run
  assertEquals(checkNames.includes("Check: always-pass"), true);
  assertEquals(checkNames.includes("Check: always-fail"), false);
});

Deno.test("validateModel check selection on model without checks", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    checks: { require: ["nonexistent"] },
  });

  // testExprModel has no checks defined
  const { results } = await service.validateModel(
    definition,
    testExprModel,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "nonexistent");
});

Deno.test("validateModel skips checks with appliesTo when no method specified", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  // always-fail has appliesTo: ["create"], so without --method it should be skipped
  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext(), // no method specified
  );

  const checkResults = results.filter((r) => r.name.startsWith("Check:"));
  // always-pass has no appliesTo → runs; always-fail has appliesTo → skipped
  assertEquals(checkResults.length, 1);
  assertEquals(checkResults[0].name, "Check: always-pass");
  assertEquals(checkResults[0].passed, true);
});

Deno.test("validateModel handles check returning invalid result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const model: ModelDefinition = {
    ...testModelWithChecks,
    checks: {
      "bad-check": {
        description: "Returns garbage",
        execute: () =>
          Promise.resolve(undefined as unknown as { pass: boolean }),
      },
    },
  };

  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  const checkResult = results.find((r) => r.name === "Check: bad-check");
  assertEquals(checkResult?.passed, false);
  assertStringIncludes(checkResult?.error ?? "", "invalid result");
});

Deno.test("validateModel warns when appliesTo references nonexistent method", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const model: ModelDefinition = {
    ...testModelWithChecks,
    checks: {
      "typo-check": {
        description: "Has a typo in appliesTo",
        appliesTo: ["creat"], // typo — "create" is the real method
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };

  const { results } = await service.validateModel(
    definition,
    model,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "creat");
  assertStringIncludes(selResult?.error ?? "", "unknown method");
});

Deno.test("validateModel warns when appliesTo is empty array", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const model: ModelDefinition = {
    ...testModelWithChecks,
    checks: {
      "dead-check": {
        description: "Empty appliesTo means it never runs",
        appliesTo: [],
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };

  const { results } = await service.validateModel(
    definition,
    model,
  );

  const selResult = results.find((r) => r.name === "Check selection");
  assertEquals(selResult?.passed, false);
  assertStringIncludes(selResult?.error ?? "", "empty appliesTo");
  assertStringIncludes(selResult?.error ?? "", "will never run");
});
