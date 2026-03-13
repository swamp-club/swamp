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

import { assertEquals } from "@std/assert";
import { merge } from "./merge.ts";

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
