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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { RunIndexSnapshot } from "./run_index_snapshot.ts";
import type { WorkflowRunSummary } from "./workflow_run_summary.ts";

const T0 = Date.UTC(2026, 0, 1);

function run(
  id: string,
  startMs?: number,
  extra: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    id,
    workflowId: "wf-1",
    workflowName: "deploy",
    status: "succeeded",
    ...(startMs !== undefined ? { startedAt: new Date(startMs) } : {}),
    tags: {},
    inputs: {},
    ...extra,
  };
}

function ids(runs: readonly { summary: WorkflowRunSummary }[]): string[] {
  return runs.map((r) => r.summary.id);
}

Deno.test("RunIndexSnapshot.of: orders newest first, keeps the given order on ties, and puts startless runs at the epoch", () => {
  const snapshot = RunIndexSnapshot.of([
    run("old", T0),
    run("none"),
    run("tie-a", T0 + 1000),
    run("new", T0 + 2000),
    run("tie-b", T0 + 1000),
  ]);
  assertEquals(ids(snapshot.runs), ["new", "tie-a", "tie-b", "old", "none"]);
  assertEquals(snapshot.size, 5);
  assertEquals(snapshot.newestStartMs, T0 + 2000);
});

Deno.test("RunIndexSnapshot.between: since is inclusive, until exclusive, and either bound drops startless runs", () => {
  const snapshot = RunIndexSnapshot.of([
    run("a", T0),
    run("b", T0 + 1000),
    run("c", T0 + 2000),
    run("none"),
  ]);
  assertEquals(ids(snapshot.between(T0 + 1000)), ["c", "b"]);
  assertEquals(ids(snapshot.between(undefined, T0 + 2000)), ["b", "a"]);
  assertEquals(ids(snapshot.between(T0, T0 + 2000)), ["b", "a"]);
  assertEquals(ids(snapshot.between(T0 + 3000)), []);
  assertEquals(ids(snapshot.between()), ["c", "b", "a", "none"]);
  // A window that spans the epoch still leaves startless runs out.
  assertEquals(ids(snapshot.between(-1)), ["c", "b", "a"]);
  assertEquals(ids(snapshot.between(undefined, 1)), []);
});

Deno.test("RunIndexSnapshot: an invalid start time counts as none", () => {
  const snapshot = RunIndexSnapshot.of([
    run("bad", undefined, { startedAt: new Date("not a date") }),
    run("good", T0),
  ]);
  assertEquals(ids(snapshot.runs), ["good", "bad"]);
  assertEquals(snapshot.runs[1].startMs, undefined);
  assertEquals(snapshot.runs[1].startedAt, undefined);
  assertEquals(ids(snapshot.between(0)), ["good"]);
});

Deno.test("RunIndexSnapshot.get: finds a run by id ignoring case", () => {
  const snapshot = RunIndexSnapshot.of([run("AbC-1", T0)]);
  assertEquals(snapshot.get("abc-1")?.summary.id, "AbC-1");
  assertEquals(snapshot.get("ABC-1")?.summary.id, "AbC-1");
  assertEquals(snapshot.get("missing"), undefined);
});

Deno.test("RunIndexSnapshot: records every workflow name and status the runs carry", () => {
  const snapshot = RunIndexSnapshot.of([
    run("a", T0, { workflowName: "old-name", status: "failed" }),
    run("b", T0, { workflowName: "deploy" }),
  ]);
  assertEquals([...snapshot.recordedNames].sort(), ["deploy", "old-name"]);
  assertEquals([...snapshot.distinctStatuses].sort(), ["failed", "succeeded"]);
});

Deno.test("RunIndexSnapshot: runs and what they hold are frozen", () => {
  const snapshot = RunIndexSnapshot.of([
    run("a", T0, { tags: { env: "prod" }, inputs: { nested: { n: 1 } } }),
  ]);
  const entry = snapshot.runs[0];
  assert(Object.isFrozen(snapshot.runs));
  assert(Object.isFrozen(entry));
  assert(Object.isFrozen(entry.summary));
  assert(Object.isFrozen(entry.summary.tags));
  assert(Object.isFrozen(entry.summary.inputs.nested));
  assertThrows(() => {
    (entry.summary.tags as Record<string, string>).env = "dev";
  });
});

Deno.test("RunIndexSnapshot: completedAt and ISO times are worked out once", () => {
  const snapshot = RunIndexSnapshot.of([
    run("a", T0, { completedAt: new Date(T0 + 500) }),
  ]);
  const entry = snapshot.runs[0];
  assertEquals(entry.startedAt, new Date(T0).toISOString());
  assertEquals(entry.completedMs, T0 + 500);
  assertEquals(entry.completedAt, new Date(T0 + 500).toISOString());
});

Deno.test("RunIndexSnapshot.of: a workflow with no runs", () => {
  const snapshot = RunIndexSnapshot.of([]);
  assertEquals(snapshot.size, 0);
  assertEquals(snapshot.newestStartMs, undefined);
  assertEquals(snapshot.between(0, 1), []);
});
