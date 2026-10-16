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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { VersionRanges } from "./version_ranges.ts";

Deno.test("VersionRanges.of: merges overlapping and adjacent ranges in any order", () => {
  assertEquals(
    VersionRanges.of([[9, 9], [1, 2], [3, 4], [6, 7], [7, 8]]).ranges,
    [[1, 4], [6, 9]],
  );
  assertStrictEquals(VersionRanges.of([]), VersionRanges.EMPTY);
});

Deno.test("VersionRanges.of: refuses a range that is not two positive versions in order", () => {
  for (const range of [[0, 1], [2, 1], [1], [1, 2, 3], [1.5, 2], [-1, 1]]) {
    assertThrows(
      () => VersionRanges.of([range]),
      Error,
      "is not a range of positive versions",
    );
  }
});

Deno.test("VersionRanges: add and delete keep the ranges merged", () => {
  let set = VersionRanges.EMPTY.add(3).add(1).add(2).add(5);
  assertEquals(set.ranges, [[1, 3], [5, 5]]);
  assertEquals(set.max, 5);
  assertEquals([0, 1, 2, 3, 4, 5, 6].map((v) => set.has(v)), [
    false,
    true,
    true,
    true,
    false,
    true,
    false,
  ]);
  set = set.delete(2);
  assertEquals(set.ranges, [[1, 1], [3, 3], [5, 5]]);
  set = set.add(4);
  assertEquals(set.ranges, [[1, 1], [3, 5]]);
  assertStrictEquals(set.add(4), set);
  assertStrictEquals(set.delete(2), set);
  assertStrictEquals(
    set.delete(1).delete(3).delete(4).delete(5),
    VersionRanges.EMPTY,
  );
});

Deno.test("VersionRanges: matches a plain set over random adds and deletes", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          add: fc.boolean(),
          version: fc.integer({ min: 1, max: 20 }),
        }),
        { maxLength: 60 },
      ),
      (steps) => {
        let ranges = VersionRanges.EMPTY;
        const plain = new Set<number>();
        for (const { add, version } of steps) {
          if (add) {
            ranges = ranges.add(version);
            plain.add(version);
          } else {
            ranges = ranges.delete(version);
            plain.delete(version);
          }
        }
        for (let v = 0; v <= 21; v++) assertEquals(ranges.has(v), plain.has(v));
        assertEquals(ranges.max, Math.max(0, ...plain));
        assertEquals(ranges.isEmpty, plain.size === 0);
        // Normalised: equal sets have equal ranges.
        assertEquals(
          VersionRanges.of([...plain].map((v) => [v, v])).ranges,
          ranges.ranges,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("VersionRanges.union: the versions in either set, merged", () => {
  const a = VersionRanges.of([[1, 2], [7, 7]]);
  const b = VersionRanges.of([[3, 4], [9, 10]]);
  assertEquals(a.union(b).ranges, [[1, 4], [7, 7], [9, 10]]);
  assertStrictEquals(a.union(VersionRanges.EMPTY), a);
  assertStrictEquals(VersionRanges.EMPTY.union(b), b);
  assertEquals(a.union(a).equals(a), true);
  assertEquals(a.equals(b), false);
});
