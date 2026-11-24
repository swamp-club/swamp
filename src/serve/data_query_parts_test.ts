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
import { UserError } from "../domain/errors.ts";
import type { DataRecord } from "../domain/data/data_record.ts";
import type { DataQueryData } from "../libswamp/data/query.ts";
import {
  assembleQueryReply,
  describeQueryItem,
  estimateJsonBytes,
  queryItems,
  queryPartBatches,
  withQueryItems,
} from "./data_query_parts.ts";

function record(name: string): DataRecord {
  return {
    name,
    modelName: "m",
    version: 3,
    content: { name },
  } as unknown as DataRecord;
}

const base = { predicate: "true", total: 2, limited: false };
const shapes: Record<string, DataQueryData> = {
  results: { ...base, results: [record("a"), record("b")] },
  scalar: {
    ...base,
    select: "name",
    results: [],
    projected: { shape: "scalar", values: ["a", null] },
  },
  map: {
    ...base,
    select: "content",
    results: [],
    projected: { shape: "map", columns: ["name"], rows: [{ name: "a" }, {}] },
  },
  list: {
    ...base,
    select: "[name]",
    results: [],
    projected: { shape: "list", rows: [["a"], ["b"]] },
  },
};

for (const [shape, data] of Object.entries(shapes)) {
  Deno.test(`assembleQueryReply: rebuilds a ${shape} reply from its parts`, () => {
    const items = [...queryItems(data)];
    const summary = withQueryItems(data, []);
    assertEquals(queryItems(summary), []);
    const parts = [{ items: items.slice(0, 1) }, { items: items.slice(1) }];
    assertEquals(assembleQueryReply(summary, parts, items.length), data);
  });
}

Deno.test("withQueryItems: leaves the reply it copies unchanged", () => {
  const data = shapes.map;
  const before = structuredClone(data);
  withQueryItems(data, []);
  assertEquals(data, before);
});

Deno.test("assembleQueryReply: no parts and no matches is an empty reply", () => {
  const summary = withQueryItems(shapes.results, []);
  assertEquals(assembleQueryReply(summary, [], 0).results, []);
});

Deno.test("assembleQueryReply: fewer items than partItems is refused with both counts", () => {
  const summary = withQueryItems(shapes.results, []);
  assertThrows(
    () => assembleQueryReply(summary, [{ items: [record("a")] }], 2),
    UserError,
    "sent 1 of the 2 query results",
  );
});

Deno.test("assembleQueryReply: more items than partItems is refused", () => {
  const summary = withQueryItems(shapes.scalar, []);
  assertThrows(
    () => assembleQueryReply(summary, [{ items: ["a", "b", "c"] }], 2),
    UserError,
    "sent 3 of the 2",
  );
});

Deno.test("assembleQueryReply: a part without an items array is refused", () => {
  const summary = withQueryItems(shapes.scalar, []);
  for (const part of [null, "x", {}, { items: "a" }]) {
    assertThrows(
      () => assembleQueryReply(summary, [part], 0),
      UserError,
      "without items",
    );
  }
});

Deno.test("queryPartBatches: keeps order and cuts at the budget", () => {
  const items = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  const batches = [...queryPartBatches(items, 90)];
  assertEquals(batches, [[items[0], items[1]], [items[2]]]);
});

Deno.test("queryPartBatches: an item over the budget goes alone", () => {
  const big = "x".repeat(500);
  assertEquals([...queryPartBatches(["a", big, "b"], 100)], [["a"], [big], [
    "b",
  ]]);
});

Deno.test("queryPartBatches: no items is no parts", () => {
  assertEquals([...queryPartBatches([], 100)], []);
});

Deno.test("estimateJsonBytes: a string's estimate is its JSON length", () => {
  const value = "x".repeat(1000);
  assertEquals(estimateJsonBytes(value, 10_000), JSON.stringify(value).length);
});

Deno.test("estimateJsonBytes: never under the JSON length for plain ASCII values", () => {
  const value = {
    name: "abc",
    n: 12345.678,
    nested: [{ a: true, b: null }, ["x", "yy"]],
    when: new Date(0),
  };
  const estimate = estimateJsonBytes(value, Number.MAX_SAFE_INTEGER);
  assertEquals(estimate >= JSON.stringify(value).length, true);
});

Deno.test("estimateJsonBytes: stops counting once past the cap", () => {
  const items = Array.from({ length: 100 }, () => "x".repeat(100));
  const estimate = estimateJsonBytes(items, 1000);
  assertEquals(estimate > 1000 && estimate < 1300, true);
});

Deno.test("estimateJsonBytes: measures values nested deeper than the stack", () => {
  let value: unknown = "leaf";
  for (let i = 0; i < 100_000; i++) value = [value];
  assertEquals(estimateJsonBytes(value, Number.MAX_SAFE_INTEGER) > 0, true);
});

Deno.test("describeQueryItem: names a record, or a projected match by position", () => {
  assertEquals(describeQueryItem(record("a"), 0), "m/a version 3");
  assertEquals(describeQueryItem("value", 4), "match 5");
  assertEquals(describeQueryItem({ name: "a" }, 0), "match 1");
});
