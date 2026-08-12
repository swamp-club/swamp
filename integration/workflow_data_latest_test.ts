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

import { assertEquals } from "@std/assert";
import { CLI_ARGS, initializeTestRepo } from "./test_helpers.ts";
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
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-latest-" });
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

Deno.test("workflow run: data.latest() sees writes from earlier steps after guard caches null", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const producer = Definition.create({
      name: "producer",
      methods: { execute: { arguments: { run: "echo producer-output" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, producer);

    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "guard-then-consume",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "produce",
              guard: '${{ data.latest("producer", "result") }}',
              task: StepTask.model("producer", "execute"),
            }),
            Step.create({
              name: "consume",
              dependsOn: [{
                step: "produce",
                condition: TriggerCondition.completed(),
              }],
              task: StepTask.assert(
                'data.latest("producer", "result") != null',
                "data.latest must see the data written by the produce step",
              ),
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
        "guard-then-consume",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
    assertEquals(output.jobs[0].steps[1].status, "succeeded");
  });
});

Deno.test("workflow run: data.latest() sees writes regardless of read ordering", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const stamper = Definition.create({
      name: "stamper",
      methods: { execute: { arguments: { run: "echo stamped" } } },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, stamper);

    const repo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "read-order-independent",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "early-read",
              task: StepTask.assert(
                'data.latest("stamper", "result") == null || data.latest("stamper", "result") != null',
                "early read — touches the coordinates before the write",
              ),
            }),
            Step.create({
              name: "write",
              dependsOn: [{
                step: "early-read",
                condition: TriggerCondition.succeeded(),
              }],
              task: StepTask.model("stamper", "execute"),
            }),
            Step.create({
              name: "late-read",
              dependsOn: [{
                step: "write",
                condition: TriggerCondition.completed(),
              }],
              task: StepTask.assert(
                'data.latest("stamper", "result") != null',
                "late read must see the data written by the write step",
              ),
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
        "read-order-independent",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
    assertEquals(output.jobs[0].steps[1].status, "succeeded");
    assertEquals(output.jobs[0].steps[2].status, "succeeded");
  });
});
