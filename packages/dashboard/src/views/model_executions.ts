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

// A model's executions (method runs) from serve's `model.output.search`.
// Older servers ignore the model and time filters and return every output,
// so the dashboard filters again on its side: the result is right either
// way, only the payload size differs.

/** Mirrors ModelOutputSearchItem in src/libswamp/models/output_search.ts. */
export interface ModelOutput {
  id: string;
  definitionId?: string;
  modelName?: string;
  type?: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  triggeredBy?: "manual" | "workflow" | "model" | string;
  workflowId?: string;
  workflowName?: string;
  workflowRunId?: string;
  stepName?: string;
}

export interface OutputFilter {
  /** Keep only this model's outputs (by name or definition id). */
  modelName?: string;
  modelId?: string;
  since?: string;
  until?: string;
}

/** Outputs matching `filter`, newest first. */
export function filterOutputs(
  outputs: readonly ModelOutput[],
  filter: OutputFilter,
): ModelOutput[] {
  const since = filter.since ? Date.parse(filter.since) : null;
  const until = filter.until ? Date.parse(filter.until) : null;
  const byModel = filter.modelName !== undefined ||
    filter.modelId !== undefined;
  return outputs
    .filter((o) => {
      if (
        byModel &&
        !(filter.modelName !== undefined && o.modelName === filter.modelName) &&
        !(filter.modelId !== undefined && o.definitionId === filter.modelId)
      ) return false;
      const t = Date.parse(o.startedAt);
      if (Number.isNaN(t)) return since === null && until === null;
      if (since !== null && t < since) return false;
      // `until` is exclusive, as serve reads it.
      if (until !== null && t >= until) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** A RunHistoryBar entry (kept structural so this module stays JSX-free). */
export interface OutputPip {
  id: string;
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  workflowName?: string;
  label: string;
}

/**
 * Run-history pips for outputs (newest first). An output a workflow ran
 * links to that run; a direct run has no page, so its pip is titled with
 * the method instead.
 */
export function outputPips(outputs: readonly ModelOutput[]): OutputPip[] {
  return outputs.map((o) => {
    const runId = o.workflowName && o.workflowRunId ? o.workflowRunId : null;
    const via = runId
      ? `${o.methodName} via ${o.workflowName}${
        o.stepName ? ` › ${o.stepName}` : ""
      }`
      : `${o.methodName} · ${o.triggeredBy ?? "manual"}`;
    return {
      id: o.id,
      runId: runId ?? o.id,
      status: o.status,
      startedAt: o.startedAt,
      duration: o.durationMs,
      label: via,
      ...(runId && { workflowName: o.workflowName }),
    };
  });
}

/** The workflow run an output belongs to, when it has one. */
export function outputRunRoute(o: ModelOutput): RouteState | null {
  if (!o.workflowName || !o.workflowRunId) return null;
  return {
    view: "workflows",
    detail: {
      kind: "run",
      workflowName: o.workflowName,
      runId: o.workflowRunId,
    },
  };
}

export interface ModelUsage {
  executions: number;
  failed: number;
  lastStartedAt: string | null;
  /** Distinct methods run, most recent first. */
  methods: string[];
  /** Newest first. */
  recent: ModelOutput[];
}

/**
 * Usage per model from one unfiltered output search, keyed by both name
 * and definition id so a card can look itself up by either.
 */
export function usageByModel(
  outputs: readonly ModelOutput[],
  recentLimit = 20,
): Map<string, ModelUsage> {
  const sorted = [...outputs].sort((a, b) =>
    Date.parse(b.startedAt) - Date.parse(a.startedAt)
  );
  const byKey = new Map<string, ModelUsage>();
  for (const o of sorted) {
    const key = o.definitionId ?? o.modelName;
    if (!key) continue;
    let usage = byKey.get(key);
    if (!usage) {
      usage = {
        executions: 0,
        failed: 0,
        lastStartedAt: o.startedAt,
        methods: [],
        recent: [],
      };
      byKey.set(key, usage);
      if (o.modelName && o.definitionId) byKey.set(o.modelName, usage);
    }
    usage.executions++;
    if (o.status === "failed") usage.failed++;
    if (!usage.methods.includes(o.methodName)) usage.methods.push(o.methodName);
    if (usage.recent.length < recentLimit) usage.recent.push(o);
  }
  return byKey;
}
