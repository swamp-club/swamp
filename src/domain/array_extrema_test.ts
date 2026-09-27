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
import { maxOf, minOf } from "./array_extrema.ts";

/** Above the ~125k-element ceiling where `Math.max(...values)` throws. */
const LARGE = 200_000;

Deno.test("maxOf: returns undefined for no values", () => {
  assertEquals(maxOf([]), undefined);
});

Deno.test("maxOf: returns the only value", () => {
  assertEquals(maxOf([7]), 7);
});

Deno.test("maxOf: finds the largest of unsorted values", () => {
  assertEquals(maxOf([3, 9, 1, 9, 4]), 9);
});

Deno.test("maxOf: handles negative values", () => {
  assertEquals(maxOf([-5, -2, -9]), -2);
});

Deno.test("maxOf: accepts any iterable", () => {
  assertEquals(maxOf(new Set([4, 12, 8])), 12);
});

Deno.test("maxOf: handles more values than fit in a spread call", () => {
  const values = Array.from({ length: LARGE }, (_, i) => i + 1);
  assertEquals(maxOf(values), LARGE);
});

Deno.test("minOf: returns undefined for no values", () => {
  assertEquals(minOf([]), undefined);
});

Deno.test("minOf: returns the only value", () => {
  assertEquals(minOf([7]), 7);
});

Deno.test("minOf: finds the smallest of unsorted values", () => {
  assertEquals(minOf([3, 9, 1, 9, 4]), 1);
});

Deno.test("minOf: handles negative values", () => {
  assertEquals(minOf([-5, -2, -9]), -9);
});

Deno.test("minOf: handles more values than fit in a spread call", () => {
  const values = Array.from({ length: LARGE }, (_, i) => LARGE - i);
  assertEquals(minOf(values), 1);
});
