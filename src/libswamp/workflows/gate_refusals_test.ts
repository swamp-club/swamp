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
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { waitingGate } from "./gate_refusals.ts";

function runWithGates(jobs: string[], waiting: string[]): WorkflowRun {
  const workflow = Workflow.create({
    name: "gated",
    jobs: jobs.map((name) =>
      Job.create({
        name,
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
        ],
      })
    ),
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const name of waiting) {
    const job = run.getJob(name)!;
    job.start();
    job.getStep("gate")!.start();
    job.getStep("gate")!.waitForApproval();
  }
  return run;
}

function withStart(run: WorkflowRun, job: string, at: string): WorkflowRun {
  const data = run.toData();
  data.jobs.find((j) => j.jobName === job)!.steps[0].startedAt = at;
  return WorkflowRun.fromData(data);
}

const EARLY = "2026-01-01T00:00:00.000Z";
const LATE = "2026-01-01T00:00:05.000Z";

Deno.test("waitingGate: a time alone picks the gate waiting since then", () => {
  const run = withStart(
    withStart(runWithGates(["a", "b"], ["a", "b"]), "a", EARLY),
    "b",
    LATE,
  );
  const target = { stepName: "gate" };
  assertEquals(
    waitingGate(run, { ...target, suspendedAt: LATE })?.jobName,
    "b",
  );
  assertEquals(
    waitingGate(run, { ...target, suspendedAt: EARLY })?.jobName,
    "a",
  );
});

Deno.test("waitingGate: with no time or no match, the first waiting gate answers", () => {
  const run = withStart(
    withStart(runWithGates(["a", "b"], ["a", "b"]), "a", EARLY),
    "b",
    LATE,
  );
  const target = { stepName: "gate" };
  assertEquals(waitingGate(run, target)?.jobName, "a");
  assertEquals(
    waitingGate(run, { ...target, suspendedAt: "2020-01-01T00:00:00.000Z" })
      ?.jobName,
    "a",
  );
  assertEquals(
    waitingGate(run, { ...target, suspendedAt: "not a time" })?.jobName,
    "a",
  );
});

Deno.test("waitingGate: a named job is the only one looked at, and a step not waiting is no gate", () => {
  const run = withStart(
    withStart(runWithGates(["a", "b"], ["a", "b"]), "a", EARLY),
    "b",
    LATE,
  );
  assertEquals(
    waitingGate(run, { stepName: "gate", jobName: "b", suspendedAt: EARLY })
      ?.jobName,
    "b",
  );
  assertEquals(
    waitingGate(runWithGates(["a"], []), { stepName: "gate" }),
    undefined,
  );
  assertEquals(waitingGate(run, { stepName: "other" }), undefined);
});
