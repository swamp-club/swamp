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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import type { DataQueryData } from "../libswamp/data/query.ts";
import {
  assembleQueryReply,
  queryItems,
  queryPartBatches,
  withQueryItems,
} from "./data_query_parts.ts";

const json = fc.jsonValue({ maxDepth: 3 });

const reply: fc.Arbitrary<DataQueryData> = fc.oneof(
  fc.array(json).map((values) => ({
    predicate: "true",
    select: "v",
    results: [],
    projected: { shape: "scalar" as const, values },
    total: values.length,
    limited: false,
  })),
  fc.array(fc.dictionary(fc.string(), json)).map((rows) => ({
    predicate: "true",
    select: "m",
    results: [],
    projected: { shape: "map" as const, columns: [], rows },
    total: rows.length,
    limited: true,
    nextCursor: "c",
  })),
  fc.array(fc.array(json)).map((rows) => ({
    predicate: "true",
    select: "[a]",
    results: [],
    projected: { shape: "list" as const, rows },
    total: rows.length,
    limited: false,
  })),
);

Deno.test("data query parts: assembling the parts of any reply gives it back, for any budget", () => {
  fc.assert(
    fc.property(reply, fc.integer({ min: 1, max: 4096 }), (data, budget) => {
      const items = queryItems(data);
      const batches = [...queryPartBatches(items, budget)];
      for (const batch of batches) assertEquals(batch.length > 0, true);
      const parts = batches.map((batch) => ({ items: batch }));
      const rebuilt = assembleQueryReply(
        withQueryItems(data, []),
        JSON.parse(JSON.stringify(parts)),
        items.length,
      );
      assertEquals(rebuilt, JSON.parse(JSON.stringify(data)));
    }),
  );
});
