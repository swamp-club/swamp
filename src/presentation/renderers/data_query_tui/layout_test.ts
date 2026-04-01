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
import { computeQueryTuiLayout } from "./layout.ts";

Deno.test("computeQueryTuiLayout: standard terminal no autocomplete no error", () => {
  const layout = computeQueryTuiLayout(80, 24, 0, 0);
  // 24 - 7 chrome = 17
  assertEquals(layout.resultsHeight, 17);
  assertEquals(layout.inspectorHeight, 17);
  assertEquals(layout.inspectorWidth, 76); // min(80-4, 80)
});

Deno.test("computeQueryTuiLayout: with autocomplete dropdown", () => {
  const layout = computeQueryTuiLayout(80, 24, 8, 0);
  // 24 - 7 - 8 = 9
  assertEquals(layout.resultsHeight, 9);
});

Deno.test("computeQueryTuiLayout: with error lines", () => {
  const layout = computeQueryTuiLayout(80, 24, 0, 3);
  // 24 - 7 - 3 = 14
  assertEquals(layout.resultsHeight, 14);
});

Deno.test("computeQueryTuiLayout: with both autocomplete and error", () => {
  const layout = computeQueryTuiLayout(80, 24, 5, 2);
  // 24 - 7 - 5 - 2 = 10
  assertEquals(layout.resultsHeight, 10);
});

Deno.test("computeQueryTuiLayout: minimum results height is 1", () => {
  // Very small terminal or huge autocomplete + error
  const layout = computeQueryTuiLayout(80, 10, 8, 5);
  // 10 - 7 - 8 - 5 = -10, clamped to 1
  assertEquals(layout.resultsHeight, 1);
});

Deno.test("computeQueryTuiLayout: wide terminal caps inspector width", () => {
  const layout = computeQueryTuiLayout(200, 40, 0, 0);
  assertEquals(layout.inspectorWidth, 80); // min(196, 80)
});

Deno.test("computeQueryTuiLayout: narrow terminal", () => {
  const layout = computeQueryTuiLayout(40, 24, 0, 0);
  assertEquals(layout.inspectorWidth, 36); // min(36, 80)
});

Deno.test("computeQueryTuiLayout: tall terminal gives more results space", () => {
  const layout = computeQueryTuiLayout(80, 50, 0, 0);
  // 50 - 7 = 43
  assertEquals(layout.resultsHeight, 43);
});
