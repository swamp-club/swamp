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
 * Integration tests for the workflow commands.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertPathStringIncludes } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-" });
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
    "vaults",
    ".swamp/secrets",
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
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

function createTestWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    description: "Test workflow",
    jobs: [
      Job.create({
        name: "build",
        description: "Build job",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.model("test-model", "execute"),
          }),
        ],
      }),
      Job.create({
        name: "test",
        description: "Test job",
        steps: [
          Step.create({
            name: "unit",
            task: StepTask.model("test-model", "execute"),
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded() },
        ],
      }),
    ],
  });
}

// workflow create tests

Deno.test("CLI: workflow create creates new workflow file", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const result = await runCliCommand(
      [
        "workflow",
        "create",
        "my-workflow",
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
    assertEquals(output.name, "my-workflow");
    assertEquals(typeof output.id, "string");
    assertEquals(output.id.length, 36); // UUID length
    assertPathStringIncludes(output.path, "workflows/workflow-");
  });
});

Deno.test("CLI: workflow create rejects duplicate names", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create first workflow
    await runCliCommand(
      ["workflow", "create", "duplicate-name", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    // Try to create second with same name
    const result = await runCliCommand(
      ["workflow", "create", "duplicate-name", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Command should fail");
    assertStringIncludes(result.stderr + result.stdout, "already exists");
  });
});

// workflow get tests

Deno.test("CLI: workflow get shows workflow details", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = createTestWorkflow("get-test");
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "get",
        "get-test",
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
    assertEquals(output.name, "get-test");
    assertEquals(output.id, workflow.id);
    assertEquals(output.jobs.length, 2);
    assertEquals(output.jobs[0].name, "build");
    assertEquals(output.jobs[1].name, "test");
  });
});

Deno.test("CLI: workflow get can look up by UUID", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = createTestWorkflow("uuid-lookup-test");
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "get",
        workflow.id,
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.id, workflow.id);
    assertEquals(output.name, "uuid-lookup-test");
  });
});

Deno.test("CLI: workflow get errors for non-existent workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const result = await runCliCommand(
      [
        "workflow",
        "get",
        "non-existent",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Command should fail");
    assertStringIncludes(result.stderr + result.stdout, "not found");
  });
});

// workflow validate tests

Deno.test("CLI: workflow validate passes for valid workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = createTestWorkflow("valid-workflow");
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "validate",
        "valid-workflow",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.workflowName, "valid-workflow");
    assertEquals(output.passed, true);
    assertEquals(
      output.validations.every((v: { passed: boolean }) => v.passed),
      true,
    );
  });
});

Deno.test("CLI: workflow validate with no args validates all workflows", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow1 = createTestWorkflow("workflow-1");
    const workflow2 = createTestWorkflow("workflow-2");
    await repo.save(workflow1);
    await repo.save(workflow2);

    const result = await runCliCommand(
      [
        "workflow",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.workflows.length, 2);
    assertEquals(output.totalPassed, 2);
    assertEquals(output.totalFailed, 0);
    assertEquals(output.passed, true);
  });
});

Deno.test("CLI: workflow validate errors when no workflows found", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const result = await runCliCommand(
      [
        "workflow",
        "validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Command should fail");
    assertStringIncludes(result.stderr + result.stdout, "No workflows found");
  });
});

// workflow search tests

Deno.test("CLI: workflow search returns all workflows in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow1 = createTestWorkflow("search-1");
    const workflow2 = createTestWorkflow("search-2");
    await repo.save(workflow1);
    await repo.save(workflow2);

    const result = await runCliCommand(
      [
        "workflow",
        "search",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);

    const names = output.results.map((r: { name: string }) => r.name);
    assertEquals(names.includes("search-1"), true);
    assertEquals(names.includes("search-2"), true);
  });
});

Deno.test("CLI: workflow search filters by query with multiple matches in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow1 = createTestWorkflow("deploy-staging");
    const workflow2 = createTestWorkflow("deploy-production");
    const workflow3 = createTestWorkflow("build-app");
    await repo.save(workflow1);
    await repo.save(workflow2);
    await repo.save(workflow3);

    const result = await runCliCommand(
      [
        "workflow",
        "search",
        "deploy",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);
    const names = output.results.map((r: { name: string }) => r.name);
    assertEquals(names.includes("deploy-staging"), true);
    assertEquals(names.includes("deploy-production"), true);
  });
});

Deno.test("CLI: workflow search with single match returns full details in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow1 = createTestWorkflow("alpha-workflow");
    const workflow2 = createTestWorkflow("beta-workflow");
    await repo.save(workflow1);
    await repo.save(workflow2);

    const result = await runCliCommand(
      [
        "workflow",
        "search",
        "alpha",
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

    // When single match, returns full workflow details (same as workflow get)
    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "alpha-workflow");
    assertEquals(output.id, workflow1.id);
    assertEquals(output.jobs.length, 2);
    assertEquals(output.jobs[0].name, "build");
    assertEquals(output.jobs[1].name, "test");
  });
});

// workflow run tests

Deno.test("CLI: workflow run executes simple workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model definition so the step can execute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const testModel = Definition.create({
      name: "test-model",
      methods: { execute: { arguments: { run: "echo hello" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, testModel);

    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "simple-run",
      jobs: [
        Job.create({
          name: "shell-job",
          steps: [
            Step.create({
              name: "shell-step",
              task: StepTask.model("test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "simple-run",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.workflowName, "simple-run");
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs.length, 1);
    assertEquals(output.jobs[0].name, "shell-job");
    assertEquals(output.jobs[0].status, "succeeded");
  });
});

Deno.test("CLI: workflow run executes workflow with dependencies", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model definition so steps can execute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const testModel = Definition.create({
      name: "test-model",
      methods: { execute: { arguments: { run: "echo hello" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, testModel);

    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = createTestWorkflow("dep-run");
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "dep-run",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].status, "succeeded");
    assertEquals(output.jobs[1].status, "succeeded");
  });
});

Deno.test("CLI: workflow run fails when step fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "failing-workflow",
      jobs: [
        Job.create({
          name: "failing-job",
          steps: [
            Step.create({
              name: "failing-step",
              task: StepTask.model("nonexistent-model", "run"), // Model not found causes step failure
            }),
          ],
        }),
      ],
    });
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "failing-workflow",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "failed");
    assertEquals(output.jobs[0].status, "failed");
    assertEquals(output.jobs[0].steps[0].status, "failed");
  });
});

Deno.test("CLI: workflow run skips job when condition not met", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "conditional-skip",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "fail",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "run",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });
    await repo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "conditional-skip",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow should fail because build failed
    assertEquals(result.code, 1);

    const output = JSON.parse(result.stdout);
    assertEquals(output.jobs[0].status, "failed"); // build
    assertEquals(output.jobs[1].status, "skipped"); // test
  });
});

Deno.test("CLI: workflow run errors for non-existent workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "non-existent",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Command should fail");
    assertStringIncludes(result.stderr + result.stdout, "not found");
  });
});

// workflow command help

Deno.test("CLI: workflow shows help", async () => {
  const result = await runCliCommand(
    ["workflow"],
    Deno.cwd(),
  );

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "workflow");
  assertStringIncludes(result.stdout, "create");
  assertStringIncludes(result.stdout, "get");
  assertStringIncludes(result.stdout, "validate");
  assertStringIncludes(result.stdout, "search");
  assertStringIncludes(result.stdout, "run");
});

// Model validation during workflow execution

Deno.test("CLI: workflow run fails when model has invalid expression syntax", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model input with invalid expression (missing model. prefix)
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "invalid-expr-model",
      methods: {
        execute: {
          arguments: {
            // Invalid: should be ${{ model.some-vpc.resource.<specName>.<instanceName>.attributes.VpcId }}
            run: "${{some-vpc.VpcId}}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that references this model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "validate-expr-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("invalid-expr-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow - should fail validation
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "validate-expr-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Should fail due to validation error
    assertEquals(result.code, 1, "Command should fail with exit code 1");

    // Error message should mention expression validation
    assertStringIncludes(
      result.stderr + result.stdout,
      "Expression paths",
    );
  });
});

Deno.test("CLI: workflow run fails when model has malformed expression", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model input with malformed expression (missing $ prefix)
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "malformed-expr-model",
      methods: {
        execute: {
          arguments: {
            // Malformed: missing $ prefix
            run: "{{some-vpc.VpcId}}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that references this model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "malformed-expr-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("malformed-expr-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow - should fail validation
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "malformed-expr-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Should fail due to malformed expression
    assertEquals(result.code, 1, "Command should fail with exit code 1");

    // Error message should mention the malformed expression
    assertStringIncludes(
      result.stderr + result.stdout,
      "Expression paths",
    );
  });
});

Deno.test("CLI: workflow run succeeds with valid model expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create two model inputs - one will reference the other
    const definitionRepo = new YamlDefinitionRepository(repoDir);

    const sourceModel = Definition.create({
      name: "source-model",
      globalArguments: {
        run: "echo 'Hello from source'",
      },
      methods: {
        execute: {
          arguments: {
            run: "echo 'Hello from source'",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, sourceModel);

    const dependentModel = Definition.create({
      name: "dependent-model",
      methods: {
        execute: {
          arguments: {
            // Valid expression referencing source-model's globalArgument
            run: "${{ model.source-model.input.globalArguments.run }}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, dependentModel);

    // Create a workflow that runs both models
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "valid-expr-workflow",
      jobs: [
        Job.create({
          name: "run-models",
          steps: [
            Step.create({
              name: "run-source",
              task: StepTask.model("source-model", "execute"),
            }),
            Step.create({
              name: "run-dependent",
              task: StepTask.model("dependent-model", "execute"),
              dependsOn: [
                {
                  step: "run-source",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow - should succeed
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "valid-expr-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
    assertEquals(output.jobs[0].steps[1].status, "succeeded");
  });
});

Deno.test("CLI: workflow run succeeds with self reference expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model that references its own name
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "self-ref-model",
      methods: {
        execute: {
          arguments: {
            // Valid self reference
            run: "echo ${{ self.name }}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that runs the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "self-ref-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("self-ref-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow - should succeed
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "self-ref-workflow",
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
  });
});

// Model deletion blocked by workflow reference tests

Deno.test("CLI: model delete blocked when referenced by workflow, succeeds after workflow deleted", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Step 1: Create a model using CLI
    const createModelResult = await runCliCommand(
      [
        "model",
        "create",
        "command/shell",
        "my-test-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      createModelResult.code,
      0,
      `Model create should succeed. stderr: ${createModelResult.stderr}`,
    );

    const modelOutput = JSON.parse(createModelResult.stdout);
    assertEquals(modelOutput.name, "my-test-model");
    const modelId = modelOutput.id;

    // Step 2: Create a workflow that references the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "workflow-using-model",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("my-test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Step 3: Try to delete the model - should fail because workflow references it
    const deleteModelBlockedResult = await runCliCommand(
      [
        "model",
        "delete",
        "my-test-model",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteModelBlockedResult.code !== 0,
      true,
      "Model delete should fail when referenced by workflow",
    );
    assertStringIncludes(
      deleteModelBlockedResult.stderr + deleteModelBlockedResult.stdout,
      "workflow-using-model",
    );
    assertStringIncludes(
      deleteModelBlockedResult.stderr + deleteModelBlockedResult.stdout,
      "referenced by workflow",
    );

    // Step 4: Delete the workflow using CLI
    const deleteWorkflowResult = await runCliCommand(
      [
        "workflow",
        "delete",
        "workflow-using-model",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteWorkflowResult.code,
      0,
      `Workflow delete should succeed. stderr: ${deleteWorkflowResult.stderr}`,
    );

    const workflowDeleteOutput = JSON.parse(deleteWorkflowResult.stdout);
    assertEquals(workflowDeleteOutput.deleted.name, "workflow-using-model");

    // Step 5: Now model delete should succeed
    const deleteModelSuccessResult = await runCliCommand(
      [
        "model",
        "delete",
        modelId,
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteModelSuccessResult.code,
      0,
      `Model delete should succeed after workflow deleted. stderr: ${deleteModelSuccessResult.stderr}`,
    );

    const modelDeleteOutput = JSON.parse(deleteModelSuccessResult.stdout);
    assertEquals(modelDeleteOutput.deleted.name, "my-test-model");
    assertEquals(modelDeleteOutput.deleted.id, modelId);
  });
});

Deno.test("CLI: model delete blocked when referenced by workflow using model ID", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "id-ref-model",
      methods: {
        execute: {
          arguments: {
            run: "echo test",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that references the model by ID (not name)
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "workflow-using-id",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              // Reference by ID instead of name
              task: StepTask.model(input.id, "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Try to delete the model - should fail because workflow references it by ID
    const deleteModelResult = await runCliCommand(
      [
        "model",
        "delete",
        "id-ref-model",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteModelResult.code !== 0,
      true,
      "Model delete should fail when referenced by workflow using ID",
    );
    assertStringIncludes(
      deleteModelResult.stderr + deleteModelResult.stdout,
      "workflow-using-id",
    );
  });
});

Deno.test("CLI: model delete succeeds when not referenced by any workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model
    const createModelResult = await runCliCommand(
      [
        "model",
        "create",
        "command/shell",
        "standalone-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(createModelResult.code, 0);

    // Create a workflow that does NOT reference the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "unrelated-workflow",
      jobs: [
        Job.create({
          name: "shell-job",
          steps: [
            Step.create({
              name: "echo-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Delete the model - should succeed because workflow doesn't reference it
    const deleteModelResult = await runCliCommand(
      [
        "model",
        "delete",
        "standalone-model",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteModelResult.code,
      0,
      `Model delete should succeed. stderr: ${deleteModelResult.stderr}`,
    );

    const output = JSON.parse(deleteModelResult.stdout);
    assertEquals(output.deleted.name, "standalone-model");
  });
});

Deno.test("CLI: model delete cleans up empty type directories", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model using CLI
    const createResult = await runCliCommand(
      [
        "model",
        "create",
        "command/shell",
        "cleanup-test-model",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(createResult.code, 0, "Model create should succeed");

    // Verify the directory structure was created
    const definitionsDir = `${repoDir}/models`;
    const echoDir = `${definitionsDir}/command/shell`;
    const swampDir = `${definitionsDir}/swamp`;

    // Check that directories exist using Deno.stat
    const echoStatBefore = await Deno.stat(echoDir).catch(() => null);
    assertEquals(
      echoStatBefore !== null && echoStatBefore.isDirectory,
      true,
      "command/shell directory should exist before delete",
    );

    // Delete the model
    const deleteResult = await runCliCommand(
      [
        "model",
        "delete",
        "cleanup-test-model",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteResult.code,
      0,
      `Model delete should succeed. stderr: ${deleteResult.stderr}`,
    );

    // Verify the command/shell directory was cleaned up (should not exist)
    const echoStatAfter = await Deno.stat(echoDir).catch(() => null);
    assertEquals(
      echoStatAfter,
      null,
      "command/shell directory should be cleaned up",
    );

    // Verify the swamp directory was also cleaned up
    const swampStatAfter = await Deno.stat(swampDir).catch(() => null);
    assertEquals(
      swampStatAfter,
      null,
      "swamp directory should be cleaned up",
    );

    // But definitions directory should still exist
    const definitionsStatAfter = await Deno.stat(definitionsDir).catch(
      () => null,
    );
    assertEquals(
      definitionsStatAfter !== null && definitionsStatAfter.isDirectory,
      true,
      "definitions directory should still exist",
    );
  });
});

Deno.test("CLI: workflow delete command removes workflow and all runs", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create model definition so the workflow can run
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const testModel = Definition.create({
      name: "test-model",
      methods: { execute: { arguments: { run: "echo hello" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, testModel);

    // Create a workflow
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "delete-test-workflow",
      jobs: [
        Job.create({
          name: "shell-job",
          steps: [
            Step.create({
              name: "shell-step",
              task: StepTask.model("test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow to create run history
    const runResult = await runCliCommand(
      [
        "workflow",
        "run",
        "delete-test-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(runResult.code, 0, "Workflow run should succeed");

    // Delete the workflow
    const deleteResult = await runCliCommand(
      [
        "workflow",
        "delete",
        "delete-test-workflow",
        "--repo-dir",
        repoDir,
        "--force",
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      deleteResult.code,
      0,
      `Workflow delete should succeed. stderr: ${deleteResult.stderr}`,
    );

    const output = JSON.parse(deleteResult.stdout);
    assertEquals(output.deleted.name, "delete-test-workflow");
    assertEquals(output.runsDeleted, 1);

    // Verify workflow is gone
    const getResult = await runCliCommand(
      [
        "workflow",
        "get",
        "delete-test-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(getResult.code !== 0, true, "Workflow should not exist");
    assertStringIncludes(getResult.stderr + getResult.stdout, "not found");
  });
});

// Environment variable expression tests

Deno.test("CLI: workflow run evaluates env variable expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model with an env variable expression
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "env-test-model",
      methods: {
        execute: {
          arguments: {
            // Use env variable expression
            run: "echo ${{ env.SWAMP_TEST_VAR }}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that runs the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "env-var-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("env-test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow with env var set
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "env-var-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
      { SWAMP_TEST_VAR: "hello-from-env" },
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});

Deno.test("CLI: workflow run evaluates inline env expression with surrounding text", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model with an inline env expression (not the entire value)
    const definitionRepo = new YamlDefinitionRepository(repoDir);

    const inlineEnvModel = Definition.create({
      name: "inline-env-model",
      methods: {
        execute: {
          arguments: {
            // Inline env expression with surrounding text
            run: "echo prefix-${{ env.SWAMP_VAR }}-suffix",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, inlineEnvModel);

    // Create a workflow that runs the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "inline-env-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-inline",
              task: StepTask.model("inline-env-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow with env var set
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "inline-env-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
      { SWAMP_VAR: "middle" },
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
  });
});

// Vault expression tests in workflows

Deno.test("CLI: workflow run resolves vault expressions in model inputs", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // 1. Create a local_encryption vault via CLI
    const vaultCreateResult = await runCliCommand(
      [
        "vault",
        "create",
        "local_encryption",
        "workflow-vault",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      vaultCreateResult.code,
      0,
      `Vault create should succeed. stderr: ${vaultCreateResult.stderr}`,
    );

    // 2. Store a secret in the vault using vault put
    const secretValue = "secret-from-vault-123";
    const vaultPutResult = await runCliCommand(
      [
        "vault",
        "put",
        "workflow-vault",
        `API_KEY=${secretValue}`,
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      vaultPutResult.code,
      0,
      `Vault put should succeed. stderr: ${vaultPutResult.stderr}`,
    );

    // 3. Create a model that uses a vault.get() expression
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "vault-model",
      methods: {
        execute: {
          arguments: {
            // Use vault expression to get the secret
            run: "echo ${{ vault.get(workflow-vault, API_KEY) }}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // 4. Create a workflow that runs the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "vault-workflow",
      jobs: [
        Job.create({
          name: "run-vault-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("vault-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // 5. Run the workflow
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "vault-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow run should succeed. stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});

// Data artifact tracking tests

Deno.test("CLI: workflow run creates Data with step-output tags", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model input
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "data-tag-test-model",
      methods: {
        execute: {
          arguments: {
            run: "echo 'test message for data tags'",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow that runs the model
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "data-tag-workflow",
      jobs: [
        Job.create({
          name: "data-job",
          steps: [
            Step.create({
              name: "run-data",
              task: StepTask.model("data-tag-test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "data-tag-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow run should succeed. stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");

    // Verify the step run has data artifacts with correct tags
    const stepOutput = output.jobs[0].steps[0];
    assertEquals(
      stepOutput.dataArtifacts !== undefined,
      true,
      "Step output should have dataArtifacts",
    );
    assertEquals(
      stepOutput.dataArtifacts.length > 0,
      true,
      "Should have at least one data artifact",
    );

    // Verify tags on the data artifact
    const artifact = stepOutput.dataArtifacts[0];
    assertEquals(
      artifact.tags.source,
      "step-output",
      "Tag source should be step-output",
    );
    assertEquals(
      artifact.tags.workflow,
      "data-tag-workflow",
      "Tag workflow should match workflow name",
    );
    assertEquals(
      artifact.tags.step,
      "run-data",
      "Tag step should match step name",
    );
  });
});

Deno.test("CLI: workflow run persists data artifacts in workflow run record", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    // Create a model input
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const input = Definition.create({
      name: "persist-test-model",
      methods: {
        execute: {
          arguments: {
            run: "echo 'test message for persistence'",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, input);

    // Create a workflow
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "persist-workflow",
      jobs: [
        Job.create({
          name: "persist-job",
          steps: [
            Step.create({
              name: "run-persist",
              task: StepTask.model("persist-test-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run the workflow
    const runResult = await runCliCommand(
      [
        "workflow",
        "run",
        "persist-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      runResult.code,
      0,
      `Workflow run should succeed. stderr: ${runResult.stderr}`,
    );

    const runOutput = JSON.parse(runResult.stdout);
    assertEquals(runOutput.status, "succeeded", "Workflow should succeed");

    // Verify data artifacts are in the run output
    const stepData = runOutput.jobs[0].steps[0];
    assertEquals(
      stepData.dataArtifacts !== undefined && stepData.dataArtifacts.length > 0,
      true,
      "Step should have data artifacts",
    );

    // Verify tags are correct
    assertEquals(
      stepData.dataArtifacts[0].tags.source,
      "step-output",
      "Tag source should be step-output",
    );
    assertEquals(
      stepData.dataArtifacts[0].tags.workflow,
      "persist-workflow",
      "Tag workflow should match",
    );
    assertEquals(
      stepData.dataArtifacts[0].tags.step,
      "run-persist",
      "Tag step should match",
    );
  });
});

// workflow nesting tests (workflow calling workflow)

Deno.test("CLI: workflow run executes nested workflow via type: workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create shell model definitions
    const childShell = Definition.create({
      name: "child-shell",
      methods: {
        execute: { arguments: { run: "echo 'Hello from child workflow'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, childShell);

    const parentShell = Definition.create({
      name: "parent-shell",
      methods: {
        execute: { arguments: { run: "echo 'Hello from parent workflow'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, parentShell);

    // Create the child workflow
    const childWorkflow = Workflow.create({
      name: "child-workflow",
      jobs: [
        Job.create({
          name: "child-job",
          steps: [
            Step.create({
              name: "child-shell-step",
              task: StepTask.model("child-shell", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    // Create the parent workflow that calls the child workflow
    const parentWorkflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "parent-shell-job",
          steps: [
            Step.create({
              name: "parent-shell-step",
              task: StepTask.model("parent-shell", "execute"),
            }),
          ],
        }),
        Job.create({
          name: "call-child-job",
          steps: [
            Step.create({
              name: "invoke-child",
              task: StepTask.workflow("child-workflow"),
            }),
          ],
          dependsOn: [
            {
              job: "parent-shell-job",
              condition: TriggerCondition.succeeded(),
            },
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    // Run the parent workflow
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "parent-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Parent workflow should succeed. stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.workflowName, "parent-workflow");

    // Verify parent shell job succeeded
    const parentJob = output.jobs.find(
      (j: { name: string }) => j.name === "parent-shell-job",
    );
    assertEquals(parentJob?.status, "succeeded");
    assertEquals(parentJob?.steps[0]?.status, "succeeded");

    // Verify child workflow invocation job succeeded
    const childJob = output.jobs.find(
      (j: { name: string }) => j.name === "call-child-job",
    );
    assertEquals(childJob?.status, "succeeded");
    assertEquals(childJob?.steps[0]?.status, "succeeded");
  });
});

Deno.test("CLI: workflow run detects direct workflow cycle", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create a workflow that calls itself
    const selfCallingWorkflow = Workflow.create({
      name: "self-calling",
      jobs: [
        Job.create({
          name: "recursive-job",
          steps: [
            Step.create({
              name: "call-self",
              task: StepTask.workflow("self-calling"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(selfCallingWorkflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "self-calling",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    // Workflow should fail due to cycle detection
    assertEquals(
      result.code !== 0,
      true,
      `Self-calling workflow should fail. stdout: ${result.stdout}`,
    );
  });
});
