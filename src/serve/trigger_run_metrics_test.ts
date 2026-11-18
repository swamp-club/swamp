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

import { assert, assertEquals } from "@std/assert";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import type { ScheduledExecutionEvent } from "../libswamp/workflows/scheduled_execution.ts";
import { RunMetricsTracker, type RunOutcome } from "./run_metrics_tracker.ts";
import {
  recordScheduledRunOutcome,
  recordWebhookRunOutcome,
  type TriggerRunMetricsDeps,
} from "./trigger_run_metrics.ts";
import type { WebhookEvent } from "./webhook.ts";

const WF_ID = "wf-1" as WorkflowId;

function recorder(
  started: Record<string, Date> = {},
): {
  records: { outcome: RunOutcome; durationMs: number }[];
  deps: TriggerRunMetricsDeps;
} {
  const records: { outcome: RunOutcome; durationMs: number }[] = [];
  return {
    records,
    deps: {
      metrics: {
        record: (outcome, durationMs) => records.push({ outcome, durationMs }),
      },
      startedAt: (runId) => started[runId],
    },
  };
}

Deno.test("recordScheduledRunOutcome: a completed run records its duration since start", () => {
  const { records, deps } = recorder({
    "run-1": new Date(Date.now() - 60_000),
  });
  recordScheduledRunOutcome(deps, {
    kind: "schedule_completed",
    workflowId: WF_ID,
    workflowName: "nightly",
    runId: "run-1",
  });
  assertEquals(records.length, 1);
  assertEquals(records[0].outcome, "completed");
  assert(records[0].durationMs >= 60_000);
});

Deno.test("recordScheduledRunOutcome: an untracked completed run records duration 0", () => {
  const { records, deps } = recorder();
  recordScheduledRunOutcome(deps, {
    kind: "schedule_completed",
    workflowId: WF_ID,
    workflowName: "nightly",
    runId: "run-unknown",
  });
  assertEquals(records, [{ outcome: "completed", durationMs: 0 }]);
});

Deno.test("recordScheduledRunOutcome: a failed run records failed with duration 0", () => {
  const { records, deps } = recorder();
  recordScheduledRunOutcome(deps, {
    kind: "schedule_failed",
    workflowId: WF_ID,
    workflowName: "nightly",
    error: "boom",
  });
  assertEquals(records, [{ outcome: "failed", durationMs: 0 }]);
});

Deno.test("recordScheduledRunOutcome: non-terminal events record nothing", () => {
  const { records, deps } = recorder({ "run-1": new Date() });
  const base = { workflowId: WF_ID, workflowName: "nightly" };
  const events: ScheduledExecutionEvent[] = [
    { ...base, kind: "schedule_registered", cronExpression: "* * * * *" },
    { ...base, kind: "schedule_unregistered" },
    { ...base, kind: "schedule_fired", fireTime: "2026-01-01T00:00:00.000Z" },
    {
      ...base,
      kind: "schedule_missed",
      fireTime: "2026-01-01T00:00:00.000Z",
      oldestFireTime: "2026-01-01T00:00:00.000Z",
      missedCount: 1,
      saturated: false,
      caughtUp: false,
    },
    { ...base, kind: "schedule_skipped", reason: "overlap" },
    { ...base, kind: "schedule_started", runId: "run-1", replayed: false },
    { ...base, kind: "schedule_denied", reason: "no grant", replayed: false },
    { ...base, kind: "schedule_suspended", runId: "run-1" },
  ];
  for (const event of events) recordScheduledRunOutcome(deps, event);
  assertEquals(records, []);
});

Deno.test("recordWebhookRunOutcome: a completed run records its duration since start", () => {
  const { records, deps } = recorder({
    "run-2": new Date(Date.now() - 30_000),
  });
  recordWebhookRunOutcome(deps, {
    kind: "webhook_completed",
    route: "/hooks/ok",
    workflowName: "wf-ok",
    runId: "run-2",
  });
  assertEquals(records.length, 1);
  assertEquals(records[0].outcome, "completed");
  assert(records[0].durationMs >= 30_000);
});

Deno.test("recordWebhookRunOutcome: an untracked completed run records duration 0", () => {
  const { records, deps } = recorder();
  recordWebhookRunOutcome(deps, {
    kind: "webhook_completed",
    route: "/hooks/ok",
    workflowName: "wf-ok",
    runId: "run-unknown",
  });
  assertEquals(records, [{ outcome: "completed", durationMs: 0 }]);
});

Deno.test("recordWebhookRunOutcome: a failed run records failed with duration 0", () => {
  const { records, deps } = recorder();
  recordWebhookRunOutcome(deps, {
    kind: "webhook_failed",
    route: "/hooks/bad",
    workflowName: "wf-bad",
    error: "Command exited with code 3",
  });
  assertEquals(records, [{ outcome: "failed", durationMs: 0 }]);
});

Deno.test("recordWebhookRunOutcome: non-terminal events record nothing", () => {
  const { records, deps } = recorder({ "run-2": new Date() });
  const base = { route: "/hooks/ok", workflowName: "wf-ok" };
  const events: WebhookEvent[] = [
    { ...base, kind: "webhook_received" },
    { ...base, kind: "webhook_rejected", reason: "bad signature" },
    { ...base, kind: "webhook_queued", runId: "run-2" },
    { ...base, kind: "webhook_started", runId: "run-2", replayed: false },
    { ...base, kind: "webhook_denied", reason: "no grant", replayed: false },
  ];
  for (const event of events) recordWebhookRunOutcome(deps, event);
  assertEquals(records, []);
});

Deno.test("recordWebhookRunOutcome: outcomes from both triggers reach a real tracker's snapshot", () => {
  const tracker = new RunMetricsTracker();
  const deps: TriggerRunMetricsDeps = {
    metrics: tracker,
    startedAt: () => undefined,
  };
  recordWebhookRunOutcome(deps, {
    kind: "webhook_completed",
    route: "/hooks/ok",
    workflowName: "wf-ok",
    runId: "run-ok",
  });
  recordWebhookRunOutcome(deps, {
    kind: "webhook_failed",
    route: "/hooks/bad",
    workflowName: "wf-bad",
    error: "exit 3",
  });
  recordScheduledRunOutcome(deps, {
    kind: "schedule_completed",
    workflowId: WF_ID,
    workflowName: "nightly",
    runId: "run-s",
  });
  recordScheduledRunOutcome(deps, {
    kind: "schedule_failed",
    workflowId: WF_ID,
    workflowName: "nightly",
    error: "boom",
  });
  const snapshot = tracker.snapshot();
  assertEquals(snapshot.completions, 2);
  assertEquals(snapshot.failures, 2);
  assertEquals(snapshot.cancellations, 0);
});
