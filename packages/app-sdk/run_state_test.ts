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
import {
  IDLE_RUN,
  runClock,
  runReducer,
  type RunState,
  type RunStreamEvent,
} from "./run_state.ts";

function replay(events: unknown[], from: RunState = IDLE_RUN): RunState {
  let state = runReducer(from, { kind: "begin", at: 0 });
  events.forEach((event, i) => {
    state = runReducer(state, {
      kind: "event",
      at: (i + 1) * 100,
      event: event as RunStreamEvent,
    });
  });
  return state;
}

Deno.test("runReducer: follows jobs and forEach iterations to a succeeded run", () => {
  const state = replay([
    { kind: "started", runId: "r1", workflowName: "w" },
    { kind: "job_started", jobId: "refresh" },
    {
      kind: "step_started",
      jobId: "refresh",
      stepId: "refresh-channel-blog",
      forEachTemplate: "refresh-channel",
    },
    {
      kind: "method_output",
      jobId: "refresh",
      stepId: "refresh-channel-blog",
      stream: "stdout",
      line: "refreshed blog",
    },
    {
      kind: "step_completed",
      jobId: "refresh",
      stepId: "refresh-channel-blog",
    },
    { kind: "job_completed", jobId: "refresh", status: "succeeded" },
    { kind: "completed", run: { status: "succeeded" } },
  ]);
  assertEquals(state.runId, "r1");
  assertEquals(state.status, "succeeded");
  assertEquals(state.jobs.refresh.status, "succeeded");
  const step = state.steps["refresh/refresh-channel-blog"];
  assertEquals(step.template, "refresh-channel");
  assertEquals(step.output, ["refreshed blog"]);
  assertEquals([step.startedAt, step.endedAt], [300, 500]);
});

Deno.test("runReducer: a failed step says why, and so does the run", () => {
  const state = replay([
    { kind: "step_started", jobId: "test", stepId: "e2e" },
    { kind: "step_failed", jobId: "test", stepId: "e2e", error: "timed out" },
    { kind: "completed", run: { status: "failed" } },
  ]);
  assertEquals(state.steps["test/e2e"].error, "timed out");
  assertEquals(state.status, "failed");
});

Deno.test("runReducer: a nested run's start does not replace the run followed", () => {
  const state = replay([
    { kind: "started", runId: "outer", workflowName: "w" },
    {
      kind: "started",
      runId: "inner",
      workflowName: "x",
      parentRunId: "outer",
    },
  ]);
  assertEquals(state.runId, "outer");
});

Deno.test("runReducer: an attach names the run and when it really started", () => {
  const state = replay([
    { kind: "attached", runId: "r9", startedAt: "1970-01-01T00:00:00.050Z" },
  ]);
  assertEquals([state.runId, state.startedAt], ["r9", 50]);
});

Deno.test("runReducer: a run on another instance is not a failure; a lost one is", () => {
  const elsewhere = replay([
    { kind: "elsewhere", runId: "r", instanceId: "b" },
  ]);
  assertEquals(elsewhere.status, "running");
  assertEquals(elsewhere.error?.includes("instance b"), true);
  const lost = replay([{ kind: "interrupted", runId: "r", instanceId: "b" }]);
  assertEquals(lost.status, "failed");
});

Deno.test("runReducer: an unknown event kind changes nothing", () => {
  const before = replay([]);
  const after = runReducer(before, {
    kind: "event",
    at: 1,
    event: { kind: "something_newer" } as unknown as RunStreamEvent,
  });
  assertEquals(after, before);
});

Deno.test("runReducer: the log keeps the most recent entries only", () => {
  const lines = Array.from({ length: 450 }, (_, i) => ({
    kind: "method_output",
    jobId: "j",
    stepId: "s",
    stream: "stdout",
    line: `l${i}`,
  }));
  const state = replay(lines);
  assertEquals(state.log.length, 400);
  assertEquals(state.log.at(-1)?.text, "s: l449");
  assertEquals(state.steps["j/s"].output.length, 50);
});

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

Deno.test("runReducer: a replayed history keeps serve's timing, though it arrives at once", () => {
  const arrival = T0 + 60_000;
  let state = runReducer(IDLE_RUN, { kind: "begin", at: arrival });
  for (
    const event of [
      { kind: "started", runId: "r", workflowName: "w", at: iso(0) },
      { kind: "step_started", jobId: "j", stepId: "a", at: iso(1000) },
      { kind: "step_completed", jobId: "j", stepId: "a", at: iso(4000) },
    ]
  ) {
    state = runReducer(state, {
      kind: "event",
      at: arrival,
      event: event as RunStreamEvent,
    });
  }
  const step = state.steps["j/a"];
  assertEquals(state.startedAt, T0);
  assertEquals([step.startedAt, step.endedAt], [T0 + 1000, T0 + 4000]);
});

Deno.test("runReducer: a browser clock ahead of serve's still grows live bars to serve's now", () => {
  const ahead = 10_000;
  let state = runReducer(IDLE_RUN, { kind: "begin", at: T0 + ahead });
  state = runReducer(state, {
    kind: "event",
    at: T0 + ahead + 50,
    event: {
      kind: "started",
      runId: "r",
      workflowName: "w",
      at: iso(0),
    } as RunStreamEvent,
  });
  assertEquals(state.clockOffsetMs, ahead + 50);
  assertEquals(state.startedAt, T0);
  // three seconds later by the browser's clock is three seconds into the run
  assertEquals(runClock(state, T0 + ahead + 50 + 3000), T0 + 3000);
});

Deno.test("runReducer: a run continued after a serve restart keeps the recorded starts its started and job_started send again", () => {
  const continued = 9_500;
  let state = runReducer(IDLE_RUN, { kind: "begin", at: T0 });
  for (
    const event of [
      {
        kind: "started",
        runId: "r",
        workflowName: "w",
        startedAt: iso(0),
        at: iso(0),
      },
      { kind: "job_started", jobId: "j", startedAt: iso(0), at: iso(0) },
      {
        kind: "step_started",
        jobId: "j",
        stepId: "a",
        startedAt: iso(0),
        at: iso(0),
      },
      { kind: "step_completed", jobId: "j", stepId: "a", at: iso(8000) },
      {
        kind: "started",
        runId: "r",
        workflowName: "w",
        startedAt: iso(0),
        at: iso(continued),
      },
      {
        kind: "job_started",
        jobId: "j",
        startedAt: iso(0),
        at: iso(continued),
      },
      {
        kind: "step_started",
        jobId: "j",
        stepId: "b",
        startedAt: iso(continued),
        at: iso(continued),
      },
    ]
  ) {
    state = runReducer(state, {
      kind: "event",
      at: T0 + 60_000,
      event: event as RunStreamEvent,
    });
  }
  assertEquals(state.startedAt, T0);
  assertEquals(state.jobs["j"].startedAt, T0);
  assertEquals(state.steps["j/b"].startedAt, T0 + continued);
  assertEquals(state.log.filter((e) => e.kind === "started").length, 1);
  assertEquals(
    state.log.filter((e) => e.text === "j started").length,
    1,
  );
});

Deno.test("runReducer: a late attach still logs the run's started once it is replayed", () => {
  const state = replay([
    { kind: "attached", runId: "r", startedAt: iso(0) },
    { kind: "started", runId: "r", workflowName: "w", startedAt: iso(0) },
  ]);
  assertEquals(state.log.map((e) => e.kind), ["attached", "started"]);
});

Deno.test("runReducer: an older serve's started sent again without startedAt keeps the run's first start", () => {
  let state = runReducer(IDLE_RUN, { kind: "begin", at: T0 });
  for (
    const event of [
      { kind: "started", runId: "r", workflowName: "w", at: iso(0) },
      { kind: "started", runId: "r", workflowName: "w", at: iso(9_500) },
    ]
  ) {
    state = runReducer(state, {
      kind: "event",
      at: T0 + 60_000,
      event: event as RunStreamEvent,
    });
  }
  assertEquals(state.startedAt, T0);
});

Deno.test("runReducer: a step started again with its recorded start is logged once", () => {
  const state = replay([
    { kind: "started", runId: "r", workflowName: "w", startedAt: iso(0) },
    { kind: "step_started", jobId: "j", stepId: "wait", startedAt: iso(0) },
    { kind: "step_started", jobId: "j", stepId: "wait", startedAt: iso(0) },
  ]);
  assertEquals(state.log.filter((e) => e.kind === "step").length, 1);
  assertEquals(state.steps["j/wait"].startedAt, T0);
});
