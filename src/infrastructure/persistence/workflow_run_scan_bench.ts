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
 * The workflow-run scans serve runs per request (swamp-club#4076):
 * `findAllGlobalSince`, behind `summarise`, over repositories of growing size
 * spread across 50 workflows, 2% of whose runs started inside a 7-day window;
 * and `findGlobalByStatus("suspended")`, behind `workflow.waits`, which finds
 * the 1% of runs that are suspended. Each size is read with the records'
 * mtimes at their completion, with every mtime fresh (as after a v3
 * read-model replay), and fresh under event-loop contention from four tasks
 * that each await a stat and then hold the loop for 0.25 ms. Run with:
 *
 *   deno bench --allow-all src/infrastructure/persistence/workflow_run_scan_bench.ts
 *   deno bench --allow-all src/infrastructure/persistence/workflow_run_scan_bench.ts -- 10000,50000
 *
 * Files stat'ed and read per iteration are printed when the run ends: with
 * every run index in step, a since scan should stat none and read only the
 * in-window runs, whatever the repository size or the files' mtimes.
 */

import { stringify as stringifyYaml } from "@std/yaml";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";

const SIZES = (Deno.args[0] ?? "2000,10000").split(",").map(Number);
const WORKFLOWS = 50;
const IN_WINDOW = 0.02;
const SUSPENDED = 0.01;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENDERS = 4;
const CONTENTION_MS = 0.25;

const now = Date.now();
const cutoff = new Date(now - 7 * DAY_MS);
const root = await Deno.makeTempDir({ prefix: "swamp_run_scan_bench_" });
const workflow = Workflow.create({
  id: crypto.randomUUID(),
  name: "bench",
  jobs: [
    Job.create({
      name: "job",
      steps: [
        Step.create({ name: "step", task: StepTask.model("bench", "run") }),
      ],
    }),
  ],
});
const template = WorkflowRun.create(workflow).toPersistedData();

/**
 * A repository of `size` runs over {@link WORKFLOWS} workflows, their mtimes
 * at completion or now, with every workflow's run index built.
 */
async function seed(
  size: number,
  fresh: boolean,
): Promise<YamlWorkflowRunRepository> {
  const repoDir = join(root, `${size}-${fresh ? "fresh" : "settled"}`);
  const repo = new YamlWorkflowRunRepository(repoDir);
  const workflowIds: WorkflowId[] = Array.from(
    { length: WORKFLOWS },
    () => createWorkflowId(crypto.randomUUID()),
  );
  const dirs = new Set<string>();
  for (let i = 0; i < size; i++) {
    const startedAt = new Date(
      now -
        (i < size * IN_WINDOW ? Math.random() * 6 : 8 + Math.random() * 300) *
          DAY_MS,
    );
    const completedAt = new Date(startedAt.getTime() + 1500);
    const suspended = i % Math.round(1 / SUSPENDED) === 0;
    const run = WorkflowRun.fromData({
      ...template,
      id: crypto.randomUUID(),
      status: suspended ? "suspended" : "succeeded",
      startedAt: startedAt.toISOString(),
      completedAt: suspended ? undefined : completedAt.toISOString(),
    });
    const path = repo.getPath(workflowIds[i % WORKFLOWS], run.id);
    if (!dirs.has(dirname(path))) {
      await ensureDir(dirname(path));
      dirs.add(dirname(path));
    }
    await Deno.writeTextFile(
      path,
      stringifyYaml(JSON.parse(JSON.stringify(run.toPersistedData()))),
    );
    const mtime = fresh ? new Date(now) : completedAt;
    await Deno.utime(path, mtime, mtime);
  }
  // A status scan builds every workflow's run index from its records.
  await repo.findGlobalByStatus("suspended");
  return repo;
}

const ops = new Map<string, { stats: number; reads: number; runs: number }>();
const stat = Deno.stat;
const readTextFile = Deno.readTextFile;
let counting: { stats: number; reads: number; runs: number } | undefined;
(Deno as { stat: typeof Deno.stat }).stat = (path) => {
  if (counting) counting.stats++;
  return stat(path);
};
(Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = (
  path,
  options,
) => {
  if (counting && /workflow-run-[^/\\]*\.yaml$/.test(String(path))) {
    counting.reads++;
  }
  return readTextFile(path, options);
};

/** Holds the event loop as other in-flight requests would, until stopped. */
function contend(): () => Promise<void> {
  let running = true;
  const contenders = Array.from({ length: CONTENDERS }, async () => {
    while (running) {
      await stat(root);
      const until = performance.now() + CONTENTION_MS;
      while (performance.now() < until) {
        // Busy: another request's synchronous work.
      }
    }
  });
  return async () => {
    running = false;
    await Promise.all(contenders);
  };
}

async function scan(
  label: string,
  read: () => Promise<unknown>,
  contended: boolean,
): Promise<void> {
  counting = ops.get(label) ?? { stats: 0, reads: 0, runs: 0 };
  ops.set(label, counting);
  counting.runs++;
  const stop = contended ? contend() : undefined;
  try {
    await read();
  } finally {
    counting = undefined;
    await stop?.();
  }
}

for (const size of SIZES) {
  const settled = await seed(size, false);
  const fresh = await seed(size, true);
  for (
    const [scanName, read] of [
      [
        "since 7d",
        (repo: YamlWorkflowRunRepository) => repo.findAllGlobalSince(cutoff),
      ],
      [
        "suspended",
        (repo: YamlWorkflowRunRepository) =>
          repo.findGlobalByStatus("suspended"),
      ],
    ] as const
  ) {
    const group = `${size} runs, ${scanName}`;
    for (
      const [name, repo, contended, n] of [
        ["mtimes at completion", settled, false, 10],
        ["every mtime fresh", fresh, false, 10],
        ["every mtime fresh, contended loop", fresh, true, 3],
      ] as const
    ) {
      const label = `${group}: ${name}`;
      Deno.bench({
        name: label,
        group,
        baseline: !contended && repo === settled,
        n,
        warmup: 1,
        async fn() {
          await scan(label, () => read(repo), contended);
        },
      });
    }
  }
}

globalThis.addEventListener("unload", () => {
  for (const [label, { stats, reads, runs }] of ops) {
    console.log(
      `${label}: ${(stats / runs).toFixed(0)} stats, ${
        (reads / runs).toFixed(0)
      } reads per iteration`,
    );
  }
  Deno.removeSync(root, { recursive: true });
});
