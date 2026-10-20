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
import {
  assignSlots,
  CAPTION_FULL_MIN_WIDTH,
  fadeFraction,
  fleetCounts,
  type FleetLease,
  type FleetWorker,
  freeSlots,
  groupCaption,
  groupKeys,
  groupValue,
  groupWorkers,
  hostMapDrawMode,
  isConnected,
  isEligible,
  isVisible,
  OUTCOME_MS,
  parseSelector,
  toSchedulable,
  UNLABELED,
  workerSummary,
} from "./host_map_model.ts";

const NOW = Date.parse("2026-06-09T12:00:00.000Z");

function worker(name: string, overrides?: Partial<FleetWorker>): FleetWorker {
  return {
    name,
    tokenName: "ci",
    status: "idle",
    labels: { fleet: "ci", region: "us-east-1" },
    platform: "linux",
    arch: "x86_64",
    instanceUuid: `uuid-${name}`,
    enrolledAt: "2026-06-09T00:00:00.000Z",
    lastSeenAt: "2026-06-09T11:00:00.000Z",
    capacity: 2,
    activeDispatchIds: [],
    ...overrides,
  };
}

function lease(dispatchId: string, state: FleetLease["state"]): FleetLease {
  return {
    leaseId: dispatchId,
    dispatchId,
    workerName: "w",
    state,
    modelType: "command/shell",
    methodName: "execute",
    createdAt: "2026-06-09T11:59:00.000Z",
  };
}

Deno.test("assignSlots: keeps a lease in its slot when an earlier lease ends", () => {
  const w = worker("w", { capacity: 3, activeDispatchIds: ["a", "b"] });
  const first = assignSlots(undefined, w, new Map(), NOW);
  assertEquals(first.map((s) => s.dispatchId), ["a", "b", undefined]);

  const next = assignSlots(
    first,
    { ...w, activeDispatchIds: ["b"] },
    new Map([["a", lease("a", "failed")]]),
    NOW + 1000,
  );
  assertEquals(next.map((s) => s.state), ["failed", "active", "free"]);
  assertEquals(next[1].dispatchId, "b");
});

Deno.test("assignSlots: frees an outcome after OUTCOME_MS and fills free slots first", () => {
  const w = worker("w", { capacity: 2, activeDispatchIds: ["a"] });
  const first = assignSlots(undefined, w, new Map(), NOW);
  const ended = assignSlots(
    first,
    { ...w, activeDispatchIds: [] },
    new Map([["a", lease("a", "completed")]]),
    NOW,
  );
  assertEquals(ended[0].state, "completed");

  const withNew = assignSlots(
    ended,
    { ...w, activeDispatchIds: ["c"] },
    new Map(),
    NOW + 10,
  );
  assertEquals(withNew.map((s) => s.state), ["completed", "active"]);

  const later = assignSlots(
    withNew,
    { ...w, activeDispatchIds: ["c"] },
    new Map(),
    NOW + OUTCOME_MS + 1,
  );
  assertEquals(later.map((s) => s.state), ["free", "active"]);
});

Deno.test("assignSlots: a vanished lease with no record just frees its slot", () => {
  const w = worker("w", { capacity: 1, activeDispatchIds: ["a"] });
  const first = assignSlots(undefined, w, new Map(), NOW);
  const next = assignSlots(
    first,
    { ...w, activeDispatchIds: [] },
    new Map(),
    NOW,
  );
  assertEquals(next[0].state, "free");
});

Deno.test("isVisible / fadeFraction: disconnected workers fade across the TTL", () => {
  const ttl = 2 * 60 * 60 * 1000;
  const recent = worker("r", {
    status: "disconnected",
    disconnectedAt: "2026-06-09T11:00:00.000Z",
  });
  const old = worker("o", {
    status: "disconnected",
    disconnectedAt: "2026-06-09T09:00:00.000Z",
  });
  const undated = worker("u", { status: "disconnected" });
  assertEquals(isVisible(worker("live"), NOW, ttl), true);
  assertEquals(isVisible(recent, NOW, ttl), true);
  assertEquals(isVisible(old, NOW, ttl), false);
  assertEquals(isVisible(undated, NOW, ttl), false);
  assertEquals(fadeFraction(recent, NOW, ttl), 0.5);
  assertEquals(fadeFraction(worker("live"), NOW, ttl), 0);
});

Deno.test("groupValue / groupKeys: fleet falls back to the token, unlabeled bucket, platform", () => {
  const unlabeledFleet = worker("a", { labels: {}, tokenName: "edge" });
  assertEquals(groupValue(unlabeledFleet, "fleet"), "edge");
  assertEquals(groupValue(unlabeledFleet, "region"), UNLABELED);
  assertEquals(groupValue(worker("b"), "platform"), "linux/x86_64");
  assertEquals(
    groupKeys([worker("a"), worker("b", { labels: { gpu: "h100" } })]),
    ["fleet", "gpu", "region", "platform"],
  );
});

Deno.test("groupWorkers: counts connected workers and up workers' slots; biggest capacity first, unlabeled last", () => {
  const groups = groupWorkers([
    worker("a", { status: "busy", activeDispatchIds: ["x"], capacity: 2 }),
    worker("b", { status: "draining", capacity: 2 }),
    worker("e", { status: "disconnected", capacity: 2 }),
    worker("c", { labels: { region: "eu" }, capacity: 8 }),
    worker("d", { labels: {} }),
  ], "region");
  assertEquals(groups.map((g) => g.key), ["eu", "us-east-1", UNLABELED]);
  const usEast = groups[1];
  assertEquals(usEast.connected, 2);
  assertEquals(usEast.usedSlots, 1);
  assertEquals(usEast.totalSlots, 2);
  assertEquals(usEast.byStatus.draining, 1);
  assertEquals(usEast.byStatus.disconnected, 1);
});

Deno.test("isConnected: every status but disconnected", () => {
  for (const status of ["idle", "busy", "draining", "unverified"] as const) {
    assertEquals(isConnected(worker("a", { status })), true);
  }
  assertEquals(isConnected(worker("a", { status: "disconnected" })), false);
});

Deno.test("fleetCounts: a rolled fleet counts its live workers as connected and leaves replaced records out of slots", () => {
  const live = Array.from(
    { length: 16 },
    (_, i) =>
      worker(`live-${i}`, {
        capacity: 1,
        ...(i === 0 ? { status: "busy", activeDispatchIds: ["x"] } : {}),
      }),
  );
  const replaced = Array.from(
    { length: 15 },
    (_, i) =>
      worker(`old-${i}`, {
        status: "disconnected",
        capacity: 1,
        disconnectedAt: "2026-06-09T11:50:00.000Z",
      }),
  );
  const counts = fleetCounts([...live, ...replaced]);
  assertEquals(counts.connected, 16);
  assertEquals(counts.byStatus, {
    unverified: 0,
    idle: 15,
    busy: 1,
    draining: 0,
    disconnected: 15,
  });
  assertEquals(counts.usedSlots, 1);
  assertEquals(counts.totalSlots, 16);
});

Deno.test("fleetCounts: draining and unverified are connected but add no slots", () => {
  const counts = fleetCounts([
    worker("a", { status: "draining", activeDispatchIds: ["x"] }),
    worker("b", { status: "unverified" }),
  ]);
  assertEquals(counts.connected, 2);
  assertEquals(counts.usedSlots, 0);
  assertEquals(counts.totalSlots, 0);
});

Deno.test("groupCaption: connected workers and slots, slots only on a narrow card", () => {
  const stats = fleetCounts([
    worker("a", { status: "busy", activeDispatchIds: ["x"], capacity: 1 }),
    worker("b", { capacity: 1 }),
    worker("c", { status: "disconnected", capacity: 1 }),
  ]);
  assertEquals(
    groupCaption(stats, CAPTION_FULL_MIN_WIDTH),
    "2 connected · 1/2 slots",
  );
  assertEquals(groupCaption(stats, CAPTION_FULL_MIN_WIDTH - 1), "1/2 slots");
});

Deno.test("parseSelector: labels, platform, target, and invalid tokens", () => {
  const { selector, invalid } = parseSelector(
    "gpu=h100, region=us-west-2 platform=linux/x86_64,target=gpu-1, junk, =x",
  );
  assertEquals(selector.labels, { gpu: "h100", region: "us-west-2" });
  assertEquals(selector.platform, "linux/x86_64");
  assertEquals(selector.target, "gpu-1");
  assertEquals(invalid, ["junk", "=x"]);
});

Deno.test("isEligible: mirrors scheduler eligibility", () => {
  const sel = (text: string) => parseSelector(text).selector;
  const live = toSchedulable(worker("w"));
  assertEquals(isEligible(sel("region=us-east-1"), live), true);
  assertEquals(isEligible(sel("region=eu"), live), false);
  assertEquals(isEligible(sel("platform=linux"), live), true);
  assertEquals(isEligible(sel("platform=linux/arm64"), live), false);
  assertEquals(isEligible(sel("target=uuid-w"), live), true);
  assertEquals(
    isEligible(sel(""), toSchedulable(worker("u", { status: "unverified" }))),
    false,
  );
  assertEquals(
    isEligible(
      sel("target=d"),
      toSchedulable(worker("d", { status: "draining" })),
    ),
    false,
  );
  assertEquals(
    isEligible(sel(""), toSchedulable(worker("x", { status: "disconnected" }))),
    false,
  );
});

Deno.test("freeSlots: counts free capacity on schedulable matches only", () => {
  const sel = parseSelector("region=us-east-1").selector;
  assertEquals(
    freeSlots(sel, [
      worker("a", { capacity: 4, status: "busy", activeDispatchIds: ["x"] }),
      worker("b", { capacity: 2, status: "draining" }),
      worker("c", { capacity: 2, status: "unverified" }),
      worker("d", { capacity: 2, labels: { region: "eu" } }),
    ]),
    3,
  );
});

Deno.test("workerSummary: busy, idle, and connected workers that cannot take work; disconnected left out", () => {
  assertEquals(
    workerSummary([
      worker("a", { status: "busy", activeDispatchIds: ["x"] }),
      worker("b"),
      worker("c", { status: "draining" }),
      worker("d", { status: "unverified" }),
      worker("e", { status: "disconnected" }),
    ]),
    { busy: 1, idle: 1, unavailable: 2 },
  );
});

Deno.test("hostMapDrawMode: skips while hidden, snaps once back, animates otherwise", () => {
  assertEquals(hostMapDrawMode({ hidden: true, skipped: false }), "skip");
  assertEquals(hostMapDrawMode({ hidden: true, skipped: true }), "skip");
  assertEquals(hostMapDrawMode({ hidden: false, skipped: true }), "snap");
  assertEquals(hostMapDrawMode({ hidden: false, skipped: false }), "animate");
});
