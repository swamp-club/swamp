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
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-inputs-" });
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

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    "workflows",
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

async function createShellModelWithInputs(
  repoDir: string,
  name: string,
): Promise<void> {
  // Create model with inputs schema
  const modelData = {
    type: "command/shell",
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
      execute: {
        arguments: {
          run: "echo '${{ inputs.environment }}'",
        },
      },
    },
  };

  const modelDir = join(repoDir, "models/command/shell");
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
    await createShellModelWithInputs(repoDir, "shell-env");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "shell-env",
        "execute",
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
    assertEquals(output.modelName, "shell-env");
  });
});

Deno.test("CLI: model method run with invalid enum value fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "shell-env-enum");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "shell-env-enum",
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment": "invalid"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for invalid enum");
    assertStringIncludes(result.stderr + result.stdout, "must be one of");
  });
});

Deno.test("CLI: model method run with missing required input fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "shell-env-missing");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "shell-env-missing",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for missing input");
    assertStringIncludes(result.stderr + result.stdout, "environment");
  });
});

// Test 3: Workflow Inputs with Expression References

Deno.test("CLI: workflow run with valid input succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "echo-model");

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
                methodName: "execute",
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

    const workflowDir = join(repoDir, "workflows");
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

    const workflowDir = join(repoDir, "workflows");
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
    assertStringIncludes(result.stderr + result.stdout, "environment");
  });
});

Deno.test("CLI: workflow run with input-file works", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model definition so the step can execute
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "test-model",
      version: 1,
      tags: {},
      globalArguments: {},
      methods: {
        execute: {
          arguments: {
            run: "echo 'hello'",
          },
        },
      },
    };
    const modelDir = join(repoDir, "models/command/shell");
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
          run: { type: "string" },
        },
        required: ["run"],
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
                methodName: "execute",
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

    const workflowDir = join(repoDir, "workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    // Create input file
    const inputData = { run: "echo 'hello from file'" };
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
      type: "command/shell",
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
        execute: {
          arguments: {
            run: "echo '${{ inputs.name }}'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
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
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        '{"name": 123}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for type mismatch");
    assertStringIncludes(result.stderr + result.stdout, "must be a string");
  });
});

Deno.test("CLI: input validation reports multiple errors", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model with multiple inputs
    const modelData = {
      type: "command/shell",
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
        execute: {
          arguments: {
            run: "echo '${{ inputs.name }}'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
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
        "execute",
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
    assertStringIncludes(result.stderr + result.stdout, "name");
    assertStringIncludes(result.stderr + result.stdout, "count");
  });
});

// Test: Key-value input for model method run

Deno.test("CLI: model method run with key=value input succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "shell-env-kv");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "shell-env-kv",
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        "environment=dev",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "shell-env-kv");
  });
});

// Test: Key-value input for workflow run

Deno.test("CLI: workflow run with key=value input succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "echo-model-kv");

    // Create workflow with inputs
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-workflow-kv",
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
                modelIdOrName: "echo-model-kv",
                methodName: "execute",
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

    const workflowDir = join(repoDir, "workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-workflow-kv",
        "--repo-dir",
        repoDir,
        "--input",
        "environment-one=dev",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

// Test: Multiple key=value inputs with schema coercion

Deno.test("CLI: model method run with multiple k=v and type coercion", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model with number and string inputs
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "coerce-model",
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
        execute: {
          arguments: {
            run: "echo '${{ inputs.name }} ${{ inputs.count }}'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
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
        "coerce-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        "name=alice",
        "--input",
        "count=5",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "coerce-model");
  });
});

// Test: @file input reads file contents

Deno.test("CLI: model method run with @file input", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model that takes a string input
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "file-input-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      globalArguments: {},
      methods: {
        execute: {
          arguments: {
            run: "echo '${{ inputs.message }}'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    // Create a file to read
    const contentFile = join(repoDir, "message.txt");
    await Deno.writeTextFile(contentFile, "hello from file");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "file-input-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        `message=@${contentFile}`,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "file-input-model");
  });
});

// Test: Existing JSON tests still pass (backward compat explicitly verified)

Deno.test("CLI: model method run with JSON input still works", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModelWithInputs(repoDir, "shell-env-json-compat");

    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "shell-env-json-compat",
        "execute",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment": "production"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "shell-env-json-compat");
  });
});

// Test: Method-aware required input filtering (#626)

Deno.test("CLI: method succeeds when required inputs are not referenced by method", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Model has required inputs but execute method doesn't reference them
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "unreferenced-inputs-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          dropletName: { type: "string" },
          region: {
            type: "string",
            enum: ["nyc1", "sfo1", "ams3"],
          },
        },
        required: ["dropletName", "region"],
      },
      globalArguments: {},
      methods: {
        execute: {
          arguments: {
            run: "echo 'hello'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    // Running without inputs should succeed since execute doesn't reference them
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "unreferenced-inputs-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Should succeed without unreferenced inputs. stderr: ${result.stderr}`,
    );
  });
});

Deno.test("CLI: method validates required inputs that it references", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Model where execute references both required inputs
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "referenced-inputs-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          dropletName: { type: "string" },
          region: {
            type: "string",
            enum: ["nyc1", "sfo1", "ams3"],
          },
        },
        required: ["dropletName", "region"],
      },
      globalArguments: {},
      methods: {
        execute: {
          arguments: {
            run:
              "echo 'creating ${{ inputs.dropletName }} in ${{ inputs.region }}'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    // Running without required inputs should fail since execute references them
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "referenced-inputs-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code !== 0,
      true,
      "Should fail without referenced required inputs",
    );
    assertStringIncludes(result.stderr + result.stdout, "dropletName");
    assertStringIncludes(result.stderr + result.stdout, "region");
  });
});

Deno.test("CLI: inputs in globalArguments do not block methods that don't reference them", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Model where globalArguments references inputs but execute method does not
    const modelData = {
      type: "command/shell",
      typeVersion: 1,
      id: crypto.randomUUID(),
      name: "global-input-model",
      version: 1,
      tags: {},
      inputs: {
        properties: {
          apiToken: { type: "string" },
          region: { type: "string" },
        },
        required: ["apiToken", "region"],
      },
      globalArguments: {
        authHeader: "Bearer ${{ inputs.apiToken }}",
      },
      methods: {
        execute: {
          arguments: {
            run: "echo 'hello'",
          },
        },
      },
    };

    const modelDir = join(repoDir, "models/command/shell");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, `${modelData.id}.yaml`),
      stringifyYaml(modelData as Record<string, unknown>),
    );

    // Running without apiToken should succeed — execute doesn't reference it
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "global-input-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Should succeed — globalArguments inputs not needed by execute. stderr: ${result.stderr}`,
    );
  });
});
