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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { FanOutPolicySchema } from "./fan_out.ts";
import {
  describePlacement,
  eligibleWorkers,
  hasPlacement,
  laneDispatchVerdict,
  planFanOut,
  type SchedulableWorker,
  scheduleStep,
  unmetPlacement,
} from "./scheduler.ts";
import type { PoolWorker } from "./worker_pool.ts";

function worker(
  overrides: Partial<SchedulableWorker> & { name: string },
): SchedulableWorker {
  return {
    instanceUuid: `uuid-${overrides.name}`,
    labels: {},
    platform: "linux",
    arch: "x86_64",
    status: "idle",
    connected: true,
    capacity: 1,
    activeDispatchIds: [],
    ...overrides,
  };
}

Deno.test("hasPlacement: false for undefined or empty placement", () => {
  assertEquals(hasPlacement(undefined), false);
  assertEquals(hasPlacement({}), false);
  assertEquals(hasPlacement({ labels: {} }), false);
});

Deno.test("hasPlacement: true for any requirement", () => {
  assertEquals(hasPlacement({ target: "w1" }), true);
  assertEquals(hasPlacement({ labels: { gpu: "true" } }), true);
  assertEquals(hasPlacement({ platform: "linux" }), true);
});

Deno.test("scheduleStep: direct target matches by name or instance uuid", () => {
  const pool = [worker({ name: "a" }), worker({ name: "b" })];
  const byName = scheduleStep({ target: "b" }, pool);
  assertEquals(byName.kind, "dispatch");
  assertEquals(
    byName.kind === "dispatch" ? byName.worker.name : "",
    "b",
  );
  const byUuid = scheduleStep({ target: "uuid-a" }, pool);
  assertEquals(byUuid.kind === "dispatch" ? byUuid.worker.name : "", "a");
});

Deno.test("scheduleStep: direct target on a busy worker queues", () => {
  const pool = [
    worker({
      name: "a",
      status: "busy",
      activeDispatchIds: ["d1"],
      capacity: 1,
    }),
  ];
  assertEquals(scheduleStep({ target: "a" }, pool).kind, "queue");
});

Deno.test("scheduleStep: direct target not connected queues", () => {
  const pool = [worker({ name: "a", connected: false })];
  const decision = scheduleStep({ target: "a" }, pool);
  assertEquals(decision.kind, "queue");
});

Deno.test("scheduleStep: label selectors require every entry to match", () => {
  const pool = [
    worker({ name: "gpu-east", labels: { gpu: "true", region: "us-east" } }),
    worker({ name: "cpu-east", labels: { region: "us-east" } }),
  ];
  const decision = scheduleStep(
    { labels: { gpu: "true", region: "us-east" } },
    pool,
  );
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "gpu-east",
  );
});

Deno.test("scheduleStep: platform matches 'os' and 'os/arch' forms", () => {
  const pool = [
    worker({ name: "lin-x86", platform: "linux", arch: "x86_64" }),
    worker({ name: "lin-arm", platform: "linux", arch: "aarch64" }),
    worker({ name: "mac", platform: "darwin", arch: "aarch64" }),
  ];
  assertEquals(eligibleWorkers({ platform: "linux" }, pool).length, 2);
  const armOnly = eligibleWorkers({ platform: "linux/aarch64" }, pool);
  assertEquals(armOnly.map((w) => w.name), ["lin-arm"]);
  assertEquals(
    scheduleStep({ platform: "windows" }, pool).kind,
    "queue",
  );
});

Deno.test("scheduleStep: all-busy eligible pool queues rather than failing", () => {
  const pool = [
    worker({
      name: "a",
      status: "busy",
      labels: { gpu: "true" },
      activeDispatchIds: ["d1"],
      capacity: 1,
    }),
    worker({
      name: "b",
      status: "busy",
      labels: { gpu: "true" },
      activeDispatchIds: ["d2"],
      capacity: 1,
    }),
  ];
  assertEquals(scheduleStep({ labels: { gpu: "true" } }, pool).kind, "queue");
});

Deno.test("scheduleStep: deterministic tiebreak among idle workers", () => {
  const pool = [
    worker({ name: "zeta" }),
    worker({ name: "alpha" }),
    worker({ name: "mid" }),
  ];
  const decision = scheduleStep({ platform: "linux" }, pool);
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "alpha",
  );
});

Deno.test("scheduleStep: disconnected workers never match", () => {
  const pool = [
    worker({ name: "gone", connected: false }),
    worker({ name: "here" }),
  ];
  const decision = scheduleStep({ platform: "linux" }, pool);
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "here",
  );
});

Deno.test("scheduleStep: no-match placement queues", () => {
  const decision = scheduleStep(
    { labels: { gpu: "true" }, platform: "linux/aarch64" },
    [worker({ name: "plain" })],
  );
  assertEquals(decision.kind, "queue");
});

Deno.test("describePlacement: names target requirement", () => {
  assertEquals(
    describePlacement({ target: "my-worker" }),
    "target 'my-worker'",
  );
});

Deno.test("describePlacement: names labels and platform", () => {
  const desc = describePlacement({
    labels: { gpu: "true" },
    platform: "linux/aarch64",
  });
  assertStringIncludes(desc, "gpu=true");
  assertStringIncludes(desc, "linux/aarch64");
});

Deno.test("describePlacement: falls back to 'any worker'", () => {
  assertEquals(describePlacement({}), "any worker");
});

Deno.test("eligibleWorkers: excludes unverified workers", () => {
  const pool = [
    worker({ name: "ok", status: "idle" }),
    worker({ name: "bad", status: "unverified" }),
  ];
  const eligible = eligibleWorkers({}, pool);
  assertEquals(eligible.length, 1);
  assertEquals(eligible[0].name, "ok");
});

Deno.test("scheduleStep: unverified worker is never dispatched to without target", () => {
  const pool = [worker({ name: "a", status: "unverified" })];
  assertEquals(scheduleStep({}, pool).kind, "queue");
});

Deno.test("eligibleWorkers: targeted placement reaches unverified worker", () => {
  const pool = [worker({ name: "probe-target", status: "unverified" })];
  const eligible = eligibleWorkers({ target: "probe-target" }, pool);
  assertEquals(eligible.length, 1);
  assertEquals(eligible[0].name, "probe-target");
});

Deno.test("scheduleStep: targeted dispatch to unverified worker queues", () => {
  const pool = [
    worker({
      name: "a",
      status: "unverified",
      activeDispatchIds: ["d1"],
      capacity: 1,
    }),
  ];
  const decision = scheduleStep({ target: "a" }, pool);
  assertEquals(decision.kind, "queue");
});

Deno.test("eligibleWorkers: draining workers excluded from non-targeted placement", () => {
  const pool = [
    worker({ name: "a", status: "draining" }),
    worker({ name: "b", status: "idle" }),
  ];
  const eligible = eligibleWorkers({}, pool);
  assertEquals(eligible.length, 1);
  assertEquals(eligible[0].name, "b");
});

Deno.test("eligibleWorkers: targeted placement excludes draining worker", () => {
  const pool = [worker({ name: "drain-target", status: "draining" })];
  const eligible = eligibleWorkers({ target: "drain-target" }, pool);
  assertEquals(eligible.length, 0);
});

Deno.test("scheduleStep: draining workers are not scheduled", () => {
  const pool = [worker({ name: "a", status: "draining" })];
  assertEquals(scheduleStep({}, pool).kind, "queue");
});

Deno.test("scheduleStep: least-loaded tiebreak picks worker with most free slots", () => {
  const pool = [
    worker({
      name: "heavy",
      status: "busy",
      capacity: 8,
      activeDispatchIds: ["d1", "d2", "d3", "d4", "d5", "d6"],
    }),
    worker({
      name: "light",
      status: "busy",
      capacity: 8,
      activeDispatchIds: ["d1", "d2"],
    }),
  ];
  const decision = scheduleStep({}, pool);
  assertEquals(decision.kind, "dispatch");
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "light",
  );
});

Deno.test("scheduleStep: equal free slots breaks on name", () => {
  const pool = [
    worker({
      name: "zulu",
      status: "busy",
      capacity: 8,
      activeDispatchIds: ["d1", "d2", "d3", "d4"],
    }),
    worker({
      name: "alpha",
      status: "busy",
      capacity: 8,
      activeDispatchIds: ["d1", "d2", "d3", "d4"],
    }),
  ];
  const decision = scheduleStep({}, pool);
  assertEquals(decision.kind, "dispatch");
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "alpha",
  );
});

Deno.test("scheduleStep: worker at capacity is not schedulable", () => {
  const pool = [
    worker({
      name: "full",
      status: "busy",
      capacity: 4,
      activeDispatchIds: ["d1", "d2", "d3", "d4"],
    }),
  ];
  assertEquals(scheduleStep({}, pool).kind, "queue");
});

Deno.test("scheduleStep: multi-capacity worker with available slots dispatches", () => {
  const pool = [
    worker({
      name: "partial",
      status: "busy",
      capacity: 4,
      activeDispatchIds: ["d1", "d2"],
    }),
  ];
  const decision = scheduleStep({}, pool);
  assertEquals(decision.kind, "dispatch");
  assertEquals(
    decision.kind === "dispatch" ? decision.worker.name : "",
    "partial",
  );
});

Deno.test("unmetPlacement: null when the worker meets every requirement", () => {
  const w = worker({
    name: "b",
    labels: { pool: "worker", slot: "b" },
    platform: "linux",
    arch: "aarch64",
  });
  assertEquals(unmetPlacement({}, w), null);
  assertEquals(unmetPlacement({ target: "b" }, w), null);
  assertEquals(unmetPlacement({ target: "uuid-b" }, w), null);
  assertEquals(unmetPlacement({ labels: { pool: "worker" } }, w), null);
  assertEquals(
    unmetPlacement({ labels: { pool: "worker", slot: "b" } }, w),
    null,
  );
  assertEquals(unmetPlacement({ platform: "linux/aarch64" }, w), null);
});

Deno.test("unmetPlacement: names the target the worker is not", () => {
  const w = worker({ name: "w1" });
  assertEquals(unmetPlacement({ target: "w2" }, w), "target 'w2'");
});

Deno.test("unmetPlacement: a target stands in for labels and platform, as in eligibleWorkers", () => {
  const w = worker({ name: "special", labels: {}, platform: "linux" });
  const placement = {
    target: "special",
    labels: { pool: "build" },
    platform: "windows",
  };
  assertEquals(unmetPlacement(placement, w), null);
  assertEquals(eligibleWorkers(placement, [w]).map((x) => x.name), [
    "special",
  ]);
});

Deno.test("unmetPlacement: names the first label the worker lacks", () => {
  const w = worker({ name: "b", labels: { pool: "worker", slot: "b" } });
  assertEquals(
    unmetPlacement({ labels: { pool: "worker", slot: "a" } }, w),
    "label slot=a",
  );
  assertEquals(
    unmetPlacement({ labels: { gpu: "true" } }, w),
    "label gpu=true",
  );
});

Deno.test("unmetPlacement: names a platform or arch the worker is not", () => {
  const w = worker({ name: "b", platform: "linux", arch: "x86_64" });
  assertEquals(
    unmetPlacement({ platform: "windows" }, w),
    "platform 'windows'",
  );
  assertEquals(
    unmetPlacement({ platform: "linux/aarch64" }, w),
    "platform 'linux/aarch64'",
  );
});

Deno.test("unmetPlacement: ignores status, connection and affinity", () => {
  const w = worker({ name: "b", status: "draining", connected: false });
  assertEquals(
    unmetPlacement({ target: "b", affinityKey: "run-1" }, w),
    null,
  );
});

// --- Placement table (swamp-club#4271) ---
//
// Every worker status against every placement field, for one worker that
// meets each field's requirement. The fleet fan-out work must leave every
// cell as it is. Expected values are written out, never derived from the
// scheduler's own rules.

type TableStatus =
  | "idle"
  | "busy with a free slot"
  | "busy at capacity"
  | "unverified"
  | "draining"
  | "disconnected";

function tableWorker(status: TableStatus): SchedulableWorker {
  const base = {
    name: "w1",
    labels: { fleet: "web" },
    platform: "linux",
    arch: "x86_64",
  };
  switch (status) {
    case "idle":
      return worker(base);
    case "busy with a free slot":
      return worker({
        ...base,
        status: "busy",
        capacity: 2,
        activeDispatchIds: ["d1"],
      });
    case "busy at capacity":
      return worker({ ...base, status: "busy", activeDispatchIds: ["d1"] });
    case "unverified":
      return worker({ ...base, status: "unverified" });
    case "draining":
      return worker({ ...base, status: "draining" });
    case "disconnected":
      return worker({ ...base, connected: false });
  }
}

const TABLE_PLACEMENTS = {
  "target by name": { target: "w1" },
  "target by instance uuid": { target: "uuid-w1" },
  "labels": { labels: { fleet: "web" } },
  "platform": { platform: "linux" },
  "platform/arch": { platform: "linux/x86_64" },
  "no placement": {},
} as const;

type TablePlacement = keyof typeof TABLE_PLACEMENTS;
type Cell = "dispatch" | "queue";

// [eligible, decision] per placement, by status.
const PLACEMENT_TABLE: Record<
  TableStatus,
  Record<TablePlacement, [boolean, Cell]>
> = {
  "idle": {
    "target by name": [true, "dispatch"],
    "target by instance uuid": [true, "dispatch"],
    "labels": [true, "dispatch"],
    "platform": [true, "dispatch"],
    "platform/arch": [true, "dispatch"],
    "no placement": [true, "dispatch"],
  },
  "busy with a free slot": {
    "target by name": [true, "dispatch"],
    "target by instance uuid": [true, "dispatch"],
    "labels": [true, "dispatch"],
    "platform": [true, "dispatch"],
    "platform/arch": [true, "dispatch"],
    "no placement": [true, "dispatch"],
  },
  "busy at capacity": {
    "target by name": [true, "queue"],
    "target by instance uuid": [true, "queue"],
    "labels": [true, "queue"],
    "platform": [true, "queue"],
    "platform/arch": [true, "queue"],
    "no placement": [true, "queue"],
  },
  // A target skips the unverified filter in eligibleWorkers, but
  // scheduleStep still never dispatches to an unverified worker: a targeted
  // step queues until queueTimeout.
  "unverified": {
    "target by name": [true, "queue"],
    "target by instance uuid": [true, "queue"],
    "labels": [false, "queue"],
    "platform": [false, "queue"],
    "platform/arch": [false, "queue"],
    "no placement": [false, "queue"],
  },
  "draining": {
    "target by name": [false, "queue"],
    "target by instance uuid": [false, "queue"],
    "labels": [false, "queue"],
    "platform": [false, "queue"],
    "platform/arch": [false, "queue"],
    "no placement": [false, "queue"],
  },
  "disconnected": {
    "target by name": [false, "queue"],
    "target by instance uuid": [false, "queue"],
    "labels": [false, "queue"],
    "platform": [false, "queue"],
    "platform/arch": [false, "queue"],
    "no placement": [false, "queue"],
  },
};

for (const [status, row] of Object.entries(PLACEMENT_TABLE)) {
  for (const [placementName, [eligible, decision]] of Object.entries(row)) {
    Deno.test(`placement table: ${status} worker, ${placementName} -> ${eligible ? "eligible" : "not eligible"}, ${decision}`, () => {
      const placement = TABLE_PLACEMENTS[placementName as TablePlacement];
      const pool = [tableWorker(status as TableStatus)];
      assertEquals(
        eligibleWorkers(placement, pool).map((w) => w.name),
        eligible ? ["w1"] : [],
      );
      const result = scheduleStep(placement, pool);
      assertEquals(result.kind, decision);
      if (result.kind === "dispatch") assertEquals(result.worker.name, "w1");
    });
  }
}

// A worker that does not meet the placement is never eligible, whatever its
// status: the requirement is checked before the status could matter.
const UNMET_PLACEMENTS = {
  "another target": { target: "w2" },
  "a label it lacks": { labels: { fleet: "db" } },
  "another platform": { platform: "darwin" },
  "another arch": { platform: "linux/aarch64" },
} as const;

for (const [placementName, placement] of Object.entries(UNMET_PLACEMENTS)) {
  Deno.test(`placement table: ${placementName} is never eligible, in any status`, () => {
    for (const status of Object.keys(PLACEMENT_TABLE) as TableStatus[]) {
      const pool = [tableWorker(status)];
      assertEquals(eligibleWorkers(placement, pool), [], status);
      assertEquals(scheduleStep(placement, pool).kind, "queue", status);
    }
  });
}

Deno.test("placement table: among eligible workers, most free slots wins, then name, for every placement field", () => {
  const pool = [
    worker({
      name: "c",
      labels: { fleet: "web" },
      capacity: 3,
      activeDispatchIds: ["d1"],
    }),
    worker({ name: "b", labels: { fleet: "web" }, capacity: 2 }),
    worker({ name: "a", labels: { fleet: "web" }, capacity: 2 }),
  ];
  for (
    const placement of [
      { labels: { fleet: "web" } },
      { platform: "linux" },
      { platform: "linux/x86_64" },
      {},
    ]
  ) {
    const result = scheduleStep(placement, pool);
    // a, b and c each have 2 free slots; the name breaks the tie.
    assertEquals(
      result.kind === "dispatch" ? result.worker.name : result.kind,
      "a",
      JSON.stringify(placement),
    );
  }
  const busier = scheduleStep({ labels: { fleet: "web" } }, [
    ...pool.slice(0, 2),
    worker({
      name: "a",
      labels: { fleet: "web" },
      capacity: 2,
      activeDispatchIds: ["d2"],
    }),
  ]);
  // a now has 1 free slot, b and c have 2: name order among the freest.
  assertEquals(busier.kind === "dispatch" ? busier.worker.name : "", "b");
});

function poolWorker(
  overrides: Partial<PoolWorker> & { name: string },
): PoolWorker {
  return {
    instanceUuid: `uuid-${overrides.name}`,
    labels: { role: "web" },
    platform: "linux",
    arch: "x86_64",
    status: "idle",
    connected: true,
    ...overrides,
  };
}

const defaultPolicy = FanOutPolicySchema.parse({});

Deno.test("planFanOut: gives each matching worker one disposition, in name order", () => {
  const pool = [
    poolWorker({ name: "web-05", status: "draining" }),
    poolWorker({ name: "web-01", status: "busy" }),
    poolWorker({ name: "web-04", status: "unverified" }),
    poolWorker({ name: "web-03", status: "idle", connected: false }),
    poolWorker({ name: "web-02" }),
    poolWorker({ name: "db-01", labels: { role: "db" } }),
  ];
  const plan = planFanOut({ labels: { role: "web" } }, defaultPolicy, pool);
  assertEquals(plan, {
    kind: "planned",
    members: [
      {
        worker: "web-01",
        instanceUuid: "uuid-web-01",
        disposition: "dispatch",
      },
      {
        worker: "web-02",
        instanceUuid: "uuid-web-02",
        disposition: "dispatch",
      },
      {
        worker: "web-03",
        instanceUuid: "uuid-web-03",
        disposition: "waiting",
        reason: "disconnected",
      },
      {
        worker: "web-04",
        instanceUuid: "uuid-web-04",
        disposition: "excluded",
        reason: "unverified",
      },
      {
        worker: "web-05",
        instanceUuid: "uuid-web-05",
        disposition: "excluded",
        reason: "draining",
      },
    ],
    plannedLanes: 3,
    maxFailures: null,
  });
});

Deno.test("planFanOut: offline policy decides a disconnected worker's disposition", () => {
  const pool = [
    poolWorker({ name: "a" }),
    poolWorker({ name: "b", status: "disconnected", connected: false }),
  ];
  const disposition = (offline: "wait" | "skip" | "fail") => {
    const plan = planFanOut(
      {},
      FanOutPolicySchema.parse({ offline }),
      pool,
    );
    if (plan.kind !== "planned") throw new Error("expected a plan");
    return plan.members[1].disposition;
  };
  assertEquals(disposition("wait"), "waiting");
  assertEquals(disposition("skip"), "skipped");
  assertEquals(disposition("fail"), "failed");
});

Deno.test("planFanOut: a disconnected draining or unverified worker is excluded, not offline", () => {
  const pool = [
    poolWorker({ name: "a" }),
    poolWorker({ name: "b", status: "draining", connected: false }),
    poolWorker({ name: "c", status: "unverified", connected: false }),
  ];
  const plan = planFanOut({}, defaultPolicy, pool);
  if (plan.kind !== "planned") throw new Error("expected a plan");
  assertEquals(
    plan.members.map((m) => [m.worker, m.disposition, m.reason]),
    [["a", "dispatch", undefined], ["b", "excluded", "draining"], [
      "c",
      "excluded",
      "unverified",
    ]],
  );
});

Deno.test("planFanOut: platform selector uses the scheduler's platform/arch matching", () => {
  const pool = [
    poolWorker({ name: "a", platform: "linux", arch: "aarch64" }),
    poolWorker({ name: "b", platform: "linux", arch: "x86_64" }),
    poolWorker({ name: "c", platform: "darwin", arch: "aarch64" }),
  ];
  const workers = (platform: string) => {
    const plan = planFanOut({ platform }, defaultPolicy, pool);
    return plan.kind === "planned" ? plan.members.map((m) => m.worker) : [];
  };
  assertEquals(workers("linux"), ["a", "b"]);
  assertEquals(workers("linux/aarch64"), ["a"]);
  assertEquals(workers("darwin"), ["c"]);
});

Deno.test("planFanOut: refuses with no members when fewer than minWorkers are live", () => {
  const pool = [
    poolWorker({ name: "a" }),
    poolWorker({ name: "b", connected: false }),
    poolWorker({ name: "c", status: "unverified" }),
  ];
  assertEquals(
    planFanOut({}, FanOutPolicySchema.parse({ minWorkers: 3 }), pool),
    { kind: "refused", reason: "min_workers", live: 2, minWorkers: 3 },
  );
  assertEquals(
    planFanOut({}, FanOutPolicySchema.parse({ minWorkers: 2 }), pool).kind,
    "planned",
  );
  assertEquals(
    planFanOut(
      {},
      FanOutPolicySchema.parse({ minWorkers: 2, offline: "skip" }),
      pool,
    ).kind,
    "refused",
  );
});

Deno.test("planFanOut: an empty selector match is refused under the default minWorkers", () => {
  assertEquals(
    planFanOut({ labels: { role: "none" } }, defaultPolicy, [
      poolWorker({ name: "a" }),
    ]),
    { kind: "refused", reason: "min_workers", live: 0, minWorkers: 1 },
  );
});

Deno.test("planFanOut: resolves a percentage budget against planned lanes only", () => {
  const pool = [
    ...["a", "b", "c", "d", "e", "f", "g"].map((name) => poolWorker({ name })),
    poolWorker({ name: "h", connected: false }),
    poolWorker({ name: "x", status: "draining" }),
    poolWorker({ name: "y", status: "unverified" }),
  ];
  const plan = planFanOut(
    {},
    FanOutPolicySchema.parse({
      rollout: { batches: [1, "100%"], maxFailures: "25%" },
    }),
    pool,
  );
  if (plan.kind !== "planned") throw new Error("expected a plan");
  assertEquals(plan.plannedLanes, 8);
  assertEquals(plan.maxFailures, 2);
});

Deno.test("planFanOut: throws when the pool repeats a worker name", () => {
  assertThrows(
    () =>
      planFanOut({}, defaultPolicy, [
        poolWorker({ name: "a" }),
        poolWorker({ name: "a", instanceUuid: "other" }),
      ]),
    Error,
    "more than once",
  );
});

Deno.test("laneDispatchVerdict: a connected idle or busy worker takes its lane, whatever its instance UUID", () => {
  for (const status of ["idle", "busy"] as const) {
    assertEquals(laneDispatchVerdict({ status, connected: true }), {
      kind: "dispatch",
    });
  }
});

Deno.test("laneDispatchVerdict: a worker absent from the pool or disconnected makes the lane wait", () => {
  assertEquals(laneDispatchVerdict(null), { kind: "wait" });
  assertEquals(laneDispatchVerdict({ status: "idle", connected: false }), {
    kind: "wait",
  });
});

Deno.test("laneDispatchVerdict: an unverified or draining worker is ineligible, connected or not", () => {
  for (const status of ["unverified", "draining"] as const) {
    for (const connected of [true, false]) {
      assertEquals(laneDispatchVerdict({ status, connected }), {
        kind: "ineligible",
        reason: status,
      });
    }
  }
});
