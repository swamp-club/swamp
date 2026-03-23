// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
} from "./run_search.ts";

const now = Date.now();

function makeRun(overrides: {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: Date;
  completedAt?: Date;
  tags?: Record<string, string>;
}) {
  return {
    id: overrides.id,
    workflowId: overrides.workflowId,
    workflowName: overrides.workflowName,
    status: overrides.status,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    tags: overrides.tags ?? {},
  };
}

function makeDeps(
  overrides: Partial<WorkflowRunSearchDeps> = {},
): WorkflowRunSearchDeps {
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) => {
      if (id === "wf-1") {
        return Promise.resolve([
          makeRun({
            id: "run-1",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "succeeded",
            startedAt: new Date(now - 1000),
            completedAt: new Date(now),
          }),
          makeRun({
            id: "run-2",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "failed",
            startedAt: new Date(now - 5000),
            completedAt: new Date(now - 4000),
          }),
        ]);
      }
      if (id === "wf-2") {
        return Promise.resolve([
          makeRun({
            id: "run-3",
            workflowId: "wf-2",
            workflowName: "test",
            status: "succeeded",
            startedAt: new Date(now - 3000),
            completedAt: new Date(now - 2000),
          }),
        ]);
      }
      return Promise.resolve([]);
    },
    ...overrides,
  };
}

Deno.test("workflowRunSearch: returns all runs sorted by startedAt desc", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.results.length, 3);
  // Most recent first
  assertEquals(completed.data.results[0].runId, "run-1");
  assertEquals(completed.data.results[1].runId, "run-3");
  assertEquals(completed.data.results[2].runId, "run-2");
});

Deno.test("workflowRunSearch: filters by status", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { status: "failed" }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-2");
  assertEquals(completed.data.results[0].status, "failed");
});

Deno.test("workflowRunSearch: filters by since", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
    findAllRunsByWorkflowId: () =>
      Promise.resolve([
        makeRun({
          id: "run-recent",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 1000),
        }),
        makeRun({
          id: "run-old",
          workflowId: "wf-1",
          workflowName: "deploy",
          status: "succeeded",
          startedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        }),
      ]),
  });

  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { since: "1d" }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].runId, "run-recent");
});

Deno.test("workflowRunSearch: applies limit", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowRunSearchEvent>(
    workflowRunSearch(createLibSwampContext(), deps, { limit: 2 }),
  );

  const completed = events[1] as Extract<
    WorkflowRunSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 2);
});
