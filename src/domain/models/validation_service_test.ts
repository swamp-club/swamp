// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { createExtensionCelEnvironment } from "../../infrastructure/cel/cel_evaluator.ts";
import { z } from "zod";
import {
  DefaultModelValidationService,
  FOREIGN_TEMPLATE_WARNING_NAME,
  ValidationResult,
} from "./validation_service.ts";
import { DATA_NAMESPACE_ACCESSORS } from "../expressions/expression_parser.ts";
import { Definition, type DefinitionId } from "../definitions/definition.ts";
import {
  defineModel,
  type LazyModelEntry,
  type MethodContext,
  type ModelDefinition,
  modelRegistry,
} from "./model.ts";
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

Deno.test("validateModel with valid definition returns passing results", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 5);
  assertEquals(results[0].name, "Definition schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[1].name, "Type version");
  assertEquals(results[1].passed, true);
  assertEquals(results[2].name, "Global arguments");
  assertEquals(results[2].passed, true);
  assertEquals(results[3].name, "Method arguments");
  assertEquals(results[3].passed, true);
  assertEquals(results[4].name, "Check selection");
  assertEquals(results[4].passed, true);
});

Deno.test("validateModel with invalid method arguments returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { wrongAttribute: "hello" },
    methods: { write: { arguments: { wrongAttribute: "hello" } } }, // Missing required 'message'
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 5);
  assertEquals(results[0].name, "Definition schema");
  assertEquals(results[0].passed, true);
  assertEquals(results[3].name, "Method arguments");
  assertEquals(results[3].passed, false);
  assertEquals(typeof results[3].error, "string");
});

Deno.test("validateModel with empty message passes when schema allows it", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "" },
    methods: { write: { arguments: { message: "" } } }, // Empty message is allowed by z.string()
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 5);
  assertEquals(results[0].passed, true);
  assertEquals(results[1].passed, true);
  assertEquals(results[2].passed, true);
  assertEquals(results[3].passed, true);
  assertEquals(results[4].passed, true);
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
    assertEquals(outcome.results.length, 5);
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

Deno.test("validateModel with expression paths allows unknown self segments for extension extras", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ self.workItem }}" },
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

Deno.test("validateModel with expression paths still validates globalArguments paths", async () => {
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

  // Should only have definition schema, type version, global arguments,
  // method arguments, and check selection
  assertEquals(results.length, 5);
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

// Template-like text: malformed swamp expressions vs another service's syntax

/**
 * A model type whose `message` global argument and `write` method's `run`
 * argument are declared as foreign template text. Built as a plain object so
 * the tests do not register a type in the process-global registry.
 */
const foreignTemplateModel: ModelDefinition = {
  type: ModelType.create("test/foreign-template"),
  version: "2026.09.24.1",
  globalArguments: z.object({
    message: z.string().meta({ foreignTemplate: true }).describe("Alert body"),
    query: z.string().optional(),
  }),
  methods: {
    write: {
      description: "Write test",
      arguments: z.object({
        run: z.string().meta({ foreignTemplate: true }),
        workingDir: z.string().optional(),
      }),
      execute: () => Promise.resolve({}),
    },
  },
};

async function validateWith(
  modelDef: ModelDefinition,
  props: Parameters<typeof Definition.create>[0],
) {
  const definition = Definition.create(props);
  const mockRepo = createMockDefinitionRepo([
    { name: props.name, type: modelDef.type.normalized, definition },
  ]);
  const { results, warnings } = await new DefaultModelValidationService()
    .validateModel(definition, modelDef, mockRepo);
  return {
    expressionPaths: results.find((r) => r.name === "Expression paths"),
    warnings,
  };
}

Deno.test("validateModel reports a dropped $ on a swamp expression with both remedies", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "{{self.name}}" },
  });
  assertEquals(expressionPaths?.passed, false);
  const error = expressionPaths?.error ?? "";
  assertStringIncludes(error, "{{self.name}}");
  assertStringIncludes(error, "instead of ${{");
  assertStringIncludes(error, 'at "globalArguments.message"');
  assertStringIncludes(error, 'Add "$" prefix');
  assertStringIncludes(error, ".meta({ foreignTemplate: true })");
  assertStringIncludes(error, "CEL string concatenation");
  assertStringIncludes(error, '${{ "{" + "{name}" + "}" }}');
  assertEquals(warnings, []);
});

Deno.test("validateModel keeps a colliding vendor root like {{env.name}} an error with both remedies", async () => {
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "crashed in {{env.name}}" },
  });
  assertEquals(expressionPaths?.passed, false);
  assertStringIncludes(expressionPaths?.error ?? "", "{{env.name}}");
  assertStringIncludes(
    expressionPaths?.error ?? "",
    ".meta({ foreignTemplate: true })",
  );
});

Deno.test("validateModel warns, not fails, on another service's double-brace syntax", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "{{#is_alert}}crashed on {{host.name}}{{/is_alert}}",
    },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].name, FOREIGN_TEMPLATE_WARNING_NAME);
  assertEquals(warnings[0].name, "Template syntax passed through");
  assertStringIncludes(warnings[0].message, "passed to the method unchanged");
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.message", text: "{{#is_alert}}" },
    { path: "globalArguments.message", text: "{{host.name}}" },
    { path: "globalArguments.message", text: "{{/is_alert}}" },
  ]);
});

Deno.test("validateModel treats {{my-vpc.VpcId}} as another service's syntax", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "{{my-vpc.VpcId}}" },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.message", text: "{{my-vpc.VpcId}}" },
  ]);
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

Deno.test("validateModel warns on template text in nested attributes with its full path", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "valid",
      nested: { value: "{{invalid-expression}}" },
    },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.nested.value", text: "{{invalid-expression}}" },
  ]);
});

Deno.test("validateModel reports every match in a string, failing on the swamp one", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "{{host.name}} in {{self.name}}" },
  });
  assertEquals(expressionPaths?.passed, false);
  assertStringIncludes(expressionPaths?.error ?? "", "{{self.name}}");
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.message", text: "{{host.name}}" },
  ]);
});

Deno.test("validateModel attributes {{inputs.X}} by the definition's declared inputs", async () => {
  const declared = await validateWith(testExprModel, {
    name: "test-definition",
    inputs: { type: "object", properties: { env: { type: "string" } } },
    globalArguments: { message: "{{inputs.env}}" },
  });
  assertEquals(declared.expressionPaths?.passed, false);

  const undeclared = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "{{inputs.env}}" },
  });
  assertEquals(undeclared.expressionPaths?.passed, true);
  assertEquals(undeclared.warnings[0].templates?.[0].text, "{{inputs.env}}");
});

Deno.test("validateModel warns on shell ${VAR} and fails on a single-brace swamp root", async () => {
  const shell = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: 'echo "${HOME}"' },
  });
  assertEquals(shell.expressionPaths?.passed, true);
  assertEquals(shell.warnings[0].templates, [
    { path: "globalArguments.message", text: "${HOME}" },
  ]);

  const terraform = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "${data.aws_ami.ubuntu.id}" },
  });
  assertEquals(terraform.expressionPaths?.passed, false);
  const error = terraform.expressionPaths?.error ?? "";
  assertStringIncludes(error, "double braces");
  assertStringIncludes(error, ".meta({ foreignTemplate: true })");
  assertStringIncludes(error, '${{ "$" + "{name}" }}');
  assertEquals(error.includes('"{" + "{name}" + "}"'), false);
});

Deno.test("validateModel accepts the concatenation examples its errors suggest", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: 'crashed in ${{ "{" + "{env.name}" + "}" }}',
      nested: { ami: '${{ "$" + "{data.aws_ami.ubuntu.id}" }}' },
    },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(
    warnings.filter((w) => w.name === FOREIGN_TEMPLATE_WARNING_NAME),
    [],
  );
});

Deno.test("validateModel stays silent on declared foreign template fields", async () => {
  const { expressionPaths, warnings } = await validateWith(
    foreignTemplateModel,
    {
      name: "test-definition",
      globalArguments: { message: "{{env.name}} crashed on {{host.name}}" },
      methods: {
        write: { arguments: { run: 'echo "${HOME}" {{self.name}}' } },
      },
    },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings, []);
});

Deno.test("validateModel still checks undeclared fields of a type that declares others", async () => {
  const { expressionPaths, warnings } = await validateWith(
    foreignTemplateModel,
    {
      name: "test-definition",
      globalArguments: { message: "{{host.name}}", query: "{{host.name}}" },
      methods: { write: { arguments: { run: "ok", workingDir: "${HOME}" } } },
    },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.query", text: "{{host.name}}" },
    { path: "methods.write.arguments.workingDir", text: "${HOME}" },
  ]);
});

Deno.test("validateModel fails {{...}} inside a ${{ }} string, even in a declared field", async () => {
  for (const modelDef of [testExprModel, foreignTemplateModel]) {
    const { expressionPaths, warnings } = await validateWith(modelDef, {
      name: "test-definition",
      globalArguments: { message: 'crashed on ${{ "{{host.name}}" }}' },
    });
    assertEquals(expressionPaths?.passed, false);
    const error = expressionPaths?.error ?? "";
    assertStringIncludes(error, "cuts it short");
    assertStringIncludes(error, "ends at the first }}");
    assertStringIncludes(error, "CEL string concatenation");
    assertEquals(warnings, []);
  }
});

Deno.test("validateModel reports an unclosed expression, not the {{...}} it runs into, even in a declared field", async () => {
  for (const modelDef of [testExprModel, foreignTemplateModel]) {
    const { expressionPaths, warnings } = await validateWith(modelDef, {
      name: "test-definition",
      globalArguments: {
        message: "echo ${{ self.name } && docker ps --format '{{.Names}}'",
      },
    });
    assertEquals(expressionPaths?.passed, false);
    const error = expressionPaths?.error ?? "";
    assertStringIncludes(error, "Unclosed ${{...}} expression");
    assertStringIncludes(error, "missing a closing brace");
    assertEquals(error.includes("cuts it short"), false, error);
    assertEquals(warnings, []);
  }
});

Deno.test("validateModel gives an unclosed expression one error", async () => {
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "echo ${{ foo } && docker ps --format '{{.Names}}'",
    },
  });
  assertEquals(expressionPaths?.passed, false);
  const error = expressionPaths?.error ?? "";
  assertStringIncludes(error, "Unclosed ${{...}} expression");
  assertEquals(
    error.includes("does not contain valid model, self, or env references"),
    false,
    error,
  );
});

Deno.test("validateModel passes braces inside an expression that parses", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "echo ${{ '{{' }}" },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings, []);
});

Deno.test("validateModel still validates ${{ }} expressions inside a declared field", async () => {
  const { expressionPaths, warnings } = await validateWith(
    foreignTemplateModel,
    {
      name: "test-definition",
      globalArguments: { message: "${{my-vpc.VpcId}} on {{host.name}}" },
    },
  );
  assertEquals(expressionPaths?.passed, false);
  assertStringIncludes(expressionPaths?.error ?? "", "my-vpc.VpcId");
  assertStringIncludes(expressionPaths?.error ?? "", 'Missing "model." prefix');
  assertEquals(warnings, []);
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

// Regression test for issue #89: cross-model expression validation must
// await ensureTypeLoaded before calling modelRegistry.get(), otherwise
// lazy-registered types (catalog-known but not yet imported) cause the
// validator to emit a misleading "Unknown model type" error even though
// the type is registered and works at execution time. Introduced by PR
// #1063 (lazy per-bundle loading); the execution path was wired up but
// the validation path was missed.
Deno.test("validateModel loads lazy types before resolving cross-model references", async () => {
  // Unique type string avoids collision with other tests sharing the
  // global modelRegistry singleton; the finally block removes it again so
  // the test also holds under --repeats. defineModel is intentionally NOT
  // used here because it would eagerly register the type and defeat the
  // whole point of simulating the lazy state.
  const LAZY_TYPE = "@test/issue-89-lazy-regression";
  const LAZY_MODEL_TYPE = ModelType.create(LAZY_TYPE);
  const lazyModel: ModelDefinition = {
    type: LAZY_MODEL_TYPE,
    version: "2026.04.11.1",
    globalArguments: z.object({ ollamaUrl: z.string() }),
    methods: {},
  };

  const lazyEntry: LazyModelEntry = {
    type: LAZY_MODEL_TYPE,
    bundlePath: `/repo/.swamp/bundles/${LAZY_TYPE}.js`,
    sourcePath: `/repo/extensions/models/${LAZY_TYPE}.ts`,
    version: "2026.04.11.1",
  };
  modelRegistry.registerLazy(lazyEntry);

  let loaderCalled = false;
  modelRegistry.setTypeLoader((type) => {
    loaderCalled = true;
    if (type === LAZY_TYPE) {
      modelRegistry.promoteFromLazy(lazyModel);
    }
    return Promise.resolve();
  });

  try {
    const service = new DefaultModelValidationService();
    const targetDefinition = Definition.create({
      name: "lazy-target",
      globalArguments: { ollamaUrl: "http://localhost:11434" },
    });
    const definition = Definition.create({
      name: "lazy-consumer",
      globalArguments: {
        ollamaUrl:
          "${{ model.lazy-target.definition.globalArguments.ollamaUrl }}",
      },
    });

    const mockRepo = createMockDefinitionRepo([
      { name: "lazy-target", type: LAZY_TYPE, definition: targetDefinition },
      {
        name: "lazy-consumer",
        type: "test/expr-validation",
        definition,
      },
    ]);

    const { results } = await service.validateModel(
      definition,
      testExprModel,
      mockRepo,
    );

    const exprResult = results.find((r) => r.name === "Expression paths");
    assertEquals(
      exprResult?.passed,
      true,
      `Expression paths validation should pass once ensureTypeLoaded is awaited. Error: ${exprResult?.error}`,
    );
    assertEquals(
      loaderCalled,
      true,
      "validateModelPathReference must await ensureTypeLoaded, which invokes the type loader for lazy types",
    );
  } finally {
    modelRegistry.setTypeLoader(() => Promise.resolve());
    // The loader promoted the type to fully loaded; drop it so a repeated
    // run starts from the lazy state again.
    modelRegistry.invalidateType(LAZY_TYPE);
  }
});

// ---------- Check Validation Tests ----------

import type { CheckValidationContext } from "./validation_service.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { SOLO_NAMESPACE } from "../data/namespace.ts";
import { generateDataId } from "../data/data_id.ts";
import { createDefinitionId } from "../definitions/definition.ts";

function createMockDataRepo(): UnifiedDataRepository {
  return {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findAllForType: () => Promise.resolve([]),
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
      Promise.resolve({
        version: 1,
        contentPath: "/tmp/mock",
        priorVersions: [],
      }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    findByTaggedName: () => Promise.resolve([]),
    rename: () => {
      throw new Error("not implemented");
    },
    saveDeferred: () =>
      Promise.resolve({
        type: ModelType.create("test"),
        modelId: "",
        dataName: "",
        version: 1,
      }),
    finalizeVersionDeferred: () =>
      Promise.resolve({
        receipt: {
          type: ModelType.create("test"),
          modelId: "",
          dataName: "",
          version: 1,
        },
        size: 0,
        checksum: "",
      }),
    advanceLatestMarkers: () => Promise.resolve(),
    rollbackVersions: () => Promise.resolve(),
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
    createCelEnvironment: createExtensionCelEnvironment,
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

// ---------- Vault Expression Resolution in Checks ----------

Deno.test("validateModel: checks receive resolved globalArgs when resolveRuntimeExpressions provided", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      password: '${{ vault.get("my-vault", "MY_SECRET") }}',
    },
  });

  let capturedGlobalArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/vault-check"),
    version: "2026.02.09.1",
    globalArguments: z.object({ password: z.string() }),
    methods: {
      create: {
        description: "Create",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures globalArgs for assertion",
        execute: (ctx) => {
          capturedGlobalArgs = ctx.globalArgs as Record<string, unknown>;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      resolveRuntimeExpressions: (data) =>
        Promise.resolve(
          JSON.parse(
            JSON.stringify(data).replace(
              /\$\{\{[^}]+\}\}/g,
              "resolved-secret",
            ),
          ),
        ),
    }),
  );

  assertEquals(capturedGlobalArgs?.password, "resolved-secret");
});

Deno.test("validateModel: checks receive raw globalArgs when resolveRuntimeExpressions not provided", async () => {
  const service = new DefaultModelValidationService();
  const vaultExpr = '${{ vault.get("my-vault", "MY_SECRET") }}';
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { password: vaultExpr },
  });

  let capturedGlobalArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/vault-check"),
    version: "2026.02.09.1",
    globalArguments: z.object({ password: z.string() }),
    methods: {
      create: {
        description: "Create",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures globalArgs for assertion",
        execute: (ctx) => {
          capturedGlobalArgs = ctx.globalArgs as Record<string, unknown>;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  // Without resolver, checks see the raw expression (existing behavior)
  assertEquals(capturedGlobalArgs?.password, vaultExpr);
});

Deno.test("validateModel: vault resolution failure degrades gracefully to raw globalArgs", async () => {
  const service = new DefaultModelValidationService();
  const vaultExpr = '${{ vault.get("my-vault", "MY_SECRET") }}';
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { password: vaultExpr },
  });

  let capturedGlobalArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/vault-check"),
    version: "2026.02.09.1",
    globalArguments: z.object({ password: z.string() }),
    methods: {
      create: {
        description: "Create",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures globalArgs for assertion",
        execute: (ctx) => {
          capturedGlobalArgs = ctx.globalArgs as Record<string, unknown>;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      resolveRuntimeExpressions: () => {
        throw new Error("Vault not configured");
      },
    }),
  );

  // Resolution failed — checks fall back to raw expression
  assertEquals(capturedGlobalArgs?.password, vaultExpr);
});

Deno.test("validateModel: resolved globalArgs also appear in unresolvedMethodArgs", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {
      password: '${{ vault.get("my-vault", "MY_SECRET") }}',
    },
  });

  let capturedUnresolvedMethodArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/vault-check"),
    version: "2026.02.09.1",
    globalArguments: z.object({ password: z.string() }),
    methods: {
      create: {
        description: "Create",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "capture-args": {
        description: "Captures unresolvedMethodArgs for assertion",
        execute: (ctx) => {
          capturedUnresolvedMethodArgs = ctx
            .unresolvedMethodArgs as Record<string, unknown>;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      resolveRuntimeExpressions: (data) =>
        Promise.resolve(
          JSON.parse(
            JSON.stringify(data).replace(
              /\$\{\{[^}]+\}\}/g,
              "resolved-secret",
            ),
          ),
        ),
    }),
  );

  // Resolved value should pass through filteredGlobalArgs into unresolvedMethodArgs
  assertEquals(capturedUnresolvedMethodArgs?.password, "resolved-secret");
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

Deno.test("validateModel runs checks with appliesTo even when no method specified", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext(), // no method specified
  );

  const checkResults = results.filter((r) => r.name.startsWith("Check:"));
  // Both checks run: always-pass succeeds, always-fail (with appliesTo) also runs
  assertEquals(checkResults.length, 2);
  const passResult = checkResults.find((r) => r.name === "Check: always-pass");
  const failResult = checkResults.find((r) => r.name === "Check: always-fail");
  assertEquals(passResult?.passed, true);
  assertEquals(failResult?.passed, false);
});

Deno.test("validateModel skips checks with appliesTo when --method specifies a different method", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  // always-fail has appliesTo: ["create"], so --method delete should skip it
  const { results } = await service.validateModel(
    definition,
    testModelWithChecks,
    undefined,
    createCheckContext({ method: "delete" }),
  );

  const checkResults = results.filter((r) => r.name.startsWith("Check:"));
  // always-pass has no appliesTo → runs; always-fail has appliesTo: ["create"] → skipped for "delete"
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

// ---------- Strict schema validation tests ----------

Deno.test("validateModel rejects unknown global argument key", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello", unknownKey: "oops" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
  assertStringIncludes(globalResult?.error ?? "", "unknownKey");
});

Deno.test("validateModel rejects unknown method argument key", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello", typo: "oops" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  const methodResult = results.find((r) => r.name === "Method arguments");
  assertEquals(methodResult?.passed, false);
  assertStringIncludes(methodResult?.error ?? "", "typo");
});

Deno.test("validateModel: coerces string global arguments to match schema types", async () => {
  const NumericGlobalArgsSchema = z.object({
    count: z.number(),
  });
  const numericModel: ModelDefinition = defineModel({
    type: ModelType.create("test/numeric-global"),
    version: "2026.05.11.1",
    globalArguments: NumericGlobalArgsSchema,
    resources: {},
    methods: {
      run: {
        description: "Run",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });

  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { count: "42" },
    methods: {},
  });

  const { results } = await service.validateModel(definition, numericModel);

  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, true);
});

Deno.test("validateModel: coerces string method arguments to match schema types", async () => {
  const service = new DefaultModelValidationService();
  const NumericMethodModel: ModelDefinition = defineModel({
    type: ModelType.create("test/numeric-method"),
    version: "2026.05.11.1",
    globalArguments: z.object({}),
    resources: {},
    methods: {
      run: {
        description: "Run",
        arguments: z.object({ port: z.number(), verbose: z.boolean() }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });

  const definition = Definition.create({
    name: "test-definition",
    globalArguments: {},
    methods: { run: { arguments: { port: "8080", verbose: "true" } } },
  });

  const { results } = await service.validateModel(
    definition,
    NumericMethodModel,
  );

  const methodResult = results.find((r) => r.name === "Method arguments");
  assertEquals(methodResult?.passed, true);
});

Deno.test("validateModel passes with required globalArgs schema when definition has empty globalArgs", async () => {
  const service = new DefaultModelValidationService();
  const RequiredArgsModel = defineModel({
    type: ModelType.create("test/required-globals"),
    version: "2026.05.18.1",
    globalArguments: z.object({
      Bucket: z.string(),
      PolicyDocument: z.string(),
    }),
    resources: {},
    methods: {
      get: {
        description: "Get",
        arguments: z.object({ identifier: z.string() }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });

  const definition = Definition.create({
    name: "policy-lookup",
    globalArguments: {},
  });

  const { results } = await service.validateModel(
    definition,
    RequiredArgsModel,
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, true);
});

Deno.test("validateModel still rejects invalid types on provided globalArgs", async () => {
  const service = new DefaultModelValidationService();
  const TypedModel = defineModel({
    type: ModelType.create("test/typed-globals"),
    version: "2026.05.18.1",
    globalArguments: z.object({ region: z.string(), count: z.number() }),
    resources: {},
    methods: {
      run: {
        description: "Run",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });

  const definition = Definition.create({
    name: "test-typed",
    globalArguments: { region: 12345 },
  });

  const { results } = await service.validateModel(definition, TypedModel);
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
});

Deno.test("validateModel: check receives unresolvedMethodArgs with method arguments", async () => {
  const service = new DefaultModelValidationService();

  let capturedArgs: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    type: ModelType.create("test/check-args-validation"),
    version: "1",
    methods: {
      forward: {
        description: "Forward ports",
        arguments: z.object({ spec: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "spec-valid": {
        description: "Validates spec via unresolvedMethodArgs",
        appliesTo: ["forward"],
        execute: (context: MethodContext) => {
          capturedArgs = context.unresolvedMethodArgs;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };

  const definition = Definition.create({
    name: "test-forward",
    globalArguments: {},
    methods: {
      forward: { arguments: { spec: "19090:localhost:22" } },
    },
  });

  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({ method: "forward" }),
  );

  const checkResult = results.find((r) => r.name === "Check: spec-valid");
  assertEquals(checkResult?.passed, true);
  assertEquals(capturedArgs?.spec, "19090:localhost:22");
});

// Regression tests for issue #2295: every accessor the CEL data namespace
// exposes must be accepted in a model global argument. The validator's
// allow-list was hand-written and fell behind the namespace, so `data.query`
// and `data.findBySpec` were rejected in global arguments long after they
// worked everywhere else — the reporter hit this and worked around it by
// writing a list as one resource and reading it back with `data.latest`.
//
// The table is driven from DATA_NAMESPACE_ACCESSORS rather than listing names,
// so an accessor added to the namespace without a case here is impossible.
Deno.test("validateModel accepts every data namespace accessor in a global argument", async () => {
  const callFor: Record<string, string> = {
    version: "data.version('my-model', 'output', 1)",
    latest: "data.latest('my-model', 'output')",
    listVersions: "data.listVersions('my-model', 'output')",
    findByTag: "data.findByTag('env', 'prod')",
    findBySpec: "data.findBySpec('my-model', 'output')",
    query: `data.query('specName == "output"')`,
  };

  for (const accessor of DATA_NAMESPACE_ACCESSORS) {
    const call = callFor[accessor];
    assertEquals(
      typeof call,
      "string",
      `no probe expression for accessor "${accessor}" — add one`,
    );

    const definition = Definition.create({
      name: "test-definition",
      globalArguments: { message: `\${{ ${call} }}` },
    });
    const mockRepo = createMockDefinitionRepo([
      { name: "test-definition", type: "test/expr-validation", definition },
    ]);

    const { results } = await new DefaultModelValidationService().validateModel(
      definition,
      testExprModel,
      mockRepo,
    );

    const exprResult = results.find((r) => r.name === "Expression paths");
    assertEquals(
      exprResult?.passed,
      true,
      `data.${accessor} must be valid in a global argument, got: ${exprResult?.error}`,
    );
  }
});

Deno.test("validateModel still rejects a global argument referencing nothing valid", async () => {
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ my-vpc.VpcId }}" },
  });
  const mockRepo = createMockDefinitionRepo([
    { name: "test-definition", type: "test/expr-validation", definition },
  ]);

  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    testExprModel,
    mockRepo,
  );

  const exprResult = results.find((r) => r.name === "Expression paths");
  assertEquals(exprResult?.passed, false);
});

Deno.test("validateModel reports a malformed typeVersion as a failed validation", async () => {
  // The Definition schema types typeVersion as a plain optional string so a
  // malformed value survives for `model get` to name, which means the schema
  // check passes it. This item is what turns it into something a user can see
  // before a run fails (swamp-club#2412).
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    typeVersion: "1.0",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  const schema = results.find((r) => r.name === "Definition schema")!;
  assertEquals(schema.passed, true, "the envelope itself is still well-formed");

  const typeVersion = results.find((r) => r.name === "Type version")!;
  assertEquals(typeVersion.passed, false);
  assertStringIncludes(typeVersion.error!, "1.0");
  assertStringIncludes(typeVersion.error!, "YYYY.MM.DD.MICRO");
});

Deno.test("validateModel accepts a definition that records no typeVersion", async () => {
  // Absence is a legitimate state for a hand-written definition — it records
  // that nobody stated which version the arguments were authored for. The
  // upgrade service declines to migrate it rather than guessing, which is not
  // a validation failure.
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });
  assertEquals(definition.typeVersion, undefined);

  const { results } = await service.validateModel(definition, testExprModel);

  const typeVersion = results.find((r) => r.name === "Type version")!;
  assertEquals(typeVersion.passed, true);
});

Deno.test("validateModel accepts a valid CalVer typeVersion", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    typeVersion: "2026.02.09.1",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  const typeVersion = results.find((r) => r.name === "Type version")!;
  assertEquals(typeVersion.passed, true);
});
