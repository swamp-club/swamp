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

import { maxOf } from "../lib/array_extrema.ts";

// layered left-to-right layout, pure and deterministic, so a live run that only
// changes statuses never moves a card

export interface LayoutNodeInput {
  id: string;
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  /** Barycentre sweeps (down + up) to run; more rarely helps past 8. */
  sweeps?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PositionedNode {
  id: string;
  level: number;
  order: number;
  x: number;
  y: number;
}

export interface RoutedEdge {
  from: string;
  to: string;
  points: Point[];
  /**
   * the edge closes a cycle: invalid for a workflow, but drawn rather than
   * crashing, and routed in layer order (target to source)
   */
  reversed: boolean;
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: RoutedEdge[];
  levels: string[][];
  width: number;
  height: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 232,
  nodeHeight: 72,
  columnGap: 72,
  rowGap: 20,
  sweeps: 8,
};

interface Item {
  key: string;
  id: string | null;
  level: number;
  seed: [number, number, number];
  up: Item[];
  down: Item[];
  y: number;
}

/** Lays out a directed graph. Unknown endpoints and self-loops are ignored. */
export function layoutGraph(
  nodeInputs: readonly LayoutNodeInput[],
  edgeInputs: readonly LayoutEdgeInput[],
  options: LayoutOptions = DEFAULT_LAYOUT,
): GraphLayout {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = options;
  const sweeps = options.sweeps ?? 8;

  const ids: string[] = [];
  const index = new Map<string, number>();
  for (const n of nodeInputs) {
    if (index.has(n.id)) continue;
    index.set(n.id, ids.length);
    ids.push(n.id);
  }
  const edgeKeys = new Set<string>();
  const edges: LayoutEdgeInput[] = [];
  for (const e of edgeInputs) {
    if (!index.has(e.from) || !index.has(e.to) || e.from === e.to) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from: e.from, to: e.to });
  }

  const out: number[][] = ids.map(() => []);
  edges.forEach((e, i) => out[index.get(e.from)!].push(i));
  const reversed = new Set<number>();
  const state = new Uint8Array(ids.length);
  for (let root = 0; root < ids.length; root++) {
    if (state[root] !== 0) continue;
    // Iterative DFS so a long chain cannot overflow the stack.
    const stack: Array<[number, number]> = [[root, 0]];
    state[root] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [node, next] = frame;
      if (next >= out[node].length) {
        state[node] = 2;
        stack.pop();
        continue;
      }
      frame[1]++;
      const edgeIndex = out[node][next];
      const target = index.get(edges[edgeIndex].to)!;
      if (state[target] === 1) reversed.add(edgeIndex);
      else if (state[target] === 0) {
        state[target] = 1;
        stack.push([target, 0]);
      }
    }
  }
  const dag = edges.map((e, i) =>
    reversed.has(i)
      ? { from: index.get(e.to)!, to: index.get(e.from)! }
      : { from: index.get(e.from)!, to: index.get(e.to)! }
  );

  const level = new Array<number>(ids.length).fill(0);
  const indegree = new Array<number>(ids.length).fill(0);
  const succ: number[][] = ids.map(() => []);
  for (const e of dag) {
    indegree[e.to]++;
    succ[e.from].push(e.to);
  }
  const queue: number[] = [];
  for (let i = 0; i < ids.length; i++) if (indegree[i] === 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    for (const t of succ[n]) {
      level[t] = Math.max(level[t], level[n] + 1);
      if (--indegree[t] === 0) queue.push(t);
    }
  }

  const component = componentsOf(ids.length, dag);

  const items: Item[] = ids.map((id, i) => ({
    key: id,
    id,
    level: level[i],
    seed: [component[i], i, 0],
    up: [],
    down: [],
    y: 0,
  }));
  const chains: Item[][] = [];
  dag.forEach((e, edgeIndex) => {
    const chain: Item[] = [items[e.from]];
    for (let l = level[e.from] + 1; l < level[e.to]; l++) {
      const virtual: Item = {
        key: `\u0000${edgeIndex}:${l}`,
        id: null,
        level: l,
        seed: [component[e.from], e.from + 0.5, edgeIndex],
        up: [],
        down: [],
        y: 0,
      };
      items.push(virtual);
      chain.push(virtual);
    }
    chain.push(items[e.to]);
    for (let k = 0; k + 1 < chain.length; k++) {
      chain[k].down.push(chain[k + 1]);
      chain[k + 1].up.push(chain[k]);
    }
    chains.push(chain);
  });

  const levelCount = ids.length === 0 ? 0 : (maxOf(level) ?? -1) + 1;
  let layers: Item[][] = Array.from({ length: levelCount }, () => []);
  for (const item of items) layers[item.level].push(item);
  for (const layer of layers) layer.sort((a, b) => compareSeed(a.seed, b.seed));

  let best = layers.map((l) => [...l]);
  let bestCrossings = totalCrossings(best);
  for (let s = 0; s < sweeps && bestCrossings > 0; s++) {
    for (let l = 1; l < levelCount; l++) {
      layers[l] = reorder(layers[l], layers[l - 1], "up");
    }
    for (let l = levelCount - 2; l >= 0; l--) {
      layers[l] = reorder(layers[l], layers[l + 1], "down");
    }
    const crossings = totalCrossings(layers);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = layers.map((l) => [...l]);
    }
  }
  layers = best;

  const virtualGap = rowGap / 2;
  const size = (item: Item) => (item.id === null ? 0 : nodeHeight);
  const separation = (a: Item, b: Item) =>
    (size(a) + size(b)) / 2 +
    (a.id === null || b.id === null ? virtualGap : rowGap);
  const place = (layer: Item[], desired: number[]) => {
    const ys = placeInOrder(layer, desired, separation);
    layer.forEach((item, i) => (item.y = ys[i]));
  };
  const mean = (list: Item[]) =>
    list.reduce((sum, n) => sum + n.y, 0) / list.length;

  if (levelCount > 0) {
    place(layers[0], layers[0].map(() => 0));
  }
  const forward = (keepFirst: boolean) => {
    for (let l = keepFirst ? 1 : 0; l < levelCount; l++) {
      place(
        layers[l],
        layers[l].map((n) => (n.up.length > 0 ? mean(n.up) : n.y)),
      );
    }
  };
  forward(true);
  for (let l = levelCount - 2; l >= 0; l--) {
    place(
      layers[l],
      layers[l].map((n) =>
        n.up.length === 0 && n.down.length > 0 ? mean(n.down) : n.y
      ),
    );
  }
  forward(true);

  let top = Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    top = Math.min(top, item.y - size(item) / 2);
    bottom = Math.max(bottom, item.y + size(item) / 2);
  }
  if (!Number.isFinite(top)) {
    top = 0;
    bottom = 0;
  }
  const columnX = (l: number) => l * (nodeWidth + columnGap);
  const nodes: PositionedNode[] = [];
  const levels: string[][] = [];
  layers.forEach((layer, l) => {
    const real = layer.filter((n) => n.id !== null);
    levels.push(real.map((n) => n.id!));
    real.forEach((n, order) => {
      nodes.push({
        id: n.id!,
        level: l,
        order,
        x: columnX(l),
        y: round(n.y - nodeHeight / 2 - top),
      });
    });
  });
  nodes.sort((a, b) => index.get(a.id)! - index.get(b.id)!);

  const routed: RoutedEdge[] = edges.map((e, i) => {
    const chain = chains[i];
    const points: Point[] = [];
    chain.forEach((item, k) => {
      const x = columnX(item.level);
      const y = round(item.y - top);
      if (k === 0) points.push({ x: x + nodeWidth, y });
      else if (k === chain.length - 1) points.push({ x, y });
      else {
        points.push({ x, y }, { x: x + nodeWidth, y });
      }
    });
    return { from: e.from, to: e.to, points, reversed: reversed.has(i) };
  });

  return {
    nodes,
    edges: routed,
    levels,
    width: levelCount === 0 ? 0 : columnX(levelCount - 1) + nodeWidth,
    height: round(bottom - top),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function compareSeed(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function componentsOf(
  count: number,
  edges: ReadonlyArray<{ from: number; to: number }>,
): number[] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (n: number): number => {
    while (parent[n] !== n) {
      parent[n] = parent[parent[n]];
      n = parent[n];
    }
    return n;
  };
  for (const e of edges) {
    const a = find(e.from);
    const b = find(e.to);
    // Keep the earliest node as the root, so numbering follows input order.
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const numbering = new Map<number, number>();
  return Array.from({ length: count }, (_, i) => {
    const root = find(i);
    if (!numbering.has(root)) numbering.set(root, numbering.size);
    return numbering.get(root)!;
  });
}

function reorder(
  layer: Item[],
  fixed: Item[],
  side: "up" | "down",
): Item[] {
  const position = new Map(fixed.map((item, i) => [item, i]));
  const keyed = layer.map((item, i) => {
    const neighbours = item[side];
    const scale = fixed.length > 1
      ? (layer.length - 1) / (fixed.length - 1)
      : 1;
    const key = neighbours.length === 0
      ? i
      : (neighbours.reduce((sum, n) => sum + (position.get(n) ?? 0), 0) /
        neighbours.length) * scale;
    return { item, key, i };
  });
  keyed.sort((a, b) => a.key - b.key || a.i - b.i);
  return keyed.map((k) => k.item);
}

function totalCrossings(layers: Item[][]): number {
  let total = 0;
  for (let l = 0; l + 1 < layers.length; l++) {
    const next = new Map(layers[l + 1].map((item, i) => [item, i]));
    const pairs: Array<[number, number]> = [];
    layers[l].forEach((item, i) => {
      for (const d of item.down) {
        const j = next.get(d);
        if (j !== undefined) pairs.push([i, j]);
      }
    });
    total += countPairCrossings(pairs);
  }
  return total;
}

function countPairCrossings(pairs: ReadonlyArray<[number, number]>): number {
  let crossings = 0;
  for (let a = 0; a < pairs.length; a++) {
    for (let b = a + 1; b < pairs.length; b++) {
      const [a0, a1] = pairs[a];
      const [b0, b1] = pairs[b];
      if ((a0 - b0) * (a1 - b1) < 0) crossings++;
    }
  }
  return crossings;
}

export function countCrossings(
  levels: readonly (readonly string[])[],
  edges: readonly LayoutEdgeInput[],
): number {
  const where = new Map<string, [number, number]>();
  levels.forEach((ids, l) => ids.forEach((id, i) => where.set(id, [l, i])));
  let total = 0;
  for (let l = 0; l + 1 < levels.length; l++) {
    const pairs: Array<[number, number]> = [];
    for (const e of edges) {
      const a = where.get(e.from);
      const b = where.get(e.to);
      if (a && b && a[0] === l && b[0] === l + 1) pairs.push([a[1], b[1]]);
    }
    total += countPairCrossings(pairs);
  }
  return total;
}

/**
 * least-squares closest positions that keep `separation` between neighbours:
 * isotonic regression by pool-adjacent-violators on positions with the minimum
 * spacing taken out
 */
function placeInOrder(
  layer: Item[],
  desired: number[],
  separation: (a: Item, b: Item) => number,
): number[] {
  const offsets: number[] = [];
  let acc = 0;
  layer.forEach((item, i) => {
    if (i > 0) acc += separation(layer[i - 1], item);
    offsets.push(acc);
  });
  const blocks: Array<{ sum: number; count: number }> = [];
  for (let i = 0; i < layer.length; i++) {
    blocks.push({ sum: desired[i] - offsets[i], count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.count <= last.sum / last.count) break;
      prev.sum += last.sum;
      prev.count += last.count;
      blocks.pop();
    }
  }
  const result: number[] = [];
  for (const block of blocks) {
    const value = block.sum / block.count;
    for (let k = 0; k < block.count; k++) {
      result.push(value + offsets[result.length]);
    }
  }
  return result;
}

export function edgePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const f = (n: number) => String(round(n));
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p.y === q.y) {
      d += ` L${f(q.x)} ${f(q.y)}`;
      continue;
    }
    const mid = (q.x - p.x) / 2;
    d += ` C${f(p.x + mid)} ${f(p.y)} ${f(q.x - mid)} ${f(q.y)} ${f(q.x)} ${
      f(q.y)
    }`;
  }
  return d;
}

export function relatives(
  id: string,
  edges: readonly LayoutEdgeInput[],
): { upstream: Set<string>; downstream: Set<string> } {
  const walk = (start: string, dir: "up" | "down") => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of edges) {
        const [here, there] = dir === "up" ? [e.to, e.from] : [e.from, e.to];
        if (here === current && there !== start && !seen.has(there)) {
          seen.add(there);
          queue.push(there);
        }
      }
    }
    return seen;
  };
  return { upstream: walk(id, "up"), downstream: walk(id, "down") };
}

export type Direction = "left" | "right" | "up" | "down";

export function neighborInDirection(
  layout: GraphLayout,
  id: string,
  direction: Direction,
  edges: readonly LayoutEdgeInput[] = layout.edges,
): string | null {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) return null;
  const column = layout.levels[node.level] ?? [];
  if (direction === "up") return column[node.order - 1] ?? null;
  if (direction === "down") return column[node.order + 1] ?? null;
  const step = direction === "left" ? -1 : 1;
  for (
    let l = node.level + step;
    l >= 0 && l < layout.levels.length;
    l += step
  ) {
    const candidates = layout.levels[l];
    if (candidates.length === 0) continue;
    const connected = new Set(
      edges.flatMap((e) =>
        e.from === id ? [e.to] : e.to === id ? [e.from] : []
      ),
    );
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const pool = candidates.some((c) => connected.has(c))
      ? candidates.filter((c) => connected.has(c))
      : candidates;
    let bestId = pool[0];
    let bestDistance = Infinity;
    for (const c of pool) {
      const distance = Math.abs(byId.get(c)!.y - node.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = c;
      }
    }
    return bestId;
  }
  return null;
}
