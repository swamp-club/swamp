// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
 * Integration tests for the `workflow run search` command.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-search-" });
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

/**
 * Creates a shell model definition and a simple workflow that uses it.
 */
async function createModelAndWorkflow(
  repoDir: string,
  modelName: string,
  workflowName: string,
): Promise<void> {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const model = Definition.create({
    name: modelName,
    methods: { execute: { arguments: { run: "echo test" } } },
  });
  await definitionRepo.save(SHELL_MODEL_TYPE, model);

  const workflowRepo = new YamlWorkflowRepository(repoDir);
  const workflow = Workflow.create({
    name: workflowName,
    jobs: [
      Job.create({
        name: "test-job",
        steps: [
          Step.create({
            name: "test-step",
            task: StepTask.model(modelName, "execute"),
          }),
        ],
      }),
    ],
  });
  await workflowRepo.save(workflow);
}

/**
 * Runs a workflow and returns the CLI result.
 */
async function executeWorkflow(
  repoDir: string,
  workflowName: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await runCliCommand(
    ["workflow", "run", workflowName, "--repo-dir", repoDir, "--json"],
    Deno.cwd(),
  );
}

// Tests

Deno.test("CLI: workflow run search returns all runs", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createModelAndWorkflow(repoDir, "search-model", "search-workflow");

    // Run the workflow twice
    const run1 = await executeWorkflow(repoDir, "search-workflow");
    assertEquals(
      run1.code,
      0,
      `First run should succeed. stderr: ${run1.stderr}`,
    );
    const run2 = await executeWorkflow(repoDir, "search-workflow");
    assertEquals(
      run2.code,
      0,
      `Second run should succeed. stderr: ${run2.stderr}`,
    );

    // Search for all runs
    const result = await runCliCommand(
      ["workflow", "run", "search", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);
    assertEquals(output.results[0].workflowName, "search-workflow");
    assertEquals(output.results[0].status, "succeeded");
  });
});

Deno.test("CLI: workflow run search filters by --status", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createModelAndWorkflow(repoDir, "status-model", "status-workflow");

    // Run the workflow (it should succeed)
    const run = await executeWorkflow(repoDir, "status-workflow");
    assertEquals(run.code, 0, `Run should succeed. stderr: ${run.stderr}`);

    // Search with --status succeeded
    const succeededResult = await runCliCommand(
      [
        "workflow",
        "run",
        "search",
        "--status",
        "succeeded",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      succeededResult.code,
      0,
      `Search should succeed. stderr: ${succeededResult.stderr}`,
    );
    const succeededOutput = JSON.parse(succeededResult.stdout);
    assertEquals(succeededOutput.results.length, 1);
    assertEquals(succeededOutput.results[0].status, "succeeded");

    // Search with --status failed (should return no results)
    const failedResult = await runCliCommand(
      [
        "workflow",
        "run",
        "search",
        "--status",
        "failed",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );
    assertEquals(
      failedResult.code,
      0,
      `Search should succeed. stderr: ${failedResult.stderr}`,
    );
    const failedOutput = JSON.parse(failedResult.stdout);
    assertEquals(failedOutput.results.length, 0);
  });
});

Deno.test("CLI: workflow run search filters by --workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create two different workflows
    await createModelAndWorkflow(repoDir, "alpha-model", "alpha-workflow");
    await createModelAndWorkflow(repoDir, "beta-model", "beta-workflow");

    // Run each workflow
    const runAlpha = await executeWorkflow(repoDir, "alpha-workflow");
    assertEquals(
      runAlpha.code,
      0,
      `Alpha run should succeed. stderr: ${runAlpha.stderr}`,
    );
    const runBeta = await executeWorkflow(repoDir, "beta-workflow");
    assertEquals(
      runBeta.code,
      0,
      `Beta run should succeed. stderr: ${runBeta.stderr}`,
    );

    // Search for alpha only
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "search",
        "--workflow",
        "alpha-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 1);
    assertEquals(output.results[0].workflowName, "alpha-workflow");
  });
});

Deno.test("CLI: workflow run search filters by --since", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createModelAndWorkflow(repoDir, "since-model", "since-workflow");

    // Run the workflow (just ran, so it's within --since 1h)
    const run = await executeWorkflow(repoDir, "since-workflow");
    assertEquals(run.code, 0, `Run should succeed. stderr: ${run.stderr}`);

    // Search with --since 1h (should include the recent run)
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "search",
        "--since",
        "1h",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 1);
    assertEquals(output.results[0].workflowName, "since-workflow");
  });
});

Deno.test("CLI: workflow run search with query filters by text", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createModelAndWorkflow(repoDir, "query-model-a", "query-wf-alpha");
    await createModelAndWorkflow(repoDir, "query-model-b", "query-wf-beta");

    const runAlpha = await executeWorkflow(repoDir, "query-wf-alpha");
    assertEquals(
      runAlpha.code,
      0,
      `Alpha run should succeed. stderr: ${runAlpha.stderr}`,
    );
    const runBeta = await executeWorkflow(repoDir, "query-wf-beta");
    assertEquals(
      runBeta.code,
      0,
      `Beta run should succeed. stderr: ${runBeta.stderr}`,
    );

    // Search with query "alpha"
    const result = await runCliCommand(
      [
        "workflow",
        "run",
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
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 1);
    assertEquals(output.results[0].workflowName, "query-wf-alpha");
  });
});

Deno.test("CLI: workflow run search with no runs returns empty", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const result = await runCliCommand(
      ["workflow", "run", "search", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 0);
    assertEquals(output.query, "");
  });
});

Deno.test("CLI: workflow run search respects --limit", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createModelAndWorkflow(repoDir, "limit-model", "limit-workflow");

    // Run the workflow 3 times
    for (let i = 0; i < 3; i++) {
      const run = await executeWorkflow(repoDir, "limit-workflow");
      assertEquals(
        run.code,
        0,
        `Run ${i + 1} should succeed. stderr: ${run.stderr}`,
      );
    }

    // Search with --limit 2
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "search",
        "--limit",
        "2",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Search should succeed. stderr: ${result.stderr}`,
    );
    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);
  });
});
