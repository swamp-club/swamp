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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import {
  INDEXED_INPUT_MAX_BYTES,
  INDEXED_INPUTS_MAX_BYTES,
} from "../src/domain/workflows/workflow_run_summary.ts";
import {
  getIndexPath,
  readRunIndex,
} from "../src/infrastructure/persistence/workflow_run_index.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchEvent,
} from "../src/libswamp/workflows/run_search.ts";
import {
  workflowHistorySearch,
  type WorkflowHistorySearchEvent,
} from "../src/libswamp/workflows/history_search.ts";
import "../src/domain/models/models.ts";

const LARGE_INPUT_BYTES = 200 * 1024;

async function withRepoDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-index-append-" });
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

function webhookWorkflow(): Workflow {
  return Workflow.create({
    name: "webhook",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "step",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

async function saveLargeRun(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  body: string,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.captureInputs({ source: "github", body });
  run.start();
  await repo.save(workflow.id, run);
  return run;
}

/** bytes the index grows by when an existing run moves on */
async function bytesOneSaveAppends(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
  run: WorkflowRun,
  indexPath: string,
): Promise<number> {
  const before = (await Deno.stat(indexPath)).size;
  run.complete();
  await repo.save(workflow.id, run);
  return (await Deno.stat(indexPath)).size - before;
}

Deno.test("YamlWorkflowRunRepository.save: the bytes one save adds do not grow with the large inputs of retained runs", async () => {
  await withRepoDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const workflow = webhookWorkflow();
    const indexPath = getIndexPath(
      join(dir, ".swamp", "workflow-runs", workflow.id),
    );
    const body = "x".repeat(LARGE_INPUT_BYTES);

    const first = await saveLargeRun(repo, workflow, body);
    const withOneRun = await bytesOneSaveAppends(
      repo,
      workflow,
      first,
      indexPath,
    );

    for (let i = 0; i < 50; i++) await saveLargeRun(repo, workflow, body);
    const last = await saveLargeRun(repo, workflow, body);
    const withManyRuns = await bytesOneSaveAppends(
      repo,
      workflow,
      last,
      indexPath,
    );

    // The lines differ only in their record fingerprints' digits.
    assert(Math.abs(withManyRuns - withOneRun) < 64);
    assert(withOneRun < LARGE_INPUT_BYTES / 10);
    // 4096 bytes of slack per entry for its fields besides inputs.
    const size = (await Deno.stat(indexPath)).size;
    assert(size < 52 * 2 * (INDEXED_INPUTS_MAX_BYTES + 4096));
    const entries = (await readRunIndex(join(indexPath, "..")))!.entries;
    assertEquals(Object.keys(entries).length, 52);
    for (const entry of Object.values(entries)) {
      assertEquals(entry.inputs, { source: "github" });
      assertEquals(entry.inputsOmitted, ["body"]);
    }
  });
});

Deno.test("workflowRunSearch and workflowHistorySearch: match an omitted input exactly through the records", async () => {
  await withRepoDir(async (dir) => {
    const workflowRepo = new YamlWorkflowRepository(dir);
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflow = webhookWorkflow();
    await workflowRepo.save(workflow);
    const pad = "p".repeat(INDEXED_INPUT_MAX_BYTES * 2);
    const wanted = await saveLargeRun(runRepo, workflow, `deploy ${pad}`);
    await saveLargeRun(runRepo, workflow, `hold ${pad}`);
    const runInputsOf = (workflowId: string, runId: string) =>
      runRepo.findPersistedInputs(
        createWorkflowId(workflowId),
        createWorkflowRunId(runId),
      );

    const runEvents = await collect<WorkflowRunSearchEvent>(
      workflowRunSearch(createLibSwampContext(), {
        findAllWorkflows: () => workflowRepo.findAllListings(),
        runIndexOf: (id) => runRepo.runIndexSnapshot(createWorkflowId(id)),
        runInputsOf,
      }, { inputs: { body: `deploy ${pad}` } }),
    );
    const runResults = (runEvents.at(-1) as Extract<
      WorkflowRunSearchEvent,
      { kind: "completed" }
    >).data.results;
    assertEquals(runResults.map((r) => r.runId), [wanted.id]);
    assertEquals(runResults[0].inputs, { source: "github" });
    assertEquals(runResults[0].inputsOmitted, ["body"]);

    const historyEvents = await collect<WorkflowHistorySearchEvent>(
      workflowHistorySearch(createLibSwampContext(), {
        findAllWorkflows: () => workflowRepo.findAll(),
        findAllRunsByWorkflowId: (id) =>
          runRepo.findAllSummariesFromIndex(createWorkflowId(id)),
        runInputsOf,
      }, { filter: 'inputs.body.startsWith("deploy")' }),
    );
    const historyResults = (historyEvents.at(-1) as Extract<
      WorkflowHistorySearchEvent,
      { kind: "completed" }
    >).data.results;
    assertEquals(historyResults.map((r) => r.runId), [wanted.id]);
  });
});
