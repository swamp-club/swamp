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
import { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { YamlWorkflowRunRepository } from "../persistence/yaml_workflow_run_repository.ts";
import { reconcileRefusedRuns } from "./refused_run_records.ts";

const DATA_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

async function withRuns(
  fn: (repo: YamlWorkflowRunRepository, workflow: Workflow) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-refused-runs-" });
  try {
    const workflow = Workflow.create({
      name: "flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      })],
    });
    await fn(new YamlWorkflowRunRepository(dir), workflow);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function succeeded(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const job of run.jobs) {
    job.start();
    for (const step of job.steps) {
      step.start();
      step.succeed();
    }
    job.succeed();
  }
  run.complete();
  return run;
}

function refusal(workflow: Workflow, run: WorkflowRun): PartitionsRefusedError {
  return new PartitionsRefusedError(
    [{
      partition: partitionOf({
        kind: "definition",
        id: "55555555-5555-4555-8555-555555555555",
      }),
      reason: "version-live",
      message: "refused",
      versions: [{ dataId: DATA_ID, version: 1 }],
    }],
    [partitionOf({ kind: "run", workflowId: workflow.id, runId: run.id })],
  );
}

Deno.test("reconcileRefusedRuns: saves a held run with the step that wrote refused data failed", async () => {
  await withRuns(async (repo, workflow) => {
    const run = succeeded(workflow);
    run.getJob("main")!.getStep("s")!.addDataArtifact({
      dataId: DATA_ID,
      name: "result",
      version: 1,
      tags: {},
    });
    await repo.save(workflow.id, run);

    await reconcileRefusedRuns(repo, refusal(workflow, run));

    const saved = await repo.findById(workflow.id, run.id);
    assertEquals(saved?.status, "failed");
    assertEquals(saved?.getJob("main")?.getStep("s")?.status, "failed");
  });
});

Deno.test("reconcileRefusedRuns: saves a run failed only by a workflow-scope report artifact", async () => {
  await withRuns(async (repo, workflow) => {
    const run = succeeded(workflow);
    run.addWorkflowDataArtifact({
      dataId: DATA_ID,
      name: "report",
      version: 1,
      tags: {},
    });
    await repo.save(workflow.id, run);

    await reconcileRefusedRuns(repo, refusal(workflow, run));

    const saved = await repo.findById(workflow.id, run.id);
    assertEquals(saved?.status, "failed");
    assertEquals(saved?.getJob("main")?.getStep("s")?.status, "succeeded");
  });
});

Deno.test("reconcileRefusedRuns: leaves a held run that names no refused data unsaved", async () => {
  await withRuns(async (repo, workflow) => {
    const run = succeeded(workflow);
    await repo.save(workflow.id, run);
    const path = repo.getPath(workflow.id, run.id);
    const before = await Deno.readTextFile(path);

    await reconcileRefusedRuns(repo, refusal(workflow, run));

    assertEquals(await Deno.readTextFile(path), before);
  });
});
