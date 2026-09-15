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
import { createRunMatcher } from "./run_lookup.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

const WORKFLOW_ID = "550e8400-e29b-41d4-a716-446655440000" as WorkflowId;
const TARGET_ID = "9f3c1a7e-5b2d-4e8a-9c1f-2d4b6a8e0c31";
const OTHER_ID = "9f3c1a7e-0000-4e8a-9c1f-2d4b6a8e0c31";

function makeRun(id: string, status: "running" | "succeeded"): WorkflowRun {
  return WorkflowRun.fromData({
    id,
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status,
    startedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    jobs: [],
    tags: {},
    logFile: "/abs/path/run.log",
  });
}

/**
 * Counting fake. The point of the fix is a call that must NOT happen, so the
 * call counts are the assertion, not an implementation detail.
 */
function fakeRepo(runs: WorkflowRun[]) {
  const calls = { findGlobalById: 0, findAllGlobal: 0 };
  return {
    calls,
    findGlobalById: (runId: WorkflowRunId) => {
      calls.findGlobalById++;
      const run = runs.find((r) => r.id === runId);
      return Promise.resolve(
        run ? { run, workflowId: WORKFLOW_ID } : null,
      );
    },
    findAllGlobal: () => {
      calls.findAllGlobal++;
      return Promise.resolve(
        runs.map((run) => ({ run, workflowId: WORKFLOW_ID })),
      );
    },
  };
}

Deno.test("createRunMatcher: resolves a complete UUID without loading the global history", async () => {
  const repo = fakeRepo([
    makeRun(TARGET_ID, "running"),
    makeRun(OTHER_ID, "running"),
  ]);
  const match = createRunMatcher(repo);

  const result = await match(TARGET_ID);

  assertEquals(result.status, "found");
  assertEquals(result.match?.id, TARGET_ID);
  assertEquals(repo.calls.findGlobalById, 1);
  assertEquals(repo.calls.findAllGlobal, 0);
});

Deno.test("createRunMatcher: takes the fast path for an uppercase complete UUID", async () => {
  const repo = fakeRepo([makeRun(TARGET_ID, "running")]);
  const match = createRunMatcher(repo);

  const result = await match(TARGET_ID.toUpperCase());

  assertEquals(result.status, "found");
  assertEquals(result.match?.id, TARGET_ID);
  assertEquals(repo.calls.findAllGlobal, 0);
});

Deno.test("createRunMatcher: takes the fast path for a complete UUID with dashes stripped", async () => {
  const repo = fakeRepo([makeRun(TARGET_ID, "running")]);
  const match = createRunMatcher(repo);

  const result = await match(TARGET_ID.replaceAll("-", ""));

  assertEquals(result.status, "found");
  assertEquals(result.match?.id, TARGET_ID);
  assertEquals(repo.calls.findAllGlobal, 0);
});

Deno.test("createRunMatcher: fast path returns the run with its absolute logFile", async () => {
  const repo = fakeRepo([makeRun(TARGET_ID, "running")]);

  const result = await createRunMatcher(repo)(TARGET_ID);

  assertEquals(result.match?.logFile, "/abs/path/run.log");
});

Deno.test("createRunMatcher: a prefix still scans and reports ambiguity with every candidate", async () => {
  const repo = fakeRepo([
    makeRun(TARGET_ID, "running"),
    makeRun(OTHER_ID, "running"),
  ]);
  const match = createRunMatcher(repo);

  const result = await match("9f3c1a7e");

  assertEquals(result.status, "ambiguous");
  assertEquals(
    result.matches?.map((m) => m.id).sort(),
    [OTHER_ID, TARGET_ID].sort(),
  );
  assertEquals(repo.calls.findGlobalById, 0);
  assertEquals(repo.calls.findAllGlobal, 1);
});

Deno.test("createRunMatcher: a unique prefix still resolves through the scan", async () => {
  const repo = fakeRepo([
    makeRun(TARGET_ID, "running"),
    makeRun(OTHER_ID, "running"),
  ]);

  const result = await createRunMatcher(repo)("9f3c1a7e-5b2d");

  assertEquals(result.status, "found");
  assertEquals(result.match?.id, TARGET_ID);
  assertEquals(repo.calls.findAllGlobal, 1);
});

Deno.test("createRunMatcher: an unknown complete UUID falls back to the scan and reports not_found", async () => {
  const repo = fakeRepo([makeRun(OTHER_ID, "running")]);

  const result = await createRunMatcher(repo)(TARGET_ID);

  assertEquals(result.status, "not_found");
  assertEquals(repo.calls.findGlobalById, 1);
  assertEquals(repo.calls.findAllGlobal, 1);
});

Deno.test("createRunMatcher: a null from findGlobalById falls back to the scan rather than reporting not_found", async () => {
  // The run exists, but the targeted lookup missed it — the deleted-mid-lookup
  // and non-canonical-filename cases. The scan must still find it.
  const run = makeRun(TARGET_ID, "running");
  const calls = { findGlobalById: 0, findAllGlobal: 0 };
  const repo = {
    findGlobalById: () => {
      calls.findGlobalById++;
      return Promise.resolve(null);
    },
    findAllGlobal: () => {
      calls.findAllGlobal++;
      return Promise.resolve([{ run, workflowId: WORKFLOW_ID }]);
    },
  };

  const result = await createRunMatcher(repo)(TARGET_ID);

  assertEquals(result.status, "found");
  assertEquals(result.match?.id, TARGET_ID);
  assertEquals(calls.findAllGlobal, 1);
});

Deno.test("createRunMatcher: a workflow name is left to the scan", async () => {
  const repo = fakeRepo([makeRun(TARGET_ID, "running")]);

  const result = await createRunMatcher(repo)("nightly-build");

  assertEquals(result.status, "not_found");
  assertEquals(repo.calls.findGlobalById, 0);
});

Deno.test("createRunMatcher: repeated lookups reflect the current persisted status", async () => {
  // Nothing may be cached between calls: `workflow history get` is how a user
  // watches a run progress.
  let status: "running" | "succeeded" = "running";
  const repo = {
    findGlobalById: () =>
      Promise.resolve({
        run: makeRun(TARGET_ID, status),
        workflowId: WORKFLOW_ID,
      }),
    findAllGlobal: () => Promise.resolve([]),
  };
  const match = createRunMatcher(repo);

  assertEquals((await match(TARGET_ID)).match?.status, "running");
  status = "succeeded";
  assertEquals((await match(TARGET_ID)).match?.status, "succeeded");
});
