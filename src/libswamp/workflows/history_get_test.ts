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
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  workflowHistoryGet,
  type WorkflowHistoryGetDeps,
  type WorkflowHistoryGetEvent,
} from "./history_get.ts";

const testWorkflow = {
  id: "wf-1" as unknown as WorkflowId,
  name: "my-workflow",
} as unknown as Workflow;

const testRun = {
  id: "run-1",
  workflowId: "wf-1" as unknown as WorkflowId,
  workflowName: "my-workflow",
  status: "completed",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: new Date("2026-01-01T00:01:00Z"),
  jobs: [],
} as unknown as WorkflowRun;

function makeDeps(
  overrides: Partial<WorkflowHistoryGetDeps> = {},
): WorkflowHistoryGetDeps {
  return {
    findWorkflow: () => Promise.resolve(testWorkflow),
    findLatestRun: () => Promise.resolve(testRun),
    getRunPath: () => "/repo/.swamp/runs/wf-1/run-1",
    ...overrides,
  };
}

Deno.test("workflowHistoryGet yields resolving then completed on happy path", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowHistoryGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, "run-1");
  assertEquals(completed.data.workflowName, "my-workflow");
});

Deno.test("workflowHistoryGet yields error with not_found when workflow not found", async () => {
  const deps = makeDeps({
    findWorkflow: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "unknown-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowHistoryGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowHistoryGet yields error with not_found when no runs exist", async () => {
  const deps = makeDeps({
    findLatestRun: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowHistoryGetEvent>(
    workflowHistoryGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowHistoryGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
