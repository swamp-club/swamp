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
import {
  fanOutJobFailed,
  perWorkerBehaviorName,
  planLaneSteps,
} from "./fan_out_lanes.ts";

const nameArb = fc.stringMatching(/^[a-z\[\]]{1,4}$/);

Deno.test("planLaneSteps: every lane step name is unique and maps back to exactly its step and worker, or the plan is refused", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(nameArb, { minLength: 1, maxLength: 4 }),
      fc.uniqueArray(nameArb, { minLength: 1, maxLength: 4 }),
      (steps, workers) => {
        let planned;
        try {
          planned = planLaneSteps("job", steps, workers);
        } catch {
          const names = workers.flatMap((w) => steps.map((s) => `${s}[${w}]`));
          const unique = new Set(names).size === names.length;
          const clashesAuthored = names.some((n) => steps.includes(n));
          assert(!unique || clashesAuthored);
          return;
        }
        assertEquals(planned.size, steps.length * workers.length);
        for (const worker of workers) {
          for (const step of steps) {
            assertEquals(planned.get(`${step}[${worker}]`), {
              worker,
              authored: step,
            });
          }
        }
        for (const name of planned.keys()) assert(!steps.includes(name));
      },
    ),
    { numRuns: 2000 },
  );
});

Deno.test("fanOutJobFailed: the job succeeds exactly when no lane failed and no member failed at plan time", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "dispatch" as const,
          "waiting" as const,
          "skipped" as const,
          "failed" as const,
          "excluded" as const,
        ),
      ),
      fc.nat(5),
      (dispositions, failedLanes) => {
        const failed = fanOutJobFailed(
          dispositions.map((disposition) => ({ disposition })),
          failedLanes,
        );
        assertEquals(
          failed,
          failedLanes > 0 || dispositions.includes("failed"),
        );
      },
    ),
  );
});

// worker names pass the definition-name check at token mint, so the joined
// instance name can never introduce a path-traversal sequence of its own
Deno.test("perWorkerBehaviorName: joining two names free of traversal sequences never creates one", () => {
  const traversal = (name: string) =>
    name.includes("..") || name.includes("\\") || name.includes("\0");
  fc.assert(
    fc.property(fc.string(), fc.string(), (behavior, worker) => {
      fc.pre(!traversal(behavior) && !traversal(worker));
      assert(!traversal(perWorkerBehaviorName(behavior, worker)));
    }),
    { numRuns: 5000 },
  );
});
