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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { InFlightDataWrites } from "./in_flight_data_writes.ts";

Deno.test("InFlightDataWrites.track: returns the write's own promise result and counts it until it settles", async () => {
  const writes = new InFlightDataWrites();
  const { promise, resolve } = Promise.withResolvers<string>();
  const tracked = writes.track(promise);
  assertEquals(writes.size, 1);
  resolve("v1");
  assertEquals(await tracked, "v1");
  await writes.settle(1_000);
  assertEquals(writes.size, 0);
});

Deno.test("InFlightDataWrites.track: a rejected write stops counting and still rejects for the caller", async () => {
  const writes = new InFlightDataWrites();
  const tracked = writes.track(Promise.reject(new Error("disk full")));
  await assertRejects(() => tracked, Error, "disk full");
  assertEquals(await writes.settle(1_000), 0);
});

Deno.test("InFlightDataWrites.settle: waits for a write started while it waits", async () => {
  const writes = new InFlightDataWrites();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  writes.track(first.promise);
  const settled = writes.settle(10_000);
  writes.track(second.promise);
  first.resolve();
  await Promise.resolve();
  assertEquals(writes.size, 1);
  second.resolve();
  assertEquals(await settled, 0);
});

Deno.test("InFlightDataWrites.settle: stops at its deadline and reports what is still pending", async () => {
  const writes = new InFlightDataWrites();
  const never = Promise.withResolvers<void>();
  writes.track(never.promise);
  assertEquals(await writes.settle(5), 1);
  never.resolve();
});

Deno.test("InFlightDataWrites.track: a run's writes also count for its parent", async () => {
  const parent = new InFlightDataWrites();
  const run = new InFlightDataWrites(parent);
  const write = Promise.withResolvers<number>();
  const tracked = run.track(write.promise);
  assertEquals(run.size, 1);
  assertEquals(parent.size, 1);
  write.resolve(3);
  assertStrictEquals(await tracked, 3);
  assertEquals(await parent.settle(1_000), 0);
  assertEquals(run.size, 0);
});
