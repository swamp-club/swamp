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
import type { FanOutMember } from "./fan_out.ts";
import { nextBatch, planBatches, type RolloutProgress } from "./rollout.ts";

function members(
  dispatch: string[],
  waiting: string[] = [],
  other: string[] = [],
): FanOutMember[] {
  return [
    ...waiting.map((worker) => ({
      worker,
      instanceUuid: worker,
      disposition: "waiting" as const,
      reason: "disconnected" as const,
    })),
    ...other.map((worker) => ({
      worker,
      instanceUuid: worker,
      disposition: "excluded" as const,
      reason: "draining" as const,
    })),
    ...dispatch.map((worker) => ({
      worker,
      instanceUuid: worker,
      disposition: "dispatch" as const,
    })),
  ];
}

function progress(
  started: string[],
  settled: string[] = [],
  failed: string[] = [],
): RolloutProgress {
  return {
    started: new Set(started),
    settled: new Set(settled),
    failed: new Set(failed),
  };
}

Deno.test("planBatches: no rollout puts every lane in one batch, dispatch before waiting", () => {
  assertEquals(planBatches(members(["c", "a"], ["b"], ["x"])), [[
    "a",
    "c",
    "b",
  ]]);
});

Deno.test("planBatches: no lanes gives no batches", () => {
  assertEquals(
    planBatches(members([], [], ["x"]), { batches: [1, "100%"] }),
    [],
  );
});

Deno.test("planBatches: counts, then the rest, with waiting members last", () => {
  assertEquals(
    planBatches(members(["e", "d", "c", "a"], ["b", "f"]), {
      batches: [1, 2, "100%"],
    }),
    [["a"], ["c", "d"], ["e", "b", "f"]],
  );
});

Deno.test("planBatches: percentages round up so a small canary is one lane", () => {
  assertEquals(
    planBatches(members(["a", "b", "c", "d", "e"]), {
      batches: ["10%", "50%", "100%"],
    }),
    [["a"], ["b", "c", "d"], ["e"]],
  );
});

Deno.test("planBatches: drops batches once the lanes run out", () => {
  assertEquals(planBatches(members(["a", "b"]), { batches: [5, 1, "100%"] }), [[
    "a",
    "b",
  ]]);
});

const rollout = { batches: [["a"], ["b", "c"], ["d", "e"]], maxFailures: 0 };

Deno.test("nextBatch: starts with the canary batch", () => {
  assertEquals(nextBatch(progress([]), rollout), {
    kind: "start",
    batch: 0,
    lanes: ["a"],
  });
});

Deno.test("nextBatch: waits for the current batch to settle before the next", () => {
  assertEquals(nextBatch(progress(["a"]), rollout), { kind: "wait" });
  assertEquals(nextBatch(progress(["a"], ["a"]), rollout), {
    kind: "start",
    batch: 1,
    lanes: ["b", "c"],
  });
});

Deno.test("nextBatch: offers the rest of a batch while some of its lanes run", () => {
  assertEquals(nextBatch(progress(["a", "b"], ["a"]), rollout), {
    kind: "start",
    batch: 1,
    lanes: ["c"],
  });
});

Deno.test("nextBatch: halts once failures pass the budget and holds every lane not started", () => {
  assertEquals(nextBatch(progress(["a"], ["a"], ["a"]), rollout), {
    kind: "halt",
    held: ["b", "c", "d", "e"],
  });
  assertEquals(
    nextBatch(progress(["a", "b"], ["a", "b"], ["b"]), rollout),
    { kind: "halt", held: ["c", "d", "e"] },
  );
});

Deno.test("nextBatch: tolerates failures up to the budget", () => {
  const budget2 = { ...rollout, maxFailures: 2 };
  assertEquals(
    nextBatch(progress(["a", "b", "c"], ["a", "b", "c"], ["a", "b"]), budget2),
    { kind: "start", batch: 2, lanes: ["d", "e"] },
  );
});

Deno.test("nextBatch: no budget never halts", () => {
  const all = ["a", "b", "c", "d", "e"];
  assertEquals(
    nextBatch(progress(all, all, all), { ...rollout, maxFailures: null }),
    { kind: "complete" },
  );
});

Deno.test("nextBatch: complete only when every lane has settled", () => {
  const all = ["a", "b", "c", "d", "e"];
  assertEquals(nextBatch(progress(all, ["a", "b", "c", "d"]), rollout), {
    kind: "wait",
  });
  assertEquals(nextBatch(progress(all, all), rollout), { kind: "complete" });
  assertEquals(nextBatch(progress([]), { batches: [], maxFailures: 0 }), {
    kind: "complete",
  });
});
