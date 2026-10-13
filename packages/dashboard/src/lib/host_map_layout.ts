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

/**
 * Pure geometry for the fleet host map: a squarified treemap of groups
 * weighted by their workers' slot area, worker squares sized by area to
 * capacity, each worker's slot grid, and the bounds a worker is held to
 * inside its group card.
 */

import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

/** Card header height: group name, counts and the status-mix bar. */
export const HEADER = 46;
/** Inset between a card's edge and the workers inside it. */
export const PAD = 12;
/** Space between group cards. */
export const GUTTER = 14;
/** Breathing room between neighbouring workers. */
export const GAP = 4;

const BASE_SIZE = 15;
const AREA_FACTOR = 3.6;
const GROUP_MINIMUM = 16_000;
const MIN_HEIGHT = 380;
const MAX_HEIGHT = 1400;

/** Side length of a worker square; its area grows linearly with capacity. */
export function nodeSize(capacity: number): number {
  return Math.round(BASE_SIZE * Math.sqrt(Math.max(1, capacity)));
}

export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Columns of slot cells: two up to 8 slots (2×1 … 2×4), then a near-square grid. */
export function slotColumns(capacity: number): number {
  if (capacity <= 1) return 1;
  if (capacity <= 8) return 2;
  return Math.ceil(Math.sqrt(capacity));
}

/** Slot cells inside a worker square centred on the origin. */
export function slotGrid(capacity: number, size: number): SlotRect[] {
  const count = Math.max(1, capacity);
  const cols = slotColumns(count);
  const rows = Math.ceil(count / cols);
  const inner = size - 6;
  const gap = 1.5;
  const w = (inner - (cols - 1) * gap) / cols;
  const h = (inner - (rows - 1) * gap) / rows;
  const cells: SlotRect[] = [];
  for (let i = 0; i < count; i++) {
    cells.push({
      x: -inner / 2 + (i % cols) * (w + gap),
      y: -inner / 2 + Math.floor(i / cols) * (h + gap),
      w,
      h,
    });
  }
  return cells;
}

export interface GroupInput {
  key: string;
  /** Capacity of each worker in the group. */
  capacities: readonly number[];
}

export interface CellBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface GroupCell {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the group's workers settle. */
  cx: number;
  cy: number;
  /** Radius workers are first placed within. */
  r: number;
}

export interface HostMapLayout {
  cells: GroupCell[];
  height: number;
}

/** The slot area a group's workers occupy, the treemap's weight. */
export function groupArea(capacities: readonly number[]): number {
  let area = 0;
  for (const capacity of capacities) {
    const side = nodeSize(capacity) + GAP;
    area += side * side;
  }
  return area;
}

/**
 * Lays the groups out as a squarified treemap `width` wide. Each group's
 * area is proportional to its workers' area plus a fixed minimum, so small
 * groups stay readable; the canvas grows taller with total capacity.
 */
export function layoutGroups(
  groups: readonly GroupInput[],
  width: number,
): HostMapLayout {
  if (groups.length === 0 || width <= 0) {
    return { cells: [], height: MIN_HEIGHT };
  }
  const leaves = groups.map((g) => ({
    key: g.key,
    value: groupArea(g.capacities) * AREA_FACTOR + GROUP_MINIMUM,
  }));
  let total = 0;
  for (const leaf of leaves) total += leaf.value;
  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Math.round(total / width)),
  );
  const root = hierarchy<
    { key?: string; value?: number; children?: unknown[] }
  >(
    { children: leaves },
  )
    .sum((d) => d.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  treemap<{ key?: string; value?: number; children?: unknown[] }>()
    .size([width, height])
    .paddingInner(GUTTER)
    .round(true)
    .tile(treemapSquarify.ratio(1))(root);
  const cells: GroupCell[] = [];
  for (const leaf of root.leaves()) {
    const node = leaf as unknown as {
      data: { key: string };
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    };
    const w = node.x1 - node.x0;
    const h = node.y1 - node.y0;
    cells.push({
      key: node.data.key,
      x: node.x0,
      y: node.y0,
      w,
      h,
      cx: node.x0 + w / 2,
      cy: node.y0 + HEADER + 6 + (h - HEADER - 18) / 2,
      r: Math.max(10, Math.min(w - 2 * PAD, h - HEADER - PAD) / 2),
    });
  }
  return { cells, height };
}

/**
 * Where a worker's centre may sit inside its card: below the header and
 * inset by the worker's own half-size, so no square crosses an edge.
 * Collapses to the centre line when the card is too small.
 */
export function clampBounds(cell: GroupCell, size: number): CellBounds {
  const half = size / 2 + GAP;
  let minX = cell.x + PAD + half;
  let maxX = cell.x + cell.w - PAD - half;
  let minY = cell.y + HEADER + 6 + half;
  let maxY = cell.y + cell.h - PAD - half;
  if (maxX < minX) minX = maxX = cell.x + cell.w / 2;
  if (maxY < minY) minY = maxY = cell.y + HEADER + (cell.h - HEADER) / 2;
  return { minX, maxX, minY, maxY };
}
