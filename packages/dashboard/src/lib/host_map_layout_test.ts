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

import { assert, assertEquals } from "@std/assert";
import {
  clampBounds,
  GUTTER,
  HEADER,
  layoutGroups,
  nodeSize,
  slotGrid,
} from "./host_map_layout.ts";

Deno.test("nodeSize: area grows linearly with capacity", () => {
  assertEquals(nodeSize(1), 15);
  assertEquals(nodeSize(4), 30);
  const ratio = (nodeSize(8) ** 2) / (nodeSize(1) ** 2);
  assert(ratio > 7.5 && ratio < 8.5, `area ratio ${ratio}`);
  assertEquals(nodeSize(0), 15);
});

Deno.test("slotGrid: one cell per slot, two columns up to 8 slots, inside the square", () => {
  const cells = slotGrid(8, 42);
  assertEquals(cells.length, 8);
  const xs = new Set(cells.map((c) => c.x.toFixed(2)));
  const ys = new Set(cells.map((c) => c.y.toFixed(2)));
  assertEquals(xs.size, 2);
  assertEquals(ys.size, 4);
  assertEquals(new Set(slotGrid(6, 37).map((c) => c.x.toFixed(2))).size, 2);
  assertEquals(new Set(slotGrid(16, 60).map((c) => c.x.toFixed(2))).size, 4);
  for (const c of cells) {
    assert(c.x >= -18 && c.x + c.w <= 18.001);
    assert(c.y >= -18 && c.y + c.h <= 18.001);
  }
  assertEquals(slotGrid(1, 15).length, 1);
});

Deno.test("layoutGroups: bigger capacity gets more area, cells tile the width", () => {
  const { cells, height } = layoutGroups([
    { key: "ci", capacities: Array(14).fill(8) },
    { key: "mac", capacities: Array(5).fill(2) },
    { key: "edge", capacities: Array(6).fill(1) },
  ], 1200);
  assert(height >= 380 && height <= 1400);
  const area = (k: string) => {
    const c = cells.find((x) => x.key === k)!;
    return c.w * c.h;
  };
  assert(area("ci") > area("mac"));
  assert(area("ci") > area("edge"));
  for (const c of cells) {
    assert(c.x >= 0 && c.x + c.w <= 1200);
    assert(c.y >= 0 && c.y + c.h <= height);
    assert(c.h > HEADER, `${c.key} taller than its header`);
  }
  // Gutters keep cards apart.
  for (const a of cells) {
    for (const b of cells) {
      if (a === b) continue;
      const apart = a.x + a.w + GUTTER <= b.x + 1 ||
        b.x + b.w + GUTTER <= a.x + 1 ||
        a.y + a.h + GUTTER <= b.y + 1 || b.y + b.h + GUTTER <= a.y + 1;
      assert(apart, `${a.key} overlaps ${b.key}`);
    }
  }
});

Deno.test("layoutGroups: empty input has no cells", () => {
  assertEquals(layoutGroups([], 1200).cells, []);
});

Deno.test("clampBounds: keeps a worker's square inside the card and below the header", () => {
  const { cells } = layoutGroups([{ key: "g", capacities: [8] }], 800);
  const cell = cells[0];
  const size = nodeSize(8);
  const b = clampBounds(cell, size);
  assert(b.minX - size / 2 >= cell.x);
  assert(b.maxX + size / 2 <= cell.x + cell.w);
  assert(b.minY - size / 2 >= cell.y + HEADER);
  assert(b.maxY + size / 2 <= cell.y + cell.h);
});

Deno.test("clampBounds: collapses to the centre when the card is too small", () => {
  const b = clampBounds({
    key: "x",
    x: 0,
    y: 0,
    w: 20,
    h: 50,
    cx: 10,
    cy: 48,
    r: 10,
  }, 40);
  assertEquals(b.minX, b.maxX);
  assertEquals(b.minY, b.maxY);
});
