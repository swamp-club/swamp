// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

import { assertEquals, assertRejects } from "@std/assert";
import { AsyncIterableQueue } from "./queue.ts";

async function drain<T>(queue: AsyncIterableQueue<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of queue) seen.push(value);
  return seen;
}

Deno.test("AsyncIterableQueue: error while next() waits rejects that next()", async () => {
  const queue = new AsyncIterableQueue<number>();
  const waiting = queue[Symbol.asyncIterator]().next();
  const err = new Error("refused");
  queue.error(err);
  const thrown = await assertRejects(() => waiting, Error, "refused");
  assertEquals(thrown, err);
});

Deno.test("AsyncIterableQueue: for await throws when the error arrives while it waits", async () => {
  const queue = new AsyncIterableQueue<number>();
  const seen: number[] = [];
  const consumed = (async () => {
    for await (const value of queue) seen.push(value);
  })();
  queue.push(1);
  await Promise.resolve();
  queue.error(new Error("refused"));
  await assertRejects(() => consumed, Error, "refused");
  assertEquals(seen, [1]);
});

Deno.test("AsyncIterableQueue: error before next() delivers buffered values, then throws", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.error(new Error("refused"));
  const it = queue[Symbol.asyncIterator]();
  assertEquals(await it.next(), { value: 1, done: false });
  assertEquals(await it.next(), { value: 2, done: false });
  await assertRejects(() => it.next(), Error, "refused");
});

Deno.test("AsyncIterableQueue: error with no reader rejects nothing until next() is called", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.error(new Error("refused"));
  await Promise.resolve();
  await assertRejects(
    () => queue[Symbol.asyncIterator]().next(),
    Error,
    "refused",
  );
});

Deno.test("AsyncIterableQueue: done then error ends cleanly", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.push(1);
  queue.done();
  queue.error(new Error("late"));
  assertEquals(await drain(queue), [1]);
});

Deno.test("AsyncIterableQueue: error then done still throws", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.push(1);
  queue.error(new Error("refused"));
  queue.done();
  const it = queue[Symbol.asyncIterator]();
  assertEquals(await it.next(), { value: 1, done: false });
  await assertRejects(() => it.next(), Error, "refused");
});

Deno.test("AsyncIterableQueue: the first error wins", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.error(new Error("first"));
  queue.error(new Error("second"));
  await assertRejects(() => drain(queue), Error, "first");
});

Deno.test("AsyncIterableQueue: done twice ends once", async () => {
  const queue = new AsyncIterableQueue<number>();
  const waiting = queue[Symbol.asyncIterator]().next();
  queue.done();
  queue.done();
  assertEquals((await waiting).done, true);
  assertEquals(await drain(queue), []);
});

Deno.test("AsyncIterableQueue: push after a terminal is ignored", async () => {
  const queue = new AsyncIterableQueue<number>();
  queue.push(1);
  queue.error(new Error("refused"));
  queue.push(2);
  const seen: number[] = [];
  await assertRejects(
    async () => {
      for await (const value of queue) seen.push(value);
    },
    Error,
    "refused",
  );
  assertEquals(seen, [1]);
});

Deno.test("AsyncIterableQueue: a value pushed while next() waits is delivered", async () => {
  const queue = new AsyncIterableQueue<number>();
  const waiting = queue[Symbol.asyncIterator]().next();
  queue.push(7);
  assertEquals(await waiting, { value: 7, done: false });
});
