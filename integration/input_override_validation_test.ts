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
 * Integration tests for input override validation.
 *
 * Tests the validation of step/CLI inputs that override method arguments.
 * With the globalArguments refactoring, inputs are merged directly into
 * method arguments and validated by the method's Zod schema.
 *
 * Tests verify that:
 * 1. Valid input overrides work correctly
 * 2. Type mismatches between input values and schema are rejected
 * 3. CEL expression-based inputs are resolved correctly
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-input-override-" });
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

async function createEchoModel(
  repoDir: string,
  name: string,
  methodArguments: Record<string, unknown> = { message: "default" },
): Promise<string> {
  const modelData = {
    type: "swamp/echo",
    typeVersion: "2026.02.09.1",
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: {
      write: {
        arguments: methodArguments,
      },
    },
  };

  const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );

  return modelData.id;
}

// ============================================================================
// CLI Input Override Validation Tests
// ============================================================================

Deno.test("CLI: model method run with valid input override succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-valid-override", {
      message: "original",
    });

    // Override the message method argument with a valid string value
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-valid-override",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"message": "overridden"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "echo-valid-override");
  });
});

Deno.test("CLI: model method run with type mismatch fails - number instead of string", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-type-mismatch", { message: "test" });

    // Try to override string field with a number - Zod schema rejects this
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-type-mismatch",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"message": 123}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for type mismatch");
    // Zod validation error for method arguments
    assertStringIncludes(
      result.stderr,
      "Method arguments validation failed",
    );
  });
});

// ============================================================================
// Workflow Step Input Override Validation Tests
// ============================================================================

Deno.test("Workflow: step with valid input override succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-workflow-valid", {
      message: "original",
    });

    // Create workflow that overrides the message method argument
    const workflowData = {
      id: crypto.randomUUID(),
      name: "valid-override-workflow",
      version: 1,
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "override-step",
              task: {
                type: "model_method",
                modelIdOrName: "echo-workflow-valid",
                methodName: "write",
                inputs: {
                  message: "overridden via workflow",
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
        "valid-override-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

Deno.test("Workflow: step with type mismatch fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-workflow-type", { message: "test" });

    // Create workflow with wrong type for input
    const workflowData = {
      id: crypto.randomUUID(),
      name: "type-mismatch-workflow",
      version: 1,
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "type-mismatch-step",
              task: {
                type: "model_method",
                modelIdOrName: "echo-workflow-type",
                methodName: "write",
                inputs: {
                  message: 12345,
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
        "type-mismatch-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow errors are captured in the JSON output
    assertEquals(result.code !== 0, true, "Should fail for type mismatch");
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed", "Workflow status should be failed");
    const stepError = output.jobs[0].steps[0].error;
    // Zod validation error for method arguments
    assertStringIncludes(stepError, "Method arguments validation failed");
  });
});

Deno.test("Workflow: step input override with CEL expression preserves type", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-cel-type", { message: "original" });

    // Create workflow that uses a CEL expression for the input
    const workflowData = {
      id: crypto.randomUUID(),
      name: "cel-type-workflow",
      version: 1,
      inputs: {
        properties: {
          customMessage: { type: "string" },
        },
        required: ["customMessage"],
      },
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "cel-step",
              task: {
                type: "model_method",
                modelIdOrName: "echo-cel-type",
                methodName: "write",
                inputs: {
                  message: "${{ inputs.customMessage }}",
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
        "cel-type-workflow",
        "--repo-dir",
        repoDir,
        "--input",
        '{"customMessage": "from CEL"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});
