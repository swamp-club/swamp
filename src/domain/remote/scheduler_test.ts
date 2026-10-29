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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  describePlacement,
  eligibleWorkers,
  hasPlacement,
  type SchedulableWorker,
  scheduleStep,
  unmetPlacement,
} from "./scheduler.ts";

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
