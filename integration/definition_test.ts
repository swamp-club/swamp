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

/**
 * Integration tests for the Definition entity with CEL expression evaluation.
 *
 * Tests the full flow:
 * 1. Create definitions with CEL expressions
 * 2. Evaluate expressions
 * 3. Verify evaluated definitions are correct
 */

import { assertEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-definition-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Definition: create and save definition with static attributes", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition with static attributes
    const definition = Definition.create({
      name: "my-echo",
      version: 1,
      tags: { env: "test" },
      globalArguments: {
        message: "Hello, World!",
        count: 42,
      },
    });

    // Save the definition
    await definitionRepo.save(modelType, definition);

    // Verify the file was created at the correct path
    const path = definitionRepo.getPath(modelType, definition.id);
    assertEquals(existsSync(path), true, "Definition file should exist");

    // Verify the content
    const content = await Deno.readTextFile(path);
    const data = parseYaml(content) as Record<string, unknown>;
    assertEquals(data.type, "swamp/echo");
    assertEquals(data.typeVersion, undefined);
    assertEquals(data.name, "my-echo");
    assertEquals(data.version, 1);
    assertEquals((data.tags as Record<string, string>).env, "test");
    assertEquals(
      (data.globalArguments as Record<string, unknown>).message,
      "Hello, World!",
    );
  });
});

Deno.test("Definition: definition with CEL expression is preserved on save", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition with CEL expressions
    const definition = Definition.create({
      name: "my-echo-with-expression",
      globalArguments: {
        message: "${{ model.other.input.globalArguments.greeting }}",
        computed: "${{ self.name + '-suffix' }}",
      },
    });

    // Save the definition
    await definitionRepo.save(modelType, definition);

    // Load it back
    const loaded = await definitionRepo.findById(modelType, definition.id);
    assertEquals(loaded !== null, true, "Definition should be loaded");

    // Verify CEL expressions are preserved (not evaluated)
    assertEquals(
      loaded!.globalArguments.message,
      "${{ model.other.input.globalArguments.greeting }}",
    );
    assertEquals(
      loaded!.globalArguments.computed,
      "${{ self.name + '-suffix' }}",
    );
  });
});

Deno.test("Definition: evaluate definition with CEL expressions referencing self", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition with self-referencing CEL expression
    const definition = Definition.create({
      name: "self-reference-test",
      version: 1,
      tags: { env: "test" },
      globalArguments: {
        selfName: "${{ self.name }}",
        tagValue: "${{ self.tags.env }}",
      },
    });

    await definitionRepo.save(modelType, definition);

    // Create the expression evaluation service
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    // Evaluate the definition
    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(
      result.definition.globalArguments.selfName,
      "self-reference-test",
    );
    assertEquals(result.definition.globalArguments.tagValue, "test");
  });
});

Deno.test("Definition: evaluate definition with CEL expressions referencing other models", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a source definition that will be referenced
    // Note: Using underscore instead of hyphen because CEL interprets hyphens as subtraction
    const sourceDefinition = Definition.create({
      name: "source_model",
      version: 1,
      tags: {},
      globalArguments: {
        greeting: "Hello from source!",
        count: 10,
      },
    });
    await definitionRepo.save(modelType, sourceDefinition);

    // Create a definition that references the other model
    const definition = Definition.create({
      name: "referencing_definition",
      globalArguments: {
        message:
          "${{ model.source_model.definition.globalArguments.greeting }}",
        doubled:
          "${{ model.source_model.definition.globalArguments.count * 2 }}",
      },
    });
    await definitionRepo.save(modelType, definition);

    // Create the expression evaluation service
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    // Evaluate the definition
    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(
      result.definition.globalArguments.message,
      "Hello from source!",
    );
    assertEquals(result.definition.globalArguments.doubled, 20);
  });
});

Deno.test("Definition: evaluate definition with inputs parameter", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition with inputs schema and expression
    const definition = Definition.create({
      name: "parameterized-definition",
      globalArguments: {
        message: "${{ inputs.greeting }}",
        fullMessage: '${{ inputs.greeting + " " + inputs.name + "!" }}',
      },
      inputs: {
        type: "object",
        properties: {
          greeting: { type: "string", description: "A greeting" },
          name: { type: "string", description: "A name" },
        },
        required: ["greeting", "name"],
      },
    });
    await definitionRepo.save(modelType, definition);

    // Create the expression evaluation service
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    // Evaluate the definition with input values
    const inputValues = {
      greeting: "Hello",
      name: "World",
    };

    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
      inputValues,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.message, "Hello");
    assertEquals(result.definition.globalArguments.fullMessage, "Hello World!");
  });
});

Deno.test("Definition: save and load evaluated definitions", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const evaluatedRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition with CEL expression
    const definition = Definition.create({
      name: "to-be-evaluated",
      globalArguments: {
        computed: "${{ 1 + 2 + 3 }}",
      },
    });
    await definitionRepo.save(modelType, definition);

    // Evaluate the definition
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
    );

    // Save the evaluated definition
    await evaluatedRepo.save(modelType, result.definition);

    // Load the evaluated definition
    const loaded = await evaluatedRepo.findById(modelType, definition.id);
    assertEquals(loaded !== null, true, "Evaluated definition should exist");
    assertEquals(loaded!.globalArguments.computed, 6);

    // Verify the original is unchanged
    const original = await definitionRepo.findById(modelType, definition.id);
    assertEquals(
      original!.globalArguments.computed,
      "${{ 1 + 2 + 3 }}",
      "Original should preserve expression",
    );
  });
});

Deno.test("Definition: definition without expressions returns hadExpressions=false", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create a definition without any expressions
    const definition = Definition.create({
      name: "static-only",
      globalArguments: {
        message: "Just a static string",
        count: 42,
      },
    });
    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
    );

    assertEquals(result.hadExpressions, false);
    assertEquals(
      result.definition.globalArguments.message,
      "Just a static string",
    );
  });
});

Deno.test("Definition: findByName works correctly", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    // Create multiple definitions
    const def1 = Definition.create({
      name: "first-def",
      globalArguments: { a: 1 },
    });
    const def2 = Definition.create({
      name: "second-def",
      globalArguments: { b: 2 },
    });

    await definitionRepo.save(modelType, def1);
    await definitionRepo.save(modelType, def2);

    // Find by name
    const found = await definitionRepo.findByName(modelType, "second-def");
    assertEquals(found !== null, true);
    assertEquals(found!.name, "second-def");
    assertEquals(found!.globalArguments.b, 2);

    // Find non-existent
    const notFound = await definitionRepo.findByName(modelType, "no-such-def");
    assertEquals(notFound, null);
  });
});

Deno.test("Definition: findByNameGlobal works across types", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type1 = ModelType.create("swamp/echo");
    const type2 = ModelType.create("aws/ec2/vpc");

    // Create definitions in different types
    const def1 = Definition.create({
      name: "unique-name",
      globalArguments: { x: 1 },
    });
    const def2 = Definition.create({
      name: "another-name",
      globalArguments: { y: 2 },
    });

    await definitionRepo.save(type1, def1);
    await definitionRepo.save(type2, def2);

    // Find globally
    const found = await definitionRepo.findByNameGlobal("another-name");
    assertEquals(found !== null, true);
    assertEquals(found!.definition.name, "another-name");
    assertEquals(found!.type.normalized, "aws/ec2/vpc");
  });
});

Deno.test("Definition: hasDefinitionExpressions detects expressions correctly", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-definition-test-" });
  try {
    const definitionRepo = new YamlDefinitionRepository(dir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      dir,
    );

    const withExpr = Definition.create({
      name: "with-expr",
      globalArguments: { value: "${{ 1 + 1 }}" },
    });

    const withoutExpr = Definition.create({
      name: "without-expr",
      globalArguments: { value: "static" },
    });

    assertEquals(evalService.hasDefinitionExpressions(withExpr), true);
    assertEquals(evalService.hasDefinitionExpressions(withoutExpr), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
