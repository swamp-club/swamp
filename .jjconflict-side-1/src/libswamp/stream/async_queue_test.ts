// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { AsyncQueue } from "./async_queue.ts";

Deno.test("AsyncQueue preserves push order", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.push(3);
  q.close();

  const items: number[] = [];
  for await (const item of q) {
    items.push(item);
  }
  assertEquals(items, [1, 2, 3]);
});

Deno.test("AsyncQueue close on empty yields no items", async () => {
  const q = new AsyncQueue<number>();
  q.close();

  const items: number[] = [];
  for await (const item of q) {
    items.push(item);
  }
  assertEquals(items, []);
});

Deno.test("AsyncQueue concurrent push and consume", async () => {
  const q = new AsyncQueue<number>();
  const items: number[] = [];

  // Push items asynchronously
  const producer = (async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      q.push(i);
    }
    q.close();
  })();

  for await (const item of q) {
    items.push(item);
  }

  await producer;
  assertEquals(items, [0, 1, 2, 3, 4]);
});

Deno.test("AsyncQueue push after close throws", () => {
  const q = new AsyncQueue<number>();
  q.close();
  assertThrows(
    () => q.push(1),
    Error,
    "Cannot push to a closed AsyncQueue",
  );
});

Deno.test("AsyncQueue double close is safe", () => {
  const q = new AsyncQueue<number>();
  q.close();
  q.close(); // should not throw
});

Deno.test("AsyncQueue consumer waits for push", async () => {
  const q = new AsyncQueue<string>();
  const items: string[] = [];

  // Start consuming before pushing
  const consumer = (async () => {
    for await (const item of q) {
      items.push(item);
    }
  })();

  // Push after a small delay
  await new Promise((r) => setTimeout(r, 5));
  q.push("a");
  q.push("b");
  q.close();

  await consumer;
  assertEquals(items, ["a", "b"]);
});
