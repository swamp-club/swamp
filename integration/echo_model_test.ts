/**
 * Integration tests for the Echo model.
 *
 * Tests the full flow:
 * 1. Create an echo model input
 * 2. Execute the write method
 * 3. Verify the resource is created with correct content
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { ModelInput } from "../src/domain/models/model_input.ts";
import { YamlInputRepository } from "../src/infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../src/infrastructure/persistence/yaml_resource_repository.ts";
import {
  ECHO_MODEL_TYPE,
  echoModel,
} from "../src/domain/models/echo/echo_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-integration-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Echo model: full flow - create input, execute write, verify resource", async () => {
  await withTempDir(async (repoDir) => {
    // Setup repositories
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create and save an input
    const testMessage = "Hello, Swamp!";
    const input = ModelInput.create({
      name: "test-echo-input",
      attributes: { message: testMessage },
    });
    await inputRepo.save(modelType, input);

    // Verify input file was created
    const inputPath = inputRepo.getPath(modelType, input.id);
    assertEquals(existsSync(inputPath), true, "Input file should exist");

    // Read and verify input file contents
    const inputContent = await Deno.readTextFile(inputPath);
    const inputData = parseYaml(inputContent) as Record<string, unknown>;
    assertEquals(inputData.name, "test-echo-input");
    assertEquals(
      (inputData.attributes as Record<string, unknown>).message,
      testMessage,
    );

    // Execute the write method
    const result = await echoModel.methods.write.execute(input, { repoDir });

    // Save the resource
    await resourceRepo.save(modelType, result.resource);

    // Verify resource file was created
    const resourcePath = resourceRepo.getPath(modelType, result.resource.id);
    assertEquals(existsSync(resourcePath), true, "Resource file should exist");

    // Read and verify resource file contents
    const resourceContent = await Deno.readTextFile(resourcePath);
    const resourceData = parseYaml(resourceContent) as Record<string, unknown>;
    assertEquals(
      resourceData.inputId,
      input.id,
      "Resource should reference the input",
    );

    const resourceAttrs = resourceData.attributes as Record<string, unknown>;
    assertEquals(
      resourceAttrs.message,
      testMessage,
      "Resource should contain the message",
    );
    assertEquals(
      typeof resourceAttrs.timestamp,
      "string",
      "Resource should have a timestamp",
    );

    // Verify timestamp is a valid ISO date
    const timestamp = new Date(resourceAttrs.timestamp as string);
    assertEquals(
      isNaN(timestamp.getTime()),
      false,
      "Timestamp should be valid",
    );
  });
});

Deno.test("Echo model: directory structure is correct", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    const input = ModelInput.create({
      name: "test-structure",
      attributes: { message: "test" },
    });
    await inputRepo.save(modelType, input);

    const result = await echoModel.methods.write.execute(input, { repoDir });
    await resourceRepo.save(modelType, result.resource);

    // Verify directory structure
    const inputDir = join(repoDir, "inputs", "swamp/echo");
    const resourceDir = join(repoDir, "resources", "swamp/echo");

    assertEquals(existsSync(inputDir), true, "Input directory should exist");
    assertEquals(
      existsSync(resourceDir),
      true,
      "Resource directory should exist",
    );
  });
});

Deno.test("Echo model: multiple inputs and resources", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple inputs
    const messages = ["First message", "Second message", "Third message"];
    const inputs: ModelInput[] = [];

    for (let i = 0; i < messages.length; i++) {
      const input = ModelInput.create({
        name: `test-input-${i}`,
        attributes: { message: messages[i] },
      });
      await inputRepo.save(modelType, input);
      inputs.push(input);
    }

    // Verify all inputs exist
    const allInputs = await inputRepo.findAll(modelType);
    assertEquals(allInputs.length, 3, "Should have 3 inputs");

    // Execute write for each input
    for (const input of inputs) {
      const result = await echoModel.methods.write.execute(input, { repoDir });
      await resourceRepo.save(modelType, result.resource);
    }

    // Verify all resources exist
    const allResources = await resourceRepo.findAll(modelType);
    assertEquals(allResources.length, 3, "Should have 3 resources");

    // Verify each resource has correct message
    for (const input of inputs) {
      const resource = await resourceRepo.findByInputId(modelType, input.id);
      assertEquals(
        resource !== null,
        true,
        `Resource should exist for input ${input.name}`,
      );
      assertEquals(
        resource?.attributes.message,
        input.attributes.message,
        "Resource message should match input",
      );
    }
  });
});

// CLI integration test
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

Deno.test("CLI: model create command creates input file", async () => {
  await withTempDir(async (repoDir) => {
    // Run the CLI command
    const result = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "cli-test-input",
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

    // Parse the JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.type, "swamp/echo");
    assertEquals(output.name, "cli-test-input");
    assertEquals(typeof output.id, "string");
    assertStringIncludes(output.path, "swamp/echo");

    // Verify the file was created
    assertEquals(existsSync(output.path), true, "Input file should exist");
  });
});

Deno.test("CLI: model create command rejects duplicate names", async () => {
  await withTempDir(async (repoDir) => {
    // Create first input
    const result1 = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "duplicate-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(result1.code, 0);

    // Try to create another with the same name
    const result2 = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "duplicate-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(result2.code !== 0, true, "Should fail for duplicate name");
    assertStringIncludes(result2.stderr, "already exists");
  });
});

Deno.test("CLI: model create command rejects unknown model type", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand(
      [
        "model",
        "create",
        "unknown/type",
        "test-input",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(result.code !== 0, true, "Should fail for unknown type");
    assertStringIncludes(result.stderr, "Unknown model type");
  });
});
