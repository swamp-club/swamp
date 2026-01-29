/**
 * Integration tests for the workflow commands.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
            task: StepTask.shell("echo", { args: ["building..."] }),
          }),
        ],
      }),
      Job.create({
        name: "test",
        description: "Test job",
        steps: [
          Step.create({
            name: "unit",
            task: StepTask.shell("echo", { args: ["testing..."] }),
          }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded("build") },
        ],
      }),
    ],
  });
}

// workflow create tests

Deno.test("CLI: workflow create creates new workflow file", async () => {
  await withTempDir(async (repoDir) => {
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
    assertStringIncludes(output.path, "workflows/workflow-");
  });
});

Deno.test("CLI: workflow create rejects duplicate names", async () => {
  await withTempDir(async (repoDir) => {
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
    assertStringIncludes(result.stderr, "already exists");
  });
});

// workflow get tests

Deno.test("CLI: workflow get shows workflow details", async () => {
  await withTempDir(async (repoDir) => {
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
    assertStringIncludes(result.stderr, "not found");
  });
});

// workflow validate tests

Deno.test("CLI: workflow validate passes for valid workflow", async () => {
  await withTempDir(async (repoDir) => {
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
    assertStringIncludes(result.stderr, "No workflows found");
  });
});

// workflow search tests

Deno.test("CLI: workflow search returns all workflows in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
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

Deno.test("CLI: workflow search filters by query in JSON mode", async () => {
  await withTempDir(async (repoDir) => {
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

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 1);
    assertEquals(output.results[0].name, "alpha-workflow");
  });
});

// workflow run tests

Deno.test("CLI: workflow run executes simple workflow", async () => {
  await withTempDir(async (repoDir) => {
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "simple-run",
      jobs: [
        Job.create({
          name: "echo-job",
          steps: [
            Step.create({
              name: "echo-step",
              task: StepTask.shell("echo", { args: ["hello"] }),
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
    assertEquals(output.jobs[0].name, "echo-job");
    assertEquals(output.jobs[0].status, "succeeded");
  });
});

Deno.test("CLI: workflow run executes workflow with dependencies", async () => {
  await withTempDir(async (repoDir) => {
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
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "failing-workflow",
      jobs: [
        Job.create({
          name: "failing-job",
          steps: [
            Step.create({
              name: "failing-step",
              task: StepTask.shell("false"), // 'false' command always exits with 1
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
    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "conditional-skip",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "fail",
              task: StepTask.shell("false"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "run",
              task: StepTask.shell("echo", { args: ["test"] }),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded("build") },
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
    assertStringIncludes(result.stderr, "not found");
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
