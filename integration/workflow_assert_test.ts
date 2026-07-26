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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { CLI_ARGS, initializeTestRepo } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-assert-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
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

async function saveWorkflow(
  repoDir: string,
  workflow: Workflow,
): Promise<void> {
  const repo = new YamlWorkflowRepository(repoDir);
  await repo.save(workflow);
}

Deno.test("workflow assert: passing assert step succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "assert-pass-test",
      description: "Test passing assertions",
      jobs: [
        Job.create({
          name: "verify",
          steps: [
            Step.create({
              name: "always-true",
              task: StepTask.assert("1 == 1", "Math is broken", "high"),
            }),
          ],
        }),
      ],
    });
    await saveWorkflow(repoDir, workflow);

    const result = await runCliCommand(
      ["workflow", "run", "assert-pass-test", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `stderr: ${result.stderr}`);
  });
});

Deno.test("workflow assert: failing assert step fails the run", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "assert-fail-test",
      description: "Test failing assertions",
      jobs: [
        Job.create({
          name: "verify",
          steps: [
            Step.create({
              name: "always-false",
              task: StepTask.assert("1 == 2", "Expected equality", "high"),
            }),
          ],
        }),
      ],
    });
    await saveWorkflow(repoDir, workflow);

    const result = await runCliCommand(
      ["workflow", "run", "assert-fail-test", "--repo-dir", repoDir],
      Deno.cwd(),
    );

    assertEquals(result.code, 1);
  });
});

Deno.test("workflow assert: --junit flag produces JUnit XML", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "assert-junit-test",
      description: "Test JUnit output",
      jobs: [
        Job.create({
          name: "verify",
          steps: [
            Step.create({
              name: "check-true",
              task: StepTask.assert("true", "Should pass", "high"),
            }),
            Step.create({
              name: "check-false",
              task: StepTask.assert("false", "Should fail", "medium"),
            }),
          ],
        }),
      ],
    });
    await saveWorkflow(repoDir, workflow);

    const outFile = join(repoDir, "results.xml");
    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "assert-junit-test",
        "--junit",
        "--out",
        outFile,
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );

    const xml = await Deno.readTextFile(outFile);
    assertStringIncludes(xml, '<?xml version="1.0"');
    assertStringIncludes(xml, 'name="assert-junit-test"');
    assertStringIncludes(xml, 'name="check-true"');
    assertStringIncludes(xml, 'name="check-false"');
    assertStringIncludes(xml, "<failure");
    assertStringIncludes(xml, "Should fail");
    assertEquals(result.code, 1);
  });
});

Deno.test("workflow assert: assert results persist in workflow run", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "assert-persist-test",
      description: "Test assert result persistence",
      jobs: [
        Job.create({
          name: "verify",
          steps: [
            Step.create({
              name: "check-pass",
              task: StepTask.assert("2 + 2 == 4", "Math check", "high"),
            }),
          ],
        }),
      ],
    });
    await saveWorkflow(repoDir, workflow);

    const runResult = await runCliCommand(
      [
        "workflow",
        "run",
        "assert-persist-test",
        "--json",
        "--repo-dir",
        repoDir,
      ],
      Deno.cwd(),
    );

    assertEquals(runResult.code, 0, `stderr: ${runResult.stderr}`);
    const runData = JSON.parse(runResult.stdout);
    const step = runData.jobs[0].steps[0];
    assertEquals(step.assertResult.passed, true);
    assertEquals(step.assertResult.severity, "high");
    assertStringIncludes(step.assertResult.expr, "2 + 2 == 4");
  });
});
