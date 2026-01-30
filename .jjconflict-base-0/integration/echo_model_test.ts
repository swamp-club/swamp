/**
 * Integration tests for the Echo model.
 *
 * Tests the full flow:
 * 1. Create an echo model input
 * 2. Execute the write method
 * 3. Verify the data artifact is created with correct content
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { ModelInput } from "../src/domain/models/model_input.ts";
import { inputIdToDataId } from "../src/domain/models/model_data.ts";
import { YamlInputRepository } from "../src/infrastructure/persistence/yaml_input_repository.ts";
import { YamlDataRepository } from "../src/infrastructure/persistence/yaml_data_repository.ts";
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

Deno.test("Echo model: full flow - create input, execute write, verify data", async () => {
  await withTempDir(async (repoDir) => {
    // Setup repositories
    const inputRepo = new YamlInputRepository(repoDir);
    const dataRepo = new YamlDataRepository(repoDir);
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

    // Verify data exists
    assertEquals(
      result.data !== undefined,
      true,
      "Result should have data",
    );
    const data = result.data!;

    // Save the data
    await dataRepo.save(modelType, data);

    // Verify data file was created
    const dataPath = dataRepo.getPath(modelType, data.id);
    assertEquals(existsSync(dataPath), true, "Data file should exist");

    // Read and verify data file contents
    const dataContent = await Deno.readTextFile(dataPath);
    const dataObj = parseYaml(dataContent) as Record<string, unknown>;
    assertEquals(
      dataObj.id,
      data.id,
      "Data should have the correct ID",
    );

    const dataAttrs = dataObj.attributes as Record<string, unknown>;
    assertEquals(
      dataAttrs.message,
      testMessage,
      "Data should contain the message",
    );
    assertEquals(
      typeof dataAttrs.timestamp,
      "string",
      "Data should have a timestamp",
    );

    // Verify timestamp is a valid ISO date
    const timestamp = new Date(dataAttrs.timestamp as string);
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
    const dataRepo = new YamlDataRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    const input = ModelInput.create({
      name: "test-structure",
      attributes: { message: "test" },
    });
    await inputRepo.save(modelType, input);

    const result = await echoModel.methods.write.execute(input, { repoDir });
    await dataRepo.save(modelType, result.data!);

    // Verify directory structure
    const inputDir = join(repoDir, "inputs", "swamp/echo");
    const dataDir = join(repoDir, "data", "swamp/echo");

    assertEquals(existsSync(inputDir), true, "Input directory should exist");
    assertEquals(
      existsSync(dataDir),
      true,
      "Data directory should exist",
    );
  });
});

Deno.test("Echo model: multiple inputs and data", async () => {
  await withTempDir(async (repoDir) => {
    const inputRepo = new YamlInputRepository(repoDir);
    const dataRepo = new YamlDataRepository(repoDir);
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
      await dataRepo.save(modelType, result.data!);
    }

    // Verify all data artifacts exist
    const allData = await dataRepo.findAll(modelType);
    assertEquals(allData.length, 3, "Should have 3 data artifacts");

    // Verify each data artifact has correct message
    for (const input of inputs) {
      const data = await dataRepo.findById(
        modelType,
        inputIdToDataId(input.id),
      );
      assertEquals(
        data !== null,
        true,
        `Data should exist for input ${input.name}`,
      );
      assertEquals(
        data?.attributes.message,
        input.attributes.message,
        "Data message should match input",
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

// model method run integration tests

Deno.test("CLI: model method run creates data", async () => {
  await withTempDir(async (repoDir) => {
    // First create a model
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "method-run-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      createResult.code,
      0,
      `Create should succeed. stderr: ${createResult.stderr}`,
    );
    const createOutput = JSON.parse(createResult.stdout);

    // Update input file to add message attribute
    const inputRepo = new YamlInputRepository(repoDir);
    const input = await inputRepo.findByName(
      ECHO_MODEL_TYPE,
      "method-run-test",
    );
    assertEquals(input !== null, true, "Input should exist");
    input!.setAttribute("message", "Hello from CLI!");
    await inputRepo.save(ECHO_MODEL_TYPE, input!);

    // Run the method
    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "method-run-test",
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      runResult.code,
      0,
      `Method run should succeed. stderr: ${runResult.stderr}`,
    );

    // Verify JSON output
    const runOutput = JSON.parse(runResult.stdout);
    assertEquals(runOutput.modelId, createOutput.id);
    assertEquals(runOutput.modelName, "method-run-test");
    assertEquals(runOutput.type, "swamp/echo");
    assertEquals(runOutput.methodName, "write");
    assertEquals(typeof runOutput.data.id, "string");
    assertStringIncludes(runOutput.data.path, "data/swamp/echo");
    assertEquals(runOutput.data.attributes.message, "Hello from CLI!");
    assertEquals(typeof runOutput.data.attributes.timestamp, "string");

    // Verify data file was created
    assertEquals(
      existsSync(runOutput.data.path),
      true,
      "Data file should exist",
    );

    // Verify input was updated with dataId
    const updatedInput = await inputRepo.findByName(
      ECHO_MODEL_TYPE,
      "method-run-test",
    );
    assertEquals(updatedInput!.dataId, runOutput.data.id);
  });
});

Deno.test("CLI: model method run by model ID", async () => {
  await withTempDir(async (repoDir) => {
    // Create a model and set up its attributes
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "run-by-id-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(createResult.code, 0);
    const createOutput = JSON.parse(createResult.stdout);

    // Update input with message attribute
    const inputRepo = new YamlInputRepository(repoDir);
    const input = await inputRepo.findByName(ECHO_MODEL_TYPE, "run-by-id-test");
    input!.setAttribute("message", "Using ID");
    await inputRepo.save(ECHO_MODEL_TYPE, input!);

    // Run method using model ID instead of name
    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        createOutput.id,
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(runResult.code, 0, `stderr: ${runResult.stderr}`);

    const runOutput = JSON.parse(runResult.stdout);
    assertEquals(runOutput.modelId, createOutput.id);
    assertEquals(runOutput.data.attributes.message, "Using ID");
  });
});

Deno.test("CLI: model method run fails for unknown model", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "nonexistent-model",
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(result.code !== 0, true, "Should fail for unknown model");
    assertStringIncludes(result.stderr, "Model not found");
  });
});

Deno.test("CLI: model method run fails for unknown method", async () => {
  await withTempDir(async (repoDir) => {
    // Create a model
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "unknown-method-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(createResult.code, 0);

    // Try to run a nonexistent method
    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "unknown-method-test",
        "nonexistent",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(runResult.code !== 0, true, "Should fail for unknown method");
    assertStringIncludes(runResult.stderr, "Unknown method 'nonexistent'");
    assertStringIncludes(runResult.stderr, "Available methods: write");
  });
});

Deno.test("CLI: model method run fails for missing required attributes", async () => {
  await withTempDir(async (repoDir) => {
    // Create a model without setting the required 'message' attribute
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "missing-attrs-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(createResult.code, 0);

    // Try to run the method (should fail validation)
    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "missing-attrs-test",
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      runResult.code !== 0,
      true,
      "Should fail for missing attributes",
    );
    assertStringIncludes(runResult.stderr, "Input validation failed");
  });
});

// model search tests

Deno.test("CLI: model search returns all models in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    // Create two models
    await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "search-model-1",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );
    await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "search-model-2",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );

    const result = await runCliCommand(
      ["model", "search", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);
    const names = output.results.map((r: { name: string }) => r.name);
    assertEquals(names.includes("search-model-1"), true);
    assertEquals(names.includes("search-model-2"), true);
  });
});

Deno.test("CLI: model search with multiple matches returns list in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    // Create models with similar names
    await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "deploy-staging",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );
    await runCliCommand(
      ["model", "create", "swamp/echo", "deploy-prod", "--repo-dir", repoDir],
      Deno.cwd(),
    );
    await runCliCommand(
      ["model", "create", "swamp/echo", "build-app", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    const result = await runCliCommand(
      ["model", "search", "deploy", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);
    const names = output.results.map((r: { name: string }) => r.name);
    assertEquals(names.includes("deploy-staging"), true);
    assertEquals(names.includes("deploy-prod"), true);
  });
});

Deno.test("CLI: model search with single match returns full details in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    // Create two models with different names
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "alpha-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(createResult.code, 0);
    const createOutput = JSON.parse(createResult.stdout);

    await runCliCommand(
      ["model", "create", "swamp/echo", "beta-model", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    const result = await runCliCommand(
      ["model", "search", "alpha", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // When single match, returns full model details (same as model get)
    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "alpha-model");
    assertEquals(output.id, createOutput.id);
    assertEquals(output.type, "swamp/echo");
    assertEquals(typeof output.version, "number");
    assertEquals(typeof output.attributes, "object");
  });
});
