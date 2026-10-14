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

import { assertEquals } from "@std/assert";
import { assertErrors, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { runStatusBucket } from "./run_search.ts";
import { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import {
  clampRecentLimit,
  summarizeWorkflowRuns,
  workflowRunSummary,
  type WorkflowRunSummaryDeps,
  type WorkflowRunSummaryEvent,
  type WorkflowRunSummaryRun,
} from "./run_summary.ts";

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const MIN = 60 * 1000;

function run(
  runId: string,
  workflowName: string,
  status: string,
  startMs?: number,
  extra: Partial<WorkflowRunSummaryRun> = {},
): WorkflowRunSummaryRun {
  return {
    runId,
    workflowId: `id-${workflowName}`,
    workflowName,
    status,
    ...(startMs !== undefined
      ? { startedAt: new Date(startMs).toISOString() }
      : {}),
    ...extra,
  };
}

Deno.test("runStatusBucket: maps every run status to its bucket", () => {
  assertEquals(runStatusBucket("succeeded"), "succeeded");
  assertEquals(runStatusBucket("failed"), "failed");
  assertEquals(runStatusBucket("interrupted"), "failed");
  assertEquals(runStatusBucket("cancelled"), "cancelled");
  assertEquals(runStatusBucket("running"), "running");
  assertEquals(runStatusBucket("pending"), "running");
  assertEquals(runStatusBucket("suspended"), "suspended");
  assertEquals(runStatusBucket("mystery"), undefined);
});

Deno.test("clampRecentLimit: defaults to 20 and clamps to 0..100", () => {
  assertEquals(clampRecentLimit(undefined), 20);
  assertEquals(clampRecentLimit(Number.NaN), 20);
  assertEquals(clampRecentLimit(-5), 0);
  assertEquals(clampRecentLimit(0), 0);
  assertEquals(clampRecentLimit(7.9), 7);
  assertEquals(clampRecentLimit(500), 100);
});

Deno.test("summarizeWorkflowRuns: counts per workflow and in total", () => {
  const summary = summarizeWorkflowRuns([
    run("a1", "alpha", "succeeded", T0, { duration: 1000 }),
    run("a2", "alpha", "failed", T0 + MIN, { duration: 500 }),
    run("a3", "alpha", "interrupted", T0 + 2 * MIN, { duration: 50 }),
    run("b1", "beta", "running", T0 + 3 * MIN),
    run("b2", "beta", "pending"),
    run("b3", "beta", "suspended", T0 + 4 * MIN, { duration: 9999 }),
    run("b4", "beta", "cancelled", T0 + 5 * MIN, { duration: 25 }),
    run("b5", "beta", "mystery", T0 + 6 * MIN),
  ]);

  assertEquals(summary.totals, {
    workflows: 2,
    runs: 8,
    succeeded: 1,
    failed: 2,
    cancelled: 1,
    running: 2,
    suspended: 1,
    // Only finished runs: a suspended run's duration is not counted.
    durationMs: 1575,
  });
  assertEquals(summary.workflows.map((w) => w.workflowName), [
    "alpha",
    "beta",
  ]);
  const [alpha, beta] = summary.workflows;
  assertEquals(alpha.runs, 3);
  assertEquals(alpha.failed, 2);
  assertEquals(alpha.durationMs, 1550);
  assertEquals(alpha.lastStartedAt, new Date(T0 + 2 * MIN).toISOString());
  assertEquals(beta.runs, 5);
  assertEquals(beta.durationMs, 25);
  // The unknown status counts in runs only.
  assertEquals(
    beta.succeeded + beta.failed + beta.cancelled + beta.running +
      beta.suspended,
    4,
  );
  assertEquals(summary.timeline, undefined);
  assertEquals("since" in summary, false);
  // The undated run is not the oldest: it has no start to age out by.
  assertEquals(summary.oldestStartedAt, new Date(T0).toISOString());
});

Deno.test("summarizeWorkflowRuns: oldestStartedAt is absent without a dated run", () => {
  assertEquals("oldestStartedAt" in summarizeWorkflowRuns([]), false);
  assertEquals(
    "oldestStartedAt" in
      summarizeWorkflowRuns([run("undated", "alpha", "pending")]),
    false,
  );
});

Deno.test("summarizeWorkflowRuns: recent is newest first, capped, and undated runs last", () => {
  const summary = summarizeWorkflowRuns(
    [
      run("old", "alpha", "succeeded", T0, { triggerSource: "schedule" }),
      run("undated", "alpha", "pending"),
      run("new", "alpha", "failed", T0 + MIN, { duration: 10 }),
      run("mid", "alpha", "succeeded", T0 + 30 * 1000),
    ],
    { recentLimit: 3 },
  );
  const alpha = summary.workflows[0];
  assertEquals(alpha.recent.map((r) => r.runId), ["new", "mid", "old"]);
  assertEquals(alpha.recent[0], {
    runId: "new",
    status: "failed",
    startedAt: new Date(T0 + MIN).toISOString(),
    duration: 10,
  });
  assertEquals(alpha.recent[2].triggerSource, "schedule");
  assertEquals(alpha.runs, 4);

  const none = summarizeWorkflowRuns([run("x", "alpha", "succeeded", T0)], {
    recentLimit: 0,
  });
  assertEquals(none.workflows[0].recent, []);
});

Deno.test("summarizeWorkflowRuns: the timeline buckets by UTC hour, ascending, only hours with runs", () => {
  const summary = summarizeWorkflowRuns(
    [
      run("late", "alpha", "succeeded", T0 + 3 * 60 * MIN + 59 * MIN),
      run("a", "alpha", "succeeded", T0),
      run("b", "beta", "failed", T0 + 59 * MIN),
      run("c", "beta", "cancelled", T0 + 60 * MIN),
      run("d", "beta", "running", T0 + 61 * MIN),
      run("undated", "beta", "pending"),
    ],
    {
      timeline: true,
      since: "2026-10-12T00:00:00.000Z",
      until: "2026-10-13T00:00:00.000Z",
    },
  );
  assertEquals(summary.since, "2026-10-12T00:00:00.000Z");
  assertEquals(summary.until, "2026-10-13T00:00:00.000Z");
  assertEquals(summary.timeline, [
    {
      start: "2026-10-12T10:00:00.000Z",
      runs: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    },
    {
      start: "2026-10-12T11:00:00.000Z",
      runs: 2,
      succeeded: 0,
      failed: 0,
      cancelled: 1,
    },
    {
      start: "2026-10-12T13:00:00.000Z",
      runs: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    },
  ]);
});

Deno.test("summarizeWorkflowRuns: no runs give zero totals and empty lists", () => {
  assertEquals(summarizeWorkflowRuns([], { timeline: true }), {
    totals: {
      workflows: 0,
      runs: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      suspended: 0,
      durationMs: 0,
    },
    workflows: [],
    timeline: [],
  });
});

// ── workflowRunSummary generator ────────────────────────────────────────

function makeDeps(
  isReadable?: WorkflowRunSummaryDeps["isReadable"],
): WorkflowRunSummaryDeps {
  const workflows = [
    { id: "wf-a", name: "alpha", declaresInputs: false },
    { id: "wf-b", name: "beta", declaresInputs: false },
  ];
  const runs = [
    {
      id: "a1",
      workflowId: "wf-a",
      workflowName: "alpha",
      status: "succeeded",
      startedAt: new Date(T0),
      completedAt: new Date(T0 + 1000),
      triggerSource: "schedule",
    },
    {
      id: "a2",
      workflowId: "wf-a",
      workflowName: "alpha",
      status: "failed",
      startedAt: new Date(T0 + 2 * 60 * MIN),
      completedAt: new Date(T0 + 2 * 60 * MIN + 500),
      triggerSource: "api",
    },
    {
      id: "b1",
      workflowId: "wf-b",
      workflowName: "beta",
      status: "succeeded",
      startedAt: new Date(T0 + 60 * MIN),
      completedAt: new Date(T0 + 60 * MIN + 200),
      triggerSource: "schedule",
    },
  ];
  return {
    findAllWorkflows: () => Promise.resolve(workflows),
    runIndexOf: (id) =>
      Promise.resolve(
        RunIndexSnapshot.of(
          runs.filter((r) => r.workflowId === id).map((r) => ({
            ...r,
            tags: {},
            inputs: {},
          })),
        ),
      ),
    ...(isReadable ? { isReadable } : {}),
  };
}

async function summaryOf(
  deps: WorkflowRunSummaryDeps,
  input: Parameters<typeof workflowRunSummary>[2],
) {
  const events = await collect<WorkflowRunSummaryEvent>(
    workflowRunSummary(createLibSwampContext(), deps, input),
  );
  assertEquals(events[0], { kind: "resolving" });
  const last = events[events.length - 1];
  if (last.kind !== "completed") throw new Error(JSON.stringify(last));
  return last.data;
}

Deno.test("workflowRunSummary: counts every run with durations from the run times", async () => {
  const data = await summaryOf(makeDeps(), { timeline: true });
  assertEquals(data.totals.runs, 3);
  assertEquals(data.totals.workflows, 2);
  assertEquals(data.totals.durationMs, 1700);
  assertEquals(data.timeline?.map((b) => b.runs), [1, 1, 1]);
  assertEquals(data.workflows[0].recent.map((r) => r.runId), ["a2", "a1"]);
});

Deno.test("workflowRunSummary: since and until bound the window and are echoed as ISO", async () => {
  const data = await summaryOf(makeDeps(), {
    since: new Date(T0 + 30 * MIN).toISOString(),
    until: "2026-10-12T12:00:00Z",
  });
  assertEquals(data.since, new Date(T0 + 30 * MIN).toISOString());
  assertEquals(data.until, "2026-10-12T12:00:00.000Z");
  // a1 is before since; a2 starts exactly at until, which is exclusive.
  assertEquals(data.totals.runs, 1);
  // The oldest run counted, not a1 outside the window.
  assertEquals(data.oldestStartedAt, new Date(T0 + 60 * MIN).toISOString());
  assertEquals(data.workflows.map((w) => w.workflowName), ["beta"]);
});

Deno.test("workflowRunSummary: workflows and triggerSource narrow the runs counted", async () => {
  const byName = await summaryOf(makeDeps(), { workflows: ["alpha"] });
  assertEquals(byName.totals.runs, 2);
  assertEquals(byName.workflows.map((w) => w.workflowName), ["alpha"]);

  const bySource = await summaryOf(makeDeps(), { triggerSource: "schedule" });
  assertEquals(bySource.totals.runs, 2);
  assertEquals(
    bySource.workflows.flatMap((w) => w.recent.map((r) => r.runId)),
    ["a1", "b1"],
  );
});

Deno.test("workflowRunSummary: counts only the runs isReadable allows", async () => {
  const deps = makeDeps((_id, name) => Promise.resolve(name !== "beta"));
  const data = await summaryOf(deps, { timeline: true });
  assertEquals(data.totals.runs, 2);
  assertEquals(data.totals.workflows, 1);
  assertEquals(data.workflows.map((w) => w.workflowName), ["alpha"]);
  assertEquals(
    data.timeline?.map((b) => b.start),
    ["2026-10-12T10:00:00.000Z", "2026-10-12T12:00:00.000Z"],
  );
});

Deno.test("workflowRunSummary: an unreadable time is a validation error", async () => {
  const error = await assertErrors(
    workflowRunSummary(createLibSwampContext(), makeDeps(), {
      since: "last tuesday",
    }),
    "validation_failed",
  );
  assertEquals(error.message.includes("last tuesday"), true);
});
