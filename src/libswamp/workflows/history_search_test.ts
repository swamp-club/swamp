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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowHistorySearch,
  type WorkflowHistorySearchDeps,
  type WorkflowHistorySearchEvent,
} from "./history_search.ts";

const now = Date.now();

function makeDeps(
  overrides: Partial<WorkflowHistorySearchDeps> = {},
): WorkflowHistorySearchDeps {
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        { id: "wf-1", name: "deploy" },
        { id: "wf-2", name: "test" },
      ]),
    findAllRunsByWorkflowId: (id: string) => {
      if (id === "wf-1") {
        return Promise.resolve([
          {
            id: "run-1",
            workflowId: "wf-1",
            workflowName: "deploy",
            status: "succeeded",
            startedAt: new Date(now - 1000),
            completedAt: new Date(now),
            tags: {},
          },
        ]);
      }
      if (id === "wf-2") {
        return Promise.resolve([
          {
            id: "run-2",
            workflowId: "wf-2",
            workflowName: "test",
            status: "failed",
            startedAt: new Date(now - 3000),
            completedAt: new Date(now - 2000),
            tags: {},
          },
        ]);
      }
      return Promise.resolve([]);
    },
    ...overrides,
  };
}

Deno.test("workflowHistorySearch: returns all runs sorted by startedAt desc", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  // Most recent first
  assertEquals(completed.data.results[0].runId, "run-1");
  assertEquals(completed.data.results[1].runId, "run-2");
});

Deno.test("workflowHistorySearch: returns empty results when no runs exist", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([{ id: "wf-1", name: "deploy" }]),
    findAllRunsByWorkflowId: () => Promise.resolve([]),
  });
  const events = await collect<WorkflowHistorySearchEvent>(
    workflowHistorySearch(createLibSwampContext(), deps, { query: "foo" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    WorkflowHistorySearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "foo");
  assertEquals(completed.data.results.length, 0);
});
