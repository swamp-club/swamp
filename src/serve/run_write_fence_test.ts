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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assert, assertEquals } from "@std/assert";
import { ServeRunWriteFence } from "./run_write_fence.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

/** Runs `fn` and returns the warnings the fence logged meanwhile. */
async function fenceWarnings(fn: () => Promise<void>): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "shutdown"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => record.message.map(String).join(""));
}

Deno.test("ServeRunWriteFence: close closes only the runs it names", async () => {
  const fence = new ServeRunWriteFence();
  assertEquals(fence.isClosed("a"), false);
  await fence.close(["a"]);
  assertEquals(fence.isClosed("a"), true);
  assertEquals(fence.isClosed("b"), false);
});

Deno.test("ServeRunWriteFence: close waits for a save already under way", async () => {
  const fence = new ServeRunWriteFence();
  const events: string[] = [];
  const { promise: write, resolve } = Promise.withResolvers<void>();
  const tracked = fence.track("a", write).then(() => {
    events.push("saved");
  });
  const closing = fence.close(["a"]).then(() => {
    events.push("closed");
  });
  await Promise.resolve();
  assertEquals(events, []);
  resolve();
  await Promise.all([tracked, closing]);
  assertEquals(events, ["saved", "closed"]);
});

Deno.test("ServeRunWriteFence: close does not wait for another run's save", async () => {
  const fence = new ServeRunWriteFence();
  const { promise: write, resolve } = Promise.withResolvers<void>();
  const tracked = fence.track("b", write);
  await fence.close(["a"]);
  assertEquals(fence.isClosed("b"), false);
  resolve();
  await tracked;
});

Deno.test("ServeRunWriteFence: close stops waiting at its bound", async () => {
  const fence = new ServeRunWriteFence();
  const { promise: write, resolve } = Promise.withResolvers<void>();
  const tracked = fence.track("a", write);
  const warnings = await fenceWarnings(() => fence.close(["a"], 1));
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("still under way"));
  resolve();
  await tracked;
});

Deno.test("ServeRunWriteFence: a save that fails is still released and its failure reaches the saver", async () => {
  const fence = new ServeRunWriteFence();
  const failure = new Error("disk full");
  let caught: unknown;
  await fence.track("a", Promise.reject(failure)).catch((e) => {
    caught = e;
  });
  assertEquals(caught, failure);
  // Nothing left in flight, so close reports no save still under way.
  assertEquals(await fenceWarnings(() => fence.close(["a"], 60_000)), []);
});
