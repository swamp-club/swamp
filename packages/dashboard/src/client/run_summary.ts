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
import { useTimeBounds } from "./time_range.ts";

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
  timeline?: TimelineBucket[];
}

export interface RunSummaryQuery {
  workflows?: string[];
  triggerSource?: string;
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
 * query's own bounds). `enabled: false` holds the request.
 */
export function useRunSummary(
  query: RunSummaryQuery = {},
  options: { enabled?: boolean } = {},
) {
  const bounds = useTimeBounds();
  const { allTime, since, until, ...rest } = query;
  const payload: Record<string, unknown> = { ...rest };
  if (!allTime) {
    const s = since ?? bounds.since;
    const u = until ?? bounds.until;
    if (s) payload.since = s;
    if (u) payload.until = u;
  }
  const result = useRequest("workflow.run.summary", payload, options);
  return { ...result, summary: extractObject<RunSummaryData>(result.data) };
}

/** Index summaries by workflow name. */
export function summariesByName(
  summary: RunSummaryData | null,
): Map<string, WorkflowRunSummary> {
  return new Map((summary?.workflows ?? []).map((w) => [w.workflowName, w]));
}
