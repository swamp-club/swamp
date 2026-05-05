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
 * Integration tests for the full Definition → DataOutput flow.
 *
 * Tests the complete lifecycle:
 * 1. Create a model definition
 * 2. Run a method to produce DataOutput
 * 3. Verify outputs via CLI (model output search/get/data/logs)
 * 4. Verify data via CLI (data list/get/versions)
 *
 * This ensures the new architecture (Definition + DataOutput + UnifiedDataRepository)
 * is working correctly end-to-end.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-output-flow-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Initializes a test repository with the required marker file and directory structure.
 */
async function initializeTestRepo(repoDir: string): Promise<void> {
  // Create the .swamp directory structure
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  // Create the .swamp.yaml marker file
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
    args: [...CLI_ARGS, ...args],
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

// ============================================================================
// Full End-to-End Flow Tests
// ============================================================================

Deno.test("Integration: full flow - create definition, run method, verify output and data", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // 1. Create a model definition
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "e2e-echo-model",
      methods: {
        execute: { arguments: { run: "echo 'Hello from E2E test'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    // 2. Run the method to produce output
    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "e2e-echo-model",
        "execute",
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

    const runOutput = JSON.parse(runResult.stdout);
    assertEquals(runOutput.modelName, "e2e-echo-model");
    assertEquals(runOutput.methodName, "execute");
    assertEquals(
      runOutput.dataArtifacts.length > 0,
      true,
      "Should have data output",
    );

    // 3. List outputs and verify our execution appears
    const outputSearchResult = await runCliCommand(
      [
        "model",
        "output",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      outputSearchResult.code,
      0,
      `Output search should succeed. stderr: ${outputSearchResult.stderr}`,
    );

    const searchOutput = JSON.parse(outputSearchResult.stdout);
    assertEquals(
      searchOutput.results.length >= 1,
      true,
      "Should have at least one output",
    );

    // Find our output
    const ourOutput = searchOutput.results.find(
      (o: { modelName: string }) => o.modelName === "e2e-echo-model",
    );
    assertEquals(
      ourOutput !== undefined,
      true,
      "Should find our model's output",
    );
    assertEquals(ourOutput.methodName, "execute");
    assertEquals(ourOutput.status, "succeeded");

    // 4. Get output details by ID
    const outputGetResult = await runCliCommand(
      [
        "model",
        "output",
        "get",
        ourOutput.id,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      outputGetResult.code,
      0,
      `Output get should succeed. stderr: ${outputGetResult.stderr}`,
    );

    const getOutput = JSON.parse(outputGetResult.stdout);
    assertEquals(getOutput.id, ourOutput.id);
    assertEquals(getOutput.modelName, "e2e-echo-model");
    assertEquals(getOutput.status, "succeeded");
    assertEquals(typeof getOutput.durationMs, "number");

    // 5. Get output data
    const outputDataResult = await runCliCommand(
      [
        "model",
        "output",
        "data",
        ourOutput.id,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      outputDataResult.code,
      0,
      `Output data should succeed. stderr: ${outputDataResult.stderr}`,
    );

    const dataOutput = JSON.parse(outputDataResult.stdout);
    assertEquals(dataOutput.outputId, ourOutput.id);
    assertEquals(typeof dataOutput.data, "object");
    // Shell model produces result with exitCode
    assertEquals(dataOutput.data.exitCode, 0);
    assertEquals(typeof dataOutput.data.command, "string");
  });
});

Deno.test("Integration: data commands work with model data artifacts", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // 1. Create and run a model to produce data
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "data-cmd-test-model",
      methods: { execute: { arguments: { run: "echo 'Data command test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    const runResult = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "data-cmd-test-model",
        "execute",
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

    // 2. List data for the model
    const dataListResult = await runCliCommand(
      [
        "data",
        "list",
        "data-cmd-test-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      dataListResult.code,
      0,
      `Data list should succeed. stderr: ${dataListResult.stderr}`,
    );

    const listOutput = JSON.parse(dataListResult.stdout);
    assertEquals(listOutput.modelName, "data-cmd-test-model");
    assertEquals(Array.isArray(listOutput.groups), true);
    assertEquals(
      listOutput.total >= 1,
      true,
      "Should have at least one data artifact",
    );

    // Find the resource artifact from groups
    const dataGroup = listOutput.groups.find(
      (g: { type: string }) => g.type === "resource",
    );
    assertEquals(dataGroup !== undefined, true, "Should have resource group");
    assertEquals(
      dataGroup.items.length >= 1,
      true,
      "Should have at least one item",
    );
    const dataArtifact = dataGroup.items[0];

    // 3. Get data by name
    const dataGetResult = await runCliCommand(
      [
        "data",
        "get",
        "data-cmd-test-model",
        dataArtifact.name,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      dataGetResult.code,
      0,
      `Data get should succeed. stderr: ${dataGetResult.stderr}`,
    );

    const getOutput = JSON.parse(dataGetResult.stdout);
    assertEquals(getOutput.modelName, "data-cmd-test-model");
    assertEquals(getOutput.name, dataArtifact.name);
    assertEquals(typeof getOutput.contentPath, "string");
    assertEquals(getOutput.contentType, "application/json");

    // Read the content file to verify the data (contentPath is now relative)
    const content = await Deno.readTextFile(
      join(repoDir, getOutput.contentPath),
    );
    const parsedContent = JSON.parse(content);
    // Shell model produces result with exitCode and command
    assertEquals(parsedContent.exitCode, 0);
    assertEquals(typeof parsedContent.command, "string");

    // 4. Get data versions
    const dataVersionsResult = await runCliCommand(
      [
        "data",
        "versions",
        "data-cmd-test-model",
        dataArtifact.name,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      dataVersionsResult.code,
      0,
      `Data versions should succeed. stderr: ${dataVersionsResult.stderr}`,
    );

    const versionsOutput = JSON.parse(dataVersionsResult.stdout);
    assertEquals(versionsOutput.modelName, "data-cmd-test-model");
    assertEquals(versionsOutput.dataName, dataArtifact.name);
    assertEquals(Array.isArray(versionsOutput.versions), true);
    assertEquals(versionsOutput.versions.length >= 1, true);
  });
});

Deno.test("Integration: output search with partial ID matching", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create and run a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "partial-id-model",
      methods: { execute: { arguments: { run: "echo 'Partial ID test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "partial-id-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Get the output ID
    const searchResult = await runCliCommand(
      [
        "model",
        "output",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    const outputs = JSON.parse(searchResult.stdout);
    const output = outputs.results.find(
      (o: { modelName: string }) => o.modelName === "partial-id-model",
    );
    const fullId = output.id;
    const partialId = fullId.substring(0, 8); // First 8 characters

    // Get output using partial ID
    const getResult = await runCliCommand(
      [
        "model",
        "output",
        "get",
        partialId,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      getResult.code,
      0,
      `Get with partial ID should succeed. stderr: ${getResult.stderr}`,
    );

    const getOutput = JSON.parse(getResult.stdout);
    assertEquals(getOutput.id, fullId);
  });
});

Deno.test("Integration: output data with field extraction", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create and run a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "field-extract-model",
      methods: {
        execute: { arguments: { run: "echo 'Extract specific field'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "field-extract-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Get output ID
    const searchResult = await runCliCommand(
      [
        "model",
        "output",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    const outputs = JSON.parse(searchResult.stdout);
    const output = outputs.results.find(
      (o: { modelName: string }) => o.modelName === "field-extract-model",
    );

    // Get specific field from data (shell model produces exitCode)
    const fieldResult = await runCliCommand(
      [
        "model",
        "output",
        "data",
        output.id,
        "--field",
        "exitCode",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      fieldResult.code,
      0,
      `Field extraction should succeed. stderr: ${fieldResult.stderr}`,
    );

    const fieldOutput = JSON.parse(fieldResult.stdout);
    assertEquals(fieldOutput.field, "exitCode");
    assertEquals(fieldOutput.data, 0);
  });
});

// Note: Log tests are skipped because shell model produces log artifacts differently.
// Log testing would require a model that produces logs (e.g., command/shell model).

Deno.test("Integration: multiple method runs create separate outputs", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "multi-run-model",
      methods: { execute: { arguments: { run: "echo 'Multi-run test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    // Run the method twice
    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "multi-run-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "multi-run-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // List outputs - should have 2 for this model
    const searchResult = await runCliCommand(
      [
        "model",
        "output",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(searchResult.code, 0);

    const outputs = JSON.parse(searchResult.stdout);
    const modelOutputs = outputs.results.filter(
      (o: { modelName: string }) => o.modelName === "multi-run-model",
    );

    assertEquals(
      modelOutputs.length,
      2,
      "Should have 2 outputs for the model",
    );

    // Verify they have different IDs and timestamps
    assertEquals(
      modelOutputs[0].id !== modelOutputs[1].id,
      true,
      "Outputs should have different IDs",
    );
  });
});

Deno.test("Integration: data versioning across multiple runs", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    let definition = Definition.create({
      name: "version-test-model",
      methods: { execute: { arguments: { run: "echo 'Version 1'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    // Run first time
    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "version-test-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Update run command and run again
    definition = (await definitionRepo.findByName(
      SHELL_MODEL_TYPE,
      "version-test-model",
    ))!;
    definition.setMethodArgument("execute", "run", "echo 'Version 2'");
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "version-test-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // List data versions
    const listResult = await runCliCommand(
      [
        "data",
        "list",
        "version-test-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      listResult.code,
      0,
      `Data list should succeed. stderr: ${listResult.stderr}`,
    );

    const listOutput = JSON.parse(listResult.stdout);
    const dataGroup = listOutput.groups.find(
      (g: { type: string }) => g.type === "resource",
    );
    assertEquals(dataGroup !== undefined, true, "Should have resource group");
    const dataArtifact = dataGroup.items[0];

    // Check versions
    const versionsResult = await runCliCommand(
      [
        "data",
        "versions",
        "version-test-model",
        dataArtifact.name,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(versionsResult.code, 0);

    const versionsOutput = JSON.parse(versionsResult.stdout);
    assertEquals(
      versionsOutput.versions.length >= 2,
      true,
      "Should have at least 2 versions",
    );

    // Get specific version
    const v1Result = await runCliCommand(
      [
        "data",
        "get",
        "version-test-model",
        dataArtifact.name,
        "--version",
        "1",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      v1Result.code,
      0,
      `Get v1 should succeed. stderr: ${v1Result.stderr}`,
    );

    const v1Output = JSON.parse(v1Result.stdout);
    assertEquals(v1Output.version, 1);

    // Read content from file path - shell model produces exitCode (contentPath is relative)
    const v1Content = await Deno.readTextFile(
      join(repoDir, v1Output.contentPath),
    );
    const v1Parsed = JSON.parse(v1Content);
    assertEquals(v1Parsed.exitCode, 0);

    // Get latest (should be version 2 or higher)
    const latestResult = await runCliCommand(
      [
        "data",
        "get",
        "version-test-model",
        dataArtifact.name,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      latestResult.code,
      0,
      `Get latest should succeed. stderr: ${latestResult.stderr}`,
    );

    const latestOutput = JSON.parse(latestResult.stdout);
    assertEquals(
      latestOutput.version >= 2,
      true,
      "Latest should be version 2 or higher",
    );

    // Read content from file path - shell model produces exitCode (contentPath is relative)
    const latestContent = await Deno.readTextFile(
      join(repoDir, latestOutput.contentPath),
    );
    const latestParsed = JSON.parse(latestContent);
    assertEquals(latestParsed.exitCode, 0);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

Deno.test("Integration: output get fails for non-existent output", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    const result = await runCliCommand(
      [
        "model",
        "output",
        "get",
        "00000000-0000-0000-0000-000000000000",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code !== 0,
      true,
      "Should fail for non-existent output",
    );
    assertStringIncludes(result.stderr + result.stdout, "not found");
  });
});

Deno.test("Integration: data get fails for non-existent model", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    const result = await runCliCommand(
      [
        "data",
        "list",
        "non-existent-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for non-existent model");
    assertStringIncludes(result.stderr + result.stdout, "not found");
  });
});

Deno.test("Integration: output data fails for non-existent field", async () => {
  await withTempDir(async (repoDir) => {
    // Initialize the test repo with marker file
    await initializeTestRepo(repoDir);

    // Create and run a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "field-error-model",
      methods: { execute: { arguments: { run: "echo 'Field error test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    await runCliCommand(
      [
        "model",
        "method",
        "run",
        "field-error-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Get output ID
    const searchResult = await runCliCommand(
      [
        "model",
        "output",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    const outputs = JSON.parse(searchResult.stdout);
    const output = outputs.results.find(
      (o: { modelName: string }) => o.modelName === "field-error-model",
    );

    // Try to get non-existent field
    const result = await runCliCommand(
      [
        "model",
        "output",
        "data",
        output.id,
        "--field",
        "nonexistent",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for non-existent field");
    assertStringIncludes(result.stderr + result.stdout, "not found");
  });
});
