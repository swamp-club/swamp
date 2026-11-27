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

import { assertEquals, assertThrows } from "@std/assert";
import { ASYNC_QUEUE_SLICE_MS, AsyncQueue } from "./async_queue.ts";

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
  q.close();
});

Deno.test("AsyncQueue consumer waits for push", async () => {
  const q = new AsyncQueue<string>();
  const items: string[] = [];

  const consumer = (async () => {
    for await (const item of q) {
      items.push(item);
    }
  })();

  await new Promise((r) => setTimeout(r, 5));
  q.push("a");
  q.push("b");
  q.close();

  await consumer;
  assertEquals(items, ["a", "b"]);
});

Deno.test("AsyncQueue: keeps push order across pushes during a long drain and the buffer's compaction (swamp-club#5158)", async () => {
  const queue = new AsyncQueue<number>();
  let next = 0;
  for (; next < 5_000; next++) queue.push(next);
  const seen: number[] = [];
  for await (const item of queue) {
    seen.push(item);
    if (item === 2_500) { for (let i = 0; i < 3_000; i++) queue.push(next++); }
    if (item === next - 1) queue.close();
  }
  assertEquals(seen, Array.from({ length: next }, (_, i) => i));
});

/** busy-waits about ms on the monotonic clock, as a slow consumer or producer does */
function work(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
}

Deno.test("AsyncQueue: a timer set before a slow buffered drain fires while it drains (swamp-club#5158)", async () => {
  const queue = new AsyncQueue<number>();
  const total = 200;
  for (let i = 0; i < total; i++) queue.push(i);
  queue.close();
  let drained = 0;
  let drainedWhenTimerFired: number | undefined;
  setTimeout(() => {
    drainedWhenTimerFired = drained;
  }, 0);
  for await (const _ of queue) {
    // ten slices' worth of work over the whole drain
    work((ASYNC_QUEUE_SLICE_MS * 10) / total);
    drained++;
  }
  assertEquals(drained, total);
  assertEquals(
    drainedWhenTimerFired !== undefined && drainedWhenTimerFired < total,
    true,
    `the timer fired after ${drainedWhenTimerFired} of ${total} items`,
  );
});

Deno.test("AsyncQueue.belowHighWater: none below the mark; at it, one that settles once the consumer takes it to half (swamp-club#5158)", async () => {
  const queue = new AsyncQueue<number>(4);
  for (let i = 0; i < 3; i++) queue.push(i);
  assertEquals(queue.belowHighWater(), undefined);
  queue.push(3);
  const behind = queue.belowHighWater();
  assertEquals(behind instanceof Promise, true);
  let settled = false;
  behind!.then(() => {
    settled = true;
  });
  const items = queue[Symbol.asyncIterator]();
  await items.next();
  await Promise.resolve();
  assertEquals(settled, false, "three queued is still above half");
  await items.next();
  await behind;
  assertEquals(queue.size, 2);
  queue.close();
});

Deno.test("AsyncQueue.belowHighWater: a close releases a waiting producer (swamp-club#5158)", async () => {
  const queue = new AsyncQueue<number>(2);
  queue.push(0);
  queue.push(1);
  const behind = queue.belowHighWater();
  queue.close();
  await behind;
  assertEquals(queue.belowHighWater(), undefined);
});
