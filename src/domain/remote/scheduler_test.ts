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
  const pool = [worker({ name: "a", status: "busy" })];
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
    worker({ name: "a", status: "busy", labels: { gpu: "true" } }),
    worker({ name: "b", status: "busy", labels: { gpu: "true" } }),
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

Deno.test("scheduleStep: targeted dispatch to unverified worker dispatches", () => {
  const pool = [worker({ name: "a", status: "unverified" })];
  const decision = scheduleStep({ target: "a" }, pool);
  assertEquals(decision.kind, "dispatch");
  assertEquals(decision.kind === "dispatch" ? decision.worker.name : "", "a");
});
