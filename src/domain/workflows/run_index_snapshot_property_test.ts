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
import fc from "fast-check";
import { RunIndexSnapshot } from "./run_index_snapshot.ts";
import type { WorkflowRunSummary } from "./workflow_run_summary.ts";

const START = Date.UTC(2026, 0, 1);
// A narrow span so that runs often share a start time.
const SPAN = 20_000;

const arbSummaries = fc.array(
  fc.option(fc.integer({ min: START, max: START + SPAN }), { nil: undefined }),
  { maxLength: 80 },
).map((starts) =>
  starts.map((startMs, i): WorkflowRunSummary => ({
    id: `run-${i}`,
    workflowId: "wf",
    workflowName: "wf",
    status: "succeeded",
    ...(startMs !== undefined ? { startedAt: new Date(startMs) } : {}),
    tags: {},
    inputs: {},
  }))
);

const arbBound = fc.option(
  fc.integer({ min: START - 1000, max: START + SPAN + 1000 }),
  { nil: undefined },
);

/** The reference: filter by the window, then a stable sort, newest first. */
function reference(
  summaries: WorkflowRunSummary[],
  sinceMs: number | undefined,
  untilMs: number | undefined,
): string[] {
  const bounded = sinceMs !== undefined || untilMs !== undefined;
  return summaries
    .filter((s) => {
      if (!bounded) return true;
      const ms = s.startedAt?.getTime();
      if (ms === undefined) return false;
      return (sinceMs === undefined || ms >= sinceMs) &&
        (untilMs === undefined || ms < untilMs);
    })
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (b.s.startedAt?.getTime() ?? 0) - (a.s.startedAt?.getTime() ?? 0) ||
      a.i - b.i
    )
    .map(({ s }) => s.id);
}

Deno.test("RunIndexSnapshot.between: equals filtering by the window then a stable newest-first sort", () => {
  fc.assert(
    fc.property(arbSummaries, arbBound, arbBound, (summaries, since, until) => {
      const expected = reference(summaries, since, until);
      const snapshot = RunIndexSnapshot.of(summaries);
      assertEquals(
        snapshot.between(since, until).map((r) => r.summary.id),
        expected,
      );
    }),
  );
});

Deno.test("RunIndexSnapshot.get: finds exactly the run with that id", () => {
  fc.assert(
    fc.property(arbSummaries, fc.nat(100), (summaries, n) => {
      const snapshot = RunIndexSnapshot.of(summaries);
      const id = `run-${n}`;
      assertEquals(
        snapshot.get(id.toUpperCase())?.summary.id,
        summaries.find((s) => s.id === id)?.id,
      );
    }),
  );
});

Deno.test("RunIndexSnapshot: newestStartMs is the latest start time", () => {
  fc.assert(
    fc.property(arbSummaries, (summaries) => {
      const starts = summaries.flatMap((s) =>
        s.startedAt ? [s.startedAt.getTime()] : []
      );
      assertEquals(
        RunIndexSnapshot.of(summaries).newestStartMs,
        starts.length > 0 ? Math.max(...starts) : undefined,
      );
    }),
  );
});
