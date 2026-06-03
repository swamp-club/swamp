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
  workflowSearch,
  type WorkflowSearchDeps,
  type WorkflowSearchEvent,
} from "./search.ts";

function makeDeps(
  overrides: Partial<WorkflowSearchDeps> = {},
): WorkflowSearchDeps {
  return {
    findAllWorkflows: () =>
      Promise.resolve([
        {
          id: "wf-1",
          name: "deploy",
          description: "Deploy to production",
          jobs: [{}, {}],
        },
        {
          id: "wf-2",
          name: "test",
          jobs: [{}],
        },
      ]),
    ...overrides,
  };
}

Deno.test("workflowSearch: returns all workflows with no query", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowSearchEvent>(
    workflowSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].id, "wf-1");
  assertEquals(completed.data.results[0].name, "deploy");
  assertEquals(completed.data.results[0].description, "Deploy to production");
  assertEquals(completed.data.results[0].jobCount, 2);
  assertEquals(completed.data.results[1].id, "wf-2");
  assertEquals(completed.data.results[1].name, "test");
  assertEquals(completed.data.results[1].description, undefined);
  assertEquals(completed.data.results[1].jobCount, 1);
});

Deno.test("workflowSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowSearchEvent>(
    workflowSearch(createLibSwampContext(), deps, { query: "deploy" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    WorkflowSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "deploy");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("workflowSearch: returns empty results when no workflows exist", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([]),
  });
  const events = await collect<WorkflowSearchEvent>(
    workflowSearch(createLibSwampContext(), deps, { query: "foo" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    WorkflowSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
