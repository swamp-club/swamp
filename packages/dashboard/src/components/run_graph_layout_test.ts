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
  countCrossings,
  DEFAULT_LAYOUT,
  edgePath,
  type GraphLayout,
  type LayoutEdgeInput,
  layoutGraph,
  neighborInDirection,
  relatives,
} from "./run_graph_layout.ts";

const opts = {
  nodeWidth: 100,
  nodeHeight: 40,
  columnGap: 50,
  rowGap: 10,
  sweeps: 8,
};

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));
const edge = (from: string, to: string): LayoutEdgeInput => ({ from, to });
const byId = (layout: GraphLayout) =>
  new Map(layout.nodes.map((n) => [n.id, n]));

/** Real cards in one column never overlap, whatever the graph. */
function assertNoOverlap(layout: GraphLayout, nodeHeight: number) {
  const map = byId(layout);
  for (const column of layout.levels) {
    const ys = column.map((id) => map.get(id)!.y);
    for (let i = 1; i < ys.length; i++) {
      assert(
        ys[i] - ys[i - 1] >= nodeHeight,
        `cards overlap in column ${column.join(",")}: ${ys.join(",")}`,
      );
    }
  }
}

Deno.test("layoutGraph: an empty graph has no size", () => {
  const layout = layoutGraph([], [], opts);
  assertEquals(layout.nodes, []);
  assertEquals(layout.edges, []);
  assertEquals(layout.width, 0);
  assertEquals(layout.height, 0);
});

Deno.test("layoutGraph: each job sits one column after its deepest dependency", () => {
  const layout = layoutGraph(
    nodes("build", "test", "lint", "deploy"),
    [
      edge("build", "test"),
      edge("build", "lint"),
      edge("test", "deploy"),
      edge("lint", "deploy"),
      edge("build", "deploy"),
    ],
    opts,
  );
  const map = byId(layout);
  assertEquals(map.get("build")!.level, 0);
  assertEquals(map.get("test")!.level, 1);
  assertEquals(map.get("lint")!.level, 1);
  assertEquals(map.get("deploy")!.level, 2);
  assertEquals(map.get("deploy")!.x, 2 * (opts.nodeWidth + opts.columnGap));
  assertEquals(layout.width, 3 * opts.nodeWidth + 2 * opts.columnGap);
});

Deno.test("layoutGraph: a chain is drawn as one straight line", () => {
  const layout = layoutGraph(
    nodes("a", "b", "c"),
    [edge("a", "b"), edge("b", "c")],
    opts,
  );
  const ys = layout.nodes.map((n) => n.y);
  assertEquals(new Set(ys).size, 1);
  for (const e of layout.edges) {
    assertEquals(e.points[0].y, e.points[e.points.length - 1].y);
    assertEquals(edgePath(e.points).includes("C"), false);
  }
});

Deno.test("layoutGraph: a fan-in target is centred on the jobs that feed it", () => {
  const layout = layoutGraph(
    nodes("a", "b", "c", "d"),
    [edge("a", "d"), edge("b", "d"), edge("c", "d")],
    opts,
  );
  const map = byId(layout);
  assertEquals(map.get("d")!.y, map.get("b")!.y);
  assertNoOverlap(layout, opts.nodeHeight);
});

Deno.test("layoutGraph: a fan-out source is centred on what it feeds", () => {
  const layout = layoutGraph(
    nodes("a", "b", "c", "d"),
    [edge("a", "b"), edge("a", "c"), edge("a", "d")],
    opts,
  );
  const map = byId(layout);
  assertEquals(map.get("a")!.y, map.get("c")!.y);
  assertEquals(layout.nodes.every((n) => n.y >= 0), true);
});

Deno.test("layoutGraph: is deterministic", () => {
  const input = nodes("a", "b", "c", "d", "e", "f");
  const edges = [
    edge("a", "d"),
    edge("b", "e"),
    edge("c", "d"),
    edge("a", "f"),
    edge("e", "f"),
  ];
  const first = layoutGraph(input, edges, opts);
  for (let i = 0; i < 5; i++) {
    assertEquals(layoutGraph(input, edges, opts), first);
  }
});

Deno.test("layoutGraph: barycentre ordering removes an avoidable crossing", () => {
  // Input order would cross: a→d and b→c with c listed above d.
  const edges = [edge("a", "d"), edge("b", "c")];
  const input = nodes("a", "b", "c", "d");
  assertEquals(countCrossings([["a", "b"], ["c", "d"]], edges), 1);
  const layout = layoutGraph(input, edges, opts);
  assertEquals(countCrossings(layout.levels, edges), 0);
  assertEquals(layout.levels[1], ["d", "c"]);
});

Deno.test("layoutGraph: reduces crossings on a known three-column case", () => {
  // A twisted ladder: listed order has 3 crossings, the best has 0.
  const input = nodes("a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3");
  const edges = [
    edge("a1", "b3"),
    edge("a2", "b2"),
    edge("a3", "b1"),
    edge("b1", "c3"),
    edge("b2", "c2"),
    edge("b3", "c1"),
  ];
  assertEquals(
    countCrossings([["a1", "a2", "a3"], ["b1", "b2", "b3"], [
      "c1",
      "c2",
      "c3",
    ]], edges),
    6,
  );
  const layout = layoutGraph(input, edges, opts);
  assertEquals(countCrossings(layout.levels, edges), 0);
  // Chains are straight once untangled.
  const map = byId(layout);
  assertEquals(map.get("a1")!.y, map.get("b3")!.y);
  assertEquals(map.get("b3")!.y, map.get("c1")!.y);
});

Deno.test("layoutGraph: long edges route around cards, never through them", () => {
  const layout = layoutGraph(
    nodes("a", "b", "c", "d"),
    [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "d")],
    opts,
  );
  const long = layout.edges.find((e) => e.from === "a" && e.to === "d")!;
  // Source side, two columns crossed (in and out of each), target side.
  assertEquals(long.points.length, 6);
  const map = byId(layout);
  for (const id of ["b", "c"]) {
    const card = map.get(id)!;
    for (const p of long.points.slice(1, -1)) {
      if (p.x < card.x || p.x > card.x + opts.nodeWidth) continue;
      assert(
        p.y <= card.y || p.y >= card.y + opts.nodeHeight,
        `edge passes through ${id}`,
      );
    }
  }
});

Deno.test("layoutGraph: survives cycles, self-loops, duplicates and unknown jobs", () => {
  const layout = layoutGraph(
    nodes("a", "b", "c", "a"),
    [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
      edge("b", "b"),
      edge("a", "b"),
      edge("a", "ghost"),
      edge("ghost", "c"),
    ],
    opts,
  );
  assertEquals(layout.nodes.map((n) => n.id), ["a", "b", "c"]);
  assertEquals(layout.edges.length, 3);
  const back = layout.edges.filter((e) => e.reversed);
  assertEquals(back.map((e) => [e.from, e.to]), [["c", "a"]]);
  assertEquals(layout.nodes.every((n) => Number.isFinite(n.y)), true);
  assertNoOverlap(layout, opts.nodeHeight);
});

Deno.test("layoutGraph: a two-node cycle still lays out", () => {
  const layout = layoutGraph(
    nodes("x", "y"),
    [edge("x", "y"), edge("y", "x")],
    opts,
  );
  assertEquals(layout.levels, [["x"], ["y"]]);
  assertEquals(layout.edges.filter((e) => e.reversed).length, 1);
});

Deno.test("layoutGraph: disconnected components stay apart, in input order", () => {
  const layout = layoutGraph(
    nodes("a1", "b1", "lonely", "a2", "b2"),
    [edge("a1", "a2"), edge("b1", "b2")],
    opts,
  );
  assertEquals(layout.levels[0], ["a1", "b1", "lonely"]);
  assertEquals(layout.levels[1], ["a2", "b2"]);
  const map = byId(layout);
  assertEquals(map.get("a1")!.y, map.get("a2")!.y);
  assertEquals(map.get("b1")!.y, map.get("b2")!.y);
  assertNoOverlap(layout, opts.nodeHeight);
});

Deno.test("layoutGraph: dozens of jobs never overlap and edges avoid cards", () => {
  // A deterministic pseudo-random DAG: 60 jobs, edges only forward.
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const ids = Array.from({ length: 60 }, (_, i) => `job-${i}`);
  const edges: LayoutEdgeInput[] = [];
  for (let i = 1; i < ids.length; i++) {
    const count = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < count; k++) {
      edges.push(edge(ids[Math.floor(rand() * i)], ids[i]));
    }
  }
  const layout = layoutGraph(nodes(...ids), edges, DEFAULT_LAYOUT);
  assertEquals(layout.nodes.length, 60);
  assertNoOverlap(layout, DEFAULT_LAYOUT.nodeHeight);
  const cards = layout.nodes;
  for (const e of layout.edges) {
    for (const p of e.points.slice(1, -1)) {
      for (const card of cards) {
        const insideX = p.x >= card.x &&
          p.x <= card.x + DEFAULT_LAYOUT.nodeWidth;
        const insideY = p.y > card.y &&
          p.y < card.y + DEFAULT_LAYOUT.nodeHeight;
        assert(!(insideX && insideY), `${e.from}→${e.to} crosses ${card.id}`);
      }
    }
  }
  assert(layout.height > 0 && layout.width > 0);
});

Deno.test("edgePath: draws S-curves between rows and lines along them", () => {
  assertEquals(edgePath([]), "");
  assertEquals(
    edgePath([{ x: 0, y: 0 }, { x: 100, y: 0 }]),
    "M0 0 L100 0",
  );
  assertEquals(
    edgePath([{ x: 0, y: 0 }, { x: 100, y: 50 }]),
    "M0 0 C50 0 50 50 100 50",
  );
});

Deno.test("relatives: walks everything upstream and downstream", () => {
  const edges = [
    edge("a", "b"),
    edge("b", "c"),
    edge("x", "c"),
    edge("c", "d"),
    edge("z", "z2"),
  ];
  const { upstream, downstream } = relatives("c", edges);
  assertEquals([...upstream].sort(), ["a", "b", "x"]);
  assertEquals([...downstream], ["d"]);
  assertEquals(relatives("z2", edges).upstream, new Set(["z"]));
});

Deno.test("relatives: terminates on a cycle", () => {
  const { upstream, downstream } = relatives("a", [
    edge("a", "b"),
    edge("b", "a"),
  ]);
  assertEquals([...upstream], ["b"]);
  assertEquals([...downstream], ["b"]);
});

Deno.test("neighborInDirection: arrows move within and across columns", () => {
  const edges = [edge("a", "c"), edge("b", "d"), edge("b", "e")];
  const layout = layoutGraph(nodes("a", "b", "c", "d", "e"), edges, opts);
  assertEquals(neighborInDirection(layout, "a", "down"), "b");
  assertEquals(neighborInDirection(layout, "b", "up"), "a");
  assertEquals(neighborInDirection(layout, "a", "up"), null);
  assertEquals(neighborInDirection(layout, "a", "right"), "c");
  // Prefers a connected job, the nearest one in height.
  const right = neighborInDirection(layout, "b", "right");
  assert(right === "d" || right === "e");
  assertEquals(neighborInDirection(layout, "e", "left"), "b");
  assertEquals(neighborInDirection(layout, "c", "right"), null);
  assertEquals(neighborInDirection(layout, "missing", "right"), null);
});
