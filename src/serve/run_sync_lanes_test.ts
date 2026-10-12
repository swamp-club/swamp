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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { RunSyncLanes } from "./run_sync_lanes.ts";

/** Whether `promise` has settled after the microtask queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(() => done = true, () => done = true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

Deno.test("RunSyncLanes: holders of one lane run together", async () => {
  const lanes = new RunSyncLanes();
  await lanes.acquire("push");
  await lanes.acquire("push");
  assertEquals([lanes.active, lanes.holders], ["push", 2]);
  lanes.release();
  lanes.release();
  assertEquals([lanes.active, lanes.holders], [undefined, 0]);
});

Deno.test("RunSyncLanes: a pull waits for every push in flight, and a push for every pull (swamp-club#3146)", async () => {
  const lanes = new RunSyncLanes();
  await lanes.acquire("push");
  await lanes.acquire("push");
  const pull = lanes.acquire("pull");
  assertEquals(await settled(pull), false);
  lanes.release();
  assertEquals(await settled(pull), false);
  lanes.release();
  assertEquals(await settled(pull), true);
  assertEquals(lanes.active, "pull");

  const push = lanes.acquire("push");
  assertEquals(await settled(push), false);
  lanes.release();
  assertEquals(await settled(push), true);
  assertEquals(lanes.active, "push");
  lanes.release();
});

Deno.test("RunSyncLanes: a queued lane is not starved by later arrivals of the active one", async () => {
  const lanes = new RunSyncLanes();
  await lanes.acquire("push");
  const pull = lanes.acquire("pull");
  // Arrives after the queued pull, so it waits behind it.
  const latePush = lanes.acquire("push");
  lanes.release();
  assertEquals(await settled(pull), true);
  assertEquals(await settled(latePush), false);
  lanes.release();
  assertEquals(await settled(latePush), true);
  lanes.release();
});

Deno.test("RunSyncLanes: consecutive waiters of one lane are granted together", async () => {
  const lanes = new RunSyncLanes();
  await lanes.acquire("push");
  const pulls = [lanes.acquire("pull"), lanes.acquire("pull")];
  lanes.release();
  assertEquals(await Promise.all(pulls.map(settled)), [true, true]);
  assertEquals([lanes.active, lanes.holders], ["pull", 2]);
  lanes.release();
  lanes.release();
});

Deno.test("RunSyncLanes: an aborted wait leaves the queue and lets the waiters behind it in", async () => {
  const lanes = new RunSyncLanes();
  await lanes.acquire("push");
  const controller = new AbortController();
  const pull = lanes.acquire("pull", controller.signal);
  const push = lanes.acquire("push");
  controller.abort();
  await assertRejects(() => pull);
  assertEquals(await settled(push), true);
  assertEquals([lanes.active, lanes.holders, lanes.waiters], ["push", 2, 0]);
  lanes.release();
  lanes.release();
});

Deno.test("RunSyncLanes: release without a holder throws", () => {
  assertThrows(() => new RunSyncLanes().release(), Error, "without a holder");
});
