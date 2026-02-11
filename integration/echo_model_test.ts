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
 * Integration tests for the Echo model.
 *
 * Tests the full flow:
 * 1. Create an echo model definition
 * 2. Execute the write method
 * 3. Verify the data artifact is created with correct content
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, existsSync } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  ECHO_MODEL_TYPE,
  echoModel,
} from "../src/domain/models/echo/echo_model.ts";
import type { DataHandle, MethodContext } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-integration-" });
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

/**
 * Helper to read data content from a DataHandle.
 */
async function getDataHandleContent(
  dataRepo: FileSystemUnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  handle: DataHandle,
): Promise<Record<string, unknown> | undefined> {
  const content = await dataRepo.getContent(
    modelType,
    modelId,
    handle.name,
    handle.version,
  );
  if (!content) return undefined;
  const text = new TextDecoder().decode(content);
  return JSON.parse(text);
}

Deno.test("Echo model: full flow - create definition, execute write, verify data", async () => {
  await withTempDir(async (repoDir) => {
    // Setup repositories
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create and save a definition
    const testMessage = "Hello, Swamp!";
    const definition = Definition.create({
      name: "test-echo-definition",
      methods: { write: { arguments: { message: testMessage } } },
    });
    await definitionRepo.save(modelType, definition);

    // Verify definition file was created
    const definitionPath = definitionRepo.getPath(modelType, definition.id);
    assertEquals(
      existsSync(definitionPath),
      true,
      "Definition file should exist",
    );

    // Read and verify definition file contents
    const definitionContent = await Deno.readTextFile(definitionPath);
    const definitionData = parseYaml(definitionContent) as Record<
      string,
      unknown
    >;
    assertEquals(definitionData.type, "swamp/echo");
    assertEquals(definitionData.typeVersion, "2026.02.09.1");
    assertEquals(definitionData.name, "test-echo-definition");
    assertEquals(
      ((definitionData.methods as Record<string, Record<string, unknown>>).write
        .arguments as Record<string, unknown>).message,
      testMessage,
    );

    // Create writeResource for the echo model
    const { writeResource } = createResourceWriter(
      dataRepo,
      modelType,
      definition.id,
      echoModel.resources ?? {},
    );

    // Create method context
    const context: MethodContext = {
      repoDir,
      modelType,
      modelId: definition.id,
      globalArgs: { message: testMessage },
      definition: {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: definition.tags,
      },
      methodName: "write",
      logger: getLogger(["test"]),
      dataRepository: dataRepo,
      definitionRepository: definitionRepo,
      writeResource,
    };

    // Execute the write method
    const result = await echoModel.methods.write.execute(
      { message: testMessage },
      context,
    );

    // Verify dataHandles exists (new API)
    assertEquals(
      result.dataHandles !== undefined,
      true,
      "Result should have dataHandles",
    );
    assertEquals(
      result.dataHandles!.length >= 1,
      true,
      "Should have at least one data handle",
    );

    // Verify data handle metadata
    const handle = result.dataHandles![0];
    assertEquals(
      handle.specName,
      "message",
      "Should have message spec name",
    );
    assertEquals(handle.kind, "resource", "Should be a resource");
    assertEquals(handle.metadata.contentType, "application/json");

    // Verify data content (read from disk via dataRepo)
    const dataAttrs = await getDataHandleContent(
      dataRepo,
      modelType,
      definition.id,
      handle,
    );
    assertEquals(
      dataAttrs?.message,
      testMessage,
      "Data should contain the message",
    );
    assertEquals(
      typeof dataAttrs?.timestamp,
      "string",
      "Data should have a timestamp",
    );

    // Verify timestamp is a valid ISO date
    const timestamp = new Date(dataAttrs?.timestamp as string);
    assertEquals(
      isNaN(timestamp.getTime()),
      false,
      "Timestamp should be valid",
    );
  });
});

Deno.test("Echo model: directory structure is correct", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    const definition = Definition.create({
      name: "test-structure",
      methods: { write: { arguments: { message: "test" } } },
    });
    await definitionRepo.save(modelType, definition);

    // Verify directory structure
    const definitionDir = join(repoDir, ".swamp", "definitions", "swamp/echo");

    assertEquals(
      existsSync(definitionDir),
      true,
      "Definition directory should exist",
    );
  });
});

Deno.test("Echo model: multiple definitions", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ECHO_MODEL_TYPE;

    // Create multiple definitions
    const messages = ["First message", "Second message", "Third message"];
    const definitions: Definition[] = [];

    for (let i = 0; i < messages.length; i++) {
      const definition = Definition.create({
        name: `test-definition-${i}`,
        methods: { write: { arguments: { message: messages[i] } } },
      });
      await definitionRepo.save(modelType, definition);
      definitions.push(definition);
    }

    // Verify all definitions exist
    const allDefinitions = await definitionRepo.findAll(modelType);
    assertEquals(allDefinitions.length, 3, "Should have 3 definitions");
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

Deno.test("CLI: model create command creates definition file", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Run the CLI command
    const result = await runCliCommand(
      [
        "model",
        "create",
        "swamp/echo",
        "cli-test-definition",
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
    assertEquals(output.name, "cli-test-definition");
    assertEquals(typeof output.id, "string");
    assertStringIncludes(output.path, "swamp/echo");

    // Verify the file was created
    assertEquals(existsSync(output.path), true, "Definition file should exist");
  });
});

Deno.test("CLI: model create command rejects duplicate names", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create first definition
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
    await initializeTestRepo(repoDir);
    const result = await runCliCommand(
      [
        "model",
        "create",
        "unknown/type",
        "test-definition",
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
    await initializeTestRepo(repoDir);
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

    // Update definition file to add message attribute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = await definitionRepo.findByName(
      ECHO_MODEL_TYPE,
      "method-run-test",
    );
    assertEquals(definition !== null, true, "Definition should exist");
    definition!.setMethodArgument("write", "message", "Hello from CLI!");
    await definitionRepo.save(ECHO_MODEL_TYPE, definition!);

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
    assertEquals(runOutput.data !== undefined, true);
  });
});

Deno.test("CLI: model method run by model ID", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
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

    // Update definition with message attribute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = await definitionRepo.findByName(
      ECHO_MODEL_TYPE,
      "run-by-id-test",
    );
    definition!.setMethodArgument("write", "message", "Using ID");
    await definitionRepo.save(ECHO_MODEL_TYPE, definition!);

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
  });
});

Deno.test("CLI: model method run fails for unknown model", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
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
    await initializeTestRepo(repoDir);
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
    await initializeTestRepo(repoDir);
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
    assertStringIncludes(runResult.stderr, "validation failed");
  });
});

// model search tests

Deno.test("CLI: model search returns all models in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
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
    await initializeTestRepo(repoDir);
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
    await initializeTestRepo(repoDir);
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
    assertEquals(typeof output.globalArguments, "object");
  });
});
