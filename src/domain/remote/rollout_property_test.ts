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
  type FanOutMember,
  parsePercent,
  resolveMaxFailures,
  type RolloutBatchSize,
} from "./fan_out.ts";
import {
  nextBatch,
  planBatches,
  type PlannedRollout,
  resumeRollout,
} from "./rollout.ts";

const membersArb: fc.Arbitrary<FanOutMember[]> = fc.uniqueArray(
  fc.record({
    worker: fc.stringMatching(/^[a-z]{1,3}$/),
    instanceUuid: fc.constant("u"),
    disposition: fc.constantFrom(
      "dispatch" as const,
      "waiting" as const,
      "skipped" as const,
      "failed" as const,
      "excluded" as const,
    ),
  }),
  { selector: (member) => member.worker, maxLength: 15 },
);

const batchesArb: fc.Arbitrary<RolloutBatchSize[]> = fc.array(
  fc.oneof(
    fc.integer({ min: 1, max: 5 }),
    fc.integer({ min: 1, max: 99 }).map((pct) => `${pct}%` as RolloutBatchSize),
  ),
  { maxLength: 4 },
).map((sizes) => [...sizes, "100%"]);

function requested(size: RolloutBatchSize, lanes: number): number {
  return typeof size === "number"
    ? size
    : Math.ceil((parsePercent(size)! * lanes) / 100);
}

Deno.test("planBatches: batches cover every lane once, in order, waiting last, at the requested sizes", () => {
  fc.assert(
    fc.property(membersArb, batchesArb, (members, sizes) => {
      const named = (d: string) =>
        members.filter((m) => m.disposition === d).map((m) => m.worker).sort();
      const lanes = [...named("dispatch"), ...named("waiting")];
      const batches = planBatches(members, { batches: sizes });
      assertEquals(batches.flat(), lanes);
      assert(batches.every((batch) => batch.length > 0));
      let remaining = lanes.length;
      batches.forEach((batch, k) => {
        const expected = k === sizes.length - 1
          ? remaining
          : Math.min(requested(sizes[k], lanes.length), remaining);
        assertEquals(batch.length, expected, `batch ${k}`);
        remaining -= batch.length;
      });
      assertEquals(planBatches(members).flat(), lanes);
    }),
    { numRuns: 500 },
  );
});

Deno.test("resolveMaxFailures: a percentage budget is floor(pct x planned lanes)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 5000 }),
      (pct, lanes) => {
        const budget = resolveMaxFailures(`${pct}%`, lanes)!;
        assert(Number.isInteger(budget));
        assert(budget * 100 <= pct * lanes && pct * lanes < (budget + 1) * 100);
      },
    ),
  );
});

interface Coverage {
  halt: number;
  complete: number;
  waitWhileRunning: number;
  startMidBatch: number;
  noBudget: number;
}

// a lane engine in miniature: start while offered and a slot is free, else settle one
function simulate(
  rollout: PlannedRollout,
  failing: ReadonlySet<string>,
  concurrency: number,
  picks: readonly number[],
  coverage: Coverage,
): void {
  const lanes = rollout.batches.flat();
  const batchOf = new Map(
    rollout.batches.flatMap((batch, i) =>
      batch.map((lane) => [lane, i] as const)
    ),
  );
  const started = new Set<string>();
  const settled = new Set<string>();
  const failed = new Set<string>();
  const running: string[] = [];
  let held: string[] | null = null;
  let pick = 0;
  const settleOne = () => {
    const [lane] = running.splice(
      picks[pick++ % picks.length] % running.length,
      1,
    );
    settled.add(lane);
    if (failing.has(lane)) failed.add(lane);
  };
  for (let guard = 0; guard < 10 * lanes.length + 10; guard++) {
    const decision = nextBatch({ started, settled, failed }, rollout);
    if (decision.kind === "halt") {
      assert(rollout.maxFailures !== null && failed.size > rollout.maxFailures);
      for (const lane of decision.held) {
        assert(!started.has(lane), `${lane} started yet held`);
      }
      held = decision.held;
      coverage.halt++;
      break;
    }
    if (decision.kind === "complete") {
      assert(
        rollout.maxFailures === null || failed.size <= rollout.maxFailures,
      );
      coverage.complete++;
      break;
    }
    if (decision.kind === "start" && running.length < concurrency) {
      assert(
        rollout.maxFailures === null || failed.size <= rollout.maxFailures,
        "lane started after the budget was spent",
      );
      const lane = decision.lanes[0];
      assert(!started.has(lane));
      for (
        const earlier of rollout.batches.slice(0, batchOf.get(lane)!).flat()
      ) {
        assert(
          settled.has(earlier),
          `${lane} started before ${earlier} settled`,
        );
      }
      if (decision.lanes.length < rollout.batches[decision.batch].length) {
        coverage.startMidBatch++;
      }
      started.add(lane);
      running.push(lane);
      continue;
    }
    assert(running.length > 0, "nextBatch waits with nothing running");
    if (decision.kind === "wait") coverage.waitWhileRunning++;
    settleOne();
  }
  // running lanes finish after a halt, and the held set must not change as they do
  while (held !== null && running.length > 0) {
    settleOne();
    const after = nextBatch({ started, settled, failed }, rollout);
    assertEquals(after, { kind: "halt", held });
  }
  assertEquals(running.length, 0);
  const terminal = lanes.map((lane) =>
    [
      settled.has(lane) && !failed.has(lane),
      failed.has(lane),
      held?.includes(lane) ?? false,
    ]
      .filter(Boolean).length
  );
  assert(
    terminal.every((count) => count === 1),
    "every lane ends in exactly one terminal state",
  );
}

Deno.test("nextBatch: no lane starts past the budget, started lanes are never held, every lane ends once", () => {
  const coverage: Coverage = {
    halt: 0,
    complete: 0,
    waitWhileRunning: 0,
    startMidBatch: 0,
    noBudget: 0,
  };
  fc.assert(
    fc.property(
      membersArb,
      batchesArb,
      fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
      fc.func(fc.boolean()),
      (members, sizes, maxFailures, concurrency, picks, fails) => {
        const batches = planBatches(members, { batches: sizes });
        const failing = new Set(batches.flat().filter((lane) => fails(lane)));
        if (maxFailures === null) coverage.noBudget++;
        simulate(
          { batches, maxFailures },
          failing,
          concurrency,
          picks,
          coverage,
        );
      },
    ),
    { numRuns: 1000 },
  );
  console.log("nextBatch coverage", coverage);
  for (const [branch, hits] of Object.entries(coverage)) {
    assert(hits > 20, `branch ${branch} hit only ${hits} times`);
  }
});

Deno.test("nextBatch: no budget never halts", () => {
  fc.assert(
    fc.property(
      membersArb,
      batchesArb,
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.nat(), { minLength: 1 }),
      (members, sizes, concurrency, picks) => {
        const batches = planBatches(members, { batches: sizes });
        const coverage: Coverage = {
          halt: 0,
          complete: 0,
          waitWhileRunning: 0,
          startMidBatch: 0,
          noBudget: 0,
        };
        simulate(
          { batches, maxFailures: null },
          new Set(batches.flat()),
          concurrency,
          picks,
          coverage,
        );
        assertEquals(coverage.halt, 0);
        assertEquals(coverage.complete, 1);
      },
    ),
  );
});

Deno.test("resumeRollout: runs every re-run lane once, failed-first lanes before the rest, the rest in frozen batch order", () => {
  fc.assert(
    fc.property(
      membersArb,
      batchesArb,
      fc.func(fc.boolean()),
      fc.func(fc.boolean()),
      (members, sizes, rerunOf, failedOf) => {
        const batches = planBatches(members, { batches: sizes });
        const lanes = batches.flat();
        const rerun = new Set(lanes.filter((lane) => rerunOf(lane)));
        const failed = new Set(lanes.filter((lane) => failedOf(lane)));
        const resumed = resumeRollout(batches, rerun, failed);
        const flat = resumed.flat();
        assertEquals(new Set(flat), rerun);
        assertEquals(flat.length, rerun.size);
        assert(resumed.every((batch) => batch.length > 0));
        const first = lanes.filter((lane) =>
          rerun.has(lane) && failed.has(lane)
        );
        if (first.length > 0) assertEquals(resumed[0], first);
        const rest = resumed.slice(first.length > 0 ? 1 : 0);
        const batchOf = new Map(
          batches.flatMap((batch, index) => batch.map((lane) => [lane, index])),
        );
        // each remaining batch is one frozen batch's lanes, in plan order
        for (const batch of rest) {
          assert(batch.every((lane) => !failed.has(lane)));
          assertEquals(new Set(batch.map((lane) => batchOf.get(lane))).size, 1);
        }
        assertEquals(
          rest.flat(),
          lanes.filter((l) => rerun.has(l) && !failed.has(l)),
        );
      },
    ),
    { numRuns: 500 },
  );
});
