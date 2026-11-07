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
import { RunSaveHorizon } from "./run_save_horizon.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

function horizonTestRun(): WorkflowRun {
  return WorkflowRun.create(
    Workflow.create({
      name: "horizon",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "a",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    }),
  );
}

Deno.test("RunSaveHorizon: an event is not covered before any save lands", () => {
  const horizon = new RunSaveHorizon();
  const run = horizonTestRun();
  const event = { kind: "step_started" };
  horizon.stamp(event);
  assertEquals(horizon.covers(run, event), false);
});

Deno.test("RunSaveHorizon: an event stamped before a save began is covered once it lands", () => {
  const horizon = new RunSaveHorizon();
  const run = horizonTestRun();
  const first = { kind: "step_started" };
  const second = { kind: "step_completed" };
  horizon.stamp(first);
  horizon.stamp(second);
  const mark = horizon.begin();
  assertEquals(horizon.covers(run, first), false);
  horizon.landed(run, mark);
  assertEquals(horizon.covers(run, first), true);
  assertEquals(horizon.covers(run, second), true);
});

Deno.test("RunSaveHorizon: an event stamped after a save began is not covered by it", () => {
  const horizon = new RunSaveHorizon();
  const run = horizonTestRun();
  const before = { kind: "step_started" };
  horizon.stamp(before);
  const mark = horizon.begin();
  const after = { kind: "step_completed" };
  horizon.stamp(after);
  horizon.landed(run, mark);
  assertEquals(horizon.covers(run, before), true);
  assertEquals(horizon.covers(run, after), false);
});

Deno.test("RunSaveHorizon: an unstamped event is never covered", () => {
  const horizon = new RunSaveHorizon();
  const run = horizonTestRun();
  horizon.stamp({ kind: "step_started" });
  horizon.landed(run, horizon.begin());
  assertEquals(horizon.covers(run, { kind: "step_failed" }), false);
});

Deno.test("RunSaveHorizon: a save of one run covers nothing for another", () => {
  const horizon = new RunSaveHorizon();
  const saved = horizonTestRun();
  const other = horizonTestRun();
  const event = { kind: "step_started" };
  horizon.stamp(event);
  horizon.landed(saved, horizon.begin());
  assertEquals(horizon.covers(saved, event), true);
  assertEquals(horizon.covers(other, event), false);
});

Deno.test("RunSaveHorizon: an older save landing late does not lower the horizon", () => {
  const horizon = new RunSaveHorizon();
  const run = horizonTestRun();
  const early = horizon.begin();
  const event = { kind: "step_started" };
  horizon.stamp(event);
  const late = horizon.begin();
  horizon.landed(run, late);
  horizon.landed(run, early);
  assertEquals(horizon.covers(run, event), true);
});
