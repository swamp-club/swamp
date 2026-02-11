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
 * Integration tests for inputs support in workflows and models.
 *
 * Tests the full input flow including:
 * - Model inputs with enum validation
 * - Step task inputs to model
 * - Workflow inputs with expression references
 * - Input validation error messages
 * - Last evaluated execution with inputs
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-inputs-" });
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
    ".swamp/workflows",
    ".swamp/workflow-runs",
    ".swamp/workflows-evaluated",
    ".swamp/definitions-evaluated",
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

async function createEchoModelWithInputs(
  repoDir: string,
  name: string,
): Promise<void> {
  // Create model with inputs schema
  const modelData = {
    type: "swamp/echo",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    inputs: {
      properties: {
        environment: {
          type: "string",
          enum: ["dev", "staging", "production"],
          description: "Target environment for deployment",
        },
      },
      required: ["environment"],
    },
    globalArguments: {},
    methods: {
      write: {
        arguments: {
          message: "${{ inputs.environment }}",
        },
      },
    },
  };

  const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

// Test 1: Model with Inputs and Enum Validation

Deno.test("CLI: model method run with valid input succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModelWithInputs(repoDir, "echo-env");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-env",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment": "dev"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "echo-env");
  });
});

Deno.test("CLI: model method run with invalid enum value fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModelWithInputs(repoDir, "echo-env-enum");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-env-enum",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment": "invalid"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for invalid enum");
    assertStringIncludes(result.stderr, "must be one of");
  });
});

Deno.test("CLI: model method run with missing required input fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModelWithInputs(repoDir, "echo-env-missing");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-env-missing",
        "write",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for missing input");
    assertStringIncludes(result.stderr, "environment");
  });
});

// Test 3: Workflow Inputs with Expression References

Deno.test("CLI: workflow run with valid input succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModelWithInputs(repoDir, "echo-model");

    // Create workflow with inputs
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-workflow-inputs",
      version: 1,
      inputs: {
        properties: {
          "environment-one": {
            type: "string",
            enum: ["dev", "staging", "production"],
            description: "Target environment",
          },
        },
        required: ["environment-one"],
      },
      jobs: [
        {
          name: "echo-job",
          steps: [
            {
              name: "first-env",
              task: {
                type: "model_method",
                modelIdOrName: "echo-model",
                methodName: "write",
                inputs: {
                  environment: '${{ inputs["environment-one"] }}',
                },
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-workflow-inputs",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment-one": "dev"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

Deno.test("CLI: workflow run with missing required input fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create workflow with required inputs
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-missing-input",
      version: 1,
      inputs: {
        properties: {
          environment: {
            type: "string",
          },
        },
        required: ["environment"],
      },
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "run",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-missing-input",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for missing input");
    assertStringIncludes(result.stderr, "environment");
  });
});

Deno.test("CLI: workflow run with input-file works", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model definition so the step can execute
    const modelData = {
      type: "swamp/echo",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "test-model",
      version: 1,
      tags: {},
      globalArguments: {},
      methods: {
        write: {
          arguments: {
            message: "hello",
          },
        },
      },
    };
    const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    // Create workflow with inputs
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-input-file",
      version: 1,
      inputs: {
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    // Create input file
    const inputData = { message: "hello from file" };
    const inputFilePath = join(repoDir, "inputs.yaml");
    await Deno.writeTextFile(
      inputFilePath,
      stringifyYaml(inputData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-input-file",
        "--repo-dir",
        repoDir,
        "--input-file",
        inputFilePath,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

// Test 8: Input Validation Error Messages

Deno.test("CLI: input validation reports type mismatch", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model with string type input
    const modelData = {
      type: "swamp/echo",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "type-check-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      globalArguments: {},
      methods: {
        write: {
          arguments: {
            message: "${{ inputs.name }}",
          },
        },
      },
    };

    const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "type-check-model",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"name": 123}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for type mismatch");
    assertStringIncludes(result.stderr, "must be a string");
  });
});

Deno.test("CLI: input validation reports multiple errors", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model with multiple inputs
    const modelData = {
      type: "swamp/echo",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "multi-error-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
        },
        required: ["name", "count"],
      },
      globalArguments: {},
      methods: {
        write: {
          arguments: {
            message: "${{ inputs.name }}",
          },
        },
      },
    };

    const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "multi-error-model",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"name": 123, "count": "not-a-number"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for multiple errors");
    // Should report both errors
    assertStringIncludes(result.stderr, "name");
    assertStringIncludes(result.stderr, "count");
  });
});
