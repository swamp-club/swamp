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

// What an approval gate holds back: the job the gated step belongs to and
// every job downstream of it, as nodes and edges for a MiniDag.

import type { MiniDagEdge, MiniDagNode } from "./mini_dag_layout.ts";

/** A job as `workflow.get` returns it. */
export interface WorkflowJobDef {
  name: string;
  dependsOn?: ReadonlyArray<{ job?: string } | string>;
  steps?: ReadonlyArray<{ name: string }>;
}

export interface GateContext {
  /** The job holding the gated step; null when no job lists the step. */
  gateJob: string | null;
  /** Jobs that start as soon as the gate's job finishes. */
  next: string[];
  /** Every job that transitively waits on the gate's job. */
  downstream: string[];
  nodes: MiniDagNode[];
  edges: MiniDagEdge[];
  /** The gate's job and everything downstream of it. */
  highlight: string[];
}

function dependencyName(dep: { job?: string } | string): string | undefined {
  return typeof dep === "string" ? dep : dep.job;
}

/** Builds the job graph of a workflow around the gate at `stepName`. */
export function gateContext(
  jobs: readonly WorkflowJobDef[],
  stepName: string,
): GateContext {
  const edges: MiniDagEdge[] = [];
  const dependents = new Map<string, string[]>();
  for (const job of jobs) {
    for (const dep of job.dependsOn ?? []) {
      const from = dependencyName(dep);
      if (!from) continue;
      edges.push({ from, to: job.name });
      const list = dependents.get(from) ?? [];
      list.push(job.name);
      dependents.set(from, list);
    }
  }
  const gateJob =
    jobs.find((j) => (j.steps ?? []).some((s) => s.name === stepName))
      ?.name ?? null;

  const downstream: string[] = [];
  if (gateJob) {
    const seen = new Set<string>([gateJob]);
    const queue = [...(dependents.get(gateJob) ?? [])];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      downstream.push(name);
      for (const next of dependents.get(name) ?? []) queue.push(next);
    }
  }
  const waiting = new Set(downstream);
  const nodes: MiniDagNode[] = jobs.map((j) => ({
    id: j.name,
    label: j.name,
    status: j.name === gateJob
      ? "suspended"
      : waiting.has(j.name)
      ? "waiting"
      : undefined,
    title: j.name === gateJob
      ? `${j.name} — holds the gate ${stepName}`
      : waiting.has(j.name)
      ? `${j.name} — waits on the gate`
      : j.name,
  }));
  return {
    gateJob,
    next: gateJob ? [...new Set(dependents.get(gateJob) ?? [])] : [],
    downstream,
    nodes,
    edges,
    highlight: gateJob ? [gateJob, ...downstream] : [],
  };
}
