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

/**
 * The dashboard's placement selector (packages/dashboard host map) must pick
 * exactly the workers the scheduler would (src/domain/remote/scheduler.ts).
 * Workers reach the dashboard through the real libswamp worker list; the
 * scheduler sees the gateway's view of the same workers.
 */

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  eligibleWorkers,
  type SchedulableWorker,
  scheduleStep,
  type StepPlacement,
} from "../src/domain/remote/scheduler.ts";
import {
  workerList,
  type WorkerListEvent,
} from "../src/libswamp/worker/list.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import {
  type FleetWorker,
  freeSlots,
  isEligible,
  type Selector,
  toSchedulable,
} from "../packages/dashboard/src/lib/host_map_model.ts";

type Status = "idle" | "busy" | "unverified" | "draining" | "disconnected";

interface PoolEntry {
  name: string;
  status: Status;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  capacity: number;
  active: number;
}

const entryArb: fc.Arbitrary<PoolEntry> = fc.record({
  name: fc.constantFrom("w1", "w2", "w3", "w4", "w5", "w6"),
  status: fc.constantFrom<Status>(
    "idle",
    "busy",
    "unverified",
    "draining",
    "disconnected",
  ),
  labels: fc.record(
    {
      region: fc.constantFrom("us-east-1", "eu-central-1"),
      gpu: fc.constantFrom("a100", "h100"),
      tier: fc.constantFrom("ci", "train"),
    },
    { requiredKeys: [] },
  ),
  platform: fc.constantFrom("linux", "darwin"),
  arch: fc.constantFrom("x86_64", "arm64"),
  capacity: fc.integer({ min: 1, max: 8 }),
  active: fc.integer({ min: 0, max: 8 }),
});

const poolArb = fc.uniqueArray(entryArb, {
  selector: (e) => e.name,
  maxLength: 6,
});

const selectorArb: fc.Arbitrary<Selector> = fc.record({
  labels: fc.record(
    {
      region: fc.constantFrom("us-east-1", "eu-central-1"),
      gpu: fc.constantFrom("a100", "h100"),
      tier: fc.constantFrom("ci", "train"),
    },
    { requiredKeys: [] },
  ),
  platform: fc.option(
    fc.constantFrom(
      "linux",
      "darwin",
      "linux/x86_64",
      "darwin/arm64",
      "linux/arm64",
    ),
    { nil: undefined },
  ),
  target: fc.option(
    fc.constantFrom("w1", "w3", "uuid-w2", "nobody"),
    { nil: undefined },
  ),
}).map((s) => {
  const out: Selector = { labels: s.labels };
  if (s.platform !== undefined) out.platform = s.platform;
  if (s.target !== undefined) out.target = s.target;
  return out;
});

function activeIds(entry: PoolEntry): string[] {
  const count = entry.status === "disconnected"
    ? 0
    : Math.min(entry.active, entry.capacity);
  return Array.from({ length: count }, (_, i) => `${entry.name}-d${i}`);
}

function record(entry: PoolEntry): DataRecord {
  return {
    id: `rec-${entry.name}`,
    name: "state-main",
    version: 1,
    isLatest: true,
    createdAt: "2026-06-09T00:00:00.000Z",
    attributes: {
      name: entry.name,
      instanceUuid: `uuid-${entry.name}`,
      tokenName: entry.name,
      status: entry.status,
      labels: entry.labels,
      platform: entry.platform,
      arch: entry.arch,
      swampVersion: "1.0.0",
      protocolVersion: 1,
      enrolledAt: "2026-06-09T00:00:00.000Z",
      lastSeenAt: "2026-06-09T00:00:00.000Z",
      capacity: entry.capacity,
      activeDispatchIds: activeIds(entry),
      ...(entry.status === "disconnected"
        ? { disconnectedAt: "2026-06-09T00:00:00.000Z" }
        : {}),
    },
  } as unknown as DataRecord;
}

/** The gateway's view: a disconnected worker has no channel. */
function gatewayView(entry: PoolEntry): SchedulableWorker {
  return {
    name: entry.name,
    instanceUuid: `uuid-${entry.name}`,
    labels: entry.labels,
    platform: entry.platform,
    arch: entry.arch,
    status: entry.status === "disconnected" ? "idle" : entry.status,
    connected: entry.status !== "disconnected",
    capacity: entry.capacity,
    activeDispatchIds: activeIds(entry),
  };
}

async function listed(pool: PoolEntry[]): Promise<FleetWorker[]> {
  const events = await collect<WorkerListEvent>(
    workerList(
      createLibSwampContext(),
      { query: () => Promise.resolve(pool.map(record)) },
      { includeDisconnected: true },
    ),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkerListEvent,
    { kind: "completed" }
  >;
  return completed.data.workers as FleetWorker[];
}

Deno.test("host map selector picks the same workers as scheduler eligibleWorkers", async () => {
  await fc.assert(
    fc.asyncProperty(poolArb, selectorArb, async (pool, selector) => {
      const workers = await listed(pool);
      const placement: StepPlacement = { ...selector };
      const scheduled = eligibleWorkers(placement, pool.map(gatewayView))
        .map((w) => w.name)
        .sort();
      const dashboard = workers
        .filter((w) => isEligible(selector, toSchedulable(w)))
        .map((w) => w.name)
        .sort();
      assertEquals(dashboard, scheduled);
    }),
    { numRuns: 300 },
  );
});

Deno.test("host map free slots are positive exactly when the scheduler would dispatch", async () => {
  await fc.assert(
    fc.asyncProperty(poolArb, selectorArb, async (pool, selector) => {
      const workers = await listed(pool);
      const decision = scheduleStep({ ...selector }, pool.map(gatewayView));
      assertEquals(
        freeSlots(selector, workers) > 0,
        decision.kind === "dispatch",
      );
    }),
    { numRuns: 300 },
  );
});
