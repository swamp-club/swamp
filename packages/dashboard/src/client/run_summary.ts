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

// Client types for serve's `workflow.run.summary`: per-workflow run counts,
// recent runs and an hourly timeline over a time window, aggregated on the
// server after authorization so totals are exact (not "the last 500 runs").

import { useRequest } from "./useRequest.ts";
import { extractObject } from "./extract.ts";
import { isRelativeBound, useRequestTimeBounds } from "./time_range.ts";
import { ageOutDelayMs, useRefetchOnRunActivity } from "./run_activity.ts";

export interface RecentRun {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  triggerSource?: string;
}

export interface RunCounts {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  suspended: number;
  /** Sum of finished runs' durations. */
  durationMs: number;
}

export interface WorkflowRunSummary extends RunCounts {
  workflowId: string;
  workflowName: string;
  lastStartedAt?: string;
  /** Newest first. */
  recent: RecentRun[];
}

export interface TimelineBucket {
  /** Top of the UTC hour. */
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface RunSummaryData {
  since?: string;
  until?: string;
  totals: Omit<RunCounts, "runs"> & { runs: number; workflows: number };
  workflows: WorkflowRunSummary[];
  /** Start of the oldest counted run; older serves leave it out. */
  oldestStartedAt?: string;
  timeline?: TimelineBucket[];
}

export interface RunSummaryQuery {
  workflows?: string[];
  triggerSource?: string;
  /** Any of these trigger sources. */
  triggerSources?: string[];
  recentLimit?: number;
  timeline?: boolean;
  /** Override the dashboard time range (e.g. a calendar's own window). */
  since?: string;
  until?: string;
  /** Ignore the dashboard time range entirely. */
  allTime?: boolean;
}

/**
 * Fetches the run summary for the dashboard's current time range (or the
 * query's own bounds), and fetches it again when serve starts or finishes
 * a run, the tab comes back into view, or (on a preset range) the oldest
 * counted run leaves the window. `enabled: false` holds the request.
 */
export function useRunSummary(
  query: RunSummaryQuery = {},
  options: { enabled?: boolean } = {},
) {
  const bounds = useRequestTimeBounds();
  const { allTime, since, until, ...rest } = query;
  const payload: Record<string, unknown> = { ...rest };
  const sentSince = allTime ? undefined : since ?? bounds.since;
  if (!allTime) {
    const u = until ?? bounds.until;
    if (sentSince) payload.since = sentSince;
    if (u) payload.until = u;
  }
  const result = useRequest("workflow.run.summary", payload, options);
  const summary = extractObject<RunSummaryData>(result.data);
  // Only a preset's window moves; a custom or calendar window never
  // loses a run it counted.
  const delayMs = isRelativeBound(sentSince)
    ? ageOutDelayMs(summary?.since, summary?.oldestStartedAt)
    : null;
  useRefetchOnRunActivity(result.refetch, options.enabled ?? true, {
    answer: result.data,
    delayMs,
  });
  return { ...result, summary };
}

/** Index summaries by workflow name. */
export function summariesByName(
  summary: RunSummaryData | null,
): Map<string, WorkflowRunSummary> {
  return new Map((summary?.workflows ?? []).map((w) => [w.workflowName, w]));
}
