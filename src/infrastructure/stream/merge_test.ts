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
import { merge, mergeWithConcurrency } from "./merge.ts";

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function* delayed<T>(items: T[], ms: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, ms));
    yield item;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) {
    result.push(item);
  }
  return result;
}

Deno.test("merge empty array yields nothing", async () => {
  const items = await collect(merge([]));
  assertEquals(items, []);
});

Deno.test("merge single stream is passthrough", async () => {
  const items = await collect(merge([fromArray([1, 2, 3])]));
  assertEquals(items, [1, 2, 3]);
});

Deno.test("merge two streams contains all items", async () => {
  const items = await collect(merge([
    fromArray(["a", "b"]),
    fromArray(["c", "d"]),
  ]));
  // All items present, order may vary
  assertEquals(items.sort(), ["a", "b", "c", "d"]);
});

Deno.test("merge interleaves delayed streams", async () => {
  const items = await collect(merge([
    delayed(["a1", "a2"], 5),
    delayed(["b1", "b2"], 5),
  ]));
  // All items present
  assertEquals(items.length, 4);
  assertEquals(items.sort(), ["a1", "a2", "b1", "b2"]);
});

Deno.test("merge handles streams of different lengths", async () => {
  const items = await collect(merge([
    fromArray([1]),
    fromArray([2, 3, 4]),
    fromArray([5, 6]),
  ]));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

Deno.test("merge handles stream that yields nothing", async () => {
  const items = await collect(merge([
    fromArray([]),
    fromArray([1, 2]),
  ]));
  assertEquals(items, [1, 2]);
});

Deno.test("merge with pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const items = await collect(merge([
    fromArray([1, 2]),
    fromArray([3, 4]),
  ], controller.signal));
  assertEquals(items, []);
});

// mergeWithConcurrency tests

Deno.test("mergeWithConcurrency: undefined limit delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1, 2]),
    fromArray([3, 4]),
  ], undefined));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4]);
});

Deno.test("mergeWithConcurrency: zero limit delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray(["a", "b"]),
    fromArray(["c"]),
  ], 0));
  assertEquals(items.sort(), ["a", "b", "c"]);
});

Deno.test("mergeWithConcurrency: limit >= streams delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1]),
    fromArray([2]),
  ], 5));
  assertEquals(items.sort((a, b) => a - b), [1, 2]);
});

Deno.test("mergeWithConcurrency: collects all items", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1, 2]),
    fromArray([3, 4]),
    fromArray([5, 6]),
    fromArray([7, 8]),
  ], 2));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

Deno.test("mergeWithConcurrency: limits actual concurrency", async () => {
  let active = 0;
  let maxActive = 0;

  async function* tracked(id: number): AsyncGenerator<number> {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    yield id;
    active--;
  }

  const streams = Array.from({ length: 6 }, (_, i) => tracked(i));
  const items = await collect(mergeWithConcurrency(streams, 2));
  assertEquals(items.length, 6);
  assertEquals(maxActive, 2);
});

Deno.test("mergeWithConcurrency: with pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const items = await collect(mergeWithConcurrency(
    [
      fromArray([1, 2]),
      fromArray([3, 4]),
    ],
    1,
    controller.signal,
  ));
  assertEquals(items, []);
});

// Error propagation tests

async function* throwAfter<T>(
  items: T[],
  error: Error,
): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
  throw error;
}

function throwImmediately<T>(error: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(error);
        },
      };
    },
  };
}

Deno.test("merge propagates source stream error", async () => {
  const err = new Error("generator crashed");
  await assertRejects(
    () => collect(merge([throwAfter([1, 2], err)])),
    Error,
    "generator crashed",
  );
});

Deno.test("merge propagates error from one of multiple streams", async () => {
  const err = new Error("stream B crashed");
  await assertRejects(
    () =>
      collect(merge([
        fromArray([1, 2]),
        throwImmediately(err),
      ])),
    Error,
    "stream B crashed",
  );
});

Deno.test("merge does not propagate stream error when signal is aborted", async () => {
  const controller = new AbortController();
  function abortThenThrow(): AsyncIterable<number> {
    return {
      [Symbol.asyncIterator]() {
        let called = false;
        return {
          async next() {
            if (!called) {
              called = true;
              controller.abort();
              await new Promise((r) => setTimeout(r, 10));
              throw new Error("should be suppressed");
            }
            return { value: undefined as unknown as number, done: true };
          },
        };
      },
    };
  }
  // Should NOT throw — the abort came first
  const items = await collect(merge(
    [fromArray([1]), abortThenThrow()],
    controller.signal,
  ));
  // May or may not contain 1 depending on timing, but must not throw
  assertEquals(items.length <= 1, true);
});

Deno.test("mergeWithConcurrency propagates source stream error", async () => {
  const err = new Error("generator crashed");
  await assertRejects(
    () => collect(mergeWithConcurrency([throwAfter([1, 2], err)], 1)),
    Error,
    "generator crashed",
  );
});

Deno.test("mergeWithConcurrency propagates error from one of multiple streams", async () => {
  const err = new Error("step exploded");
  await assertRejects(
    () =>
      collect(mergeWithConcurrency([
        delayed([1, 2], 5),
        throwImmediately(err),
        fromArray([3, 4]),
      ], 2)),
    Error,
    "step exploded",
  );
});
