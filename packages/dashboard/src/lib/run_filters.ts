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

// Run filtering shared by Executions and Approvals. Runs are paged on the
// server, so the workflow filter (fuzzy query, prefix, trigger, webhook)
// is resolved against the workflow catalog into the exact names serve
// should match, and the run's own filters ride alongside.

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
/** "" means every status. */
export type RunStatusFilter = "" | RunStatus;

/** What started a run, as serve records it in `triggerSource`. */
export const RUN_SOURCES = ["schedule", "webhook", "api", "manual"] as const;
export type RunSource = typeof RUN_SOURCES[number];
/** "" means any source. */
export type RunSourceFilter = "" | RunSource;

export const RUN_SOURCE_LABELS: Record<RunSource, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  api: "API",
  manual: "Manual",
};

/**
 * The exact workflow names a filter selects, sorted so the request (and
 * its cache key) is stable. Null when no filter is active: the request
 * then names no workflows and serve matches all of them. An empty array
 * means the filter matches nothing, so there is nothing to request.
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
 * Filters rows that each name a workflow (approval gates, suspended runs)
 * by that workflow's facets. Rows keep their incoming order — the fuzzy
 * query only selects, it never reranks, so an urgency ordering survives.
 * A workflow missing from the catalog is matched by its name alone.
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
  status: RunStatusFilter;
  source: RunSourceFilter;
  /** From {@link workflowNamesForFilter}; null sends no workflow filter. */
  workflows: readonly string[] | null;
  since?: string;
  until?: string;
}

/** The `workflow.run.search` payload for one page of runs. */
export function runSearchPayload(q: RunSearchQuery): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    limit: q.pageSize,
    offset: q.page * q.pageSize,
  };
  if (q.status) payload.status = q.status;
  if (q.source) payload.triggerSource = q.source;
  if (q.workflows !== null) payload.workflows = [...q.workflows];
  if (q.since) payload.since = q.since;
  if (q.until) payload.until = q.until;
  return payload;
}

export interface RunTotals {
  runs: number;
  succeeded: number;
  failed: number;
  running: number;
  suspended: number;
  cancelled: number;
}

/** Runs per status filter, "" being every run. */
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
