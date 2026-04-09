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
 * Integration tests for workflows with the new architecture.
 *
 * Tests the full flow:
 * 1. Create workflow referencing model definitions
 * 2. Run workflow, verify Data created for each step
 * 3. Verify workflow run tracking
 * 4. Edge cases (errors, validation failures)
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-arch-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, "models"));
  await ensureDir(join(dir, "workflows"));
  await ensureDir(join(dir, ".swamp", "workflow-runs"));
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, ".swamp", "outputs"));
  await ensureDir(join(dir, ".swamp", "logs"));
  await ensureDir(join(dir, "workflows"));

  // Create the .swamp.yaml marker file for CLI commands
  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(dir, ".swamp.yaml"),
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

// ============================================================================
// Workflow Referencing Model Definitions
// ============================================================================

Deno.test("Workflow Architecture: workflow references model by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create model definition
    const model = Definition.create({
      name: "my-shell-model",
      methods: { execute: { arguments: { run: "echo 'Hello from model'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    // Create workflow that references the model
    const workflow = Workflow.create({
      name: "model-ref-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model("my-shell-model", "execute"),
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
        "model-ref-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs.length, 1);
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});

Deno.test("Workflow Architecture: workflow references model by UUID", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create model definition
    const model = Definition.create({
      name: "uuid-ref-model",
      methods: { execute: { arguments: { run: "echo 'Referenced by UUID'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    // Create workflow that references model by UUID
    const workflow = Workflow.create({
      name: "uuid-ref-workflow",
      jobs: [
        Job.create({
          name: "run-model",
          steps: [
            Step.create({
              name: "run-shell",
              task: StepTask.model(model.id, "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "uuid-ref-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0);
    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
  });
});

// ============================================================================
// Data Creation per Step
// ============================================================================

Deno.test("Workflow Architecture: step creates Data artifact", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create model
    const model = Definition.create({
      name: "data-creator-model",
      methods: {
        execute: { arguments: { run: "echo 'Creating data artifact'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    // Create workflow
    const workflow = Workflow.create({
      name: "data-artifact-workflow",
      jobs: [
        Job.create({
          name: "create-data",
          steps: [
            Step.create({
              name: "run-data",
              task: StepTask.model("data-creator-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "data-artifact-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow run should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(
      output.status,
      "succeeded",
      `Workflow status should be succeeded: ${JSON.stringify(output)}`,
    );

    // Verify jobs array exists
    assertExists(
      output.jobs,
      `Output should have jobs: ${JSON.stringify(output)}`,
    );
    assertEquals(output.jobs.length > 0, true, "Should have at least one job");

    // Verify data artifact was created
    const stepData = output.jobs[0].steps[0];
    assertExists(stepData, "First step should exist");
    assertExists(
      stepData.dataArtifacts,
      `Step should have dataArtifacts: ${JSON.stringify(stepData)}`,
    );
    assertEquals(stepData.dataArtifacts.length > 0, true);

    // Verify artifact has correct tags
    const artifact = stepData.dataArtifacts[0];
    assertExists(artifact.dataId);
    assertExists(artifact.version);
    assertExists(artifact.tags);
    assertEquals(artifact.tags.source, "step-output");
    assertEquals(artifact.tags.workflow, "data-artifact-workflow");
    assertEquals(artifact.tags.step, "run-data");
  });
});

Deno.test("Workflow Architecture: multiple steps create multiple Data artifacts", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create multiple models
    const model1 = Definition.create({
      name: "model-one",
      methods: { execute: { arguments: { run: "echo 'First model'" } } },
    });
    const model2 = Definition.create({
      name: "model-two",
      methods: { execute: { arguments: { run: "echo 'Second model'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model1);
    await definitionRepo.save(SHELL_MODEL_TYPE, model2);

    // Create workflow with multiple steps
    const workflow = Workflow.create({
      name: "multi-step-workflow",
      jobs: [
        Job.create({
          name: "multi-step-job",
          steps: [
            Step.create({
              name: "step-one",
              task: StepTask.model("model-one", "execute"),
            }),
            Step.create({
              name: "step-two",
              task: StepTask.model("model-two", "execute"),
              dependsOn: [
                {
                  step: "step-one",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "multi-step-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0);

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps.length, 2);

    // Both steps should have artifacts
    for (const step of output.jobs[0].steps) {
      assertEquals(step.status, "succeeded");
      assertExists(step.dataArtifacts);
      assertEquals(step.dataArtifacts.length > 0, true);
    }

    // Verify different step tags
    assertEquals(
      output.jobs[0].steps[0].dataArtifacts[0].tags.step,
      "step-one",
    );
    assertEquals(
      output.jobs[0].steps[1].dataArtifacts[0].tags.step,
      "step-two",
    );
  });
});

// ============================================================================
// Workflow Run Tracking
// ============================================================================

Deno.test("Workflow Architecture: workflow run is persisted", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflowRunRepo = new YamlWorkflowRunRepository(repoDir);

    // Create model and workflow
    const model = Definition.create({
      name: "tracked-model",
      methods: { execute: { arguments: { run: "echo 'Tracked execution'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "tracked-workflow",
      jobs: [
        Job.create({
          name: "tracked-job",
          steps: [
            Step.create({
              name: "tracked-step",
              task: StepTask.model("tracked-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run workflow
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "tracked-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0);
    const _output = JSON.parse(result.stdout);

    // Verify run was persisted
    const runs = await workflowRunRepo.findAllByWorkflowId(workflow.id);
    assertEquals(runs.length, 1);

    const run = runs[0];
    assertEquals(run.status, "succeeded");
    assertEquals(run.workflowId, workflow.id);
    assertExists(run.startedAt);
    assertExists(run.completedAt);
  });
});

Deno.test("Workflow Architecture: workflow run history", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflowRunRepo = new YamlWorkflowRunRepository(repoDir);

    const model = Definition.create({
      name: "history-model",
      methods: { execute: { arguments: { run: "echo 'History test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "history-workflow",
      jobs: [
        Job.create({
          name: "history-job",
          steps: [
            Step.create({
              name: "history-step",
              task: StepTask.model("history-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Run workflow 3 times
    for (let i = 0; i < 3; i++) {
      const result = await runCliCommand(
        [
          "workflow",
          "run",
          "history-workflow",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(result.code, 0);
    }

    // Check run history
    const runs = await workflowRunRepo.findAllByWorkflowId(workflow.id);
    assertEquals(runs.length, 3);

    // All should be succeeded
    for (const run of runs) {
      assertEquals(run.status, "succeeded");
    }
  });
});

Deno.test("Workflow Architecture: step execution duration is tracked", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const model = Definition.create({
      name: "timing-model",
      methods: { execute: { arguments: { run: "echo 'Timing test'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "timing-workflow",
      jobs: [
        Job.create({
          name: "timing-job",
          steps: [
            Step.create({
              name: "timing-step",
              task: StepTask.model("timing-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "timing-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Workflow should succeed: ${result.stderr}`);
    const output = JSON.parse(result.stdout);

    // Verify duration info is present
    assertExists(output.duration, "Workflow should have duration");

    const jobRun = output.jobs[0];
    assertExists(jobRun.duration, "Job should have duration");

    const stepRun = jobRun.steps[0];
    assertExists(stepRun.duration, "Step should have duration");

    // Durations should be non-negative
    assertEquals(
      output.duration >= 0,
      true,
      "Workflow duration should be non-negative",
    );
    assertEquals(
      jobRun.duration >= 0,
      true,
      "Job duration should be non-negative",
    );
    assertEquals(
      stepRun.duration >= 0,
      true,
      "Step duration should be non-negative",
    );
  });
});

// ============================================================================
// Error Handling and Validation Failures
// ============================================================================

Deno.test("Workflow Architecture: fails for non-existent model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create workflow referencing non-existent model
    const workflow = Workflow.create({
      name: "missing-model-workflow",
      jobs: [
        Job.create({
          name: "failing-job",
          steps: [
            Step.create({
              name: "missing-step",
              task: StepTask.model("nonexistent-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "missing-model-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr + result.stdout,
      "nonexistent-model",
    );
  });
});

Deno.test("Workflow Architecture: fails for invalid expression", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create model with invalid expression
    const model = Definition.create({
      name: "invalid-expr-model",
      methods: {
        execute: {
          arguments: {
            // Invalid expression syntax
            run: "${{invalid.syntax.here}}",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "invalid-expr-workflow",
      jobs: [
        Job.create({
          name: "invalid-job",
          steps: [
            Step.create({
              name: "invalid-step",
              task: StepTask.model("invalid-expr-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "invalid-expr-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 1);
    // Should contain validation error
    assertStringIncludes(result.stderr + result.stdout, "Expression");
  });
});

Deno.test("Workflow Architecture: step failure propagates correctly", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create workflow with failing shell step
    const workflow = Workflow.create({
      name: "failing-step-workflow",
      jobs: [
        Job.create({
          name: "failing-job",
          steps: [
            Step.create({
              name: "failing-step",
              task: StepTask.model("failing-model", "run"), // Always fails
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "failing-step-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 1);
    const output = JSON.parse(result.stdout);

    assertEquals(output.status, "failed");
    assertEquals(output.jobs[0].status, "failed");
    assertEquals(output.jobs[0].steps[0].status, "failed");
  });
});

Deno.test("Workflow Architecture: dependent step skipped on failure", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const model = Definition.create({
      name: "skip-test-model",
      methods: { execute: { arguments: { run: "echo 'Should be skipped'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "skip-on-failure-workflow",
      jobs: [
        Job.create({
          name: "conditional-job",
          steps: [
            Step.create({
              name: "failing-step",
              task: StepTask.model("failing-model", "run"),
            }),
            Step.create({
              name: "dependent-step",
              task: StepTask.model("skip-test-model", "execute"),
              dependsOn: [
                {
                  step: "failing-step",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "skip-on-failure-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 1);
    const output = JSON.parse(result.stdout);

    assertEquals(output.status, "failed");
    assertEquals(output.jobs[0].steps[0].status, "failed");
    // Dependent step stays pending when previous step fails
    assertEquals(
      output.jobs[0].steps[1].status === "pending" ||
        output.jobs[0].steps[1].status === "skipped",
      true,
      `Dependent step should be pending or skipped, got: ${
        output.jobs[0].steps[1].status
      }`,
    );
  });
});

// ============================================================================
// Expression Evaluation in Workflows
// ============================================================================

// Note: Expression evaluation in workflow execution is tested indirectly
// through the CEL Data Access tests. Direct workflow expression tests are
// skipped here due to complex model validation requirements.

// Note: Environment variable workflow tests are skipped here due to
// complex model validation requirements with the echo model.
// Env variable handling is tested in CEL Data Access tests.

// ============================================================================
// Data Lifecycle in Workflows
// ============================================================================

Deno.test("Workflow Architecture: data persists after workflow completion", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );

    const model = Definition.create({
      name: "persist-data-model",
      methods: { execute: { arguments: { run: "echo 'Persistent data'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "persist-data-workflow",
      jobs: [
        Job.create({
          name: "persist-job",
          steps: [
            Step.create({
              name: "persist-step",
              task: StepTask.model("persist-data-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "persist-data-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0);
    const output = JSON.parse(result.stdout);

    // Verify data artifact exists
    const artifactRef = output.jobs[0].steps[0].dataArtifacts[0];
    assertExists(artifactRef);

    // Load data from repository
    const allData = await dataRepo.findAllForModel(SHELL_MODEL_TYPE, model.id);
    assertEquals(allData.length > 0, true, "Data should be persisted");
  });
});

// Note: Data versioning across multiple workflow runs is tested in
// the Data Versioning tests. This test is skipped due to timing
// dependencies in version number assignment.

// ============================================================================
// Complex Workflow Scenarios
// ============================================================================

Deno.test("Workflow Architecture: multi-job workflow with dependencies", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create models for different stages
    const buildModel = Definition.create({
      name: "build-model",
      methods: { execute: { arguments: { run: "echo 'Building...'" } } },
    });
    const testModel = Definition.create({
      name: "test-model",
      methods: { execute: { arguments: { run: "echo 'Testing...'" } } },
    });
    const deployModel = Definition.create({
      name: "deploy-model",
      methods: { execute: { arguments: { run: "echo 'Deploying...'" } } },
    });

    await definitionRepo.save(SHELL_MODEL_TYPE, buildModel);
    await definitionRepo.save(SHELL_MODEL_TYPE, testModel);
    await definitionRepo.save(SHELL_MODEL_TYPE, deployModel);

    const workflow = Workflow.create({
      name: "multi-job-workflow",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("build-model", "execute"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "unit-tests",
              task: StepTask.model("test-model", "execute"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
        }),
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "deploy-step",
              task: StepTask.model("deploy-model", "execute"),
            }),
          ],
          dependsOn: [
            { job: "test", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "multi-job-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Should succeed: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs.length, 3);

    // All jobs should succeed
    assertEquals(output.jobs[0].name, "build");
    assertEquals(output.jobs[0].status, "succeeded");
    assertEquals(output.jobs[1].name, "test");
    assertEquals(output.jobs[1].status, "succeeded");
    assertEquals(output.jobs[2].name, "deploy");
    assertEquals(output.jobs[2].status, "succeeded");
  });
});

Deno.test("Workflow Architecture: mixed model steps", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const shellModel = Definition.create({
      name: "shell-model",
      methods: {
        execute: { arguments: { run: "echo 'Shell step replacement'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, shellModel);

    const mixedModel = Definition.create({
      name: "mixed-model",
      methods: { execute: { arguments: { run: "echo 'Model step'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, mixedModel);

    const finalModel = Definition.create({
      name: "final-model",
      methods: { execute: { arguments: { run: "echo 'Final step'" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, finalModel);

    const workflow = Workflow.create({
      name: "mixed-steps-workflow",
      jobs: [
        Job.create({
          name: "mixed-job",
          steps: [
            Step.create({
              name: "shell-step",
              task: StepTask.model("shell-model", "execute"),
            }),
            Step.create({
              name: "model-step",
              task: StepTask.model("mixed-model", "execute"),
              dependsOn: [
                {
                  step: "shell-step",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
            Step.create({
              name: "final-shell",
              task: StepTask.model("final-model", "execute"),
              dependsOn: [
                {
                  step: "model-step",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "mixed-steps-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Should succeed: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps.length, 3);

    for (const step of output.jobs[0].steps) {
      assertEquals(step.status, "succeeded");
    }
  });
});
