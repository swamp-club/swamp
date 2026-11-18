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

import type { ScheduledExecutionEvent } from "../libswamp/workflows/scheduled_execution.ts";
import type { RunMetricsTracker } from "./run_metrics_tracker.ts";
import type { WebhookEvent } from "./webhook.ts";

export interface TriggerRunMetricsDeps {
  readonly metrics: Pick<RunMetricsTracker, "record">;
  readonly startedAt: (runId: string) => Date | undefined;
}

function recordCompleted(deps: TriggerRunMetricsDeps, runId: string): void {
  const startedAt = deps.startedAt(runId);
  deps.metrics.record(
    "completed",
    startedAt ? Date.now() - startedAt.getTime() : 0,
  );
}

/** a failure carries no run id, so its duration is recorded as 0 */
export function recordScheduledRunOutcome(
  deps: TriggerRunMetricsDeps,
  event: ScheduledExecutionEvent,
): void {
  switch (event.kind) {
    case "schedule_completed":
      recordCompleted(deps, event.runId);
      break;
    case "schedule_failed":
      deps.metrics.record("failed", 0);
      break;
  }
}

/** a failure carries no run id, so its duration is recorded as 0 */
export function recordWebhookRunOutcome(
  deps: TriggerRunMetricsDeps,
  event: WebhookEvent,
): void {
  switch (event.kind) {
    case "webhook_completed":
      recordCompleted(deps, event.runId);
      break;
    case "webhook_failed":
      deps.metrics.record("failed", 0);
      break;
  }
}
