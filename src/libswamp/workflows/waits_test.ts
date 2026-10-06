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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowWaits,
  type WorkflowWaitsDeps,
  type WorkflowWaitsEvent,
} from "./waits.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

const SCHEMA = {
  type: "object" as const,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

function workflowNamed(name: string, steps: string[] = ["review"]): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          ...steps.map((step) =>
            Step.create({
              name: step,
              task: StepTask.waitForSignal(60, SCHEMA),
            })
          ),
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

/** A run suspended with each named step waiting on a wait opened at `at`. */
function waitingRun(
  workflow: Workflow,
  opened: Record<string, Date>,
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  for (const [step, at] of Object.entries(opened)) {
    job.getStep(step)!.start();
    job.getStep(step)!.waitForSignal(SignalWait.open(SCHEMA, 60, at));
  }
  job.getStep("gate")!.waitForApproval("Approve");
  run.suspend();
  return run;
}

function depsOf(runs: WorkflowRun[], now: Date): WorkflowWaitsDeps {
  return {
    now: () => now,
    runRepo: {
      findGlobalByStatus: (status: string | string[]) => {
        const wanted = Array.isArray(status) ? status : [status];
        return Promise.resolve(
          runs.filter((run) => wanted.includes(run.status)).map((run) => ({
            run,
            workflowId: createWorkflowId(run.workflowId),
          })),
        );
      },
    },
  };
}

async function list(deps: WorkflowWaitsDeps) {
  const events = await collect<WorkflowWaitsEvent>(
    workflowWaits(createLibSwampContext(), deps),
  );
  assertEquals(events[0], { kind: "resolving" });
  const last = events.at(-1)!;
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data.waits;
}

async function listUnreadable(deps: WorkflowWaitsDeps) {
  const events = await collect<WorkflowWaitsEvent>(
    workflowWaits(createLibSwampContext(), deps),
  );
  const last = events.at(-1)!;
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data.unreadableWaits;
}

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:10.000Z");

Deno.test("workflowWaits: lists each open wait with what a signal needs", async () => {
  const workflow = workflowNamed("release");
  const run = waitingRun(workflow, { review: T0 });
  const wait = run.getJob("main")!.getStep("review")!.signalWait!;

  const waits = await list(depsOf([run], T1));

  assertEquals(waits, [{
    waitId: wait.id,
    workflowId: workflow.id,
    workflowName: "release",
    runId: run.id,
    jobName: "main",
    stepName: "review",
    waitingSince: run.getJob("main")!.getStep("review")!.startedAt!
      .toISOString(),
    deadline: "2026-01-01T00:01:00.000Z",
    expired: false,
    schema: wait.schema,
    nextCommand: `swamp workflow signal ${wait.id} --payload '<json>'`,
  }]);
});

Deno.test("workflowWaits: a wait past its deadline is listed as expired with the resume command", async () => {
  const run = waitingRun(workflowNamed("release"), { review: T0 });

  const [wait] = await list(
    depsOf([run], new Date("2026-01-01T00:01:00.001Z")),
  );

  assertEquals(wait.expired, true);
  assertEquals(
    wait.nextCommand,
    `swamp workflow resume release --run ${run.id}`,
  );
});

Deno.test("workflowWaits: lists every wait of every suspended run, soonest deadline first", async () => {
  const a = waitingRun(workflowNamed("a", ["late", "early"]), {
    late: T1,
    early: T0,
  });
  const b = waitingRun(workflowNamed("b"), {
    review: new Date("2026-01-01T00:00:05.000Z"),
  });

  const waits = await list(depsOf([a, b], T1));

  assertEquals(
    waits.map((w) => `${w.workflowName}/${w.stepName}`),
    ["a/early", "b/review", "a/late"],
  );
});

Deno.test("workflowWaits: leaves out gates, settled waits and runs that are not suspended, and lists an unreadable wait apart", async () => {
  const gateOnly = waitingRun(workflowNamed("gate-only"), {});
  const settled = waitingRun(workflowNamed("settled"), { review: T0 });
  settled.getJob("main")!.getStep("review")!.acceptSignal(
    { verdict: "ship" },
    "ada",
    T0,
  );
  const cancelled = waitingRun(workflowNamed("cancelled"), { review: T0 });
  cancelled.endAsCancelled("operator");
  const brokenData = waitingRun(workflowNamed("broken"), { review: T0 })
    .toData();
  brokenData.jobs[0].steps[0].wait = { kind: "?" };
  const broken = WorkflowRun.fromData(brokenData);

  const deps = depsOf([gateOnly, settled, cancelled, broken], T1);
  assertEquals(await list(deps), []);
  assertEquals(await listUnreadable(deps), [{
    workflowId: broken.workflowId,
    workflowName: "broken",
    runId: broken.id,
    jobName: "main",
    stepName: "review",
    nextCommand: `swamp workflow resume broken --run ${broken.id}`,
  }]);
});

Deno.test("workflowWaits: no suspended runs lists nothing", async () => {
  assertEquals(await list(depsOf([], T1)), []);
});
