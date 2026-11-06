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
import { classifyGate, gateAttemptMatches } from "./gate_state.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

function gated(timeout?: number, jobs = ["main"]): Workflow {
  return Workflow.create({
    name: "gated",
    jobs: jobs.map((name) =>
      Job.create({
        name,
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("ok?", timeout),
          }),
          Step.create({ name: "later", task: StepTask.manualApproval("ok?") }),
        ],
      })
    ),
  });
}

function waiting(workflow: Workflow, at = new Date()): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("gate")!;
  step.start(at);
  step.waitForApproval();
  run.suspend();
  return run;
}

const decision = {
  approved: true,
  decidedBy: "user:alice",
  decidedAt: "2026-11-06T00:00:00.000Z",
};

Deno.test("classifyGate: reads each state a refused decision can find", async (t) => {
  const workflow = gated();
  const gateOf = (run: WorkflowRun) => run.getJob("main")!.getStep("gate")!;

  await t.step("waiting", () => {
    assertEquals(classifyGate(waiting(workflow), workflow, "gate"), "waiting");
  });
  await t.step("absent, for a step the run does not have", () => {
    assertEquals(classifyGate(waiting(workflow), workflow, "nope"), "absent");
  });
  await t.step("not_reached, for a later gate", () => {
    assertEquals(
      classifyGate(waiting(workflow), workflow, "later"),
      "not_reached",
    );
  });
  await t.step("decided, while the run is still suspended", () => {
    const run = waiting(workflow);
    gateOf(run).recordApprovalDecision(decision);
    gateOf(run).succeed();
    assertEquals(classifyGate(run, workflow, "gate"), "decided");
  });
  await t.step("decided, once a rejection failed the run", () => {
    const run = waiting(workflow);
    gateOf(run).recordApprovalDecision({ ...decision, approved: false });
    gateOf(run).fail("no");
    run.complete();
    assertEquals(classifyGate(run, workflow, "gate"), "decided");
  });
  await t.step("closed, for a gate cancelled with no decision", () => {
    const run = waiting(workflow);
    gateOf(run).fail("cancelled");
    assertEquals(classifyGate(run, workflow, "gate"), "closed");
  });
  await t.step(
    "run_active, for a waiting step of a run walking again, and closed once it ended",
    () => {
      const run = WorkflowRun.create(workflow);
      run.start();
      const job = run.getJob("main")!;
      job.start();
      job.getStep("gate")!.start();
      job.getStep("gate")!.waitForApproval();
      assertEquals(classifyGate(run, workflow, "gate"), "run_active");
      run.complete();
      assertEquals(classifyGate(run, workflow, "gate"), "closed");
    },
  );
  await t.step("closed, for a pending step of a finished run", () => {
    const run = waiting(workflow);
    run.complete();
    assertEquals(classifyGate(run, workflow, "later"), "closed");
  });
});

Deno.test("classifyGate: a gate past its timeout is expired, read from the workflow", () => {
  const workflow = gated(60);
  const run = waiting(workflow, new Date("2026-11-06T00:00:00.000Z"));
  assertEquals(
    classifyGate(run, workflow, "gate", {
      now: new Date("2026-11-06T00:00:30.000Z"),
    }),
    "waiting",
  );
  assertEquals(
    classifyGate(run, workflow, "gate", {
      now: new Date("2026-11-06T00:02:00.000Z"),
    }),
    "expired",
  );
});

Deno.test("classifyGate: a step name in two jobs needs the job", () => {
  const workflow = gated(undefined, ["main", "other"]);
  const run = waiting(workflow);
  assertEquals(classifyGate(run, workflow, "gate"), "ambiguous");
  assertEquals(
    classifyGate(run, workflow, "gate", { jobName: "main" }),
    "waiting",
  );
  assertEquals(
    classifyGate(run, workflow, "gate", { jobName: "other" }),
    "not_reached",
  );
  assertEquals(
    classifyGate(run, workflow, "gate", { jobName: "missing" }),
    "absent",
  );
});

Deno.test("gateAttemptMatches: compares instants, and an unusable value never matches", () => {
  const at = new Date("2026-11-06T10:00:00.000Z");
  assertEquals(gateAttemptMatches({ startedAt: at }, at.toISOString()), true);
  assertEquals(
    gateAttemptMatches({ startedAt: at }, "2026-11-06T11:00:00.000+01:00"),
    true,
  );
  assertEquals(
    gateAttemptMatches({ startedAt: at }, "2026-11-06T10:00:00.001Z"),
    false,
  );
  assertEquals(gateAttemptMatches({ startedAt: at }, "not a date"), false);
  assertEquals(
    gateAttemptMatches({ startedAt: undefined }, at.toISOString()),
    false,
  );
});

Deno.test("WorkflowRun: a start key survives its record, and clears", () => {
  const key = { lookup: "l", salt: "s", fingerprint: "f" };
  const run = WorkflowRun.create(gated());
  run.recordStartKey(key);
  const read = WorkflowRun.fromData(JSON.parse(JSON.stringify(run.toData())));
  assertEquals(read.startKey, key);
  read.clearStartKey();
  assertEquals(read.toData().startKey, undefined);
});
