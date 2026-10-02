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
 * Integration tests for `workflow cancel` against a run in its cleanup phase
 * (swamp-club#2897). A run aborted mid-step runs its `always` job under the
 * cleanup grace; while it does, the record on disk must show the cleanup step
 * running, so a cancel that has to kill the owner then settles that record as
 * cut off rather than leaving the step pending.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  WorkflowRun,
} from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { cancelLocalRun } from "../src/cli/commands/workflow_cancel.ts";

// Import models barrel to trigger built-in registration.
import type { RunTrackerRepository } from "../src/domain/models/run_tracker_repository.ts";
import type { MethodRunOutputs } from "../src/domain/workflows/orphaned_run_reaper.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

/** Cancel deps for runs with no tracker rows or method-run records. */
const untracked = {
  runTracker: {
    findAllRunning: () => [],
  } as unknown as RunTrackerRepository,
  outputRepo: {
    findByIds: () => Promise.resolve(new Map()),
    save: () => Promise.reject(new Error("unexpected output save")),
  } as MethodRunOutputs,
};

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-cancel-cleanup-" });
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

/**
 * `main/work` runs until the run's signal aborts; `teardown/t` runs until
 * released.
 */
class CleanupStepExecutor implements StepExecutor {
  readonly started = new Set<string>();
  private releaseTeardown: () => void = () => {};
  private readonly teardownReleased = new Promise<void>((resolve) =>
    this.releaseTeardown = resolve
  );

  release(): void {
    this.releaseTeardown();
  }

  async execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.started.add(`${ctx.jobName}/${ctx.stepName}`);
    if (ctx.stepName === "work") {
      await new Promise<void>((_resolve, reject) => {
        if (ctx.signal.aborted) reject(ctx.signal.reason);
        ctx.signal.addEventListener(
          "abort",
          () => reject(ctx.signal.reason),
          { once: true },
        );
      });
    }
    await this.teardownReleased;
    return { executed: true };
  }
}

function cleanupWorkflow(): Workflow {
  return Workflow.create({
    name: "cancel-cleanup",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "work",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
      Job.create({
        name: "teardown",
        dependsOn: [{ job: "main", condition: TriggerCondition.always() }],
        steps: [
          Step.create({ name: "t", task: StepTask.model("test-model", "run") }),
        ],
      }),
    ],
  });
}

function statuses(run: WorkflowRun | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const job of run?.jobs ?? []) {
    result[job.jobName] = job.status;
    for (const step of job.steps) {
      result[`${job.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

Deno.test("workflow cancel: the record shows a cleanup step running while it runs, and a cancel settles it as cut off", async () => {
  await withRepo(async (repoDir) => {
    const workflow = cleanupWorkflow();
    await new YamlWorkflowRepository(repoDir).save(workflow);
    const executor = new CleanupStepExecutor();
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    try {
      const service = new WorkflowExecutionService(
        new YamlWorkflowRepository(repoDir),
        new YamlWorkflowRunRepository(repoDir),
        repoDir,
        executor,
        undefined,
        catalogStore,
      );

      const abort = new AbortController();
      let runId: string | undefined;
      let finalStatus: string | undefined;
      const finished = (async () => {
        for await (
          const event of service.run(workflow.name, { signal: abort.signal })
        ) {
          if (event.kind === "started") runId = event.runId;
          if (event.kind === "completed" || event.kind === "cancelled") {
            finalStatus = event.run.status;
          }
        }
      })();

      await waitFor(() => executor.started.has("main/work"), "work to start");
      abort.abort();
      await waitFor(
        () => executor.started.has("teardown/t"),
        "cleanup to start",
      );

      // What an owner SIGKILLed now leaves behind, read as cancel reads it.
      const reader = new YamlWorkflowRunRepository(repoDir);
      const id = createWorkflowRunId(runId!);
      await waitFor(
        async () =>
          statuses(await reader.findById(workflow.id, id))["teardown/t"] ===
            "running",
        "the cleanup step saved as running",
      );
      // `t` holds until released, so this read sees the same record.
      const midCleanup = await reader.findById(workflow.id, id);
      assertEquals(statuses(midCleanup)["teardown"], "running");
      assertEquals(statuses(midCleanup)["teardown/t"], "running");
      const leftBehind = midCleanup!.toData();

      executor.release();
      await finished;
      assertEquals(finalStatus, "cancelled");
      const completed = await reader.findById(workflow.id, id);
      assertEquals(statuses(completed)["teardown/t"], "succeeded");

      // The owner was killed mid-cleanup: its last save is what cancel finds.
      await reader.save(workflow.id, WorkflowRun.fromData(leftBehind));
      const settled = await cancelLocalRun(
        WorkflowRun.fromData({ ...leftBehind, pid: Deno.pid + 1 }),
        workflow,
        "Cancelled by user",
        {
          runRepo: reader,
          findEvaluatedWorkflow: () => Promise.resolve(null),
          ...untracked,
          killProcess: () => Promise.resolve(true),
        },
      );

      assertEquals(settled?.status, "cancelled");
      assertEquals(statuses(settled)["teardown"], "failed");
      assertEquals(statuses(settled)["teardown/t"], "failed");
      assertEquals(
        settled?.getJob("teardown")?.getStep("t")?.error,
        OWNER_STOPPED_STEP_ERROR,
      );
    } finally {
      catalogStore.close();
    }
  });
});
