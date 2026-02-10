/**
 * Integration tests for input override validation.
 *
 * Tests the validation of step/CLI inputs that override model definition attributes
 * (implicit inputs). These tests verify that:
 * 1. Unknown input keys are rejected with helpful error messages
 * 2. Type mismatches between input values and schema are rejected
 * 3. Typo suggestions are provided for misspelled keys
 * 4. Valid input overrides work correctly
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
  attributes: Record<string, unknown> = { message: "default" },
): Promise<string> {
  const modelData = {
    type: "swamp/echo",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    attributes,
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

    // Override the message attribute with a valid string value
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

Deno.test("CLI: model method run with unknown input key fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-unknown-key", { message: "test" });

    // Try to override with an unknown key
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-unknown-key",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"unknownAttribute": "value"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for unknown input key");
    assertStringIncludes(result.stderr, "Invalid input overrides");
    assertStringIncludes(result.stderr, "unknownAttribute");
    assertStringIncludes(result.stderr, "Unknown input key");
  });
});

Deno.test("CLI: model method run with typo suggests correct key", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-typo-test", { message: "test" });

    // Try to override with a typo (mesage instead of message)
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-typo-test",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"mesage": "value"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for typo");
    assertStringIncludes(result.stderr, "Invalid input overrides");
    assertStringIncludes(result.stderr, "mesage");
    // Should suggest the correct key (escaped quotes in JSON output)
    assertStringIncludes(result.stderr, "Did you mean");
  });
});

Deno.test("CLI: model method run with type mismatch fails - number instead of string", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-type-mismatch", { message: "test" });

    // Try to override string field with a number
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
    assertStringIncludes(result.stderr, "Invalid input overrides");
    assertStringIncludes(result.stderr, "message");
    // Should mention the type error
    assertStringIncludes(result.stderr, "Invalid value");
  });
});

Deno.test("CLI: model method run with multiple invalid inputs reports all errors", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-multi-error", { message: "test" });

    // Try to override with multiple invalid inputs
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "echo-multi-error",
        "write",
        "--repo-dir",
        repoDir,
        "--input",
        '{"unknownKey": "value", "anotherBadKey": 123}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for multiple errors");
    assertStringIncludes(result.stderr, "Invalid input overrides");
    // Should report both errors
    assertStringIncludes(result.stderr, "unknownKey");
    assertStringIncludes(result.stderr, "anotherBadKey");
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

    // Create workflow that overrides the message attribute
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

Deno.test("Workflow: step with unknown input key fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-workflow-unknown", {
      message: "test",
    });

    // Create workflow with an unknown input key
    const workflowData = {
      id: crypto.randomUUID(),
      name: "unknown-key-workflow",
      version: 1,
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "bad-override-step",
              task: {
                type: "model_method",
                modelIdOrName: "echo-workflow-unknown",
                methodName: "write",
                inputs: {
                  invalidAttribute: "this should fail",
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
        "unknown-key-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow errors are captured in the JSON output, not stderr
    assertEquals(result.code !== 0, true, "Should fail for unknown input key");
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed", "Workflow status should be failed");
    const stepError = output.jobs[0].steps[0].error;
    assertStringIncludes(stepError, "Invalid step input overrides");
    assertStringIncludes(stepError, "invalidAttribute");
    assertStringIncludes(stepError, "Unknown input key");
  });
});

Deno.test("Workflow: step with typo suggests correct key", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-workflow-typo", { message: "test" });

    // Create workflow with a typo in the input key
    const workflowData = {
      id: crypto.randomUUID(),
      name: "typo-key-workflow",
      version: 1,
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "typo-step",
              task: {
                type: "model_method",
                modelIdOrName: "echo-workflow-typo",
                methodName: "write",
                inputs: {
                  mesage: "typo in key",
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
        "typo-key-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow errors are captured in the JSON output, not stderr
    assertEquals(result.code !== 0, true, "Should fail for typo");
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed", "Workflow status should be failed");
    const stepError = output.jobs[0].steps[0].error;
    assertStringIncludes(stepError, "Invalid step input overrides");
    assertStringIncludes(stepError, "mesage");
    assertStringIncludes(stepError, "Did you mean");
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

    // Workflow errors are captured in the JSON output, not stderr
    assertEquals(result.code !== 0, true, "Should fail for type mismatch");
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed", "Workflow status should be failed");
    const stepError = output.jobs[0].steps[0].error;
    assertStringIncludes(stepError, "Invalid step input overrides");
    assertStringIncludes(stepError, "message");
    assertStringIncludes(stepError, "Invalid value");
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

Deno.test("Workflow: step includes step name in error message", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-step-name", { message: "test" });

    // Create workflow with a named step that has invalid input
    const workflowData = {
      id: crypto.randomUUID(),
      name: "step-name-error-workflow",
      version: 1,
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "my-descriptive-step-name",
              task: {
                type: "model_method",
                modelIdOrName: "echo-step-name",
                methodName: "write",
                inputs: {
                  badKey: "invalid",
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
        "step-name-error-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow errors are captured in the JSON output, not stderr
    assertEquals(result.code !== 0, true, "Should fail");
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed", "Workflow status should be failed");
    const stepError = output.jobs[0].steps[0].error;
    // Error should include the step name for context
    assertStringIncludes(stepError, "my-descriptive-step-name");
  });
});
