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

// Per-run evaluated-workflow snapshots share their run's lifetime: run GC and
// workflow delete remove them together with the run records (swamp-club#2522).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  createLibSwampContext,
  createRunGcDeps,
  createWorkflowDeleteDeps,
  runGc,
  type RunGcData,
  workflowDelete,
} from "../src/libswamp/mod.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-run-snapshots-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

class SucceedingStepExecutor implements StepExecutor {
  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    return Promise.resolve({ step: ctx.stepName });
  }
}

function snapshotWorkflow(): Workflow {
  return Workflow.create({
    name: "snapshot-cleanup",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "only",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

/** Runs the workflow `count` times through the real execution service. */
async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  count: number,
): Promise<string[]> {
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  const service = new WorkflowExecutionService(
    new YamlWorkflowRepository(repoDir),
    new YamlWorkflowRunRepository(repoDir),
    repoDir,
    new SucceedingStepExecutor(),
    undefined,
    catalogStore,
  );
  const runIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    runIds.push(run.id);
  }
  return runIds;
}

async function snapshotIds(repoDir: string): Promise<string[]> {
  const snapshots = await new YamlEvaluatedWorkflowRepository(repoDir)
    .listRunSnapshots();
  return snapshots.map((s) => s.runId).sort();
}

async function collectGc(
  repoDir: string,
  retentionDays: number,
  dryRun: boolean,
): Promise<RunGcData> {
  let data: RunGcData | undefined;
  for await (
    const event of runGc(createLibSwampContext(), createRunGcDeps(repoDir), {
      dryRun,
      workflowRunRetentionDays: retentionDays,
      outputRetentionDays: retentionDays,
    })
  ) {
    if (event.kind === "completed") data = event.data;
  }
  if (!data) throw new Error("run gc did not complete");
  return data;
}

async function backdate(path: string, date: Date): Promise<void> {
  await Deno.utime(path, date, date);
}

Deno.test("run gc: removes the snapshots of collected runs and old orphans, keeps fresh orphans", async () => {
  await withRepo(async (repoDir) => {
    const workflow = snapshotWorkflow();
    await new YamlWorkflowRepository(repoDir).save(workflow);
    const runIds = await runWorkflow(repoDir, workflow, 2);
    assertEquals(await snapshotIds(repoDir), [...runIds].sort());

    // An orphan older than retention (its run record is gone) and a fresh
    // orphan (a run whose record has not been saved yet).
    const evaluatedRepo = new YamlEvaluatedWorkflowRepository(repoDir);
    const oldOrphan = crypto.randomUUID();
    const freshOrphan = crypto.randomUUID();
    await evaluatedRepo.saveForRun(oldOrphan, workflow);
    await evaluatedRepo.saveForRun(freshOrphan, workflow);
    const runsDir = join(repoDir, ".swamp", "workflows-evaluated", "runs");
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    await backdate(
      join(runsDir, oldOrphan, "evaluated-workflow.yaml"),
      longAgo,
    );

    // Make the first run old enough to collect; the second stays.
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    const oldRun = await runRepo.findById(
      workflow.id,
      createWorkflowRunId(runIds[0]),
    );
    const oldRunData = oldRun!.toData();
    oldRunData.startedAt = longAgo.toISOString();
    oldRunData.completedAt = longAgo.toISOString();
    const oldRunPath = runRepo.getPath(workflow.id, oldRun!.id);
    await Deno.writeTextFile(
      oldRunPath,
      stringifyYaml(JSON.parse(JSON.stringify(oldRunData))),
    );
    await backdate(oldRunPath, longAgo);

    const preview = await collectGc(repoDir, 30, true);
    assertEquals(preview.workflowRunsDeleted, 1);
    assertEquals(preview.evaluatedSnapshotsDeleted, 2);
    assertEquals((await snapshotIds(repoDir)).length, 4);

    const result = await collectGc(repoDir, 30, false);
    assertEquals(result.workflowRunsDeleted, 1);
    assertEquals(result.evaluatedSnapshotsDeleted, 2);
    assertEquals(
      await snapshotIds(repoDir),
      [runIds[1], freshOrphan].sort(),
    );
  });
});

Deno.test("workflow delete: removes the snapshots of every run it deletes", async () => {
  await withRepo(async (repoDir) => {
    const workflow = snapshotWorkflow();
    await new YamlWorkflowRepository(repoDir).save(workflow);
    const runIds = await runWorkflow(repoDir, workflow, 3);
    assertEquals((await snapshotIds(repoDir)).length, 3);

    let runsDeleted: number | undefined;
    for await (
      const event of workflowDelete(
        createLibSwampContext(),
        createWorkflowDeleteDeps(repoDir),
        { workflowIdOrName: workflow.name },
      )
    ) {
      if (event.kind === "completed") runsDeleted = event.data.runsDeleted;
    }

    assertEquals(runsDeleted, runIds.length);
    assertEquals(await snapshotIds(repoDir), []);
  });
});
