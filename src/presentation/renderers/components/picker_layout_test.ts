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
import { computePickerLayout } from "./picker_layout.ts";

// --- bordered-split tier ---

Deno.test("computePickerLayout: bordered-split at large terminal", () => {
  const layout = computePickerLayout(200, 60);
  assertEquals(layout.tier, "bordered-split");
  // Results pane capped at MAX_RESULTS_WIDTH=50
  assertEquals(layout.resultsWidth, 50);
  // Preview gets the rest: 200 - 3 (borders) - 50 = 147
  assertEquals(layout.previewWidth, 147);
  // Content height: 60 - 6 (chrome) = 54
  assertEquals(layout.resultsHeight, 54);
  assertEquals(layout.previewHeight, 54);
});

Deno.test("computePickerLayout: bordered-split at 90x16 threshold", () => {
  const layout = computePickerLayout(90, 16);
  assertEquals(layout.tier, "bordered-split");
  // Inner width: 90 - 3 = 87, results: min(50, floor(87*0.4)) = min(50, 34) = 34
  assertEquals(layout.resultsWidth, 34);
  assertEquals(layout.previewWidth, 53);
  // Content height: 16 - 6 = 10
  assertEquals(layout.resultsHeight, 10);
  assertEquals(layout.previewHeight, 10);
});

Deno.test("computePickerLayout: bordered-split respects min results width", () => {
  const layout = computePickerLayout(90, 20);
  assertEquals(layout.tier, "bordered-split");
  // Results width should be at least MIN_RESULTS_WIDTH=20
  assertEquals(layout.resultsWidth >= 20, true);
});

// --- stacked tier ---

Deno.test("computePickerLayout: stacked at 80x50", () => {
  const layout = computePickerLayout(80, 50);
  assertEquals(layout.tier, "stacked");
  // Inner width: 80 - 2 = 78
  assertEquals(layout.resultsWidth, 78);
  assertEquals(layout.previewWidth, 78);
  // Content height: 50 - 6 - 1 = 43, results: floor(43*0.45) = 19
  assertEquals(layout.resultsHeight, 19);
  // Preview: 43 - 19 = 24
  assertEquals(layout.previewHeight, 24);
});

Deno.test("computePickerLayout: stacked at 60x24 threshold", () => {
  const layout = computePickerLayout(60, 24);
  assertEquals(layout.tier, "stacked");
  // Content height: 24 - 6 - 1 = 17, results: floor(17*0.45) = 7
  assertEquals(layout.resultsHeight, 7);
  // Preview: 17 - 7 = 10
  assertEquals(layout.previewHeight, 10);
});

Deno.test("computePickerLayout: narrow but tall falls to stacked not bordered-split", () => {
  // 80 wide < 90 threshold, but tall enough for stacked
  const layout = computePickerLayout(80, 30);
  assertEquals(layout.tier, "stacked");
});

// --- inline tier ---

Deno.test("computePickerLayout: inline at 80x24", () => {
  const layout = computePickerLayout(80, 15);
  assertEquals(layout.tier, "inline");
  assertEquals(layout.resultsWidth, 80);
  assertEquals(layout.previewWidth, 76); // 80 - 4 indent
  // Content height: 15 - 3 = 12, results: 12 - 4 = 8
  assertEquals(layout.resultsHeight, 8);
  assertEquals(layout.previewHeight, 4);
});

Deno.test("computePickerLayout: inline at threshold 60x12", () => {
  const layout = computePickerLayout(60, 12);
  assertEquals(layout.tier, "inline");
  // Content height: 12 - 3 = 9, results: max(3, 9-4) = 5
  assertEquals(layout.resultsHeight, 5);
  assertEquals(layout.previewHeight, 4);
});

// --- minimal tier ---

Deno.test("computePickerLayout: minimal at 59x12", () => {
  // Width below 60 threshold
  const layout = computePickerLayout(59, 12);
  assertEquals(layout.tier, "minimal");
  assertEquals(layout.previewWidth, 0);
  assertEquals(layout.previewHeight, 0);
});

Deno.test("computePickerLayout: minimal at 60x11", () => {
  // Height below 12 threshold
  const layout = computePickerLayout(60, 11);
  assertEquals(layout.tier, "minimal");
  assertEquals(layout.previewWidth, 0);
  assertEquals(layout.previewHeight, 0);
});

Deno.test("computePickerLayout: minimal at tiny terminal", () => {
  const layout = computePickerLayout(40, 10);
  assertEquals(layout.tier, "minimal");
  assertEquals(layout.resultsWidth, 40);
  assertEquals(layout.resultsHeight, 7); // 10 - 3 = 7
  assertEquals(layout.previewWidth, 0);
  assertEquals(layout.previewHeight, 0);
});

Deno.test("computePickerLayout: minimal caps results at 10", () => {
  // Even at a tall narrow terminal, minimal caps results at 10
  const layout = computePickerLayout(40, 40);
  assertEquals(layout.tier, "minimal");
  assertEquals(layout.resultsHeight, 10);
});

// --- edge cases ---

Deno.test("computePickerLayout: very small terminal", () => {
  const layout = computePickerLayout(20, 5);
  assertEquals(layout.tier, "minimal");
  assertEquals(layout.resultsHeight, 3); // MIN_RESULTS_HEIGHT
});

Deno.test("computePickerLayout: standard 80x24 falls to stacked", () => {
  const layout = computePickerLayout(80, 24);
  assertEquals(layout.tier, "stacked");
});

Deno.test("computePickerLayout: results and preview heights are always positive", () => {
  for (const w of [20, 40, 60, 80, 100, 200]) {
    for (const h of [5, 10, 15, 20, 30, 50]) {
      const layout = computePickerLayout(w, h);
      assertEquals(
        layout.resultsHeight >= 0,
        true,
        `resultsHeight < 0 at ${w}x${h}`,
      );
      assertEquals(
        layout.previewHeight >= 0,
        true,
        `previewHeight < 0 at ${w}x${h}`,
      );
      assertEquals(
        layout.resultsWidth >= 0,
        true,
        `resultsWidth < 0 at ${w}x${h}`,
      );
      assertEquals(
        layout.previewWidth >= 0,
        true,
        `previewWidth < 0 at ${w}x${h}`,
      );
    }
  }
});
