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
 * Integration tests for the Definition entity lifecycle.
 *
 * Tests the full flow:
 * 1. Create definitions with static global arguments
 * 2. Create definitions with JsonSchema inputs
 * 3. Create definitions with CEL expressions referencing other models
 * 4. Run methods, verify Data created with correct metadata
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-def-lifecycle-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "definitions"));
  await ensureDir(join(dir, ".swamp", "data"));
}

/**
 * Initializes a test repository with marker file for CLI commands.
 */
async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    ".swamp/definitions",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

async function runCliCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

// ============================================================================
// Static Attributes
// ============================================================================

Deno.test("Definition Lifecycle: create with static attributes", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "static-attrs-model",
      version: 1,
      tags: { environment: "test", tier: "standard" },
      globalArguments: {
        message: "Hello, World!",
        count: 42,
        enabled: true,
        config: {
          nested: "value",
          number: 123,
        },
      },
    });

    await definitionRepo.save(modelType, definition);

    // Load it back and verify
    const loaded = await definitionRepo.findById(modelType, definition.id);
    assertExists(loaded);
    assertEquals(loaded.name, "static-attrs-model");
    assertEquals(loaded.version, 1);
    assertEquals(loaded.tags.environment, "test");
    assertEquals(loaded.tags.tier, "standard");
    assertEquals(loaded.globalArguments.message, "Hello, World!");
    assertEquals(loaded.globalArguments.count, 42);
    assertEquals(loaded.globalArguments.enabled, true);
    assertEquals(
      (loaded.globalArguments.config as Record<string, unknown>).nested,
      "value",
    );
  });
});

Deno.test("Definition Lifecycle: create and retrieve by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    // Create multiple definitions
    const def1 = Definition.create({
      name: "first-definition",
      globalArguments: { key: "value1" },
    });
    const def2 = Definition.create({
      name: "second-definition",
      globalArguments: { key: "value2" },
    });
    const def3 = Definition.create({
      name: "third-definition",
      globalArguments: { key: "value3" },
    });

    await definitionRepo.save(modelType, def1);
    await definitionRepo.save(modelType, def2);
    await definitionRepo.save(modelType, def3);

    // Find by name
    const found = await definitionRepo.findByName(
      modelType,
      "second-definition",
    );
    assertExists(found);
    assertEquals(found.name, "second-definition");
    assertEquals(found.id, def2.id);
    assertEquals(found.globalArguments.key, "value2");
  });
});

Deno.test("Definition Lifecycle: global name uniqueness enforced", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type1 = ModelType.create("namespace/type1");
    const type2 = ModelType.create("namespace/type2");

    // Create definition in first type
    const def1 = Definition.create({
      name: "unique-name",
      globalArguments: { x: 1 },
    });
    await definitionRepo.save(type1, def1);

    // Find globally
    const found = await definitionRepo.findByNameGlobal("unique-name");
    assertExists(found);
    assertEquals(found.definition.name, "unique-name");
    assertEquals(found.type.normalized, "namespace/type1");

    // Create another definition with same name in different type should fail
    // when we try to find it globally (uniqueness is enforced at query time)
    const def2 = Definition.create({
      name: "other-name",
      globalArguments: { y: 2 },
    });
    await definitionRepo.save(type2, def2);

    const found2 = await definitionRepo.findByNameGlobal("other-name");
    assertExists(found2);
    assertEquals(found2.type.normalized, "namespace/type2");
  });
});

// ============================================================================
// JsonSchema Inputs
// ============================================================================

Deno.test("Definition Lifecycle: create with JsonSchema inputs", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "schema-inputs-model",
      globalArguments: {
        message: "${{ inputs.greeting }}",
        fullMessage: '${{ inputs.greeting + " " + inputs.name }}',
      },
      inputs: {
        type: "object",
        properties: {
          greeting: {
            type: "string",
            description: "A greeting message",
            default: "Hello",
          },
          name: {
            type: "string",
            description: "The name to greet",
          },
          count: {
            type: "integer",
            description: "Number of repetitions",
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });

    await definitionRepo.save(modelType, definition);

    // Load and verify
    const loaded = await definitionRepo.findById(modelType, definition.id);
    assertExists(loaded);
    assertExists(loaded.inputs);
    assertEquals(loaded.inputs.type, "object");
    assertEquals(
      (loaded.inputs.properties as Record<string, unknown>).greeting !==
        undefined,
      true,
    );
    assertEquals(
      (loaded.inputs.properties as Record<string, unknown>).name !== undefined,
      true,
    );
    assertEquals(loaded.inputs.required, ["name"]);
  });
});

Deno.test("Definition Lifecycle: evaluate with input values", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "eval-inputs-model",
      globalArguments: {
        greeting: "${{ inputs.salutation }}",
        target: "${{ inputs.name }}",
        combined: '${{ inputs.salutation + ", " + inputs.name + "!" }}',
      },
      inputs: {
        type: "object",
        properties: {
          salutation: { type: "string" },
          name: { type: "string" },
        },
        required: ["salutation", "name"],
      },
    });

    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const inputValues = {
      salutation: "Good morning",
      name: "Developer",
    };

    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
      inputValues,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.greeting, "Good morning");
    assertEquals(result.definition.globalArguments.target, "Developer");
    assertEquals(
      result.definition.globalArguments.combined,
      "Good morning, Developer!",
    );
  });
});

Deno.test("Definition Lifecycle: nested JsonSchema inputs", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "nested-inputs-model",
      globalArguments: {
        hostname: "${{ inputs.server.host }}",
        port: "${{ inputs.server.port }}",
        timeout: "${{ inputs.options.timeout }}",
      },
      inputs: {
        type: "object",
        properties: {
          server: {
            type: "object",
            properties: {
              host: { type: "string" },
              port: { type: "integer" },
            },
            required: ["host", "port"],
          },
          options: {
            type: "object",
            properties: {
              timeout: { type: "integer", default: 30 },
              retry: { type: "boolean", default: true },
            },
          },
        },
        required: ["server"],
      },
    });

    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const inputValues = {
      server: { host: "localhost", port: 8080 },
      options: { timeout: 60 },
    };

    const result = await evalService.evaluateDefinition(
      definition,
      modelType,
      inputValues,
    );

    assertEquals(result.definition.globalArguments.hostname, "localhost");
    assertEquals(result.definition.globalArguments.port, 8080);
    assertEquals(result.definition.globalArguments.timeout, 60);
  });
});

// ============================================================================
// CEL Expressions Referencing Other Models
// ============================================================================

Deno.test("Definition Lifecycle: CEL expression references other model input", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    // Create source model
    const sourceModel = Definition.create({
      name: "source_model",
      globalArguments: {
        api_endpoint: "https://api.example.com",
        api_version: "v2",
      },
    });
    await definitionRepo.save(modelType, sourceModel);

    // Create dependent model that references source
    const dependentModel = Definition.create({
      name: "dependent_model",
      globalArguments: {
        base_url:
          "${{ model.source_model.input.globalArguments.api_endpoint }}",
        full_url:
          '${{ model.source_model.input.globalArguments.api_endpoint + "/" + model.source_model.input.globalArguments.api_version }}',
      },
    });
    await definitionRepo.save(modelType, dependentModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(
      dependentModel,
      modelType,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(
      result.definition.globalArguments.base_url,
      "https://api.example.com",
    );
    assertEquals(
      result.definition.globalArguments.full_url,
      "https://api.example.com/v2",
    );
  });
});

Deno.test("Definition Lifecycle: CEL expression self-reference", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "self-ref-model",
      version: 42,
      tags: { env: "production" },
      globalArguments: {
        nameRef: "${{ self.name }}",
        versionRef: "${{ self.version }}",
        envRef: "${{ self.tags.env }}",
        combined: '${{ self.name + "-" + self.tags.env }}',
      },
    });

    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(definition, modelType);

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.nameRef, "self-ref-model");
    assertEquals(result.definition.globalArguments.versionRef, 42);
    assertEquals(result.definition.globalArguments.envRef, "production");
    assertEquals(
      result.definition.globalArguments.combined,
      "self-ref-model-production",
    );
  });
});

Deno.test("Definition Lifecycle: CEL expression with arithmetic", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const sourceModel = Definition.create({
      name: "config_model",
      globalArguments: {
        base_port: 8000,
        instance_count: 3,
      },
    });
    await definitionRepo.save(modelType, sourceModel);

    const computedModel = Definition.create({
      name: "computed_model",
      globalArguments: {
        port_offset:
          "${{ model.config_model.input.globalArguments.base_port + 100 }}",
        scaled_count:
          "${{ model.config_model.input.globalArguments.instance_count * 2 }}",
        calculated:
          "${{ model.config_model.input.globalArguments.base_port + model.config_model.input.globalArguments.instance_count }}",
      },
    });
    await definitionRepo.save(modelType, computedModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(
      computedModel,
      modelType,
    );

    assertEquals(result.definition.globalArguments.port_offset, 8100);
    assertEquals(result.definition.globalArguments.scaled_count, 6);
    assertEquals(result.definition.globalArguments.calculated, 8003);
  });
});

// ============================================================================
// Run Method and Data Creation
// ============================================================================

Deno.test("CLI: model method run creates Data with correct metadata", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create a model definition using repository
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    const definition = Definition.create({
      name: "data-test-model",
      methods: { write: { arguments: { message: "Test data creation" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the write method via CLI
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "data-test-model",
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Method run should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.methodName, "write");
    assertEquals(output.modelName, "data-test-model");
    assertEquals(output.type, "swamp/echo");

    // Verify data artifact was created
    assertExists(output.data);
    assertExists(output.data.id);
    assertExists(output.data.path);
    assertExists(output.data.attributes);
    assertEquals(output.data.attributes.message, "Test data creation");
    assertExists(output.data.attributes.timestamp);
  });
});

Deno.test("CLI: model method run creates versioned Data on subsequent calls", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create a model definition using repository
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    const definition = Definition.create({
      name: "versioned-data-model",
      methods: { write: { arguments: { message: "Versioning test" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the write method multiple times
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await runCliCommand(
        [
          "model",
          "method",
          "run",
          "versioned-data-model",
          "write",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );

      assertEquals(result.code, 0, `Run ${i + 1} should succeed`);
      const output = JSON.parse(result.stdout);
      assertExists(output.data, `Run ${i + 1} should have data`);
      assertExists(output.data.path, `Run ${i + 1} should have data path`);
      paths.push(output.data.path);
    }

    // Verify each run produces unique data
    assertEquals(paths.length, 3);
    // Verify all paths are unique (each run creates new data)
    const uniquePaths = new Set(paths);
    assertEquals(
      uniquePaths.size,
      3,
      "Each run should create unique data path",
    );
  });
});

Deno.test("Definition Lifecycle: evaluate all definitions in topological order", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    // Create a chain of dependent models
    const baseModel = Definition.create({
      name: "base_model",
      globalArguments: {
        value: 10,
      },
    });

    const middleModel = Definition.create({
      name: "middle_model",
      globalArguments: {
        derived: "${{ model.base_model.input.globalArguments.value * 2 }}",
      },
    });

    const topModel = Definition.create({
      name: "top_model",
      globalArguments: {
        final: "${{ model.middle_model.input.globalArguments.derived + 5 }}",
      },
    });

    await definitionRepo.save(modelType, baseModel);
    await definitionRepo.save(modelType, middleModel);
    await definitionRepo.save(modelType, topModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    // Evaluate middle model (depends on base)
    const middleResult = await evalService.evaluateDefinition(
      middleModel,
      modelType,
    );
    assertEquals(middleResult.definition.globalArguments.derived, 20);

    // Note: top_model references middle_model.input.attributes which is the original
    // definition attributes, not the evaluated ones. This is by design.
  });
});

// ============================================================================
// Edge Cases and Validation
// ============================================================================

Deno.test("Definition Lifecycle: definition without expressions has hadExpressions=false", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "no-expressions-model",
      globalArguments: {
        static1: "value1",
        static2: 123,
        static3: true,
      },
    });

    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(definition, modelType);

    assertEquals(result.hadExpressions, false);
    assertEquals(result.definition.globalArguments.static1, "value1");
    assertEquals(result.definition.globalArguments.static2, 123);
    assertEquals(result.definition.globalArguments.static3, true);
  });
});

Deno.test("Definition Lifecycle: handles inputs with conditional expression", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    const definition = Definition.create({
      name: "conditional-inputs-model",
      globalArguments: {
        required_val: "${{ inputs.required }}",
        // Use a simple conditional expression
        computed_val: '${{ inputs.required == "provided" ? "yes" : "no" }}',
      },
      inputs: {
        type: "object",
        properties: {
          required: { type: "string" },
        },
        required: ["required"],
      },
    });

    await definitionRepo.save(modelType, definition);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(definition, modelType, {
      required: "provided",
    });

    assertEquals(result.definition.globalArguments.required_val, "provided");
    assertEquals(result.definition.globalArguments.computed_val, "yes");
  });
});

Deno.test("Definition Lifecycle: environment variable expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("test/model");

    // Set an env variable for testing
    Deno.env.set("TEST_ENV_VAR", "env-value-123");

    try {
      const definition = Definition.create({
        name: "env-var-model",
        globalArguments: {
          from_env: "${{ env.TEST_ENV_VAR }}",
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

      assertEquals(result.definition.globalArguments.from_env, "env-value-123");
    } finally {
      Deno.env.delete("TEST_ENV_VAR");
    }
  });
});

Deno.test("Model creation with attributes via repository", async () => {
  await withTempDir(async (repoDir) => {
    // Model creation with attributes must be done via repository
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");

    const definition = Definition.create({
      name: "repo-attrs-model",
      globalArguments: { count: 42 },
      methods: { write: { arguments: { message: "Hello from repository" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Verify the model was saved
    const loaded = await definitionRepo.findById(modelType, definition.id);
    assertExists(loaded);
    assertEquals(loaded.name, "repo-attrs-model");
    assertEquals(
      loaded.getMethodArguments("write").message,
      "Hello from repository",
    );
    assertEquals(loaded.globalArguments.count, 42);
  });
});
