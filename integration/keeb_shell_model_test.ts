/**
 * Integration tests for keeb/shell models with workflow execution.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/keeb/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-keeb-shell-" });
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

Deno.test("CLI: keeb/shell model executes simple shell commands", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create a shell model that echoes a message
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "simple-shell",
      attributes: {
        run: "echo 'Hello from shell'",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    // Execute the model
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "simple-shell",
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
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "simple-shell");
    assertEquals(output.data.attributes.exitCode, 0);
  });
});

Deno.test("CLI: keeb/shell model handles failing commands", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create a shell model that runs a failing command
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "failing-shell",
      attributes: {
        run: "false", // Command that always fails
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, definition);

    // Execute the model
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "failing-shell",
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
      `swamp command should succeed even when shell command fails. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "failing-shell");
    assertEquals(output.data.attributes.exitCode, 1); // Shell command failed
  });
});

Deno.test("CLI: workflow with keeb/shell models and dependencies", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);

    // Create first model that creates a file
    const downloadModel = Definition.create({
      name: "download-data",
      attributes: {
        run: "echo 'Downloaded data' > /tmp/data.txt",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, downloadModel);

    // Create second model that processes the file
    const processModel = Definition.create({
      name: "process-data",
      attributes: {
        run: "echo 'Processing: $(cat /tmp/data.txt)' > /tmp/processed.txt",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, processModel);

    // Create workflow with dependencies
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "shell-workflow",
      description: "Test workflow with keeb/shell models",
      jobs: [
        Job.create({
          name: "download",
          description: "Download data",
          steps: [
            Step.create({
              name: "download-step",
              task: StepTask.model("download-data", "execute"),
            }),
          ],
        }),
        Job.create({
          name: "process",
          description: "Process data",
          steps: [
            Step.create({
              name: "process-step",
              task: StepTask.model("process-data", "execute"),
            }),
          ],
          dependsOn: [
            {
              job: "download",
              condition: TriggerCondition.succeeded(),
            },
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
        "shell-workflow",
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
    assertEquals(output.jobs.length, 2);
    assertEquals(output.jobs[0].name, "download");
    assertEquals(output.jobs[0].status, "succeeded");
    assertEquals(output.jobs[1].name, "process");
    assertEquals(output.jobs[1].status, "succeeded");
  });
});

Deno.test("CLI: keeb/shell model with cross-model expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);

    // Create source model
    const sourceModel = Definition.create({
      name: "source-shell",
      attributes: {
        run: "echo 'Source command executed'",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, sourceModel);

    // Create dependent model that references the source model
    const dependentModel = Definition.create({
      name: "dependent-shell",
      attributes: {
        run:
          "echo 'Referencing: ${{ model.source-shell.input.attributes.run }}'",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, dependentModel);

    // Create workflow that runs both models
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "cross-ref-workflow",
      jobs: [
        Job.create({
          name: "run-models",
          steps: [
            Step.create({
              name: "run-source",
              task: StepTask.model("source-shell", "execute"),
            }),
            Step.create({
              name: "run-dependent",
              task: StepTask.model("dependent-shell", "execute"),
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

    // Run the workflow
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "cross-ref-workflow",
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
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
    assertEquals(output.jobs[0].steps[1].status, "succeeded");
  });
});

Deno.test("CLI: keeb/shell model with self-reference expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);

    // Create model that references its own name
    const selfRefModel = Definition.create({
      name: "self-ref-shell",
      attributes: {
        run: "echo 'My name is ${{ self.name }}'",
        workingDir: "/tmp",
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, selfRefModel);

    // Execute the model
    const result = await runCliCommand(
      [
        "model",
        "method",
        "run",
        "self-ref-shell",
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
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.modelName, "self-ref-shell");
    assertEquals(output.data.attributes.exitCode, 0);
  });
});
