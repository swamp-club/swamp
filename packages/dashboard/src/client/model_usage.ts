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

// counts are aggregated on the server after authorization, so they are exact

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
  methods: string[];
  recent: ModelUsageRecentOutput[];
}

export interface ModelUsageSummaryData {
  since?: string;
  until?: string;
  totals: { executions: number; failed: number };
  models: ModelUsageRow[];
}

/**
 * unlike the run summary there is no age-out re-read: on a busy repo the oldest
 * output leaves a preset window every few seconds, which would add a read each
 * time
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
