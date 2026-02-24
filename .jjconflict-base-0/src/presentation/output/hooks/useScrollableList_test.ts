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
import { calculateScrollWindow } from "./useScrollableList.ts";

Deno.test("calculateScrollWindow returns empty range for empty list", () => {
  const result = calculateScrollWindow(0, 0, 5);
  assertEquals(result, { start: 0, end: 0 });
});

Deno.test("calculateScrollWindow returns empty range for zero visible height", () => {
  const result = calculateScrollWindow(10, 0, 0);
  assertEquals(result, { start: 0, end: 0 });
});

Deno.test("calculateScrollWindow returns empty range for negative visible height", () => {
  const result = calculateScrollWindow(10, 0, -5);
  assertEquals(result, { start: 0, end: 0 });
});

Deno.test("calculateScrollWindow shows first items when selected is at start", () => {
  const result = calculateScrollWindow(10, 0, 5);
  assertEquals(result, { start: 0, end: 5 });
});

Deno.test("calculateScrollWindow shows first items when selected is within first window", () => {
  const result = calculateScrollWindow(10, 2, 5);
  assertEquals(result, { start: 0, end: 5 });
});

Deno.test("calculateScrollWindow scrolls down when selected is below visible window", () => {
  const result = calculateScrollWindow(10, 7, 5);
  assertEquals(result, { start: 3, end: 8 });
});

Deno.test("calculateScrollWindow scrolls to end when selected is last item", () => {
  const result = calculateScrollWindow(10, 9, 5);
  assertEquals(result, { start: 5, end: 10 });
});

Deno.test("calculateScrollWindow handles list smaller than visible height", () => {
  const result = calculateScrollWindow(3, 1, 5);
  assertEquals(result, { start: 0, end: 3 });
});

Deno.test("calculateScrollWindow handles visible height equal to total items", () => {
  const result = calculateScrollWindow(5, 2, 5);
  assertEquals(result, { start: 0, end: 5 });
});

Deno.test("calculateScrollWindow keeps selected item visible at bottom edge", () => {
  const result = calculateScrollWindow(10, 4, 5);
  assertEquals(result, { start: 0, end: 5 });
});

Deno.test("calculateScrollWindow scrolls when selected moves to index 5", () => {
  const result = calculateScrollWindow(10, 5, 5);
  assertEquals(result, { start: 1, end: 6 });
});

Deno.test("calculateScrollWindow handles single item list", () => {
  const result = calculateScrollWindow(1, 0, 5);
  assertEquals(result, { start: 0, end: 1 });
});

Deno.test("calculateScrollWindow handles visible height of 1", () => {
  const result = calculateScrollWindow(10, 5, 1);
  assertEquals(result, { start: 5, end: 6 });
});
