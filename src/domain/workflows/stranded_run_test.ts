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
import { cancelStrandedRun } from "./stranded_run.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import type { ActiveRunStatus } from "../models/active_run.ts";
import { createWorkflowRunId } from "./workflow_id.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";

function createWorkflow(): Workflow {
  return Workflow.create({
    name: "wf",
    jobs: [
      Job.create({
        name: "j",
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      }),
    ],
  });
}

function runningRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  return run;
}

interface Recorded {
  saved: { workflowId: WorkflowId; status: string }[];
  completed: { runId: string; status: ActiveRunStatus }[];
}

function stubs(runs: WorkflowRun[]): {
  runRepo: WorkflowRunRepository;
  runTracker: RunTrackerRepository;
  recorded: Recorded;
} {
  const recorded: Recorded = { saved: [], completed: [] };
  return {
    runRepo: {
      findById: (_wfId: WorkflowId, runId: WorkflowRunId) =>
        Promise.resolve(
          runs.find((r) => r.id === (runId as string)) ?? null,
        ),
      save: (workflowId: WorkflowId, run: WorkflowRun) => {
        recorded.saved.push({ workflowId, status: run.status });
        return Promise.resolve();
      },
    } as unknown as WorkflowRunRepository,
    runTracker: {
      complete: (runId: string, status: ActiveRunStatus) => {
        recorded.completed.push({ runId, status });
      },
    } as unknown as RunTrackerRepository,
    recorded,
  };
}

Deno.test("cancelStrandedRun: cancels a running run, saves it, and completes its tracker row", async () => {
  const wf = createWorkflow();
  const run = runningRun(wf);
  const { runRepo, runTracker, recorded } = stubs([run]);

  const cancelled = await cancelStrandedRun(
    runRepo,
    runTracker,
    wf.id,
    run.id,
    "aborted",
  );

  assertEquals(cancelled, true);
  assertEquals(run.status, "cancelled");
  assertEquals(run.tags["cancel_reason"], "aborted");
  assertEquals(recorded.saved, [{ workflowId: wf.id, status: "cancelled" }]);
  assertEquals(recorded.completed, [{ runId: run.id, status: "cancelled" }]);
});

Deno.test("cancelStrandedRun: leaves a run that is not running untouched", async () => {
  const wf = createWorkflow();

  const pendingRun = WorkflowRun.create(wf);

  const cancelledRun = runningRun(wf);
  cancelledRun.cancel("earlier");

  const failedRun = runningRun(wf);
  failedRun.jobs[0].start();
  failedRun.jobs[0].fail();
  failedRun.complete();

  const succeededRun = runningRun(wf);
  succeededRun.jobs[0].start();
  succeededRun.jobs[0].succeed();
  succeededRun.complete();

  const suspendedRun = runningRun(wf);
  suspendedRun.suspend();

  const interruptedRun = runningRun(wf);
  interruptedRun.interrupt("server_crash");

  const cases: [WorkflowRun, string][] = [
    [pendingRun, "pending"],
    [cancelledRun, "cancelled"],
    [failedRun, "failed"],
    [succeededRun, "succeeded"],
    [suspendedRun, "suspended"],
    [interruptedRun, "interrupted"],
  ];
  for (const [run, status] of cases) {
    const { runRepo, runTracker, recorded } = stubs([run]);

    const cancelled = await cancelStrandedRun(
      runRepo,
      runTracker,
      wf.id,
      run.id,
      "aborted",
    );

    assertEquals(cancelled, false, status);
    assertEquals(run.status, status);
    assertEquals(recorded.saved, [], status);
    assertEquals(recorded.completed, [], status);
  }
  assertEquals(cancelledRun.tags["cancel_reason"], "earlier");
});

Deno.test("cancelStrandedRun: returns false for a missing run", async () => {
  const wf = createWorkflow();
  const { runRepo, runTracker, recorded } = stubs([]);

  const cancelled = await cancelStrandedRun(
    runRepo,
    runTracker,
    wf.id,
    createWorkflowRunId(crypto.randomUUID()),
    "aborted",
  );

  assertEquals(cancelled, false);
  assertEquals(recorded.saved, []);
  assertEquals(recorded.completed, []);
});
