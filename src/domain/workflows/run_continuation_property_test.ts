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
import fc from "fast-check";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";
import {
  acceptedOutcomeFor,
  InMemorySignalWaitStore,
} from "./signal_wait_store_test_helpers.ts";
import { decideContinuation } from "./run_continuation.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

/** What one step of a generated run is doing when the run is read. */
type StepState =
  | "wait_settled"
  | "wait_open"
  | "gate_undecided"
  | "work_running"
  | "work_done";

const stepsArb = fc.array(
  fc.constantFrom<StepState>(
    "wait_settled",
    "wait_open",
    "gate_undecided",
    "work_running",
    "work_done",
  ),
  { minLength: 1, maxLength: 6 },
);

Deno.test("decideContinuation: a run is resumable exactly when it is suspended and nothing on it is still open (property)", async () => {
  await fc.assert(
    fc.asyncProperty(stepsArb, fc.boolean(), async (states, suspended) => {
      const run = WorkflowRun.create(
        Workflow.create({
          name: "release",
          jobs: [
            Job.create({
              name: "main",
              steps: states.map((state, i) =>
                Step.create({
                  name: `s${i}`,
                  task: state.startsWith("wait")
                    ? StepTask.waitForSignal(60, SCHEMA)
                    : state === "gate_undecided"
                    ? StepTask.manualApproval("ok?")
                    : StepTask.modelMethod("model", "method"),
                })
              ),
            }),
          ],
        }),
      );
      run.start();
      const job = run.getJob("main")!;
      job.start();
      const store = new InMemorySignalWaitStore();
      for (const [i, state] of states.entries()) {
        const step = job.getStep(`s${i}`)!;
        step.start();
        if (state === "wait_settled" || state === "wait_open") {
          const wait = SignalWait.open(SCHEMA, 60, OPENED);
          step.waitForSignal(wait);
          if (state === "wait_settled") {
            await store.settle(
              acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id }),
            );
          }
        } else if (state === "gate_undecided") {
          step.waitForApproval();
        } else if (state === "work_done") {
          step.succeed();
        }
      }
      if (suspended) run.suspend();

      const expected = suspended &&
        states.every((s) => s === "wait_settled" || s === "work_done");
      assertEquals(
        (await decideContinuation(run, store)).kind === "resumable",
        expected,
      );
    }),
  );
});
