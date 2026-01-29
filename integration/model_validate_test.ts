/**
 * Integration tests for the model validate command.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ModelInput } from "../src/domain/models/model_input.ts";
import { ModelResource } from "../src/domain/models/model_resource.ts";
import { YamlInputRepository } from "../src/infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../src/infrastructure/persistence/yaml_resource_repository.ts";
import { ECHO_MODEL_TYPE } from "../src/domain/models/echo/echo_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-validate-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("CLI: model validate passes for valid echo model input", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model input
    const input = ModelInput.create({
      name: "valid-echo-input",
      attributes: { message: "Hello, world!" },
    });
    await inputRepo.save(modelType, input);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "valid-echo-input",
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
    assertEquals(output.modelName, "valid-echo-input");
    assertEquals(output.type, "swamp/echo");
    assertEquals(output.passed, true);
    assertEquals(output.validations.length, 2); // Input schema + Input attributes
    assertEquals(
      output.validations.every((v: { passed: boolean }) => v.passed),
      true,
    );
  });
});

Deno.test("CLI: model validate passes for valid echo model with resource", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model input
    const input = ModelInput.create({
      name: "echo-with-resource",
      attributes: { message: "Hello, world!" },
    });
    await inputRepo.save(modelType, input);

    // Create a valid resource
    const resource = ModelResource.create({
      inputId: input.id,
      attributes: {
        message: "Hello, world!",
        timestamp: new Date().toISOString(),
      },
    });
    await resourceRepo.save(modelType, resource);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "echo-with-resource",
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
    assertEquals(output.validations.length, 4); // Input + Resource validations
  });
});

Deno.test("CLI: model validate fails for invalid input attributes", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create an echo model input with invalid attributes (missing message)
    const input = ModelInput.create({
      name: "invalid-echo-input",
      attributes: { wrongField: "oops" },
    });
    await inputRepo.save(modelType, input);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "invalid-echo-input",
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
    assertEquals(failedValidation.name, "Input attributes");
    assertEquals(typeof failedValidation.error, "string");
  });
});

Deno.test("CLI: model validate fails for invalid resource attributes", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model input
    const input = ModelInput.create({
      name: "echo-invalid-resource",
      attributes: { message: "Hello" },
    });
    await inputRepo.save(modelType, input);

    // Create an invalid resource (missing timestamp)
    const resource = ModelResource.create({
      inputId: input.id,
      attributes: {
        message: "Hello",
        // Missing required timestamp
      },
    });
    await resourceRepo.save(modelType, resource);

    // Run the validate command
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "echo-invalid-resource",
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

    // Find the failing resource validation
    const failedValidation = output.validations.find(
      (v: { name: string; passed: boolean }) =>
        v.name === "Resource attributes" && !v.passed,
    );
    assertEquals(failedValidation !== undefined, true);
  });
});

Deno.test("CLI: model validate can look up by UUID", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model input
    const input = ModelInput.create({
      name: "uuid-lookup-test",
      attributes: { message: "Hello" },
    });
    await inputRepo.save(modelType, input);

    // Run the validate command using the UUID
    const result = await runCliCommand(
      [
        "model",
        "validate",
        input.id,
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
    assertEquals(output.modelId, input.id);
    assertEquals(output.modelName, "uuid-lookup-test");
  });
});

Deno.test("CLI: model validate errors for non-existent model", async () => {
  await withTempDir(async (repoDir) => {
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

Deno.test("CLI: model validate interactive output shows checkmarks and summary", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create a valid echo model input
    const input = ModelInput.create({
      name: "interactive-test",
      attributes: { message: "Hello" },
    });
    await inputRepo.save(modelType, input);

    // Run without --json to get interactive output
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "interactive-test",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify interactive output contains expected elements
    assertStringIncludes(result.stdout, "interactive-test");
    assertStringIncludes(result.stdout, "swamp/echo");
    assertStringIncludes(result.stdout, "PASSED");
  });
});

// Validate-all tests (no argument)

Deno.test("CLI: model validate with no args validates all models", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple valid echo model inputs
    const input1 = ModelInput.create({
      name: "all-test-1",
      attributes: { message: "Hello 1" },
    });
    const input2 = ModelInput.create({
      name: "all-test-2",
      attributes: { message: "Hello 2" },
    });
    await inputRepo.save(modelType, input1);
    await inputRepo.save(modelType, input2);

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
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create one valid and one invalid model
    const validInput = ModelInput.create({
      name: "valid-model",
      attributes: { message: "Hello" },
    });
    const invalidInput = ModelInput.create({
      name: "invalid-model",
      attributes: { wrongField: "oops" },
    });
    await inputRepo.save(modelType, validInput);
    await inputRepo.save(modelType, invalidInput);

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

Deno.test("CLI: model validate with no args interactive output shows all models", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple valid echo model inputs
    const input1 = ModelInput.create({
      name: "interactive-all-1",
      attributes: { message: "Hello 1" },
    });
    const input2 = ModelInput.create({
      name: "interactive-all-2",
      attributes: { message: "Hello 2" },
    });
    await inputRepo.save(modelType, input1);
    await inputRepo.save(modelType, input2);

    // Run without --json to get interactive output
    const result = await runCliCommand(
      [
        "model",
        "validate",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify interactive output contains expected elements
    assertStringIncludes(result.stdout, "Validating all models...");
    assertStringIncludes(result.stdout, "interactive-all-1");
    assertStringIncludes(result.stdout, "interactive-all-2");
    assertStringIncludes(result.stdout, "2/2 models passed");
    assertStringIncludes(result.stdout, "PASSED");
  });
});
