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
import {
  createQuerySort,
  decodeQueryCursor,
  encodeQueryCursor,
} from "./query_sort.ts";

const directionArb = fc.constantFrom("asc" as const, "desc" as const);
const fieldArb = fc.oneof(
  fc.constant("createdAt"),
  fc.stringMatching(/^[A-Za-z0-9_.-]{1,20}$/).map((key) => `tags.${key}`),
);
const positionArb = fc.record({
  key: fc.string({ unit: "grapheme" }),
  id: fc.tuple(
    fc.string(),
    fc.string(),
    fc.string(),
    fc.string({ unit: "grapheme" }),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  ),
});

Deno.test("encodeQueryCursor: decodes back to the same position for its sort", () => {
  fc.assert(
    fc.property(fieldArb, directionArb, positionArb, (field, dir, position) => {
      const sort = createQuerySort(field, dir);
      assertEquals(
        decodeQueryCursor(encodeQueryCursor(sort, position), sort),
        position,
      );
    }),
  );
});
