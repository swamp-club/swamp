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
import { CarriedBytesBudget } from "./carried_bytes_budget.ts";

const live = () => new AbortController().signal;

Deno.test("CarriedBytesBudget: grants at once while there is room", async () => {
  const budget = new CarriedBytesBudget(10);
  const a = await budget.acquire(4, live());
  const b = await budget.acquire(6, live());
  assertEquals(budget.used, 10);
  a();
  b();
  assertEquals(budget.used, 0);
});

Deno.test("CarriedBytesBudget: a request past the room waits for a release", async () => {
  const budget = new CarriedBytesBudget(10);
  const first = await budget.acquire(8, live());
  let granted = false;
  const waiting = budget.acquire(4, live()).then((release) => {
    granted = true;
    return release;
  });
  await Promise.resolve();
  assertEquals(granted, false);
  first();
  const second = await waiting;
  assertEquals(budget.used, 4);
  second();
  assertEquals(budget.used, 0);
});

Deno.test("CarriedBytesBudget: a request larger than the whole budget runs alone, never deadlocks", async () => {
  const budget = new CarriedBytesBudget(10);
  const small = await budget.acquire(2, live());
  const big = budget.acquire(25, live());
  small();
  const release = await big;
  assertEquals(budget.used, 25);
  release();
  assertEquals(budget.used, 0);
});

Deno.test("CarriedBytesBudget: waiters are granted in order, so a large one is not starved", async () => {
  const budget = new CarriedBytesBudget(10);
  const held = await budget.acquire(6, live());
  const order: string[] = [];
  const large = budget.acquire(8, live()).then((r) => {
    order.push("large");
    return r;
  });
  const small = budget.acquire(1, live()).then((r) => {
    order.push("small");
    return r;
  });
  await Promise.resolve();
  assertEquals(order, []);
  held();
  const releaseLarge = await large;
  await Promise.resolve();
  assertEquals(order, ["large", "small"]);
  releaseLarge();
  (await small)();
  assertEquals(budget.used, 0);
});

Deno.test("CarriedBytesBudget: an aborted wait leaves the queue and lets the next waiter in", async () => {
  const budget = new CarriedBytesBudget(10);
  const held = await budget.acquire(9, live());
  const controller = new AbortController();
  const aborted = budget.acquire(5, controller.signal);
  const next = budget.acquire(1, live());
  controller.abort(new Error("gone"));
  await assertRejects(() => aborted, Error, "gone");
  const release = await next;
  assertEquals(budget.used, 10);
  release();
  held();
  assertEquals(budget.used, 0);
});

Deno.test("CarriedBytesBudget: a release called twice frees its bytes once", async () => {
  const budget = new CarriedBytesBudget(10);
  const other = await budget.acquire(3, live());
  const release = await budget.acquire(4, live());
  release();
  release();
  assertEquals(budget.used, 3);
  other();
});

Deno.test("CarriedBytesBudget: refuses a non-positive total and an already-aborted signal", async () => {
  assertThrows(() => new CarriedBytesBudget(0), RangeError);
  const budget = new CarriedBytesBudget(10);
  const controller = new AbortController();
  controller.abort(new Error("before"));
  await assertRejects(
    () => budget.acquire(1, controller.signal),
    Error,
    "before",
  );
  assertEquals(budget.used, 0);
});
