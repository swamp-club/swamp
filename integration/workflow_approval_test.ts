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
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-approval-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
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

Deno.test("Workflow: manual_approval step task schema round-trips through YAML", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "approval-test",
      jobs: [
        Job.create({
          name: "gate",
          steps: [
            Step.create({
              name: "verify-deploy",
              task: StepTask.manualApproval(
                "Verify the deployment is healthy",
                300,
              ),
            }),
          ],
        }),
      ],
    });

    const repo = new YamlWorkflowRepository(repoDir);
    await repo.save(workflow);

    const loaded = await repo.findById(workflow.id);
    assertEquals(loaded?.name, "approval-test");

    const step = loaded!.jobs[0].steps[0];
    assertEquals(step.task.isManualApproval(), true);
    assertEquals(step.task.data.type, "manual_approval");
    if (step.task.data.type === "manual_approval") {
      assertEquals(step.task.data.prompt, "Verify the deployment is healthy");
      assertEquals(step.task.data.timeout, 300);
    }
  });
});

Deno.test("Workflow: manual_approval with dependencies round-trips", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "gated-deploy",
      jobs: [
        Job.create({
          name: "build-and-deploy",
          steps: [
            Step.create({
              name: "build",
              task: StepTask.model("builder", "execute"),
            }),
            Step.create({
              name: "approval-gate",
              task: StepTask.manualApproval("Verify build before deploy"),
              dependsOn: [
                {
                  step: "build",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
            Step.create({
              name: "deploy",
              task: StepTask.model("deployer", "execute"),
              dependsOn: [
                {
                  step: "approval-gate",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    const repo = new YamlWorkflowRepository(repoDir);
    await repo.save(workflow);

    const loaded = await repo.findById(workflow.id);
    assertEquals(loaded!.jobs[0].steps.length, 3);
    assertEquals(loaded!.jobs[0].steps[1].task.isManualApproval(), true);
    assertEquals(loaded!.jobs[0].steps[2].task.isModelMethod(), true);
  });
});

Deno.test("Workflow: suspended run persists and round-trips", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflow = Workflow.create({
      name: "suspend-test",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("m", "run"),
            }),
          ],
        }),
      ],
    });

    const workflowRepo = new YamlWorkflowRepository(repoDir);
    await workflowRepo.save(workflow);

    const { WorkflowRun } = await import(
      "../src/domain/workflows/workflow_run.ts"
    );
    const run = WorkflowRun.create(workflow);
    run.start();

    const job = run.getJob("job1")!;
    job.start();
    const step = job.getStep("step1")!;
    step.start();
    step.waitForApproval();
    run.suspend();

    const runRepo = new YamlWorkflowRunRepository(repoDir);
    await runRepo.save(workflow.id, run);

    const loaded = await runRepo.findById(workflow.id, run.id);
    assertEquals(loaded!.status, "suspended");
    const loadedStep = loaded!.getJob("job1")!.getStep("step1")!;
    assertEquals(loadedStep.status, "waiting_approval");
  });
});
