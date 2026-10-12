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

import type { RouteState } from "../routes.ts";

// Geometry for the model diagram: a model's inputs on the left, the model
// (inside its extension's frame) in the centre, and its outputs and
// reports on the right. Narrow screens get a vertical variant: inputs
// above the model, outputs and reports below it, joined by a spine. This
// module is pure — it places boxes and draws connector paths; the
// component only paints what it returns.

export type DiagramNodeKind =
  | "argument"
  | "method"
  | "resource"
  | "file"
  | "data"
  | "report"
  | "placeholder";

export interface DiagramNode {
  id: string;
  label: string;
  /** Second line: type, kind, argument names. */
  detail?: string;
  kind: DiagramNodeKind;
  /** Where the box links; null for boxes with no page. */
  to: RouteState | null;
  /** Longer text for the tooltip (a description). */
  description?: string;
}

export type DiagramGroupKey = "arguments" | "methods" | "outputs" | "reports";

export interface DiagramGroup {
  key: DiagramGroupKey;
  title: string;
  /** Inputs flow into the model; outputs flow out of it. */
  side: "in" | "out";
  nodes: DiagramNode[];
}

export interface DiagramExtension {
  name: string;
  version?: string;
  /** True when derived from the type's scope rather than reported by serve. */
  inferred: boolean;
}

export interface DiagramModel {
  name: string;
  type: string;
  version?: number;
  /** A staleness label when the definition is not current ("upgradable"). */
  stale?: string;
  /** Footer line under the name ("2 methods"). */
  summary?: string;
}

export interface DiagramSpec {
  model: DiagramModel;
  groups: DiagramGroup[];
  extension: DiagramExtension | null;
}

export type DiagramOrientation = "horizontal" | "vertical";

export interface LayoutOptions {
  orientation: DiagramOrientation;
  /** Boxes a group shows before collapsing the rest into "+N more". */
  maxPerGroup?: number;
  /** Groups the viewer expanded to show every box. */
  expanded?: ReadonlySet<DiagramGroupKey>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedBox extends Rect {
  node: DiagramNode;
  group: DiagramGroupKey;
  side: "in" | "out";
  /** Label and detail cut to fit the box; the full text goes in a title. */
  label: string;
  detail: string;
  truncated: boolean;
}

export interface PlacedToggle extends Rect {
  group: DiagramGroupKey;
  /** Boxes hidden while collapsed (0 when expanded). */
  hidden: number;
  expanded: boolean;
  label: string;
}

export interface PlacedHeading {
  x: number;
  y: number;
  group: DiagramGroupKey;
  text: string;
  count: number;
}

export interface PlacedEdge {
  id: string;
  d: string;
  group: DiagramGroupKey;
  side: "in" | "out";
  /** Faint edge to a placeholder box. */
  muted: boolean;
}

export interface PlacedModel extends Rect {
  name: string;
  type: string;
  nameTruncated: boolean;
}

export interface PlacedFrame extends Rect {
  label: string;
  /** Where the label's baseline sits. */
  labelX: number;
  labelY: number;
}

export interface DiagramLayout {
  orientation: DiagramOrientation;
  width: number;
  height: number;
  model: PlacedModel;
  frame: PlacedFrame | null;
  headings: PlacedHeading[];
  boxes: PlacedBox[];
  toggles: PlacedToggle[];
  edges: PlacedEdge[];
}

// Geometry, in SVG user units (1:1 with CSS px at natural size).
export const PAD = 16;
export const BOX_H = 44;
export const BOX_GAP = 8;
export const HEAD_H = 26;
export const GROUP_GAP = 18;
export const TOGGLE_H = 30;
const COL_W = 224;
const GAP = 92;
const MODEL_W = 256;
const MODEL_H = 108;
const FRAME_PAD = 12;
const FRAME_TAB = 26;
const V_WIDTH = 344;
const V_SPINE_INSET = 10;
const V_BOX_INSET = 30;
const V_SECTION_GAP = 28;
const BOX_TEXT_INSET = 44; // glyph column + right padding
const LABEL_CHAR_W = 7.3; // 12px JetBrains Mono
const DETAIL_CHAR_W = 6.2; // 10.5px JetBrains Mono
const NAME_CHAR_W = 9.2; // 16px semibold sans, a generous average
const TYPE_CHAR_W = 6.6; // 11px mono
export const DEFAULT_MAX_PER_GROUP = 6;

/** Characters of `charWidth` that fit in `width` px. */
export function charsThatFit(width: number, charWidth: number): number {
  return Math.max(1, Math.floor(width / charWidth));
}

/** Cuts `text` to `max` characters with a trailing ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

/**
 * The boxes a group shows and how many are folded away. A group over the
 * cap shows `max - 1` boxes plus the toggle, so a collapsed group never
 * takes more room than `max` boxes; one that only exceeds it by one shows
 * everything, since "+1 more" would save nothing.
 */
export function visibleNodes(
  nodes: readonly DiagramNode[],
  max: number,
  expanded: boolean,
): { shown: DiagramNode[]; hidden: number; collapsible: boolean } {
  const collapsible = nodes.length > max;
  if (!collapsible || expanded) {
    return { shown: [...nodes], hidden: 0, collapsible };
  }
  const keep = Math.max(1, max - 1);
  return {
    shown: nodes.slice(0, keep),
    hidden: nodes.length - keep,
    collapsible,
  };
}

/** The extension frame's caption. */
export function frameLabel(ext: DiagramExtension): string {
  if (ext.inferred) return `${ext.name} · inferred`;
  return ext.version ? `${ext.name} · v${ext.version}` : ext.name;
}

interface GroupBlock {
  group: DiagramGroup;
  shown: DiagramNode[];
  hidden: number;
  collapsible: boolean;
  expanded: boolean;
  height: number;
}

function blockOf(
  group: DiagramGroup,
  max: number,
  expanded: ReadonlySet<DiagramGroupKey>,
): GroupBlock {
  const isExpanded = expanded.has(group.key);
  const v = visibleNodes(group.nodes, max, isExpanded);
  const rows = v.shown.length;
  let height = HEAD_H + rows * BOX_H + Math.max(0, rows - 1) * BOX_GAP;
  if (v.collapsible) height += BOX_GAP + TOGGLE_H;
  return { group, ...v, expanded: isExpanded, height };
}

function stackHeight(blocks: readonly GroupBlock[]): number {
  if (blocks.length === 0) return 0;
  return blocks.reduce((sum, b) => sum + b.height, 0) +
    (blocks.length - 1) * GROUP_GAP;
}

function placeBox(
  node: DiagramNode,
  group: DiagramGroup,
  rect: Rect,
): PlacedBox {
  const textW = rect.w - BOX_TEXT_INSET;
  const label = truncate(node.label, charsThatFit(textW, LABEL_CHAR_W));
  const detailText = node.detail ?? "";
  const detail = truncate(detailText, charsThatFit(textW, DETAIL_CHAR_W));
  return {
    ...rect,
    node,
    group: group.key,
    side: group.side,
    label,
    detail,
    truncated: label !== node.label || detail !== detailText,
  };
}

function toggleLabel(block: GroupBlock): string {
  return block.expanded ? "Show fewer" : `+${block.hidden} more`;
}

/**
 * Places one stack of groups at (x, y) with boxes `w` wide; headings sit
 * at `headX`. Returns the boxes, toggles and headings it placed.
 */
function placeStack(
  blocks: readonly GroupBlock[],
  x: number,
  y: number,
  w: number,
  out: Pick<DiagramLayout, "boxes" | "toggles" | "headings">,
): void {
  let cy = y;
  blocks.forEach((b, bi) => {
    if (bi > 0) cy += GROUP_GAP;
    out.headings.push({
      x,
      y: cy + HEAD_H - 10,
      group: b.group.key,
      text: b.group.title,
      count: b.group.nodes.filter((n) => n.kind !== "placeholder").length,
    });
    cy += HEAD_H;
    b.shown.forEach((node, i) => {
      if (i > 0) cy += BOX_GAP;
      out.boxes.push(placeBox(node, b.group, { x, y: cy, w, h: BOX_H }));
      cy += BOX_H;
    });
    if (b.collapsible) {
      cy += BOX_GAP;
      out.toggles.push({
        x,
        y: cy,
        w,
        h: TOGGLE_H,
        group: b.group.key,
        hidden: b.hidden,
        expanded: b.expanded,
        label: toggleLabel(b),
      });
      cy += TOGGLE_H;
    }
  });
}

const r = (n: number) => Math.round(n * 10) / 10;

/** A horizontal S-curve from (x1, y1) to (x2, y2). */
export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M${r(x1)} ${r(y1)} C${r(x1 + dx)} ${r(y1)} ${r(x2 - dx)} ${r(y2)} ${
    r(x2)
  } ${r(y2)}`;
}

/**
 * Where the i-th of n edges meets the model's side: spread over the middle
 * of the edge so a fan of connectors stays readable at the model.
 */
export function anchorY(model: Rect, i: number, n: number): number {
  const mid = model.y + model.h / 2;
  if (n <= 1) return mid;
  const span = Math.min(model.h * 0.6, (n - 1) * 10);
  return mid - span / 2 + (span * i) / (n - 1);
}

function placeModel(spec: DiagramSpec, rect: Rect): PlacedModel {
  const name = truncate(
    spec.model.name,
    charsThatFit(rect.w - 36, NAME_CHAR_W),
  );
  const type = truncate(
    spec.model.type,
    charsThatFit(rect.w - 36, TYPE_CHAR_W),
  );
  return {
    ...rect,
    name,
    type,
    nameTruncated: name !== spec.model.name || type !== spec.model.type,
  };
}

function placeFrame(ext: DiagramExtension, model: Rect): PlacedFrame {
  const x = model.x - FRAME_PAD;
  const y = model.y - FRAME_PAD - FRAME_TAB;
  const w = model.w + FRAME_PAD * 2;
  const label = truncate(frameLabel(ext), charsThatFit(w - 36, TYPE_CHAR_W));
  return {
    x,
    y,
    w,
    h: model.h + FRAME_PAD * 2 + FRAME_TAB,
    label,
    labelX: x + 30,
    labelY: y + 18,
  };
}

function modelBlockHeight(hasFrame: boolean): number {
  return MODEL_H + (hasFrame ? FRAME_PAD * 2 + FRAME_TAB : 0);
}

function layoutHorizontal(
  spec: DiagramSpec,
  max: number,
  expanded: ReadonlySet<DiagramGroupKey>,
): DiagramLayout {
  const ins = spec.groups.filter((g) => g.side === "in").map((g) =>
    blockOf(g, max, expanded)
  );
  const outs = spec.groups.filter((g) => g.side === "out").map((g) =>
    blockOf(g, max, expanded)
  );
  const hasFrame = spec.extension !== null;
  const inH = stackHeight(ins);
  const outH = stackHeight(outs);
  const modelH = modelBlockHeight(hasFrame);
  const inner = Math.max(inH, outH, modelH);
  const height = inner + PAD * 2;

  const leftX = PAD;
  const modelX = PAD + COL_W + GAP;
  const rightX = modelX + MODEL_W + GAP;
  const width = rightX + COL_W + PAD;

  const blockTop = PAD + (inner - modelH) / 2;
  const modelRect: Rect = {
    x: modelX,
    y: blockTop + (hasFrame ? FRAME_PAD + FRAME_TAB : 0),
    w: MODEL_W,
    h: MODEL_H,
  };

  const layout: DiagramLayout = {
    orientation: "horizontal",
    width,
    height,
    model: placeModel(spec, modelRect),
    frame: spec.extension ? placeFrame(spec.extension, modelRect) : null,
    headings: [],
    boxes: [],
    toggles: [],
    edges: [],
  };
  placeStack(ins, leftX, PAD + (inner - inH) / 2, COL_W, layout);
  placeStack(outs, rightX, PAD + (inner - outH) / 2, COL_W, layout);

  const inBoxes = layout.boxes.filter((b) => b.side === "in");
  const outBoxes = layout.boxes.filter((b) => b.side === "out");
  inBoxes.forEach((b, i) => {
    layout.edges.push({
      id: `in:${b.group}:${b.node.id}`,
      d: curve(
        b.x + b.w,
        b.y + b.h / 2,
        modelRect.x,
        anchorY(modelRect, i, inBoxes.length),
      ),
      group: b.group,
      side: "in",
      muted: b.node.kind === "placeholder",
    });
  });
  outBoxes.forEach((b, i) => {
    layout.edges.push({
      id: `out:${b.group}:${b.node.id}`,
      d: curve(
        modelRect.x + modelRect.w,
        anchorY(modelRect, i, outBoxes.length),
        b.x,
        b.y + b.h / 2,
      ),
      group: b.group,
      side: "out",
      muted: b.node.kind === "placeholder",
    });
  });
  return layout;
}

function layoutVertical(
  spec: DiagramSpec,
  max: number,
  expanded: ReadonlySet<DiagramGroupKey>,
): DiagramLayout {
  const ins = spec.groups.filter((g) => g.side === "in").map((g) =>
    blockOf(g, max, expanded)
  );
  const outs = spec.groups.filter((g) => g.side === "out").map((g) =>
    blockOf(g, max, expanded)
  );
  const hasFrame = spec.extension !== null;
  const width = V_WIDTH;
  const spineX = PAD + V_SPINE_INSET;
  const boxX = PAD + V_BOX_INSET;
  const boxW = width - boxX - PAD;

  const layout: DiagramLayout = {
    orientation: "vertical",
    width,
    height: 0,
    model: { x: 0, y: 0, w: 0, h: 0, name: "", type: "", nameTruncated: false },
    frame: null,
    headings: [],
    boxes: [],
    toggles: [],
    edges: [],
  };

  let y = PAD;
  placeStack(ins, boxX, y, boxW, layout);
  y += stackHeight(ins);
  if (ins.length > 0) y += V_SECTION_GAP;

  const modelW = width - PAD * 2 - (hasFrame ? FRAME_PAD * 2 : 0);
  const modelRect: Rect = {
    x: PAD + (hasFrame ? FRAME_PAD : 0),
    y: y + (hasFrame ? FRAME_PAD + FRAME_TAB : 0),
    w: modelW,
    h: MODEL_H,
  };
  layout.model = placeModel(spec, modelRect);
  layout.frame = spec.extension ? placeFrame(spec.extension, modelRect) : null;
  y += modelBlockHeight(hasFrame);

  if (outs.length > 0) y += V_SECTION_GAP;
  const outTop = y;
  placeStack(outs, boxX, outTop, boxW, layout);
  y += stackHeight(outs);
  layout.height = y + PAD;

  // Rounded elbows from each box onto a spine that runs into the model
  // (or its extension frame, so the spine never crosses the frame caption).
  const k = 8;
  const block: Rect = layout.frame ?? modelRect;
  const top = r(block.y);
  const bottom = r(block.y + block.h);
  for (const b of layout.boxes) {
    const cy = r(b.y + b.h / 2);
    const d = b.side === "in"
      ? `M${b.x} ${cy} L${spineX + k} ${cy} Q${spineX} ${cy} ${spineX} ${
        cy + k
      } L${spineX} ${top}`
      : `M${spineX} ${bottom} L${spineX} ${cy - k} Q${spineX} ${cy} ${
        spineX + k
      } ${cy} L${b.x} ${cy}`;
    layout.edges.push({
      id: `${b.side}:${b.group}:${b.node.id}`,
      d,
      group: b.group,
      side: b.side,
      muted: b.node.kind === "placeholder",
    });
  }
  return layout;
}

/** Lays out `spec` for the given orientation. */
export function layoutDiagram(
  spec: DiagramSpec,
  options: LayoutOptions,
): DiagramLayout {
  const max = Math.max(2, options.maxPerGroup ?? DEFAULT_MAX_PER_GROUP);
  const expanded = options.expanded ?? new Set<DiagramGroupKey>();
  return options.orientation === "horizontal"
    ? layoutHorizontal(spec, max, expanded)
    : layoutVertical(spec, max, expanded);
}
