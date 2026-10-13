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
import { dagLevels, layoutDag } from "./mini_dag_layout.ts";

const n = (id: string) => ({ id, label: id });

Deno.test("dagLevels: longest dependency chain decides the column", () => {
  const levels = dagLevels(
    [n("build"), n("test"), n("lint"), n("deploy")],
    [
      { from: "build", to: "test" },
      { from: "build", to: "deploy" },
      { from: "test", to: "deploy" },
    ],
  );
  assertEquals(Object.fromEntries(levels), {
    build: 0,
    test: 1,
    lint: 0,
    deploy: 2,
  });
});

Deno.test("dagLevels: ignores unknown nodes, self loops and survives cycles", () => {
  const levels = dagLevels(
    [n("a"), n("b"), n("c")],
    [
      { from: "ghost", to: "a" },
      { from: "a", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "b" },
    ],
  );
  assertEquals(levels.get("a"), 0);
  assertEquals(levels.size, 3);
  // b and c sit on a cycle: each still lands after something it follows.
  assertEquals(levels.get("b")! >= 1, true);
  assertEquals(levels.get("c")! >= 1, true);
});

Deno.test("layoutDag: places columns left to right and centres short columns", () => {
  const layout = layoutDag(
    [n("a"), n("b"), n("c"), n("d")],
    [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ],
    { nodeWidth: 100, nodeHeight: 20, columnGap: 30, rowGap: 10 },
  );
  assertEquals(layout.levels, 3);
  assertEquals(layout.width, 3 * 100 + 2 * 30);
  assertEquals(layout.height, 2 * 20 + 10);
  const at = Object.fromEntries(layout.nodes.map((p) => [p.id, p]));
  assertEquals([at.a.x, at.b.x, at.d.x], [0, 130, 260]);
  // The single-node columns sit midway down the two-node column.
  assertEquals(at.a.y, 15);
  assertEquals(at.d.y, 15);
  assertEquals([at.b.y, at.c.y], [0, 30]);
  assertEquals(layout.edges.length, 4);
  assertEquals(
    layout.edges[0].path,
    "M 100 25 C 115 25, 115 10, 130 10",
  );
});

Deno.test("layoutDag: orders a column by where its dependencies sit", () => {
  // y depends on the lower of two roots, x on the upper: x stays above y
  // even though y was listed first.
  const layout = layoutDag(
    [n("top"), n("bottom"), n("y"), n("x")],
    [
      { from: "bottom", to: "y" },
      { from: "top", to: "x" },
    ],
  );
  const row = Object.fromEntries(layout.nodes.map((p) => [p.id, p.row]));
  assertEquals(row, { top: 0, bottom: 1, x: 0, y: 1 });
});

Deno.test("layoutDag: empty input and duplicate edges", () => {
  const empty = layoutDag([], []);
  assertEquals([empty.width, empty.height, empty.levels], [0, 0, 0]);
  const dup = layoutDag([n("a"), n("b")], [
    { from: "a", to: "b" },
    { from: "a", to: "b" },
  ]);
  assertEquals(dup.edges.length, 1);
});
