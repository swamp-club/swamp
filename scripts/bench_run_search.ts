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
 * What the dashboard's run queries cost against a large run history
 * (swamp-club#3443): the Workflows page's 24 h summary, a run page's
 * all-time summary of one workflow, a workflow page's 20 newest runs, and a
 * live run page's lookup of one run by id. Each shape runs cold (fresh
 * repositories, as on a first request) and warm (repositories that served
 * the same request before, as serve's are). The history is synthetic: a
 * valid run index per workflow and a placeholder record per run, spread
 * over 90 days. Run with:
 *
 * ```
 * deno bench -A scripts/bench_run_search.ts
 * ```
 */

import { join } from "@std/path";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import {
  getIndexPath,
  INDEX_SCHEMA_VERSION,
} from "../src/infrastructure/persistence/workflow_run_index.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchInput,
} from "../src/libswamp/workflows/run_search.ts";
import {
  workflowRunSummary,
  type WorkflowRunSummaryInput,
} from "../src/libswamp/workflows/run_summary.ts";
import "../src/domain/models/models.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHAPES = [
  { name: "1k (20x50)", workflows: 20, runs: 50 },
  { name: "100k (200x500)", workflows: 200, runs: 500 },
];

interface Repo {
  dir: string;
  workflowName: string;
  runId: string;
}

/** A repo with `workflows` workflows of `runs` runs each. */
async function repoOf(workflows: number, runs: number): Promise<Repo> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-search-bench-" });
  const workflowRepo = new YamlWorkflowRepository(dir);
  const now = Date.now();
  let runId = "";
  for (let w = 0; w < workflows; w++) {
    const workflow = Workflow.create({
      name: `wf-${w}`,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "step",
          task: StepTask.model("bench-model", "run"),
        })],
      })],
    });
    await workflowRepo.save(workflow);
    const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
    await Deno.mkdir(runsDir, { recursive: true });
    const entries: Record<string, unknown> = {};
    for (let r = 0; r < runs; r++) {
      const id = crypto.randomUUID();
      const start = now - Math.floor(Math.random() * 90 * DAY_MS);
      entries[id] = {
        status: r % 10 === 0 ? "failed" : "succeeded",
        workflowId: workflow.id,
        workflowName: workflow.name,
        startedAt: new Date(start).toISOString(),
        completedAt: new Date(start + 5000).toISOString(),
        tags: {},
        inputs: { env: "prod" },
        triggerSource: "schedule",
        stepProgress: { completed: 1, total: 1 },
      };
      await Deno.writeTextFile(
        join(runsDir, `workflow-run-${id}.yaml`),
        `id: ${id}\n`,
      );
      if (w === 0 && r === 0) runId = id;
    }
    await Deno.writeTextFile(
      getIndexPath(runsDir),
      JSON.stringify({ version: INDEX_SCHEMA_VERSION, entries }),
    );
    // Old enough that the run index cache keeps what it reads.
    const settled = new Date(now - 60_000);
    await Deno.utime(getIndexPath(runsDir), settled, settled);
    await Deno.utime(runsDir, settled, settled);
  }
  return { dir, workflowName: "wf-0", runId };
}

function depsOn(dir: string): WorkflowRunSearchDeps {
  const workflowRepo = new YamlWorkflowRepository(dir);
  const runRepo = new YamlWorkflowRunRepository(dir);
  return {
    findAllWorkflows: () => workflowRepo.findAll(),
    runIndexOf: (id) => runRepo.runIndexSnapshot(createWorkflowId(id)),
  };
}

async function search(deps: WorkflowRunSearchDeps, input: WorkflowRunSearchInput) {
  for await (const _ of workflowRunSearch(createLibSwampContext(), deps, input)) {
    // Drained for its cost.
  }
}

async function summary(deps: WorkflowRunSearchDeps, input: WorkflowRunSummaryInput) {
  for await (const _ of workflowRunSummary(createLibSwampContext(), deps, input)) {
    // Drained for its cost.
  }
}

for (const shape of SHAPES) {
  const repo = await repoOf(shape.workflows, shape.runs);
  const warm = depsOn(repo.dir);
  const cases: Array<[string, (deps: WorkflowRunSearchDeps) => Promise<void>]> = [
    ["summary, 24 h", (d) => summary(d, { since: "1d", recentLimit: 20 })],
    [
      "summary, all time, 1 workflow",
      (d) => summary(d, { workflows: [repo.workflowName], recentLimit: 30 }),
    ],
    [
      "run.search workflow=X limit 20",
      (d) => search(d, { workflow: repo.workflowName, limit: 20 }),
    ],
    [
      "run.search by run id",
      (d) => search(d, { workflow: repo.workflowName, query: repo.runId, limit: 1 }),
    ],
  ];
  for (const [name, run] of cases) {
    // Deno.bench awaits only async functions; a few iterations are enough
    // at hundreds of milliseconds each.
    Deno.bench({
      name: `${name}: cold`,
      group: `${shape.name} ${name}`,
      n: 10,
      warmup: 1,
      async fn() {
        await run(depsOn(repo.dir));
      },
    });
    Deno.bench({
      name: `${name}: warm`,
      group: `${shape.name} ${name}`,
      baseline: true,
      n: 50,
      warmup: 2,
      async fn() {
        await run(warm);
      },
    });
  }
}
