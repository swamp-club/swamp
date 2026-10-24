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
  type ModelValidationOptions,
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
 * A model named my-vpc, so `${{ my-vpc.VpcId }}` reads as a model reference
 * missing its `model.` prefix rather than another templating system's text.
 */
const myVpc = Definition.create({
  name: "my-vpc",
  globalArguments: { message: "hello" },
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

  assertEquals(results.length, 6);
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
  assertEquals(results[5].name, "Tags");
  assertEquals(results[5].passed, true);
});

Deno.test("validateModel with invalid method arguments returns failing result", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { wrongAttribute: "hello" },
    methods: { write: { arguments: { wrongAttribute: "hello" } } }, // Missing required 'message'
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.length, 6);
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

  assertEquals(results.length, 6);
  assertEquals(results.every((r) => r.passed), true);
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
    assertEquals(outcome.results.length, 6);
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
  // method arguments, check selection and tags
  assertEquals(results.length, 6);
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
  repoModels: Definition[] = [],
  options?: ModelValidationOptions,
) {
  const definition = Definition.create(props);
  const mockRepo = createMockDefinitionRepo([
    { name: props.name, type: modelDef.type.normalized, definition },
    ...repoModels.map((d) => ({
      name: d.name,
      type: modelDef.type.normalized,
      definition: d,
    })),
  ]);
  const { results, warnings } = await new DefaultModelValidationService()
    .validateModel(definition, modelDef, mockRepo, undefined, options);
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
  assertStringIncludes(error, "literal()");
  assertStringIncludes(error, "${{ literal('{{name}}') }}");
  assertEquals(warnings, []);
});

Deno.test("validateModel carries each Expression paths error and prints each shared remedy once (swamp-club#2493)", async () => {
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "{{self.name}} {{self.version}} ${self.name}",
    },
  });
  assertEquals(expressionPaths?.passed, false);
  const entries = expressionPaths?.expressionErrors ?? [];
  assertEquals(entries.map((e) => e.expression), [
    "{{self.name}}",
    "{{self.version}}",
    "${self.name}",
  ]);
  assertEquals(entries.map((e) => e.suggestion), [
    'Add "$" prefix: ${{...}}.',
    'Add "$" prefix: ${{...}}.',
    "Use double braces: ${{...}}.",
  ]);
  assertStringIncludes(entries[0].remedy ?? "", "${{ literal('{{name}}') }}");
  assertEquals(entries[1].remedy, entries[0].remedy);
  assertStringIncludes(entries[2].remedy ?? "", "${{ literal('${name}') }}");

  const error = expressionPaths?.error ?? "";
  const lines = error.split("\n");
  assertEquals(lines.filter((l) => l.startsWith("- ")), [
    "- {{self.name}}",
    "- {{self.version}}",
    "- ${self.name}",
  ]);
  assertEquals(lines.filter((l) => l === entries[0].remedy).length, 1);
  assertEquals(lines.filter((l) => l === entries[2].remedy).length, 1);
  assertEquals(lines.slice(-2), [entries[0].remedy, entries[2].remedy]);
});

Deno.test("validateModel leaves an unclosed ${{ without a shared remedy", async () => {
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "${{ self.name" },
  });
  assertEquals(expressionPaths?.passed, false);
  const entries = expressionPaths?.expressionErrors ?? [];
  assertEquals(entries.length, 1);
  assertEquals(entries[0].remedy, undefined);
  assertStringIncludes(entries[0].suggestion ?? "", "literal()");
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
  assertStringIncludes(error, "${{ literal('${name}') }}");
  assertEquals(error.includes("literal('{{name}}')"), false);
});

Deno.test("validateModel accepts the literal() examples its errors suggest, and concatenation", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "crashed in ${{ literal('{{env.name}}') }}",
      nested: { ami: "${{ literal('${data.aws_ami.ubuntu.id}') }}" },
      opener: "${{ literal('${{') }}",
      concat: 'crashed in ${{ "{" + "{env.name}" + "}" }}',
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

Deno.test("validateModel passes {{...}} inside a ${{ }} string, declared or not (swamp-club#2492)", async () => {
  for (const modelDef of [testExprModel, foreignTemplateModel]) {
    for (
      const message of [
        'crashed on ${{ "{{host.name}}" }}',
        "${{ self.name }} alert, crashed on ${{ literal('{{host.name}}') }}",
        "${{ literal('{{a}}') + ' on-call' }}",
        "${{ literal('{{a}}') + literal('{{b}}') }}",
      ]
    ) {
      const { expressionPaths, warnings } = await validateWith(modelDef, {
        name: "test-definition",
        globalArguments: { message },
      });
      assertEquals(expressionPaths?.passed, true, message);
      assertEquals(warnings, [], message);
    }
  }
});

Deno.test("validateModel treats a literal() joined to an unknown root like the root alone", async () => {
  // A root swamp does not own makes the text another service's, with or
  // without a literal() beside it, so it is reported rather than accepted.
  for (
    const message of ["${{ typo.name }}", "${{ literal('x') + typo.name }}"]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message },
    });
    assertEquals(expressionPaths?.passed, true, message);
    assertEquals(warnings[0]?.templates, [
      { path: "globalArguments.message", text: message },
    ], message);
  }
});

Deno.test("validateModel reads no reference from text passed through literal()", async () => {
  // {{self.nope}} would fail as a self reference to a missing field if it
  // were read as code.
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "${{ literal('{{self.nope}} {{inputs.x}}') }}",
    },
  });
  assertEquals(expressionPaths?.passed, true);
});

Deno.test("validateModel scans authored global arguments in place of evaluated ones (swamp-club#2496)", async () => {
  // A direct-execution step's definition holds the evaluated braces; the
  // author wrote the concatenation that produced them.
  const { expressionPaths, warnings } = await validateWith(
    testExprModel,
    {
      name: "test-definition",
      globalArguments: { message: "crashed in {{env.name}}" },
    },
    [],
    {
      authoredGlobalArguments: {
        message: 'crashed in ${{ "{" + "{env.name}" + "}" }}',
      },
    },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings, []);
});

Deno.test("validateModel reports a dropped $ in authored global arguments", async () => {
  const { expressionPaths } = await validateWith(
    testExprModel,
    { name: "test-definition", globalArguments: { message: "fine" } },
    [],
    { authoredGlobalArguments: { message: "crashed in {{env.name}}" } },
  );
  assertEquals(expressionPaths?.passed, false);
  assertStringIncludes(expressionPaths?.error ?? "", "{{env.name}}");
  assertStringIncludes(
    expressionPaths?.error ?? "",
    'at "globalArguments.message"',
  );
});

Deno.test("validateModel lists foreign text found in authored global arguments", async () => {
  const { expressionPaths, warnings } = await validateWith(
    testExprModel,
    { name: "test-definition", globalArguments: { message: "fine" } },
    [],
    { authoredGlobalArguments: { message: "crashed on {{host.name}}" } },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.message", text: "{{host.name}}" },
  ]);
});

Deno.test("validateModel stays silent on declared foreign fields in authored global arguments", async () => {
  const { expressionPaths, warnings } = await validateWith(
    foreignTemplateModel,
    { name: "test-definition", globalArguments: { message: "fine" } },
    [],
    { authoredGlobalArguments: { message: "{{env.name}} on {{host.name}}" } },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings, []);
});

Deno.test("validateModel reports an unclosed expression in authored global arguments once", async () => {
  // The authored text carries the error; the definition never holds it, so
  // the reference checks see nothing extra to report.
  const { expressionPaths } = await validateWith(
    testExprModel,
    { name: "test-definition", globalArguments: { message: "evaluated" } },
    [],
    {
      authoredGlobalArguments: {
        message: "${{ self.name } && docker ps --format '{{.Names}}'",
      },
    },
  );
  assertEquals(expressionPaths?.passed, false);
  const error = expressionPaths?.error ?? "";
  assertEquals(error.split("Unclosed ${{...}} expression").length - 1, 1);
});

Deno.test("validateModel passes another templating system's ${{ }} text with the template warning (swamp-club#2491)", async () => {
  const { expressionPaths, warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: {
      message: "deploy ${{ github.sha }}",
      nested: { ref: "${{ github.event.model.foo.resource.x }}" },
      self: "${{ github.self.x }}",
    },
  });
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings.map((w) => w.name), [FOREIGN_TEMPLATE_WARNING_NAME]);
  assertEquals(warnings[0].templates, [
    { path: "globalArguments.message", text: "${{ github.sha }}" },
    {
      path: "globalArguments.nested.ref",
      text: "${{ github.event.model.foo.resource.x }}",
    },
    { path: "globalArguments.self", text: "${{ github.self.x }}" },
  ]);
});

Deno.test("validateModel lists ${{ }} and {{ }} foreign text in one warning", async () => {
  const { warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "{{host.name}} at ${{ github.sha }}" },
  });
  assertEquals(warnings.length, 1);
  assertEquals(
    warnings[0].templates?.map((t) => t.text).sort(),
    ["${{ github.sha }}", "{{host.name}}"],
  );
});

Deno.test("validateModel does not warn on foreign ${{ }} text in a declared field", async () => {
  const { expressionPaths, warnings } = await validateWith(
    foreignTemplateModel,
    {
      name: "test-definition",
      globalArguments: { message: "deploy ${{ github.sha }}" },
    },
  );
  assertEquals(expressionPaths?.passed, true);
  assertEquals(warnings, []);
});

Deno.test("validateModel still fails ${{ }} text that does not parse", async () => {
  // Not foreign: the run-time guard claims it, so validate must not pass it.
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "${{ not valid cel !!! }}" },
  });
  assertEquals(expressionPaths?.passed, false);
});

Deno.test("validateModel schema-checks global arguments holding foreign ${{ }} text, as the run does", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "deploy ${{ github.sha }}", count: "many" },
  });
  const { results } = await service.validateModel(definition, testExprModel);
  const globalArgs = results.find((r) => r.name === "Global arguments");
  assertEquals(globalArgs?.passed, false);
  assertStringIncludes(globalArgs?.error ?? "", "count");
});

Deno.test("validateModel does not pass swamp inputs read whole or with a computed key as foreign", async () => {
  // Validated as it was before foreign ${{ }} text was recognised: the env
  // reference is accepted, and size(inputs) names nothing validate checks.
  const computed = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "${{ inputs[env.STAGE] }}" },
  });
  assertEquals(computed.expressionPaths?.passed, true);
  assertEquals(
    computed.warnings.some((w) => w.name === FOREIGN_TEMPLATE_WARNING_NAME),
    false,
  );

  const whole = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "${{ size(inputs) }}" },
  });
  assertEquals(whole.expressionPaths?.passed, false);
  assertEquals(whole.warnings, []);
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
    assertStringIncludes(error, "missing or out of place");
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
    [myVpc],
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
    { name: "my-vpc", type: "test/expr-validation", definition: myVpc },
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
    { name: "my-vpc", type: "test/expr-validation", definition: myVpc },
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
    iterateForModel: async function* () {
      yield* [];
    },
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    ensureContentLocal: () => Promise.resolve("current" as const),
    isContentAcceptedSync: () => true,
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

Deno.test("validateModel: a missing required check reads in behavior words, with the model spelling for swamp model", async () => {
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
  const type = testModelWithChecks.type.normalized;
  assertEquals(
    selResult?.error,
    `Required check "nonexistent-check" not found on behavior type "${type}"`,
  );
  assertEquals(
    selResult?.modelError,
    `Required check "nonexistent-check" not found on model type "${type}"`,
  );
});

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
  // In swamp's own data namespace, so not another templating system's text.
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "${{ data.nope('my-model') }}" },
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

Deno.test("validateModel rejects a constant expression calling a function swamp does not have", async () => {
  for (const message of ["${{ now() }}", "${{ literal(123) }}"]) {
    const { expressionPaths } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message },
    });
    assertEquals(expressionPaths?.passed, false, message);
  }
});

Deno.test("validateModel validates a refined globalArguments schema instead of crashing on partial() (swamp-club#2766)", async () => {
  const service = new DefaultModelValidationService();
  const model: ModelDefinition = {
    ...testExprModel,
    globalArguments: z.object({ message: z.string(), count: z.number() })
      .refine(() => true),
  };

  const valid = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: { write: { arguments: { message: "hello" } } },
  });
  const validResult = (await service.validateModel(valid, model)).results
    .find((r) => r.name === "Global arguments");
  assertEquals(validResult?.passed, true);

  const invalid = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello", count: "many" },
    methods: { write: { arguments: { message: "hello" } } },
  });
  const invalidResult = (await service.validateModel(invalid, model)).results
    .find((r) => r.name === "Global arguments");
  assertEquals(invalidResult?.passed, false);
  assertStringIncludes(invalidResult?.error ?? "", '"count"');
});

Deno.test("validateModel enforces an object-level globalArguments refinement (swamp-club#2783)", async () => {
  const service = new DefaultModelValidationService();
  const model: ModelDefinition = {
    ...testExprModel,
    globalArguments: z.object({
      apiKey: z.string().optional(),
      token: z.string().optional(),
    }).superRefine((v, ctx) => {
      if (!v.apiKey && !v.token) {
        ctx.addIssue({ code: "custom", message: "apiKey or token required" });
      }
    }),
  };
  const resultFor = async (globalArguments: Record<string, unknown>) =>
    (await service.validateModel(
      Definition.create({
        name: "test-definition",
        globalArguments,
        methods: { write: { arguments: { message: "hello" } } },
      }),
      model,
    )).results.find((r) => r.name === "Global arguments");

  const invalid = await resultFor({});
  assertEquals(invalid?.passed, false);
  assertStringIncludes(invalid?.error ?? "", "apiKey or token required");
  assertEquals((await resultFor({ token: "t" }))?.passed, true);
});

// Upgrade chain in validation (swamp-club#3196)

/**
 * A model type whose one upgrade renames the `host` global argument to
 * `target`. Built as a plain object so the tests do not register a type in the
 * process-global registry.
 */
function renamingModel(
  upgradeAttributes: (old: Record<string, unknown>) => Record<string, unknown>,
  overrides: Partial<ModelDefinition> = {},
): ModelDefinition {
  return {
    type: ModelType.create("test/renaming-upgrade"),
    version: "2026.02.01.1",
    globalArguments: z.object({ target: z.string() }),
    upgrades: [{
      toVersion: "2026.02.01.1",
      description: "Rename host to target",
      upgradeAttributes,
    }],
    methods: {
      run: {
        description: "Run",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    ...overrides,
  };
}

const renameHost = (old: Record<string, unknown>) => {
  const { host, ...rest } = old;
  return { ...rest, target: host };
};

async function validateGlobalArgs(
  modelDef: ModelDefinition,
  props: Parameters<typeof Definition.create>[0],
) {
  const definition = Definition.create(props);
  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    modelDef,
  );
  return {
    definition,
    globalArguments: results.find((r) => r.name === "Global arguments"),
    typeVersion: results.find((r) => r.name === "Type version"),
    failed: results.filter((r) => !r.passed).map((r) => r.name),
  };
}

Deno.test("validateModel: checks a stale definition's global arguments after its upgrade chain", async () => {
  const { globalArguments } = await validateGlobalArgs(
    renamingModel(renameHost),
    {
      name: "stale",
      typeVersion: "2026.01.01.1",
      globalArguments: { host: "example" },
    },
  );

  assertEquals(globalArguments?.passed, true);
});

Deno.test("validateModel: leaves the validated definition as authored when it applies the upgrade chain", async () => {
  const { definition } = await validateGlobalArgs(renamingModel(renameHost), {
    name: "stale",
    typeVersion: "2026.01.01.1",
    globalArguments: { host: "example" },
  });

  assertEquals(definition.typeVersion, "2026.01.01.1");
  assertEquals(definition.globalArguments, { host: "example" });
});

Deno.test("validateModel: checks a current definition's global arguments without upgrading them", async () => {
  const model = renamingModel(() => {
    throw new Error("must not run");
  });

  const current = await validateGlobalArgs(model, {
    name: "current",
    typeVersion: "2026.02.01.1",
    globalArguments: { target: "example" },
  });
  assertEquals(current.globalArguments?.passed, true);

  const oldShape = await validateGlobalArgs(model, {
    name: "current-old-shape",
    typeVersion: "2026.02.01.1",
    globalArguments: { host: "example" },
  });
  assertEquals(oldShape.globalArguments?.passed, false);
  assertStringIncludes(oldShape.globalArguments?.error ?? "", "host");
});

Deno.test("validateModel: checks an unstamped definition's global arguments as written", async () => {
  const { globalArguments } = await validateGlobalArgs(
    renamingModel(renameHost),
    { name: "unstamped", globalArguments: { host: "example" } },
  );

  assertEquals(globalArguments?.passed, false);
  assertStringIncludes(
    globalArguments?.error ?? "",
    "Unknown global argument(s): host",
  );
});

Deno.test("validateModel: fails only Type version for a malformed typeVersion on a type with an upgrade chain", async () => {
  const { failed, typeVersion } = await validateGlobalArgs(
    renamingModel(renameHost),
    {
      name: "malformed",
      typeVersion: "1.0",
      globalArguments: { target: "example" },
    },
  );

  assertEquals(failed, ["Type version"]);
  assertStringIncludes(typeVersion?.error ?? "", "not a valid CalVer");
});

Deno.test("validateModel: fails Global arguments when an upgrade throws on static arguments", async () => {
  const { globalArguments } = await validateGlobalArgs(
    renamingModel(() => {
      throw new Error("host must be a hostname");
    }),
    {
      name: "stale",
      typeVersion: "2026.01.01.1",
      globalArguments: { host: "example" },
    },
  );

  assertEquals(globalArguments?.passed, false);
  assertEquals(
    globalArguments?.error,
    "Upgrading from typeVersion 2026.01.01.1 to 2026.02.01.1 failed: " +
      "host must be a hostname",
  );
});

Deno.test("validateModel: checks arguments as written when an upgrade throws on an expression-valued argument", async () => {
  const { globalArguments } = await validateGlobalArgs(
    renamingModel(() => {
      throw new Error("host must be a hostname");
    }),
    {
      name: "stale",
      typeVersion: "2026.01.01.1",
      globalArguments: { host: "${{ inputs.host }}" },
    },
  );

  // As before the upgrade ran in validation: a field holding a swamp
  // expression skips the schema check until the run evaluates it.
  assertEquals(globalArguments?.passed, true);
});

Deno.test("validateModel: gives pre-flight checks the upgraded global arguments", async () => {
  let seen: Record<string, unknown> | undefined;
  const model = renamingModel(renameHost, {
    checks: {
      "sees-args": {
        description: "Records the global arguments",
        execute: (context) => {
          seen = context.globalArgs;
          return Promise.resolve({ pass: true });
        },
      },
    },
  });
  const definition = Definition.create({
    name: "stale",
    typeVersion: "2026.01.01.1",
    globalArguments: { host: "example" },
  });

  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  assertEquals(
    results.find((r) => r.name === "Check: sees-args")?.passed,
    true,
  );
  assertEquals(seen, { target: "example" });
});

Deno.test("validateModel: checks arguments as written when an upgrade would convert an expression-valued argument", async () => {
  let seen: Record<string, unknown> | undefined;
  const model: ModelDefinition = {
    ...renamingModel((old) => ({ port: Number(old.port) })),
    globalArguments: z.object({ port: z.number() }),
    checks: {
      "sees-args": {
        description: "Records the global arguments",
        execute: (context) => {
          seen = context.globalArgs;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
  const definition = Definition.create({
    name: "stale",
    typeVersion: "2026.01.01.1",
    globalArguments: { port: "${{ inputs.port }}" },
  });

  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    model,
    undefined,
    createCheckContext(),
  );

  // The run upgrades the evaluated value; run over the raw expression text,
  // Number() would give a static NaN that the schema check rejects.
  assertEquals(
    results.find((r) => r.name === "Global arguments")?.passed,
    true,
  );
  assertEquals(seen, { port: "${{ inputs.port }}" });
});

Deno.test("validateModel: a bare-token vault.get raises no passed-through warning (swamp-club#3360)", async () => {
  for (
    const message of [
      "${{ vault.get(t, KEY) }}",
      "pre-${{ vault.get(t, KEY) }}",
      "${{ vault.get(my-vault, API_KEY) }}",
      '${{ vault.get("t", "KEY") }}',
      "${{ vault.get(`t`, `KEY`) }}",
      "${{ vault.get(`t`, `KEY`) + '-x' }}",
    ]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(expressionPaths?.passed, true, message);
    assertEquals(warnings, [], message);
  }
});

Deno.test("validateModel: another templating system's text beside a bare-token vault.get still warns (swamp-club#3360)", async () => {
  const { warnings } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: {
      write: {
        arguments: { message: "${{ vault.get(t, KEY) }} ${{ github.sha }}" },
      },
    },
  });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].templates, [
    { path: "methods.write.arguments.message", text: "${{ github.sha }}" },
  ]);
});

Deno.test("validateModel: Global arguments skips a field holding a bare-token vault.get, as it does the quoted form (swamp-club#3360)", async () => {
  const model: ModelDefinition = defineModel({
    type: ModelType.create("test/vault-bare-global"),
    version: "2026.02.09.1",
    globalArguments: z.object({ port: z.number() }),
    methods: {
      write: {
        description: "Write test",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  for (
    const port of [
      "${{ vault.get(t, PORT) }}",
      '${{ vault.get("t", "PORT") }}',
    ]
  ) {
    const { results, warnings } = await new DefaultModelValidationService()
      .validateModel(
        Definition.create({
          name: "test-definition",
          globalArguments: { port },
        }),
        model,
      );
    assertEquals(
      results.find((r) => r.name === "Global arguments")?.passed,
      true,
      port,
    );
    assertEquals(
      warnings.filter((w) => w.name === FOREIGN_TEMPLATE_WARNING_NAME),
      [],
      port,
    );
  }
});

Deno.test("validateModel: a vault.get followed or wrapped by more CEL passes Expression paths (swamp-club#3360)", async () => {
  for (
    const message of [
      '${{ vault.get(t, KEY) + "-x" }}',
      '${{ vault.get("t", "KEY") + "-x" }}',
      '${{ vault.get(t, KEY) == "a" ? "b" : "c" }}',
      "${{ int(vault.get(t, PORT)) }}",
      "${{ int(vault.get('t', 'PORT')) }}",
      '${{ "x" + vault.get(t, KEY) }}',
      "${{ vault.get(t, KEY).size() }}",
    ]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(expressionPaths?.error, undefined, message);
    assertEquals(expressionPaths?.passed, true, message);
    assertEquals(warnings, [], message);
  }
});

Deno.test("validateModel: a vault.get beside text that is not valid CEL still fails Expression paths", async () => {
  const { expressionPaths } = await validateWith(testExprModel, {
    name: "test-definition",
    globalArguments: { message: "hello" },
    methods: {
      write: { arguments: { message: "${{ vault.get(t, KEY) + }}" } },
    },
  });
  assertEquals(expressionPaths?.passed, false);
});

Deno.test("validateModel: a dotted bare vault.get argument that reads nothing swamp provides is an error, not a passed-through warning (swamp-club#3360)", async () => {
  for (
    const [message, arg] of [
      ["${{ vault.get(t, db.password) }}", "db.password"],
      ["${{ vault.get(github.repo, KEY) }}", "github.repo"],
      ["${{ vault.get(t.x, KEY) }}", "t.x"],
    ]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(warnings, [], message);
    assertEquals(expressionPaths?.passed, false, message);
    const entries = expressionPaths?.expressionErrors ?? [];
    assertEquals(entries.length, 1, message);
    assertStringIncludes(entries[0].error, `vault.get argument "${arg}"`);
    assertStringIncludes(entries[0].suggestion ?? "", `'${arg}'`);
  }
});

Deno.test("validateModel: a dotted bare vault.get argument over swamp's namespaces or quoted passes (swamp-club#3360)", async () => {
  for (
    const message of [
      "${{ vault.get(self.name, KEY) }}",
      "${{ vault.get(t, 'db.password') }}",
    ]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(expressionPaths?.error, undefined, message);
    assertEquals(warnings, [], message);
  }
});

Deno.test("validateModel: Global arguments does not schema-check the raw text of a vault.get with an unresolvable dotted argument (swamp-club#3360)", async () => {
  const model: ModelDefinition = defineModel({
    type: ModelType.create("test/vault-dotted-global"),
    version: "2026.02.09.1",
    globalArguments: z.object({ port: z.number() }),
    methods: {
      write: {
        description: "Write test",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { port: "${{ vault.get(t, db.port) }}" },
  });
  const { results, warnings } = await new DefaultModelValidationService()
    .validateModel(
      definition,
      model,
      createMockDefinitionRepo([
        { name: definition.name, type: model.type.normalized, definition },
      ]),
    );
  assertEquals(
    results.find((r) => r.name === "Global arguments")?.passed,
    true,
  );
  const paths = results.find((r) => r.name === "Expression paths");
  assertEquals(paths?.passed, false);
  assertStringIncludes(paths?.error ?? "", 'vault.get argument "db.port"');
  assertEquals(warnings, []);
});

Deno.test("validateModel: Expression paths still accepts every expression that is one vault.get call end to end", async () => {
  // Forms the check accepted before swamp-club#3360 and must keep accepting,
  // whether or not the classifier can parse them.
  for (
    const message of [
      "${{ vault.get(`t`, `KEY`) }}",
      "${{ vault.get( 't' , 'KEY' ) }}",
      "${{ vault.get('t') }}",
      "${{ vault.get(t, KEY).size() }}",
    ]
  ) {
    const { expressionPaths } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(expressionPaths?.error, undefined, message);
  }
});

Deno.test("validateModel: a root swamp does not provide beside a vault read is an error, not a passed-through warning (swamp-club#3360)", async () => {
  for (
    const message of [
      "${{ vault.get(t, KEY) + github.sha }}",
      "${{ vault.get('t', 'KEY') + github.sha }}",
      "${{ github.sha + vault.get(t, KEY) }}",
    ]
  ) {
    const { expressionPaths, warnings } = await validateWith(testExprModel, {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: { write: { arguments: { message } } },
    });
    assertEquals(warnings, [], message);
    assertEquals(expressionPaths?.passed, false, message);
    const entries = expressionPaths?.expressionErrors ?? [];
    assertEquals(entries.length, 1, message);
    assertStringIncludes(entries[0].error, "reads vault");
    assertStringIncludes(entries[0].error, '"github"');
    assertStringIncludes(entries[0].suggestion ?? "", "literal()");
  }
});

Deno.test("validateModel: a model name missing its prefix beside a vault read keeps the model-prefix error (swamp-club#3360)", async () => {
  const { expressionPaths } = await validateWith(
    testExprModel,
    {
      name: "test-definition",
      globalArguments: { message: "hello" },
      methods: {
        write: {
          arguments: { message: "${{ my-vpc.VpcId + vault.get(t, KEY) }}" },
        },
      },
    },
    [myVpc],
  );
  assertEquals(expressionPaths?.passed, false);
  assertEquals(
    (expressionPaths?.error ?? "").includes("reads vault"),
    false,
  );
});

const sensitiveGlobalsModel: ModelDefinition = defineModel({
  type: ModelType.create("test/sensitive-globals-validation"),
  version: "2026.02.09.1",
  globalArguments: z.object({
    token: z.string().meta({ sensitive: true }).optional(),
    message: z.string().optional(),
  }),
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals fails Global arguments for a literal sensitive global (swamp-club#3555)", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "literal-token",
    globalArguments: { token: "GLOBAL-CANARY" },
  });
  const { results } = await service.validateModel(
    definition,
    sensitiveGlobalsModel,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
  assertStringIncludes(globalResult?.error ?? "", "'token'");
  assertEquals(globalResult?.error?.includes("GLOBAL-CANARY"), false);
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals catches a literal next to an expression field (swamp-club#3555)", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "literal-token-mixed",
    globalArguments: {
      token: "GLOBAL-CANARY",
      message: "${{ inputs.message }}",
    },
  });
  const { results } = await service.validateModel(
    definition,
    sensitiveGlobalsModel,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals passes a vault.get sensitive global (swamp-club#3555)", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "vault-token",
    globalArguments: { token: "${{ vault.get('v', 'k') }}" },
  });
  const { results } = await service.validateModel(
    definition,
    sensitiveGlobalsModel,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, true);
});

Deno.test("validateModel: a literal sensitive global passes without refuseLiteralSensitiveGlobals (swamp-club#3555)", async () => {
  const service = new DefaultModelValidationService();
  // A copy holding a run's real values, which may be plaintext read through data.
  const definition = Definition.create({
    name: "real-values",
    globalArguments: { token: "Pl41n-s3cret" },
  });
  const { results } = await service.validateModel(
    definition,
    sensitiveGlobalsModel,
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, true);
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals catches a literal an upgrade moves into a sensitive field (swamp-club#3555)", async () => {
  const modelDef = renamingModel(
    (old) => {
      const { token, ...rest } = old;
      return { ...rest, apiKey: token };
    },
    {
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
      }),
    },
  );
  const definition = Definition.create({
    name: "stale-token",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "GLOBAL-CANARY" },
  });
  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    modelDef,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
  assertStringIncludes(globalResult?.error ?? "", "'apiKey'");
  assertEquals(globalResult?.error?.includes("GLOBAL-CANARY"), false);
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals reports a schema error beside the literal (swamp-club#3555)", async () => {
  const definition = Definition.create({
    name: "literal-and-typo",
    globalArguments: { token: "GLOBAL-CANARY", nope: "x" },
  });
  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    sensitiveGlobalsModel,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
  assertStringIncludes(globalResult?.error ?? "", "'token'");
  assertStringIncludes(globalResult?.error ?? "", "Unknown global argument");
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals catches an upgrade-moved literal beside an expression global (swamp-club#3555)", async () => {
  const modelDef = renamingModel(
    (old) => {
      const { token, ...rest } = old;
      return { ...rest, apiKey: token };
    },
    {
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        note: z.string().optional(),
      }),
    },
  );
  const definition = Definition.create({
    name: "stale-token-with-expression",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "GLOBAL-CANARY", note: "${{ inputs.note }}" },
  });
  const service = new DefaultModelValidationService();
  const { results } = await service.validateModel(
    definition,
    modelDef,
    undefined,
    undefined,
    { refuseLiteralSensitiveGlobals: true },
  );
  const globalResult = results.find((r) => r.name === "Global arguments");
  assertEquals(globalResult?.passed, false);
  assertStringIncludes(globalResult?.error ?? "", "'apiKey'");
  assertEquals(service.findLiteralSensitiveGlobals(definition, modelDef), [
    "apiKey",
  ]);
});

Deno.test("validateModel: refuseLiteralSensitiveGlobals does not refuse an expression an upgrade moves into a sensitive field (swamp-club#3555)", () => {
  const modelDef = renamingModel(
    (old) => {
      const { token, ...rest } = old;
      return { ...rest, apiKey: token };
    },
    {
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
      }),
    },
  );
  const definition = Definition.create({
    name: "stale-token-expression",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "${{ vault.get('v', 'k') }}" },
  });
  assertEquals(
    new DefaultModelValidationService().findLiteralSensitiveGlobals(
      definition,
      modelDef,
    ),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobals: does not refuse a default an upgrade fills only when a vault-referenced key is dropped (swamp-club#3555)", () => {
  const modelDef = renamingModel(
    (old) => {
      const { token, ...rest } = old;
      return { ...rest, apiKey: token ?? "none" };
    },
    {
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
      }),
    },
  );
  // The run upgrades this file as stored, so apiKey keeps the reference.
  const definition = Definition.create({
    name: "stale-token-vault",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "${{ vault.get('v', 'k') }}" },
  });
  assertEquals(
    new DefaultModelValidationService().findLiteralSensitiveGlobals(
      definition,
      modelDef,
    ),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobals: catches a moved literal when the upgrade also reads an expression-valued global (swamp-club#3555)", () => {
  const modelDef = renamingModel(
    (old) => ({
      apiKey: old.token,
      region: (old.region as string).toLowerCase(),
    }),
    {
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
    },
  );
  const definition = Definition.create({
    name: "stale-token-region",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "GLOBAL-CANARY", region: "${{ inputs.region }}" },
  });
  assertEquals(
    new DefaultModelValidationService().findLiteralSensitiveGlobals(
      definition,
      modelDef,
    ),
    ["apiKey"],
  );
});

Deno.test("findLiteralSensitiveGlobals: does not refuse an old key the current version reuses as a sensitive field (swamp-club#3555)", () => {
  const modelDef = renamingModel(
    (old) => {
      const { token, ...rest } = old;
      return { ...rest, clientId: token };
    },
    {
      globalArguments: z.object({
        clientId: z.string(),
        token: z.string().meta({ sensitive: true }).optional(),
      }),
    },
  );
  // v1's token was a public client id; the upgrade moves it to clientId.
  const definition = Definition.create({
    name: "stale-client-id",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "client-abc" },
  });
  assertEquals(
    new DefaultModelValidationService().findLiteralSensitiveGlobals(
      definition,
      modelDef,
    ),
    [],
  );
});

// Reserved tags (swamp-club#3635)

Deno.test("validateModel: Tags fails on a reserved key in the definition's tags, without its value", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    tags: { env: "dev", "_swamp.sensitiveFields": '["message"]' },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  const tags = results.find((r) => r.name === "Tags");
  assertEquals(tags?.passed, false);
  assertStringIncludes(
    tags?.error ?? "",
    "Tag '_swamp.sensitiveFields' from the behavior definition's tags is reserved",
  );
  assertStringIncludes(
    tags?.modelError ?? "",
    "from the model definition's tags is reserved",
  );
  assertEquals((tags?.error ?? "").includes('["message"]'), false);
  // The other checks still report.
  assertEquals(
    results.filter((r) => r.name !== "Tags").every((r) => r.passed),
    true,
  );
});

Deno.test("validateModel: Tags fails on a reserved key in a spec's default tags", async () => {
  const service = new DefaultModelValidationService();
  const modelDef: ModelDefinition = {
    ...testExprModel,
    files: {
      log: {
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { "_swamp.anything": "x" },
      },
    },
  };
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
  });

  const { results } = await service.validateModel(definition, modelDef);

  const tags = results.find((r) => r.name === "Tags");
  assertEquals(tags?.passed, false);
  assertStringIncludes(
    tags?.error ?? "",
    `from the default tags of file spec 'log' in behavior type '${testExprModel.type.normalized}'`,
  );
  assertStringIncludes(
    tags?.error ?? "",
    "The behavior type's author must remove it.",
  );
});

Deno.test("validateModel: Tags passes for lookalike keys", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { message: "hello" },
    tags: { "swamp.sensitiveFields": "a", "_SWAMP.x": "b" },
  });

  const { results } = await service.validateModel(definition, testExprModel);

  assertEquals(results.find((r) => r.name === "Tags")?.passed, true);
});

// ---------- Typed secrets (3.5): Secret usage and check delivery ----------

const secretUsageModel: ModelDefinition = {
  type: ModelType.create("test/secret-usage"),
  version: "2026.02.09.1",
  globalArguments: z.object({ token: z.string() }),
  methods: {
    create: {
      description: "Create",
      arguments: z.object({ cmd: z.string() }),
      execute: () => Promise.resolve({}),
    },
  },
};

Deno.test("validateModel: Secret usage reports each finding of the diagnostics hook with its location and code, over every authored expression", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "typed-def",
    globalArguments: { token: "${{ vault.get('v', 'k') == 'x' }}" },
    methods: {
      create: { arguments: { cmd: "echo ${{ 'a' + vault.get('v', 'k') }}" } },
    },
  });
  const seen: string[] = [];
  const { results } = await service.validateModel(
    definition,
    secretUsageModel,
    undefined,
    undefined,
    {
      diagnoseSecretMisuse: (expression, location) => {
        seen.push(`${location}|${expression}`);
        return expression.includes("==")
          ? [{
            location: `${location}:1:1`,
            code: "secret_operation_unsupported",
            reason: "no such overload: Secret == string",
          }]
          : [];
      },
    },
  );
  assertEquals(seen, [
    "globalArguments.token|vault.get('v', 'k') == 'x'",
    "methods.create.arguments.cmd|'a' + vault.get('v', 'k')",
  ]);
  const usage = results.find((r) => r.name === "Secret usage");
  assertEquals(usage?.passed, false);
  assertStringIncludes(
    usage?.error ?? "",
    'secret_operation_unsupported at "globalArguments.token:1:1": no such overload: Secret == string',
  );
  assertEquals(usage?.expressionErrors?.length, 1);
  assertEquals(
    usage?.expressionErrors?.[0].expression,
    "${{ vault.get('v', 'k') == 'x' }}",
  );
});

Deno.test("validateModel: Secret usage passes with no finding, and does not run without the hook", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "typed-def",
    globalArguments: { token: "${{ vault.get('v', 'k') + 'x' }}" },
  });
  const typed = await service.validateModel(
    definition,
    secretUsageModel,
    undefined,
    undefined,
    { diagnoseSecretMisuse: () => [] },
  );
  assertEquals(
    typed.results.find((r) => r.name === "Secret usage")?.passed,
    true,
  );
  const untyped = await service.validateModel(definition, secretUsageModel);
  assertEquals(
    untyped.results.some((r) => r.name === "Secret usage"),
    false,
  );
});

Deno.test("validateModel: checks receive what deliverCheckArguments delivers: values in globalArgs, sentinels in unresolvedMethodArgs, and the loaded bag", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { password: '${{ vault.get("my-vault", "MY_SECRET") }}' },
  });
  const bag = { resolvesAny: true } as unknown as MethodContext["vaultSecrets"];
  let captured: MethodContext | undefined;
  let resolverCalls = 0;
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
        description: "Captures the context for assertion",
        execute: (ctx) => {
          captured = ctx;
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
  const delivered: string[] = [];
  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      method: "create",
      deliverCheckArguments: (stored, methodName) => {
        delivered.push(`${stored.name}:${methodName}`);
        return Promise.resolve({
          globalArgs: { password: "the-value" },
          unresolvedMethodArgs: { password: "__SWAMP_VSEC_sentinel__" },
          vaultSecrets: bag,
        });
      },
      resolveRuntimeExpressions: () => {
        resolverCalls++;
        return Promise.reject(new Error("not consulted"));
      },
    }),
  );
  assertEquals(delivered, ["test-definition:create"]);
  assertEquals(resolverCalls, 0);
  assertEquals(
    results.find((r) => r.name === "Check: capture-args")?.passed,
    true,
  );
  assertEquals(captured?.globalArgs.password, "the-value");
  assertEquals(captured?.unresolvedMethodArgs, {
    password: "__SWAMP_VSEC_sentinel__",
  });
  assertEquals(captured?.vaultSecrets, bag);
});

Deno.test("validateModel: a refused or failed delivery fails every applicable check with its error and runs none", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { password: '${{ vault.get("my-vault", "MY_SECRET") }}' },
    checks: { skip: ["skipped"] },
  });
  let executed = 0;
  const check = {
    description: "Never runs",
    execute: () => {
      executed++;
      return Promise.resolve({ pass: true });
    },
  };
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
      first: check,
      second: check,
      skipped: check,
      other: { ...check, appliesTo: ["delete"] },
    },
  };
  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      method: "create",
      deliverCheckArguments: () =>
        Promise.reject(
          new Error(
            "A secret refuses the destination 'global argument password' (secret_destination_refused)",
          ),
        ),
    }),
  );
  const checks = results.filter((r) => r.name.startsWith("Check:"));
  assertEquals(checks.map((r) => r.name).sort(), [
    "Check: first",
    "Check: second",
  ]);
  for (const result of checks) {
    assertEquals(result.passed, false);
    assertStringIncludes(result.error ?? "", "secret_destination_refused");
  }
  assertEquals(executed, 0);
});

Deno.test("validateModel: with no applicable check nothing is delivered", async () => {
  const service = new DefaultModelValidationService();
  const definition = Definition.create({
    name: "test-definition",
    globalArguments: { password: '${{ vault.get("my-vault", "MY_SECRET") }}' },
    checks: { skip: ["skipped"] },
  });
  let deliveries = 0;
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
      skipped: {
        description: "Skipped by the definition",
        execute: () => Promise.resolve({ pass: true }),
      },
      other: {
        description: "Applies to another method",
        appliesTo: ["delete"],
        execute: () => Promise.resolve({ pass: true }),
      },
    },
  };
  const { results } = await service.validateModel(
    definition,
    model,
    undefined,
    createCheckContext({
      method: "create",
      deliverCheckArguments: () => {
        deliveries++;
        return Promise.reject(new Error("never asked"));
      },
    }),
  );
  assertEquals(deliveries, 0);
  assertEquals(results.some((r) => r.name.startsWith("Check:")), false);
});

// Validation scoped to a method (swamp-club#3726)

/** A model type with three methods, for validation scoped to one of them. */
const threeMethodModel: ModelDefinition = {
  type: ModelType.create("test/method-scope"),
  version: "2026.02.09.1",
  globalArguments: z.object({ message: z.string() }),
  methods: Object.fromEntries(
    ["run", "other", "broken"].map((name) => [name, {
      description: name,
      arguments: z.object({ message: z.string() }),
      execute: () => Promise.resolve({}),
    }]),
  ),
};

/**
 * A definition whose `run` method is sound while `other` holds an
 * unresolvable model reference, a malformed swamp expression and another
 * service's template text, `broken` an argument its schema refuses, and
 * `extra`, a method the type does not define, another unresolvable
 * reference.
 */
const scopedDefinitionProps = (
  run: Record<string, unknown> = { message: "hello" },
  globalArguments: Record<string, unknown> = { message: "hello" },
) => ({
  name: "scoped-def",
  globalArguments,
  methods: {
    run: { arguments: run },
    other: {
      arguments: {
        message:
          "${{ model.missing-model.resource.x.y.attributes.z }} {{ self.name }} {{host.name}}",
      },
    },
    broken: { arguments: { message: 42 } },
    extra: { arguments: { message: "${{ model.also-missing.resource.x }}" } },
  },
});

async function validateScoped(
  props: Parameters<typeof Definition.create>[0],
  method?: string,
) {
  const definition = Definition.create(props);
  const { results, warnings } = await new DefaultModelValidationService()
    .validateModel(
      definition,
      threeMethodModel,
      createMockDefinitionRepo([
        { name: props.name, type: "test/method-scope", definition },
      ]),
      undefined,
      { method },
    );
  return {
    result: (name: string) => results.find((r) => r.name === name),
    warnings,
  };
}

Deno.test("validateModel: scoped to a method, another method's Expression paths, Method arguments and template text pass (swamp-club#3726)", async () => {
  const { result, warnings } = await validateScoped(
    scopedDefinitionProps(),
    "run",
  );
  assertEquals(result("Expression paths")?.passed, true);
  assertEquals(result("Method arguments")?.passed, true);
  assertEquals(
    warnings.some((w) => w.name === FOREIGN_TEMPLATE_WARNING_NAME),
    false,
  );
});

Deno.test("validateModel: unscoped, the same definition fails on every method", async () => {
  const { result, warnings } = await validateScoped(scopedDefinitionProps());
  const paths = result("Expression paths");
  assertEquals(paths?.passed, false);
  assertStringIncludes(paths?.error ?? "", "missing-model");
  assertStringIncludes(paths?.error ?? "", "also-missing");
  assertStringIncludes(paths?.error ?? "", "{{ self.name }}");
  assertEquals(result("Method arguments")?.passed, false);
  assertStringIncludes(result("Method arguments")?.error ?? "", "broken");
  assertEquals(
    warnings.some((w) => w.name === FOREIGN_TEMPLATE_WARNING_NAME),
    true,
  );
});

Deno.test("validateModel: scoped to a method, its own problems and the global arguments' still fail", async () => {
  const ownReference = await validateScoped(
    scopedDefinitionProps({
      message: "${{ model.run-missing.resource.x.y.attributes.z }}",
    }),
    "run",
  );
  assertEquals(ownReference.result("Expression paths")?.passed, false);
  assertStringIncludes(
    ownReference.result("Expression paths")?.error ?? "",
    "run-missing",
  );

  const ownArgument = await validateScoped(
    scopedDefinitionProps({ message: 42 }),
    "run",
  );
  assertEquals(ownArgument.result("Method arguments")?.passed, false);

  const globalReference = await validateScoped(
    scopedDefinitionProps(undefined, {
      message: "${{ model.global-missing.resource.x.y.attributes.z }}",
    }),
    "run",
  );
  assertEquals(globalReference.result("Expression paths")?.passed, false);
  assertStringIncludes(
    globalReference.result("Expression paths")?.error ?? "",
    "global-missing",
  );
});

Deno.test("validateModel: scoped to a method the type does not define, the whole definition is validated", async () => {
  for (const method of ["bogus", "extra"]) {
    const { result } = await validateScoped(scopedDefinitionProps(), method);
    assertEquals(result("Expression paths")?.passed, false, method);
    assertEquals(result("Method arguments")?.passed, false, method);
  }
});

Deno.test("validateModel: scoped to a method, Secret usage diagnoses the global arguments and that method only", async () => {
  const definition = Definition.create({
    name: "typed-def",
    globalArguments: { token: "${{ vault.get('v', 'k') }}" },
    methods: {
      create: { arguments: { cmd: "echo ${{ vault.get('v', 'k') }}" } },
      delete: { arguments: { cmd: "echo ${{ vault.get('v', 'k') == 'x' }}" } },
    },
  });
  const model: ModelDefinition = {
    ...secretUsageModel,
    methods: {
      create: secretUsageModel.methods.create,
      delete: secretUsageModel.methods.create,
    },
  };
  const seen: string[] = [];
  const { results } = await new DefaultModelValidationService().validateModel(
    definition,
    model,
    undefined,
    undefined,
    {
      method: "create",
      diagnoseSecretMisuse: (_expression, location) => {
        seen.push(location);
        return [];
      },
    },
  );
  assertEquals(seen, [
    "globalArguments.token",
    "methods.create.arguments.cmd",
  ]);
  assertEquals(results.find((r) => r.name === "Secret usage")?.passed, true);
});

Deno.test("validateModel: a refinement that echoes a sensitive argument into an issue beside it is described in Zod's words, for global and method arguments alike (swamp-club#3681)", async () => {
  const service = new DefaultModelValidationService();
  const sensitive = z.string().meta({ sensitive: true });
  const echoing = z.object({
    apiKey: sensitive,
    confirm: z.string().optional(),
  }).superRefine((v, ctx) => {
    ctx.addIssue({
      code: "custom",
      path: ["confirm"],
      message: `confirm must equal ${v.apiKey}`,
    });
  });
  const model: ModelDefinition = {
    ...testExprModel,
    globalArguments: echoing,
    methods: {
      write: { ...testExprModel.methods.write, arguments: echoing },
    },
  };
  const results = (await service.validateModel(
    Definition.create({
      name: "test-definition",
      globalArguments: { apiKey: "hunter2-long", confirm: "x" },
      methods: {
        write: { arguments: { apiKey: "hunter2-long", confirm: "x" } },
      },
    }),
    model,
  )).results;
  for (const name of ["Global arguments", "Method arguments"]) {
    const result = results.find((r) => r.name === name);
    assertEquals(result?.passed, false, name);
    assertStringIncludes(
      result?.error ?? "",
      'Invalid input at "confirm"',
      name,
    );
    assertEquals(result?.error?.includes("hunter2-long"), false, name);
  }
});

Deno.test("validateModel: a schema that throws while parsing a sensitive argument has its message withheld, for global and method arguments alike, and one marking nothing has its throw reported as it is (swamp-club#3681)", async () => {
  const service = new DefaultModelValidationService();
  const throwing = z.object({
    apiKey: z.string().meta({ sensitive: true }).transform((text): string => {
      throw new TypeError(`normalized key rejected: ${text.toUpperCase()}`);
    }),
  });
  const model: ModelDefinition = {
    ...testExprModel,
    globalArguments: throwing,
    methods: {
      write: { ...testExprModel.methods.write, arguments: throwing },
    },
  };
  const results = (await service.validateModel(
    Definition.create({
      name: "test-definition",
      globalArguments: { apiKey: "hunter2-long" },
      methods: { write: { arguments: { apiKey: "hunter2-long" } } },
    }),
    model,
  )).results;
  for (const name of ["Global arguments", "Method arguments"]) {
    const result = results.find((r) => r.name === name);
    assertEquals(result?.passed, false, name);
    assertStringIncludes(
      result?.error ?? "",
      "the schema threw TypeError while parsing them, and its message is withheld",
      name,
    );
    assertEquals(result?.error?.includes("HUNTER2-LONG"), false, name);
  }

  const plain: ModelDefinition = {
    ...testExprModel,
    globalArguments: z.object({
      key: z.string().transform((text): string => {
        throw new TypeError(`key rejected: ${text}`);
      }),
    }),
  };
  const reported = (await service.validateModel(
    Definition.create({
      name: "test-definition",
      globalArguments: { key: "plain-value" },
      methods: { write: { arguments: { message: "hello" } } },
    }),
    plain,
  )).results.find((r) => r.name === "Global arguments");
  assertEquals(reported?.passed, false);
  assertStringIncludes(reported?.error ?? "", "key rejected: plain-value");
});

/**
 * A type whose global arguments carry a default, a coerced number and a
 * transform, with a check that records what it receives.
 */
function parsingModel(
  seen: { globalArgs?: Record<string, unknown>; unresolved?: unknown },
  overrides: Partial<ModelDefinition> = {},
): ModelDefinition {
  return {
    type: ModelType.create("test/parsed-check-args"),
    version: "2026.10.24.1",
    globalArguments: z.object({
      steamcmd: z.string().default("/opt/steamcmd/steamcmd.sh"),
      port: z.number().optional(),
      region: z.string().transform((s) => s.toUpperCase()).optional(),
    }),
    methods: {
      upload: {
        description: "Upload",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
    checks: {
      "needs-steamcmd": {
        description: "Reads a defaulted global argument",
        appliesTo: ["upload"],
        execute: (context) => {
          seen.globalArgs = context.globalArgs;
          seen.unresolved = context.unresolvedMethodArgs;
          return Promise.resolve({
            pass: (context.globalArgs.steamcmd as string).includes("steamcmd"),
          });
        },
      },
    },
    ...overrides,
  };
}

function checkResult(results: ValidationResult[], name: string) {
  return results.find((r) => r.name === `Check: ${name}`);
}

Deno.test("validateModel: pre-flight checks receive global argument defaults, as the run gives them (swamp-club#3851)", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  const { results } = await new DefaultModelValidationService().validateModel(
    Definition.create({ name: "p1" }),
    parsingModel(seen),
    undefined,
    createCheckContext(),
  );

  assertEquals(checkResult(results, "needs-steamcmd")?.passed, true);
  assertEquals(seen.globalArgs, { steamcmd: "/opt/steamcmd/steamcmd.sh" });
});

Deno.test("validateModel: pre-flight checks receive coerced and transformed global arguments", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  await new DefaultModelValidationService().validateModel(
    Definition.create({
      name: "p1",
      globalArguments: { port: "8080", region: "eu-west-1" },
    }),
    parsingModel(seen),
    undefined,
    createCheckContext(),
  );

  assertEquals(seen.globalArgs, {
    steamcmd: "/opt/steamcmd/steamcmd.sh",
    port: 8080,
    region: "EU-WEST-1",
  });
});

Deno.test("validateModel: a global argument holding an expression reaches the checks as written, not as its default", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  const expression = "${{ inputs.steamcmd }}";
  await new DefaultModelValidationService().validateModel(
    Definition.create({
      name: "p1",
      globalArguments: { steamcmd: expression, port: "22" },
    }),
    parsingModel(seen),
    undefined,
    createCheckContext(),
  );

  assertEquals(seen.globalArgs, { steamcmd: expression, port: 22 });
});

Deno.test("validateModel: a typed delivery's global arguments are parsed before the checks receive them", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  const { results } = await new DefaultModelValidationService().validateModel(
    Definition.create({ name: "p1" }),
    parsingModel(seen),
    undefined,
    createCheckContext({
      deliverCheckArguments: () =>
        Promise.resolve({
          globalArgs: { region: "us-east-1" },
          unresolvedMethodArgs: {},
        }),
    }),
  );

  assertEquals(checkResult(results, "needs-steamcmd")?.passed, true);
  assertEquals(seen.globalArgs, {
    steamcmd: "/opt/steamcmd/steamcmd.sh",
    region: "US-EAST-1",
  });
});

Deno.test("validateModel: global arguments the schema refuses reach the checks as stored", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  const { results } = await new DefaultModelValidationService().validateModel(
    Definition.create({ name: "p1", globalArguments: { port: "not-a-port" } }),
    parsingModel(seen),
    undefined,
    createCheckContext(),
  );

  assertEquals(
    results.find((r) => r.name === "Global arguments")?.passed,
    false,
  );
  assertEquals(seen.globalArgs, { port: "not-a-port" });
});

Deno.test("validateModel: unresolvedMethodArgs carries global argument defaults", async () => {
  const seen: { unresolved?: unknown } = {};
  await new DefaultModelValidationService().validateModel(
    Definition.create({ name: "p1" }),
    parsingModel(seen),
    undefined,
    createCheckContext({ method: "upload" }),
  );

  assertEquals(seen.unresolved, { steamcmd: "/opt/steamcmd/steamcmd.sh" });
});

Deno.test("validateModel: pre-flight checks receive defaults of the upgraded global arguments", async () => {
  const seen: { globalArgs?: Record<string, unknown> } = {};
  const model = parsingModel(seen, {
    version: "2026.10.24.2",
    upgrades: [{
      toVersion: "2026.10.24.2",
      description: "Rename zone to region",
      upgradeAttributes: (old) => {
        const { zone, ...rest } = old;
        return { ...rest, region: zone };
      },
    }],
  });
  await new DefaultModelValidationService().validateModel(
    Definition.create({
      name: "p1",
      typeVersion: "2026.10.24.1",
      globalArguments: { zone: "ap-south-1" },
    }),
    model,
    undefined,
    createCheckContext(),
  );

  assertEquals(seen.globalArgs, {
    steamcmd: "/opt/steamcmd/steamcmd.sh",
    region: "AP-SOUTH-1",
  });
});
