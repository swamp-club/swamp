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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { fanOutJobView } from "./fan_out_view.ts";
import type { JobRunData, StepRunData } from "./workflow_run.ts";

const RESUMED = Date.parse("2026-01-01T01:00:00.000Z");

const stepArb = fc.record({
  status: fc.constantFrom<StepRunData["status"]>(
    "pending",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "skipped",
    "unknown",
  ),
  // minutes either side of the resume, or never started
  startedOffset: fc.option(fc.integer({ min: -30, max: 30 }), {
    nil: undefined,
  }),
  allowedFailure: fc.boolean(),
  jobSkipped: fc.boolean(),
});

const laneArb = fc.array(stepArb, { minLength: 1, maxLength: 3 });

type LaneSpec = typeof laneArb extends fc.Arbitrary<infer T> ? T : never;

function laneSteps(
  worker: string,
  steps: LaneSpec,
): StepRunData[] {
  return steps.map((step, index) => ({
    stepName: `s${index}[${worker}]`,
    status: step.status,
    ...(step.startedOffset !== undefined
      ? {
        startedAt: new Date(RESUMED + step.startedOffset * 60_000)
          .toISOString(),
      }
      : {}),
    ...(step.allowedFailure ? { allowedFailure: true } : {}),
    ...(step.status === "skipped"
      ? {
        skipReason: step.jobSkipped
          ? { kind: "job_skipped" as const }
          : { kind: "guarded" as const },
      }
      : {}),
  }));
}

Deno.test("fanOutJobView: every planned lane gets exactly one result, and the latest resume splits the lanes into rerun and kept", () => {
  fc.assert(
    fc.property(
      fc.array(laneArb, { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 1, max: 5 }),
      fc.boolean(),
      (lanes, canarySize, halted) => {
        const workers = lanes.map((_, index) => `w${index}`);
        const batches = [
          workers.slice(0, canarySize),
          workers.slice(canarySize),
        ].filter((batch) => batch.length > 0);
        const job: JobRunData = {
          jobName: "patch",
          status: "running",
          steps: lanes.flatMap((steps, index) =>
            laneSteps(workers[index], steps)
          ),
          fanOutPlan: {
            members: workers.map((worker) => ({
              worker,
              instanceUuid: `uuid-${worker}`,
              disposition: "dispatch" as const,
              batch: batches.findIndex((batch) => batch.includes(worker)),
            })),
            plannedLanes: workers.length,
            maxFailures: 0,
            batches,
            lanes: workers.map((worker) => ({
              name: `patch[${worker}]`,
              worker,
              instanceUuid: `uuid-${worker}`,
              steps: [],
            })),
          },
          ...(halted
            ? {
              fanOutHalts: [{
                batch: 0,
                maxFailures: 0,
                failed: [],
                held: [workers[workers.length - 1]],
              }],
            }
            : {}),
        };
        const view = fanOutJobView(job, {
          resumedAt: new Date(RESUMED).toISOString(),
        })!;
        assertEquals(view.members.map((member) => member.worker), workers);
        for (const member of view.members) assert(member.lane !== undefined);
        const rerun = view.resume!.rerun;
        const kept = view.resume!.kept;
        assertEquals([...rerun, ...kept].sort(), [...workers].sort());
        assertEquals(new Set([...rerun, ...kept]).size, workers.length);
        lanes.forEach((steps, index) => {
          if (steps.some((step) => (step.startedOffset ?? -1) >= 0)) {
            assert(rerun.includes(workers[index]));
          }
        });
        assertEquals(
          view.budget.used,
          view.members.filter((member) => member.lane === "failed").length,
        );
        assert(!JSON.stringify(view).includes("uuid-"));
      },
    ),
    { numRuns: 1000 },
  );
});
