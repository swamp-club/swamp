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

import { assertEquals, assertRejects } from "@std/assert";
import { type RolloutLanes, runRolloutLanes } from "./fan_out_rollout.ts";

async function drain<T>(
  generator: AsyncGenerator<T, unknown>,
): Promise<{ events: T[]; end: unknown }> {
  const events: T[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, end: next.value };
    events.push(next.value);
  }
}

function lanes(
  overrides: Partial<RolloutLanes<string>>,
): RolloutLanes<string> {
  return {
    rollout: { batches: [["a"], ["b", "c"]], maxFailures: 0 },
    limit: undefined,
    // deno-lint-ignore require-yield
    start: async function* (lane) {
      await Promise.resolve(lane);
    },
    failed: () => false,
    batchStarted: (batch, members) => `batch ${batch}: ${members.join(",")}`,
    ...overrides,
  };
}

Deno.test("runRolloutLanes: announces each batch before starting its lanes and completes", async () => {
  const started: string[] = [];
  const { events, end } = await drain(runRolloutLanes(lanes({
    start: async function* (lane) {
      started.push(lane);
      yield `ran ${lane}`;
    },
  })));
  assertEquals(end, { kind: "complete" });
  assertEquals(started, ["a", "b", "c"]);
  assertEquals(events[0], "batch 0: a");
  assertEquals(events[1], "ran a");
  assertEquals(events[2], "batch 1: b,c");
});

Deno.test("runRolloutLanes: a failed canary under a zero budget holds every later lane", async () => {
  const started: string[] = [];
  const { end } = await drain(runRolloutLanes(lanes({
    // deno-lint-ignore require-yield
    start: async function* (lane) {
      started.push(lane);
    },
    failed: (lane) => lane === "a",
  })));
  assertEquals(started, ["a"]);
  assertEquals(end, { kind: "halted", held: ["b", "c"] });
});

Deno.test("runRolloutLanes: lanes that failed before they could start count against the budget", async () => {
  const started: string[] = [];
  const { end } = await drain(runRolloutLanes(lanes({
    failedBeforeStart: ["a"],
    // deno-lint-ignore require-yield
    start: async function* (lane) {
      started.push(lane);
    },
  })));
  assertEquals(started, []);
  assertEquals(end, { kind: "halted", held: ["b", "c"] });
});

Deno.test("runRolloutLanes: a budget spent by the last lanes holds nothing and completes", async () => {
  const { end } = await drain(runRolloutLanes(lanes({
    failed: (lane) => lane === "c",
  })));
  assertEquals(end, { kind: "complete" });
});

Deno.test("runRolloutLanes: a lane's error is thrown once the running lanes finish, and nothing more starts", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  await assertRejects(
    () =>
      drain(runRolloutLanes(lanes({
        rollout: { batches: [["a", "b"], ["c"]], maxFailures: null },
        start: async function* (lane) {
          started.push(lane);
          if (lane === "a") throw new Error("lane a broke");
          await Promise.resolve();
          yield lane;
          finished.push(lane);
        },
      }))),
    Error,
    "lane a broke",
  );
  assertEquals(started, ["a", "b"]);
  assertEquals(finished, ["b"]);
});

Deno.test("runRolloutLanes: an abort starts nothing more and ends aborted, holding nothing", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const { end } = await drain(runRolloutLanes(lanes({
    signal: controller.signal,
    rollout: { batches: [["a"], ["b", "c"]], maxFailures: null },
    // deno-lint-ignore require-yield
    start: async function* (lane) {
      started.push(lane);
      controller.abort();
    },
  })));
  assertEquals(started, ["a"]);
  assertEquals(end, { kind: "aborted" });
});

Deno.test("runRolloutLanes: an undecided gate pauses before the first lane it holds, once earlier batches settled", async () => {
  const started: string[] = [];
  const { events, end } = await drain(runRolloutLanes(lanes({
    start: async function* (lane) {
      started.push(lane);
      yield `ran ${lane}`;
    },
    held: (lane) => lane !== "a",
  })));
  assertEquals(started, ["a"]);
  assertEquals(events, ["batch 0: a", "ran a"]);
  assertEquals(end, { kind: "paused", lane: "b" });
});

Deno.test("runRolloutLanes: a canary that spends the budget halts and the gate never opens", async () => {
  const asked: string[] = [];
  const { end } = await drain(runRolloutLanes(lanes({
    failed: (lane) => lane === "a",
    held: (lane) => {
      asked.push(lane);
      return lane !== "a";
    },
  })));
  assertEquals(end, { kind: "halted", held: ["b", "c"] });
  assertEquals(asked, ["a"]);
});

Deno.test("runRolloutLanes: a canary failure within the budget still pauses at the gate", async () => {
  const { end } = await drain(runRolloutLanes(lanes({
    rollout: { batches: [["a"], ["b", "c"]], maxFailures: 1 },
    failed: (lane) => lane === "a",
    held: (lane) => lane !== "a",
  })));
  assertEquals(end, { kind: "paused", lane: "b" });
});
