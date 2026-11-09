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
import { runRolloutLanes } from "./fan_out_rollout.ts";

type Event =
  | { kind: "batch"; batch: number }
  | { kind: "step"; lane: string };

interface Coverage {
  halted: number;
  complete: number;
  aborted: number;
  midBatchHalt: number;
  limited: number;
  paused: number;
}

const batchesArb = fc.array(fc.integer({ min: 1, max: 4 }), {
  minLength: 1,
  maxLength: 4,
}).map((sizes) => {
  let next = 0;
  return sizes.map((size) => Array.from({ length: size }, () => `l${next++}`));
});

Deno.test("runRolloutLanes: batches settle in order, nothing starts past the budget, the limit holds, and every lane is run or held", async () => {
  const coverage: Coverage = {
    halted: 0,
    complete: 0,
    aborted: 0,
    midBatchHalt: 0,
    limited: 0,
    paused: 0,
  };
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      batchesArb,
      fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
      fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
      fc.func(fc.boolean()),
      fc.func(fc.integer({ min: 1, max: 3 })),
      fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
      // the first batch an undecided gate holds
      fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
      async (
        s,
        batches,
        maxFailures,
        limit,
        failsOf,
        stepsOf,
        abortAt,
        gateFrom,
      ) => {
        const lanes = batches.flat();
        const batchOf = new Map(
          batches.flatMap((batch, index) => batch.map((l) => [l, index])),
        );
        const controller = new AbortController();
        const started: string[] = [];
        const settled = new Set<string>();
        const failed = new Set<string>();
        let inFlight = 0;
        let maxInFlight = 0;
        let starts = 0;
        const start = (lane: string) =>
          (async function* () {
            if (maxFailures !== null) assert(failed.size <= maxFailures);
            for (const other of lanes) {
              if (batchOf.get(other)! < batchOf.get(lane)!) {
                assert(settled.has(other), `${lane} started before ${other}`);
              }
            }
            assert(!controller.signal.aborted, "started after the abort");
            started.push(lane);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (abortAt !== undefined && ++starts > abortAt) {
              controller.abort();
            }
            try {
              for (let i = 0; i < stepsOf(lane); i++) {
                await s.schedule(Promise.resolve());
                yield { kind: "step", lane } as Event;
              }
            } finally {
              inFlight--;
            }
          })();
        const seen: Event[] = [];
        const generator = runRolloutLanes<Event>({
          rollout: { batches, maxFailures },
          limit,
          signal: controller.signal,
          start,
          // the driver learns a lane's outcome only when its stream ends
          failed: (lane) => {
            settled.add(lane);
            if (failsOf(lane)) failed.add(lane);
            return failsOf(lane);
          },
          batchStarted: (batch) => ({ kind: "batch", batch }),
          ...(gateFrom !== undefined
            ? { held: (lane: string) => batchOf.get(lane)! >= gateFrom }
            : {}),
        });
        const run = (async () => {
          while (true) {
            const next = await generator.next();
            if (next.done) return next.value;
            seen.push(next.value);
          }
        })();
        const end = await s.waitFor(run);

        if (limit !== undefined) {
          assert(maxInFlight <= limit);
          if (maxInFlight === limit && limit < lanes.length) {
            coverage.limited++;
          }
        }
        assertEquals(new Set(started).size, started.length);
        if (gateFrom !== undefined) {
          for (const lane of started) assert(batchOf.get(lane)! < gateFrom);
        }
        for (const lane of started) assert(settled.has(lane));
        const announced = seen.filter((e) => e.kind === "batch")
          .map((e) => (e as { batch: number }).batch);
        assertEquals(announced, [...announced].sort((a, b) => a - b));
        assertEquals(new Set(announced).size, announced.length);
        for (const [index, event] of seen.entries()) {
          if (event.kind !== "step") continue;
          const batch = batchOf.get(event.lane)!;
          assert(
            seen.slice(0, index).some((e) =>
              e.kind === "batch" && e.batch === batch
            ),
          );
        }
        if (end.kind === "paused") {
          coverage.paused++;
          assert(gateFrom !== undefined);
          assertEquals(batchOf.get(end.lane), gateFrom);
          // the gate opens only where the budget would start the lane
          if (maxFailures !== null) assert(failed.size <= maxFailures);
          assertEquals(
            new Set(started),
            new Set(lanes.filter((l) => batchOf.get(l)! < gateFrom)),
          );
          for (const lane of started) assert(settled.has(lane));
        } else if (end.kind === "aborted") {
          coverage.aborted++;
          assert(controller.signal.aborted);
        } else if (end.kind === "halted") {
          coverage.halted++;
          assert(maxFailures !== null && failed.size > maxFailures);
          assertEquals(end.held, lanes.filter((l) => !started.includes(l)));
          assert(end.held.length > 0);
          const heldBatch = batchOf.get(end.held[0])!;
          if (batches[heldBatch].some((l) => started.includes(l))) {
            coverage.midBatchHalt++;
          }
        } else {
          coverage.complete++;
          assert(gateFrom === undefined || gateFrom >= batches.length);
          assertEquals(new Set(started), new Set(lanes));
        }
      },
    ),
    { numRuns: 1000 },
  );
  console.log("runRolloutLanes coverage", coverage);
  for (const [branch, hits] of Object.entries(coverage)) {
    assert(hits > 20, `branch ${branch} hit only ${hits} times`);
  }
});
