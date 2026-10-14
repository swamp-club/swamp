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
 * Run search and run summary over real repositories on a temp directory,
 * with a second set of repositories on the same directories standing in for
 * another process (swamp-club#3443). That is the shape of the local
 * dashboard child, which serves reads from one long-lived process while the
 * CLI writes runs: whatever the writer does, the reader's cached run index
 * snapshots must follow it.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { getIndexPath } from "../src/infrastructure/persistence/workflow_run_index.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
  type WorkflowRunSearchInput,
} from "../src/libswamp/workflows/run_search.ts";
import {
  workflowRunSummary,
  type WorkflowRunSummaryData,
  type WorkflowRunSummaryEvent,
} from "../src/libswamp/workflows/run_summary.ts";
import type { RunIndexSnapshot } from "../src/domain/workflows/run_index_snapshot.ts";
import { RunIndexWarmup } from "../src/serve/run_index_warmup.ts";
import "../src/domain/models/models.ts";

async function withRepoDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-index-cache-" });
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

function workflowNamed(name: string): Workflow {
  return Workflow.create({
    name,
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

/** One process's view of the repository. */
function processOn(dir: string) {
  const workflowRepo = new YamlWorkflowRepository(dir);
  const runRepo = new YamlWorkflowRunRepository(dir);
  const deps: WorkflowRunSearchDeps = {
    findAllWorkflows: () => workflowRepo.findAllListings(),
    runIndexOf: (id) => runRepo.runIndexSnapshot(createWorkflowId(id)),
  };
  return {
    workflowRepo,
    runRepo,
    async search(input: WorkflowRunSearchInput) {
      for await (
        const event of workflowRunSearch(createLibSwampContext(), deps, input)
      ) {
        if (event.kind === "completed") {
          return event as Extract<
            WorkflowRunSearchEvent,
            { kind: "completed" }
          >;
        }
      }
      throw new Error("run search did not complete");
    },
    async summary(): Promise<WorkflowRunSummaryData> {
      for await (
        const event of workflowRunSummary(createLibSwampContext(), deps, {})
      ) {
        if (event.kind === "completed") {
          return (event as Extract<
            WorkflowRunSummaryEvent,
            { kind: "completed" }
          >).data;
        }
      }
      throw new Error("run summary did not complete");
    },
  };
}

/**
 * Sets a workflow's run index file and records directory back a minute, so
 * the reader's next snapshot of it is kept.
 */
async function settle(dir: string, workflow: Workflow) {
  const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
  const when = new Date(Date.now() - 60_000);
  await Deno.utime(getIndexPath(runsDir), when, when);
  await Deno.utime(runsDir, when, when);
}

async function startRun(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.start();
  await repo.save(workflow.id, run);
  return run;
}

Deno.test("run index cache: the reader follows runs another process saves, updates and adds", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    const other = workflowNamed("other");
    await writer.workflowRepo.save(deploy);
    await writer.workflowRepo.save(other);
    const first = await startRun(writer.runRepo, deploy);
    await startRun(writer.runRepo, other);
    await settle(dir, deploy);
    await settle(dir, other);

    const before = await reader.search({ workflow: "deploy", limit: 20 });
    assertEquals(before.data.results.map((r) => r.runId), [first.id]);
    assertEquals(before.total, 1);
    assertEquals((await reader.summary()).totals.running, 2);

    // Same record count: only the index changes.
    first.interruptOrphaned("test");
    await writer.runRepo.save(deploy.id, first);
    assertEquals(
      (await reader.search({ workflow: "deploy" })).data.results[0].status,
      "interrupted",
    );
    await settle(dir, deploy);
    assertEquals((await reader.summary()).totals.failed, 1);

    // A new record.
    const second = await startRun(writer.runRepo, deploy);
    const after = await reader.search({ workflow: "deploy", limit: 20 });
    assertEquals(after.total, 2);
    assertEquals(after.data.results[0].runId, second.id);
    assertEquals((await reader.summary()).totals.runs, 3);
  });
});

Deno.test("run index cache: a full run id finds its run, and paging reports the total", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    await writer.workflowRepo.save(deploy);
    const runs: WorkflowRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(await startRun(writer.runRepo, deploy));
    }
    await settle(dir, deploy);

    const target = runs[2];
    const found = await reader.search({
      workflow: "deploy",
      query: target.id.toUpperCase(),
      limit: 1,
    });
    assertEquals(found.data.results.map((r) => r.runId), [target.id]);
    assertEquals(found.total, 1);

    const page = await reader.search({ offset: 1, limit: 2 });
    assertEquals(page.total, 5);
    assertEquals(page.data.results.length, 2);
  });
});

Deno.test("run index cache: deleting a workflow's runs empties its results", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    await writer.workflowRepo.save(deploy);
    await startRun(writer.runRepo, deploy);
    await settle(dir, deploy);
    assertEquals((await reader.search({})).total, 1);

    await writer.runRepo.deleteAllByWorkflowId(deploy.id);
    assertEquals((await reader.search({})).total, 0);
    assertEquals((await reader.summary()).totals.runs, 0);
  });
});

Deno.test("run index cache: renamed and deleted workflows are seen through the workflow listings", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    const doomed = workflowNamed("doomed");
    await writer.workflowRepo.save(deploy);
    await writer.workflowRepo.save(doomed);
    const oldRun = await startRun(writer.runRepo, deploy);
    await startRun(writer.runRepo, doomed);
    await settle(dir, deploy);
    await settle(dir, doomed);
    assertEquals((await reader.search({})).total, 2);

    // Renamed: runs keep the name they recorded.
    const renamed = Workflow.fromData({ ...deploy.toData(), name: "shipped" });
    await writer.workflowRepo.delete(deploy.id, deploy.name);
    await writer.workflowRepo.save(renamed);
    const newRun = await startRun(writer.runRepo, renamed);
    assertEquals(
      (await reader.search({ workflow: "deploy" })).data.results.map((r) =>
        r.runId
      ),
      [oldRun.id],
    );
    assertEquals(
      (await reader.search({ workflows: ["shipped"] })).data.results.map((r) =>
        r.runId
      ),
      [newRun.id],
    );

    // Deleted: its runs are no longer listed.
    await writer.workflowRepo.delete(doomed.id, doomed.name);
    const remaining = await reader.search({});
    assertEquals(remaining.total, 2);
    assertEquals(
      remaining.data.results.every((r) => r.workflowId === deploy.id),
      true,
    );
  });
});

Deno.test("run index cache: the serve warm-up leaves each snapshot cached for the first request", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const workflows = [workflowNamed("alpha"), workflowNamed("beta")];
    for (const workflow of workflows) {
      await writer.workflowRepo.save(workflow);
      await startRun(writer.runRepo, workflow);
      await settle(dir, workflow);
    }

    const serve = processOn(dir);
    const warmed = new Map<string, RunIndexSnapshot>();
    const warmup = new RunIndexWarmup({
      listWorkflowIds: async () =>
        (await serve.workflowRepo.findAllListings()).map((w) => w.id),
      warm: async (id) => {
        warmed.set(
          id,
          await serve.runRepo.runIndexSnapshot(createWorkflowId(id)),
        );
      },
    });
    warmup.start();
    // A request that arrives during the warm-up shares its loads.
    const during = await serve.search({});
    await warmup.dispose();

    assertEquals(during.total, 2);
    assertEquals(warmed.size, 2);
    for (const workflow of workflows) {
      assertStrictEquals(
        await serve.runRepo.runIndexSnapshot(workflow.id),
        warmed.get(workflow.id),
      );
    }
  });
});
