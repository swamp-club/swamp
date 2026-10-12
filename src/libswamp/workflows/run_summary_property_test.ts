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
import fc from "fast-check";
import {
  clampRecentLimit,
  summarizeWorkflowRuns,
  type WorkflowRunSummaryRun,
} from "./run_summary.ts";

const STATUSES = [
  "pending",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unheard-of",
] as const;

const START = Date.UTC(2026, 0, 1);
const SPAN = 14 * 24 * 60 * 60 * 1000;

/** A run, dated or not as `dated` says, with a unique id from its index. */
function arbRuns(dated: "always" | "sometimes") {
  return fc.array(
    fc.record({
      workflow: fc.integer({ min: 0, max: 5 }),
      status: fc.constantFrom(...STATUSES),
      startMs: dated === "always"
        ? fc.integer({ min: START, max: START + SPAN })
        : fc.option(fc.integer({ min: START, max: START + SPAN }), {
          nil: undefined,
        }),
      duration: fc.option(fc.integer({ min: 0, max: 3_600_000 }), {
        nil: undefined,
      }),
    }),
    { maxLength: 200 },
  ).map((rows) =>
    rows.map((row, i): WorkflowRunSummaryRun => ({
      runId: `run-${i}`,
      workflowId: `wf-${row.workflow}`,
      workflowName: `workflow-${row.workflow}`,
      status: row.status,
      ...(row.startMs !== undefined
        ? { startedAt: new Date(row.startMs).toISOString() }
        : {}),
      ...(row.duration !== undefined ? { duration: row.duration } : {}),
    }))
  );
}

const arbRecentLimit = fc.option(fc.integer({ min: -10, max: 150 }), {
  nil: undefined,
});

const COUNT_KEYS = [
  "runs",
  "succeeded",
  "failed",
  "cancelled",
  "running",
  "suspended",
  "durationMs",
] as const;

Deno.test("summarizeWorkflowRuns: totals equal the sum of the per-workflow counts", () => {
  fc.assert(
    fc.property(arbRuns("sometimes"), (runs) => {
      const summary = summarizeWorkflowRuns(runs);
      for (const key of COUNT_KEYS) {
        assertEquals(
          summary.totals[key],
          summary.workflows.reduce((n, w) => n + w[key], 0),
          key,
        );
      }
      assertEquals(summary.totals.runs, runs.length);
      assertEquals(summary.totals.workflows, summary.workflows.length);
      assertEquals(
        summary.workflows.length,
        new Set(runs.map((r) => r.workflowId)).size,
      );
    }),
  );
});

Deno.test("summarizeWorkflowRuns: status counts never exceed the runs counted", () => {
  fc.assert(
    fc.property(arbRuns("sometimes"), (runs) => {
      const summary = summarizeWorkflowRuns(runs);
      for (const entry of [summary.totals, ...summary.workflows]) {
        const bucketed = entry.succeeded + entry.failed + entry.cancelled +
          entry.running + entry.suspended;
        assert(bucketed <= entry.runs);
        assert(entry.runs >= 0);
      }
    }),
  );
});

Deno.test("summarizeWorkflowRuns: recent holds at most recentLimit runs, newest first", () => {
  fc.assert(
    fc.property(arbRuns("sometimes"), arbRecentLimit, (runs, limit) => {
      const cap = clampRecentLimit(limit);
      const summary = summarizeWorkflowRuns(runs, { recentLimit: limit });
      for (const w of summary.workflows) {
        assertEquals(w.recent.length, Math.min(cap, w.runs));
        const times = w.recent.map((r) =>
          r.startedAt ? Date.parse(r.startedAt) : -Infinity
        );
        for (let i = 1; i < times.length; i++) {
          assert(times[i - 1] >= times[i]);
        }
        if (w.lastStartedAt && w.recent.length > 0) {
          assertEquals(w.recent[0].startedAt, w.lastStartedAt);
        }
      }
    }),
  );
});

Deno.test("summarizeWorkflowRuns: the timeline accounts for every dated run, in ascending hours", () => {
  fc.assert(
    fc.property(arbRuns("always"), (runs) => {
      const summary = summarizeWorkflowRuns(runs, { timeline: true });
      const timeline = summary.timeline ?? [];
      assertEquals(
        timeline.reduce((n, b) => n + b.runs, 0),
        summary.totals.runs,
      );
      for (const key of ["succeeded", "failed", "cancelled"] as const) {
        assertEquals(
          timeline.reduce((n, b) => n + b[key], 0),
          summary.totals[key],
        );
      }
      for (let i = 0; i < timeline.length; i++) {
        const start = Date.parse(timeline[i].start);
        assertEquals(start % (60 * 60 * 1000), 0);
        assert(timeline[i].runs > 0);
        if (i > 0) assert(Date.parse(timeline[i - 1].start) < start);
      }
    }),
  );
});

Deno.test("summarizeWorkflowRuns: the result does not depend on input order", () => {
  fc.assert(
    fc.property(
      arbRuns("sometimes").chain((runs) =>
        fc.tuple(
          fc.constant(runs),
          fc.shuffledSubarray(runs, {
            minLength: runs.length,
            maxLength: runs.length,
          }),
        )
      ),
      ([runs, shuffled]) => {
        assertEquals(
          summarizeWorkflowRuns(shuffled, { timeline: true }),
          summarizeWorkflowRuns(runs, { timeline: true }),
        );
      },
    ),
  );
});
