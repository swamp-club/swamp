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
import { RingBuffer } from "./ring_buffer.ts";

Deno.test("RingBuffer: rejects zero capacity", () => {
  assertThrows(
    () => new RingBuffer(0),
    Error,
    "capacity must be at least 1",
  );
});

Deno.test("RingBuffer: empty buffer returns no items", () => {
  const buf = new RingBuffer<number>(5);
  assertEquals(buf.length, 0);
  assertEquals(buf.highSeq, 0);
  assertEquals(buf.readFrom(0), { items: [], throughSeq: 0 });
});

Deno.test("RingBuffer: push returns incrementing sequence", () => {
  const buf = new RingBuffer<string>(3);
  assertEquals(buf.push("a"), 1);
  assertEquals(buf.push("b"), 2);
  assertEquals(buf.push("c"), 3);
  assertEquals(buf.highSeq, 3);
  assertEquals(buf.length, 3);
});

Deno.test("RingBuffer: readFrom returns items after given seq", () => {
  const buf = new RingBuffer<string>(5);
  buf.push("a");
  buf.push("b");
  buf.push("c");

  const result = buf.readFrom(0);
  assertEquals(result.items, ["a", "b", "c"]);
  assertEquals(result.throughSeq, 3);

  const partial = buf.readFrom(1);
  assertEquals(partial.items, ["b", "c"]);
  assertEquals(partial.throughSeq, 3);

  const last = buf.readFrom(2);
  assertEquals(last.items, ["c"]);
  assertEquals(last.throughSeq, 3);
});

Deno.test("RingBuffer: readFrom at highSeq returns empty", () => {
  const buf = new RingBuffer<string>(5);
  buf.push("a");
  buf.push("b");
  assertEquals(buf.readFrom(2), { items: [], throughSeq: 2 });
});

Deno.test("RingBuffer: wraps around when capacity exceeded", () => {
  const buf = new RingBuffer<string>(3);
  buf.push("a"); // seq 1
  buf.push("b"); // seq 2
  buf.push("c"); // seq 3
  buf.push("d"); // seq 4, overwrites "a"

  assertEquals(buf.length, 3);
  assertEquals(buf.highSeq, 4);
  assertEquals(buf.oldestSeq, 2);

  const result = buf.readFrom(0);
  assertEquals(result.items, ["b", "c", "d"]);
  assertEquals(result.throughSeq, 4);
});

Deno.test("RingBuffer: readFrom with seq older than oldest clamps", () => {
  const buf = new RingBuffer<number>(2);
  buf.push(1);
  buf.push(2);
  buf.push(3); // seq 3, oldest is now 2

  const result = buf.readFrom(0);
  assertEquals(result.items, [2, 3]);
  assertEquals(result.throughSeq, 3);
});

Deno.test("RingBuffer: per-cursor independent reads", () => {
  const buf = new RingBuffer<string>(5);
  buf.push("a");
  buf.push("b");
  buf.push("c");

  let cursorA = 0;
  let cursorB = 0;

  const readA = buf.readFrom(cursorA);
  assertEquals(readA.items, ["a", "b", "c"]);
  cursorA = readA.throughSeq;

  buf.push("d");

  const readB = buf.readFrom(cursorB);
  assertEquals(readB.items, ["a", "b", "c", "d"]);
  cursorB = readB.throughSeq;

  const readA2 = buf.readFrom(cursorA);
  assertEquals(readA2.items, ["d"]);

  const readB2 = buf.readFrom(cursorB);
  assertEquals(readB2.items, []);
});

Deno.test("RingBuffer: capacity of 1", () => {
  const buf = new RingBuffer<string>(1);
  buf.push("a");
  assertEquals(buf.readFrom(0), { items: ["a"], throughSeq: 1 });

  buf.push("b");
  assertEquals(buf.readFrom(0), { items: ["b"], throughSeq: 2 });
  assertEquals(buf.readFrom(1), { items: ["b"], throughSeq: 2 });
});
