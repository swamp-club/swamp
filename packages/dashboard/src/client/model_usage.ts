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

// Client types for serve's `model.usage.summary`: per-model execution counts
// and newest outputs over a time window, aggregated on the server after
// authorization so counts are exact (swamp-club#4144).

import { useRequest } from "./useRequest.ts";
import { extractObject } from "./extract.ts";
import { useRequestTimeBounds } from "./time_range.ts";
import { useRefetchOnRunActivity } from "./run_activity.ts";

export interface ModelUsageRecentOutput {
  id: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  triggeredBy?: string;
  workflowId?: string;
  workflowName?: string;
  workflowRunId?: string;
  stepName?: string;
}

export interface ModelUsageRow {
  definitionId: string;
  modelName: string;
  type: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  /** Distinct methods run, most recent first. */
  methods: string[];
  /** Newest first. */
  recent: ModelUsageRecentOutput[];
}

export interface ModelUsageSummaryData {
  since?: string;
  until?: string;
  /** Every readable output, including those of definitions no longer named. */
  totals: { executions: number; failed: number };
  /** Newest use first. */
  models: ModelUsageRow[];
}

/**
 * Fetches the usage summary for the dashboard's current time range, and
 * fetches it again when serve starts or finishes a run or the tab comes back
 * into view. Each read goes through every output in the window. Unlike the
 * run summary there is no age-out re-read as well: on a busy repo the oldest
 * output leaves a preset window every few seconds, which would add a read each
 * time. Run activity alone can already keep one read going on a busy repo.
 */
export function useModelUsageSummary() {
  const bounds = useRequestTimeBounds();
  const result = useRequest("model.usage.summary", bounds);
  useRefetchOnRunActivity(result.refresh);
  return {
    ...result,
    summary: extractObject<ModelUsageSummaryData>(result.data),
  };
}
