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

// runs are paged on the server, so the workflow filter is resolved against the
// catalog into the exact names serve should match

import {
  applyWorkflowFilter,
  isFilterActive,
  type WorkflowFacets,
  type WorkflowFilter,
  type WorkflowRef,
} from "./workflow_facets.ts";

export const RUN_STATUSES = [
  "succeeded",
  "failed",
  "running",
  "suspended",
  "cancelled",
] as const;

export type RunStatus = typeof RUN_STATUSES[number];
export type RunStatusFilter = "" | RunStatus;

export const RUN_SOURCES = ["schedule", "webhook", "api", "manual"] as const;
export type RunSource = typeof RUN_SOURCES[number];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isRunSource(value: string): value is RunSource {
  return (RUN_SOURCES as readonly string[]).includes(value);
}
export type RunSourceFilter = "" | RunSource;

export const RUN_SOURCE_LABELS: Record<RunSource, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  api: "API",
  manual: "Manual",
};

/**
 * sorted so the request and its cache key are stable; null when no filter is
 * active (serve matches all); an empty array means nothing matches, so there is
 * nothing to request
 */
export function workflowNamesForFilter(
  workflows: readonly WorkflowRef[],
  filter: WorkflowFilter,
  facetsOf: (workflow: WorkflowRef) => WorkflowFacets,
): string[] | null {
  if (!isFilterActive(filter)) return null;
  return applyWorkflowFilter(workflows, filter, (w) => w, facetsOf)
    .map((w) => w.name)
    .sort();
}

/**
 * rows keep incoming order since the query only selects and never reranks, so
 * an urgency ordering survives; a workflow missing from the catalog matches by
 * name alone
 */
export function filterRowsByWorkflow<T>(
  rows: readonly T[],
  filter: WorkflowFilter,
  nameOf: (row: T) => string,
  catalog: ReadonlyMap<string, WorkflowRef>,
  facetsOf: (workflow: WorkflowRef) => WorkflowFacets,
): T[] {
  if (!isFilterActive(filter)) return [...rows];
  const kept = new Set(
    applyWorkflowFilter(
      rows,
      filter,
      (row) => catalog.get(nameOf(row)) ?? { name: nameOf(row) },
      facetsOf,
    ),
  );
  return rows.filter((row) => kept.has(row));
}

export interface RunSearchQuery {
  page: number;
  pageSize: number;
  statuses: readonly RunStatus[];
  sources: readonly RunSource[];
  workflows: readonly string[] | null;
  since?: string;
  until?: string;
}

export function runSearchPayload(q: RunSearchQuery): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    limit: q.pageSize,
    offset: q.page * q.pageSize,
  };
  if (q.statuses.length > 0) payload.statuses = [...q.statuses];
  if (q.sources.length > 0) payload.triggerSources = [...q.sources];
  if (q.workflows !== null) payload.workflows = [...q.workflows];
  if (q.since) payload.since = q.since;
  if (q.until) payload.until = q.until;
  return payload;
}

export type RunWindowRange =
  | { kind: "preset"; preset: string }
  | { kind: "custom"; from: string; to: string };

/**
 * a preset goes as serve's relative duration, resolved against serve's own
 * clock and accepted by every serve; a custom range goes as ISO bounds; "all"
 * sends neither
 */
export function runSearchWindow(
  range: RunWindowRange,
): { since?: string; until?: string } {
  if (range.kind === "custom") return { since: range.from, until: range.to };
  return range.preset === "all" ? {} : { since: range.preset };
}

export const MAX_WORKFLOW_NAMES = 1_000;

/**
 * a list over serve's cap would be refused, so it is not sent and `local` names
 * the workflows to keep instead
 */
export function splitWorkflowFilter(
  names: readonly string[] | null,
): { server: readonly string[] | null; local: ReadonlySet<string> | null } {
  if (names === null || names.length <= MAX_WORKFLOW_NAMES) {
    return { server: names, local: null };
  }
  return { server: null, local: new Set(names) };
}

export function totalsOfWorkflows(
  workflows: ReadonlyArray<
    RunTotals & { workflowName: string; durationMs: number }
  >,
  keep: ReadonlySet<string>,
): RunTotals & { durationMs: number; workflows: number } {
  const total = {
    runs: 0,
    succeeded: 0,
    failed: 0,
    running: 0,
    suspended: 0,
    cancelled: 0,
    durationMs: 0,
    workflows: 0,
  };
  for (const w of workflows) {
    if (!keep.has(w.workflowName)) continue;
    total.workflows++;
    total.runs += w.runs;
    total.succeeded += w.succeeded;
    total.failed += w.failed;
    total.running += w.running;
    total.suspended += w.suspended;
    total.cancelled += w.cancelled;
    total.durationMs += w.durationMs;
  }
  return total;
}

export interface RunTotals {
  runs: number;
  succeeded: number;
  failed: number;
  running: number;
  suspended: number;
  cancelled: number;
}

export function statusCounts(
  totals: RunTotals | null | undefined,
): Record<RunStatusFilter, number> | null {
  if (!totals) return null;
  return {
    "": totals.runs,
    succeeded: totals.succeeded,
    failed: totals.failed,
    running: totals.running,
    suspended: totals.suspended,
    cancelled: totals.cancelled,
  };
}
