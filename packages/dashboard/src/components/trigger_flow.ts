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

// Layout for the trigger → inputs → workflow → jobs diagram. Columns run
// left to right; jobs are layered by their dependencies (a job sits one
// column right of its latest dependency) and each column is centred on
// the tallest one.

export interface FlowJob {
  name: string;
  dependsOn: string[];
  stepCount: number;
}

export interface FlowSpec {
  trigger: {
    kind: "schedule" | "webhook";
    title: string;
    lines: string[];
    /** A paused schedule draws muted with a dashed edge. */
    paused?: boolean;
  };
  /** Input lines ("region = eu"); null when the trigger passes none. */
  inputs: string[] | null;
  inputsTitle?: string;
  workflowName: string;
  jobs: FlowJob[];
}

/** A job as `workflow.get` returns it. */
export interface WorkflowJobDef {
  name: string;
  dependsOn?: unknown[];
  steps?: unknown[];
}

/**
 * Jobs for the diagram from a workflow definition. Dependencies are
 * objects (`{ job: "build", condition }`); bare strings are accepted too.
 */
export function flowJobsOf(
  jobs: readonly WorkflowJobDef[] | undefined,
): FlowJob[] {
  return (jobs ?? []).map((job) => ({
    name: job.name,
    dependsOn: (job.dependsOn ?? []).flatMap((d) => {
      if (typeof d === "string") return [d];
      if (d && typeof d === "object") {
        const ref = (d as Record<string, unknown>).job;
        if (typeof ref === "string") return [ref];
      }
      return [];
    }),
    stepCount: job.steps?.length ?? 0,
  }));
}

export type FlowNodeKind = "trigger" | "inputs" | "workflow" | "job";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  title: string;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  muted?: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  path: string;
  dashed?: boolean;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

export const NODE_W = 188;
const TITLE_H = 36;
const LINE_H = 16;
const PAD_B = 10;
const GAP_X = 52;
const GAP_Y = 14;
const MARGIN = 4;
/** Input lines shown before "+N more". */
export const MAX_INPUT_LINES = 4;

/**
 * Job names by column: a job with no dependencies is in column 0, any
 * other one column right of its deepest dependency. Unknown dependencies
 * are ignored and cycles are broken, so bad data still draws.
 */
export function jobLayers(jobs: readonly FlowJob[]): string[][] {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (name: string): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const job = byName.get(name);
    let d = 0;
    for (const dep of job?.dependsOn ?? []) {
      if (byName.has(dep) && dep !== name) d = Math.max(d, visit(dep) + 1);
    }
    visiting.delete(name);
    depth.set(name, d);
    return d;
  };
  const layers: string[][] = [];
  for (const job of jobs) {
    const d = visit(job.name);
    (layers[d] ??= []).push(job.name);
  }
  return layers.filter((l) => l !== undefined);
}

function nodeHeight(lines: number): number {
  return TITLE_H + Math.max(lines, 0) * LINE_H + (lines > 0 ? PAD_B : 0);
}

function edgePath(a: FlowNode, b: FlowNode): string {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max((x2 - x1) / 2, 16);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** Positions every node and edge of the flow. */
export function layoutFlow(spec: FlowSpec): FlowLayout {
  const columns: Array<Omit<FlowNode, "x" | "y">[]> = [];
  columns.push([{
    id: "trigger",
    kind: "trigger",
    title: spec.trigger.title,
    lines: spec.trigger.lines,
    w: NODE_W,
    h: nodeHeight(spec.trigger.lines.length),
    muted: spec.trigger.paused,
  }]);

  const inputLines = spec.inputs === null
    ? ["No inputs"]
    : spec.inputs.length === 0
    ? ["Workflow defaults"]
    : spec.inputs.length > MAX_INPUT_LINES
    ? [
      ...spec.inputs.slice(0, MAX_INPUT_LINES - 1),
      `+${spec.inputs.length - (MAX_INPUT_LINES - 1)} more`,
    ]
    : spec.inputs;
  columns.push([{
    id: "inputs",
    kind: "inputs",
    title: spec.inputsTitle ?? "Inputs",
    lines: inputLines,
    w: NODE_W,
    h: nodeHeight(inputLines.length),
  }]);

  const jobCount = spec.jobs.length;
  const workflowLines = [
    jobCount === 1 ? "1 job" : `${jobCount} jobs`,
  ];
  columns.push([{
    id: "workflow",
    kind: "workflow",
    title: spec.workflowName,
    lines: workflowLines,
    w: NODE_W,
    h: nodeHeight(workflowLines.length),
  }]);

  const jobsByName = new Map(spec.jobs.map((j) => [j.name, j]));
  for (const layer of jobLayers(spec.jobs)) {
    columns.push(layer.map((name) => {
      const steps = jobsByName.get(name)?.stepCount ?? 0;
      const lines = [steps === 1 ? "1 step" : `${steps} steps`];
      return {
        id: `job:${name}`,
        kind: "job" as const,
        title: name,
        lines,
        w: NODE_W,
        h: nodeHeight(lines.length),
      };
    }));
  }

  const colHeight = (col: Omit<FlowNode, "x" | "y">[]) =>
    col.reduce((sum, n) => sum + n.h, 0) + GAP_Y * (col.length - 1);
  const height = (maxOf(columns.map(colHeight)) ?? 0) + MARGIN * 2;
  const nodes: FlowNode[] = [];
  columns.forEach((col, ci) => {
    let y = MARGIN + (height - MARGIN * 2 - colHeight(col)) / 2;
    for (const n of col) {
      nodes.push({ ...n, x: MARGIN + ci * (NODE_W + GAP_X), y });
      y += n.h + GAP_Y;
    }
  });
  const width = MARGIN * 2 + columns.length * NODE_W +
    (columns.length - 1) * GAP_X;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  const link = (from: string, to: string, dashed?: boolean) => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (a && b) {
      edges.push({ from, to, path: edgePath(a, b), ...(dashed && { dashed }) });
    }
  };
  link("trigger", "inputs", spec.trigger.paused);
  link("inputs", "workflow");
  for (const job of spec.jobs) {
    // A dependency listed twice still draws one edge.
    const deps = [
      ...new Set(
        job.dependsOn.filter((d) => jobsByName.has(d) && d !== job.name),
      ),
    ];
    if (deps.length === 0) link("workflow", `job:${job.name}`);
    for (const dep of deps) link(`job:${dep}`, `job:${job.name}`);
  }
  return { nodes, edges, width, height };
}

/** Shortens text to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
