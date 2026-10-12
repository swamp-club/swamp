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

import { maxOf } from "./array_extrema.ts";

// Layered layout for small DAGs (a workflow's jobs, a job's steps): nodes
// flow left to right in columns by dependency depth. Pure, so it is unit
// tested and reusable outside React.

/** A node to draw. `status` picks its tone (a run status, or "waiting"). */
export interface MiniDagNode {
  id: string;
  label: string;
  status?: string;
  /** Hover text; defaults to the label. */
  title?: string;
}

/** `from` must finish before `to` starts. */
export interface MiniDagEdge {
  from: string;
  to: string;
}

export interface DagLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal space between columns, where edges run. */
  columnGap?: number;
  /** Vertical space between nodes in a column. */
  rowGap?: number;
}

export interface PlacedNode extends MiniDagNode {
  /** Column: 0 for nodes with no dependencies, else one past the deepest. */
  level: number;
  /** Position within the column, top to bottom. */
  row: number;
  x: number;
  y: number;
}

export interface PlacedEdge extends MiniDagEdge {
  /** SVG path data from the right of `from` to the left of `to`. */
  path: string;
}

export interface DagLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  /** Number of columns. */
  levels: number;
}

export const DAG_DEFAULTS: Required<DagLayoutOptions> = {
  nodeWidth: 148,
  nodeHeight: 30,
  columnGap: 36,
  rowGap: 10,
};

/**
 * Each node's column: the length of the longest dependency chain leading
 * to it. Edges naming unknown nodes and self-loops are ignored; nodes
 * caught in a cycle are placed after their already-placed predecessors.
 */
export function dagLevels(
  nodes: readonly MiniDagNode[],
  edges: readonly MiniDagEdge[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
    indegree.set(n.id, 0);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }

  const level = new Map<string, number>();
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const remaining = new Map(indegree);
  const settle = (id: string) => {
    let l = 0;
    for (const p of preds.get(id)!) {
      const pl = level.get(p);
      if (pl !== undefined && pl + 1 > l) l = pl + 1;
    }
    level.set(id, l);
  };
  const drain = () => {
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (level.has(id)) continue;
      settle(id);
      for (const s of succs.get(id)!) {
        remaining.set(s, remaining.get(s)! - 1);
        if (remaining.get(s) === 0) queue.push(s);
      }
    }
  };
  drain();
  // Whatever is left sits on a cycle: break it at the first such node in
  // input order and carry on.
  for (const n of nodes) {
    if (level.has(n.id)) continue;
    queue.push(n.id);
    drain();
  }
  return level;
}

/** Places nodes in columns and routes an edge for every dependency. */
export function layoutDag(
  nodes: readonly MiniDagNode[],
  edges: readonly MiniDagEdge[],
  options: DagLayoutOptions = {},
): DagLayout {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = {
    ...DAG_DEFAULTS,
    ...options,
  };
  const levels = dagLevels(nodes, edges);
  const columnCount = nodes.length === 0
    ? 0
    : (maxOf(levels.values()) ?? -1) + 1;

  const inputIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const predsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!levels.has(e.from) || !levels.has(e.to)) continue;
    const list = predsOf.get(e.to) ?? [];
    list.push(e.from);
    predsOf.set(e.to, list);
  }

  // Column by column; a node sits near the average row of what it depends
  // on (one barycenter pass), which keeps most edges short and uncrossed.
  const rowOf = new Map<string, number>();
  const columns: MiniDagNode[][] = Array.from(
    { length: columnCount },
    () => [],
  );
  for (const n of nodes) columns[levels.get(n.id)!].push(n);
  for (const column of columns) {
    const weight = (n: MiniDagNode) => {
      const rows = (predsOf.get(n.id) ?? [])
        .filter((p) => rowOf.has(p))
        .map((p) => rowOf.get(p)!);
      return rows.length === 0
        ? Number.POSITIVE_INFINITY
        : rows.reduce((a, b) => a + b, 0) / rows.length;
    };
    const weights = new Map(column.map((n) => [n.id, weight(n)]));
    column.sort((a, b) => {
      const wa = weights.get(a.id)!;
      const wb = weights.get(b.id)!;
      if (wa !== wb) {
        if (wa === Number.POSITIVE_INFINITY) return 1;
        if (wb === Number.POSITIVE_INFINITY) return -1;
        return wa - wb;
      }
      return inputIndex.get(a.id)! - inputIndex.get(b.id)!;
    });
    column.forEach((n, i) => rowOf.set(n.id, i));
  }

  const tallest = maxOf(columns.map((c) => c.length)) ?? 0;
  const height = tallest === 0
    ? 0
    : tallest * nodeHeight + (tallest - 1) * rowGap;
  const width = columnCount === 0
    ? 0
    : columnCount * nodeWidth + (columnCount - 1) * columnGap;

  const placed = new Map<string, PlacedNode>();
  columns.forEach((column, level) => {
    const columnHeight = column.length * nodeHeight +
      (column.length - 1) * rowGap;
    const top = (height - columnHeight) / 2;
    column.forEach((n, row) => {
      placed.set(n.id, {
        ...n,
        level,
        row,
        x: level * (nodeWidth + columnGap),
        y: top + row * (nodeHeight + rowGap),
      });
    });
  });

  const placedEdges: PlacedEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b || a === b) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x1 = a.x + nodeWidth;
    const y1 = a.y + nodeHeight / 2;
    const x2 = b.x;
    const y2 = b.y + nodeHeight / 2;
    const mid = (x1 + x2) / 2;
    placedEdges.push({
      from: e.from,
      to: e.to,
      path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
    });
  }

  return {
    nodes: nodes.map((n) => placed.get(n.id)!),
    edges: placedEdges,
    width,
    height,
    nodeWidth,
    nodeHeight,
    levels: columnCount,
  };
}
