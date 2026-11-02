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
import { sortInTimeSlices } from "./scan_permits.ts";

Deno.test("sortInTimeSlices: equals the native stable sort, ties included, at sizes around a run", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1000, max: 1100 }),
        fc.integer({ min: 2000, max: 4200 }),
      ),
      fc.integer({ min: 1, max: 20 }),
      fc.integer(),
      async (length, keys, seed) => {
        const items = Array.from({ length }, (_, i) => ({
          key: Math.abs((seed + i * 2654435761) | 0) % keys,
          i,
        }));
        const compare = (a: { key: number }, b: { key: number }) =>
          a.key - b.key;
        assertEquals(
          await sortInTimeSlices(items, compare),
          items.slice().sort(compare),
        );
      },
    ),
    { numRuns: 60 },
  );
});
