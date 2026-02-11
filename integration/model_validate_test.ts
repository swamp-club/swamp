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
 * Integration tests for the model validate command.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ECHO_MODEL_TYPE } from "../src/domain/models/echo/echo_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-validate-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

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
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI: model validate passes for valid echo model definition", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model definition
    const definition = Definition.create({
      name: "valid-echo-definition",
      methods: { write: { arguments: { message: "Hello, world!" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "valid-echo-definition",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Parse and verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "valid-echo-definition");
    assertEquals(output.type, "swamp/echo");
    assertEquals(output.passed, true);
    assertEquals(output.validations.length, 4); // Definition schema + Global arguments + Method arguments + Expression paths
    assertEquals(
      output.validations.every((v: { passed: boolean }) => v.passed),
      true,
    );
  });
});

Deno.test("CLI: model validate passes for valid echo model definition", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model definition
    const definition = Definition.create({
      name: "echo-with-data",
      methods: { write: { arguments: { message: "Hello, world!" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "echo-with-data",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Parse and verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.passed, true);
    // Echo model validates: Definition schema, Global arguments, Method arguments, Expression paths
    assertEquals(output.validations.length, 4);
  });
});

Deno.test("CLI: model validate fails for invalid definition attributes", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create an echo model definition with invalid method arguments (missing message)
    const definition = Definition.create({
      name: "invalid-echo-definition",
      methods: { write: { arguments: { wrongField: "oops" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "invalid-echo-definition",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      1,
      `Command should fail with exit code 1`,
    );

    // Parse and verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.passed, false);

    // Find the failing validation
    const failedValidation = output.validations.find(
      (v: { passed: boolean }) => !v.passed,
    );
    assertEquals(failedValidation.name, "Method arguments");
    assertEquals(typeof failedValidation.error, "string");
  });
});

// Note: Test for invalid resource attributes was removed because
// the echo model now uses data artifacts instead of resources.
// Resource validation tests should use models that produce resources (like AWS models).

Deno.test("CLI: model validate can look up by UUID", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model definition
    const definition = Definition.create({
      name: "uuid-lookup-test",
      methods: { write: { arguments: { message: "Hello" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Run the validate command using the UUID
    const result = await runCliCommand(
      [
        "model",
        "validate",
        definition.id,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify it found the right model
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelId, definition.id);
    assertEquals(output.modelName, "uuid-lookup-test");
  });
});

Deno.test("CLI: model validate errors for non-existent model", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Run the validate command for a model that doesn't exist
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "non-existent-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code !== 0,
      true,
      `Command should fail`,
    );
    assertStringIncludes(result.stderr, "Model not found");
  });
});

Deno.test("CLI: model validate with --json outputs JSON", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model definition
    const definition = Definition.create({
      name: "interactive-test",
      methods: { write: { arguments: { message: "Hello" } } },
    });
    await definitionRepo.save(modelType, definition);

    const result = await runCliCommand(
      [
        "model",
        "validate",
        "interactive-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify JSON output is produced due to auto-detection
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "interactive-test");
    assertEquals(output.type, "swamp/echo");
    assertEquals(output.passed, true);
  });
});

// Validate-all tests (no argument)

Deno.test("CLI: model validate with no args validates all models", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple valid echo model definitions
    const definition1 = Definition.create({
      name: "all-test-1",
      methods: { write: { arguments: { message: "Hello 1" } } },
    });
    const definition2 = Definition.create({
      name: "all-test-2",
      methods: { write: { arguments: { message: "Hello 2" } } },
    });
    await definitionRepo.save(modelType, definition1);
    await definitionRepo.save(modelType, definition2);

    // Run the validate command without specifying a model
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Parse and verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.models.length, 2);
    assertEquals(output.totalPassed, 2);
    assertEquals(output.totalFailed, 0);
    assertEquals(output.passed, true);

    // Verify both models are included
    const modelNames = output.models.map((m: { modelName: string }) =>
      m.modelName
    );
    assertEquals(modelNames.includes("all-test-1"), true);
    assertEquals(modelNames.includes("all-test-2"), true);
  });
});

Deno.test("CLI: model validate with no args exits 1 when any model fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create one valid and one invalid model
    const validDefinition = Definition.create({
      name: "valid-model",
      methods: { write: { arguments: { message: "Hello" } } },
    });
    const invalidDefinition = Definition.create({
      name: "invalid-model",
      methods: { write: { arguments: { wrongField: "oops" } } },
    });
    await definitionRepo.save(modelType, validDefinition);
    await definitionRepo.save(modelType, invalidDefinition);

    // Run the validate command without specifying a model
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      1,
      `Command should fail with exit code 1`,
    );

    // Parse and verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.models.length, 2);
    assertEquals(output.totalPassed, 1);
    assertEquals(output.totalFailed, 1);
    assertEquals(output.passed, false);
  });
});

Deno.test("CLI: model validate with no args errors when no models found", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Run the validate command on an empty repo
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code !== 0,
      true,
      `Command should fail`,
    );
    assertStringIncludes(result.stderr, "No models found");
  });
});

Deno.test("CLI: model validate with no args and --json outputs JSON", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple valid echo model definitions
    const definition1 = Definition.create({
      name: "interactive-all-1",
      methods: { write: { arguments: { message: "Hello 1" } } },
    });
    const definition2 = Definition.create({
      name: "interactive-all-2",
      methods: { write: { arguments: { message: "Hello 2" } } },
    });
    await definitionRepo.save(modelType, definition1);
    await definitionRepo.save(modelType, definition2);

    const result = await runCliCommand(
      [
        "model",
        "validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify JSON output is produced due to auto-detection
    const output = JSON.parse(result.stdout);
    assertEquals(output.totalPassed, 2);
    assertEquals(output.totalFailed, 0);
    assertEquals(output.passed, true);
    assertEquals(output.models.length, 2);
  });
});
