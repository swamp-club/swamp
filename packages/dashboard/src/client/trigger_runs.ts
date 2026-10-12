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

// Runs started by one trigger (schedule or webhook), for the Schedules and
// Webhooks pages. Asks serve's `workflow.run.summary` for exact per-workflow
// counts over the dashboard time range; a serve that predates it is asked
// for a run search instead, summarised here.

import { useEffect, useMemo, useRef } from "react";
import { useRequest } from "./useRequest.ts";
import { extractArray, extractTotal } from "./extract.ts";
import { useTimeBounds } from "./time_range.ts";
import { useRunSummary } from "./run_summary.ts";
import {
  legacySince,
  type RunCounts,
  runsOfTrigger,
  runsWithin,
  sumCounts,
  summarizeRuns,
  type TriggerRun,
  type WorkflowRunSummary,
} from "../lib/triggers.ts";
import { MAX_WORKFLOW_NAMES } from "../lib/run_filters.ts";

export interface TriggerRunSummaries {
  byWorkflow: Map<string, WorkflowRunSummary>;
  totals: RunCounts;
  /** No answer yet. */
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Per-workflow summaries of one trigger's runs in the time range. */
export function useTriggerRunSummaries(
  triggerSource: "schedule" | "webhook",
  workflows: readonly string[],
  options: { enabled?: boolean; recentLimit?: number } = {},
): TriggerRunSummaries {
  const enabled = (options.enabled ?? true) && workflows.length > 0;
  const recentLimit = options.recentLimit ?? 20;
  const names = useMemo(() => [...new Set(workflows)].sort(), [workflows]);
  // Past serve's cap on a `workflows` filter, ask for every workflow; the
  // results are narrowed to `names` below either way.
  const sent = names.length <= MAX_WORKFLOW_NAMES ? names : undefined;
  const summary = useRunSummary(
    { triggerSource, workflows: sent, recentLimit },
    { enabled },
  );
  // Older serves don't know the summary request: fall back to a search.
  const fallback = enabled && summary.error !== null;
  const bounds = useTimeBounds();
  const search = useTriggerSearch(
    { triggerSource, workflows: sent, limit: 500 },
    bounds,
    fallback,
  );

  return useMemo(() => {
    if (!fallback) {
      const keep = new Set(names);
      const list = (summary.summary?.workflows ?? []).filter((w) =>
        keep.has(w.workflowName)
      );
      return {
        byWorkflow: new Map(list.map((w) => [w.workflowName, w])),
        totals: sumCounts(list),
        loading: enabled && summary.data === null && summary.error === null,
        error: null,
        refetch: summary.refetch,
      };
    }
    const runs = runsOfTrigger(search.runs, triggerSource, names);
    const list = summarizeRuns(runs, recentLimit);
    return {
      byWorkflow: new Map(list.map((w) => [w.workflowName, w])),
      totals: sumCounts(list),
      loading: search.loading,
      error: search.error,
      refetch: search.refetch,
    };
  }, [
    fallback,
    summary.summary,
    summary.data,
    summary.error,
    summary.refetch,
    search,
    names,
    enabled,
    triggerSource,
    recentLimit,
  ]);
}

export interface TriggerRunList {
  runs: TriggerRun[];
  /** Matches serve reported before the page limit, when it reports one. */
  total: number | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * One workflow's runs from one trigger in the time range, newest first.
 * `workflow` narrows an older serve's search to similar names; the exact
 * filter is applied here as well.
 */
export function useTriggerRuns(
  triggerSource: "schedule" | "webhook",
  workflowName: string,
  options: { limit?: number; enabled?: boolean } = {},
): TriggerRunList {
  const bounds = useTimeBounds();
  const enabled = options.enabled ?? true;
  const search = useTriggerSearch(
    {
      workflow: workflowName,
      workflows: [workflowName],
      triggerSource,
      limit: options.limit ?? 100,
    },
    bounds,
    enabled,
  );
  return useMemo(() => {
    const runs = runsOfTrigger(search.runs, triggerSource, [workflowName]);
    // A total only means "this trigger's runs" when serve did the filtering.
    const total = runs.length === search.runs.length ? search.total : null;
    return {
      runs,
      total,
      loading: search.loading,
      error: search.error,
      refetch: search.refetch,
    };
  }, [search, triggerSource, workflowName]);
}

/**
 * A run search over the time range. Serve takes ISO `since`/`until`; an
 * older serve wants `since` as a duration and has no `until`, so a refused
 * search is retried that way and the upper bound applied here.
 */
function useTriggerSearch(
  payload: Record<string, unknown>,
  bounds: { since?: string; until?: string },
  enabled: boolean,
) {
  const current = useRequest(
    "workflow.run.search",
    { ...payload, ...bounds },
    { enabled },
  );
  const legacy = enabled && current.error !== null;
  // Minute-stable, like the bounds, so the request key doesn't churn.
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const since = legacySince(bounds.since, minute);
  const older = useRequest(
    "workflow.run.search",
    { ...payload, ...(since && { since }) },
    { enabled: legacy },
  );
  const source = legacy ? older : current;
  return useMemo(() => {
    const all = extractArray<TriggerRun>(source.data);
    return {
      runs: legacy ? runsWithin(all, bounds) : all,
      total: legacy ? null : extractTotal(source.data),
      loading: enabled && source.data === null && source.error === null,
      error: source.error,
      refetch: source.refetch,
    };
  }, [source.data, source.error, source.refetch, legacy, bounds, enabled]);
}

/**
 * Refetches when `key` changes after the first render — e.g. when a
 * schedule fires (its next run moves on) or starts or stops running.
 */
export function useRefetchOnChange(key: string, refetch: () => void): void {
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    refetch();
  }, [key, refetch]);
}
