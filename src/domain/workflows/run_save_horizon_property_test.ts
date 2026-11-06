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
import { RunSaveHorizon } from "./run_save_horizon.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

function propertyRun(): WorkflowRun {
  return WorkflowRun.create(
    Workflow.create({
      name: "horizon-property",
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

type Op =
  | { kind: "stamp" }
  | { kind: "begin" }
  | { kind: "land"; pick: number }
  | { kind: "refuse"; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant({ kind: "stamp" as const }),
  fc.constant({ kind: "begin" as const }),
  fc.nat().map((pick) => ({ kind: "land" as const, pick })),
  fc.nat().map((pick) => ({ kind: "refuse" as const, pick })),
);

Deno.test("RunSaveHorizon: an event is covered exactly when a save that began after it was stamped has landed", () => {
  fc.assert(
    fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
      const horizon = new RunSaveHorizon();
      const run = propertyRun();
      // Each event remembers how many saves had begun before it was stamped.
      const events: { event: object; beganBefore: number }[] = [];
      const begun: number[] = [];
      const landedSaves = new Set<number>();
      for (const op of ops) {
        if (op.kind === "stamp") {
          const event = {};
          horizon.stamp(event);
          events.push({ event, beganBefore: begun.length });
        } else if (op.kind === "begin") {
          begun.push(horizon.begin());
        } else if (begun.length > 0) {
          const save = op.pick % begun.length;
          if (op.kind === "land") {
            horizon.landed(run, begun[save]);
            landedSaves.add(save);
          }
        }
      }
      for (const { event, beganBefore } of events) {
        const expected = [...landedSaves].some((save) => save >= beganBefore);
        assertEquals(horizon.covers(run, event), expected);
      }
    }),
  );
});
