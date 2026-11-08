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
import type { FanOutPolicy, FanOutSelector } from "./fan_out.ts";
import {
  eligibleWorkers,
  laneDispatchVerdict,
  planFanOut,
} from "./scheduler.ts";
import type { PoolWorker, PoolWorkerStatus } from "./worker_pool.ts";

const STATUSES: PoolWorkerStatus[] = [
  "idle",
  "busy",
  "unverified",
  "draining",
  "disconnected",
];

const poolArb = fc.uniqueArray(
  fc.record({
    name: fc.stringMatching(/^[a-z]{1,3}$/),
    instanceUuid: fc.uuid(),
    labels: fc.record({ role: fc.constantFrom("web", "db") }, {
      requiredKeys: [],
    })
      .chain((labels) =>
        fc.record({ zone: fc.constantFrom("a", "b") }, { requiredKeys: [] })
          .map((zone) => ({ ...labels, ...zone }) as Record<string, string>)
      ),
    platform: fc.constantFrom("linux", "darwin"),
    arch: fc.constantFrom("x86_64", "aarch64"),
    status: fc.constantFrom(...STATUSES),
    connected: fc.boolean(),
  }),
  { selector: (worker) => worker.name, maxLength: 12 },
) as fc.Arbitrary<PoolWorker[]>;

const selectorArb: fc.Arbitrary<FanOutSelector> = fc.record({
  labels: fc.record({
    role: fc.constantFrom("web", "db"),
    zone: fc.constantFrom("a", "b"),
  }, {
    requiredKeys: [],
  }),
  platform: fc.constantFrom(
    "linux",
    "darwin",
    "linux/x86_64",
    "darwin/aarch64",
  ),
}, { requiredKeys: [] });

const policyArb: fc.Arbitrary<FanOutPolicy> = fc.record({
  offline: fc.constantFrom("wait" as const, "skip" as const, "fail" as const),
  minWorkers: fc.integer({ min: 1, max: 6 }),
});

// matching through eligibleWorkers, so the oracle is not planFanOut's own code
function matches(selector: FanOutSelector, worker: PoolWorker): boolean {
  return eligibleWorkers(
    {
      labels: selector.labels ? { ...selector.labels } : undefined,
      platform: selector.platform,
    },
    [{
      ...worker,
      labels: { ...worker.labels },
      status: "idle",
      connected: true,
      capacity: 1,
      activeDispatchIds: [],
    }],
  ).length === 1;
}

function isLive(worker: PoolWorker, policy: FanOutPolicy): boolean {
  if (worker.status === "unverified" || worker.status === "draining") {
    return false;
  }
  const online = worker.connected && worker.status !== "disconnected";
  return online || policy.offline === "wait";
}

Deno.test("planFanOut: every matching worker appears exactly once and no other worker appears", () => {
  let planned = 0;
  fc.assert(
    fc.property(poolArb, selectorArb, (pool, selector) => {
      // the least-refusing policy, so most runs check a plan
      const policy: FanOutPolicy = { offline: "wait", minWorkers: 1 };
      const plan = planFanOut(selector, policy, pool);
      if (plan.kind === "refused") return;
      planned++;
      const expected = pool.filter((w) => matches(selector, w)).map((w) =>
        w.name
      ).sort();
      assertEquals(plan.members.map((m) => m.worker).sort(), expected);
      assertEquals(
        new Set(plan.members.map((m) => m.worker)).size,
        plan.members.length,
      );
    }),
    { numRuns: 500 },
  );
  console.log("planFanOut planned runs", planned);
  assert(planned > 100, `only ${planned} runs produced a plan`);
});

Deno.test("planFanOut: unverified and draining workers never get a lane", () => {
  fc.assert(
    fc.property(poolArb, selectorArb, policyArb, (pool, selector, policy) => {
      const plan = planFanOut(selector, policy, pool);
      if (plan.kind === "refused") return;
      const byName = new Map(pool.map((w) => [w.name, w]));
      for (const member of plan.members) {
        const status = byName.get(member.worker)!.status;
        if (status === "unverified" || status === "draining") {
          assertEquals(member.disposition, "excluded");
          assertEquals(member.reason, status);
        }
        if (member.disposition === "dispatch") {
          const worker = byName.get(member.worker)!;
          assert(
            worker.connected &&
              (worker.status === "idle" || worker.status === "busy"),
          );
        }
      }
    }),
    { numRuns: 500 },
  );
});

Deno.test("planFanOut: the result does not depend on pool order", () => {
  fc.assert(
    fc.property(
      poolArb,
      selectorArb,
      policyArb,
      fc.nat(),
      fc.boolean(),
      (pool, selector, policy, rotate, reverse) => {
        const shift = pool.length === 0 ? 0 : rotate % pool.length;
        const reordered = [...pool.slice(shift), ...pool.slice(0, shift)];
        if (reverse) reordered.reverse();
        assertEquals(
          planFanOut(selector, policy, reordered),
          planFanOut(selector, policy, pool),
        );
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("planFanOut: minWorkers refuses exactly when fewer members are dispatched or waiting", () => {
  let refused = 0;
  fc.assert(
    fc.property(poolArb, selectorArb, policyArb, (pool, selector, policy) => {
      const live = pool.filter((w) =>
        matches(selector, w) && isLive(w, policy)
      ).length;
      const plan = planFanOut(selector, policy, pool);
      if (live < policy.minWorkers) {
        refused++;
        assertEquals(plan, {
          kind: "refused",
          reason: "min_workers",
          live,
          minWorkers: policy.minWorkers,
        });
      } else {
        assertEquals(plan.kind, "planned");
        if (plan.kind === "planned") assertEquals(plan.plannedLanes, live);
      }
    }),
    { numRuns: 500 },
  );
  assert(refused > 50, `only ${refused} runs were refused`);
});

Deno.test("laneDispatchVerdict: a lane is only ever sent to a connected worker that is neither unverified nor draining", () => {
  fc.assert(
    fc.property(
      fc.option(
        fc.record({
          status: fc.constantFrom(
            "idle" as const,
            "busy" as const,
            "unverified" as const,
            "draining" as const,
          ),
          connected: fc.boolean(),
        }),
        { nil: null },
      ),
      (worker) => {
        const verdict = laneDispatchVerdict(worker);
        if (verdict.kind === "dispatch") {
          assert(worker !== null && worker.connected);
          assert(worker.status === "idle" || worker.status === "busy");
        }
        if (verdict.kind === "wait") {
          assert(
            worker === null ||
              (!worker.connected &&
                (worker.status === "idle" || worker.status === "busy")),
          );
        }
        if (verdict.kind === "ineligible") {
          assert(
            worker !== null &&
              (worker.status === "unverified" || worker.status === "draining"),
          );
        }
      },
    ),
    { numRuns: 500 },
  );
});
