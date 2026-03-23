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
  workflowCreate,
  type WorkflowCreateDeps,
  type WorkflowCreateEvent,
} from "./create.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";

function makeDeps(
  overrides: Partial<WorkflowCreateDeps> = {},
): WorkflowCreateDeps {
  return {
    findByName: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    getPath: () => "/repo/workflows/my-workflow.yaml",
    ...overrides,
  };
}

Deno.test("workflowCreate: yields completed on successful creation", async () => {
  let savedWorkflow: Workflow | null = null;
  const deps = makeDeps({
    save: (workflow) => {
      savedWorkflow = workflow;
      return Promise.resolve();
    },
    getPath: () => "/repo/workflows/my-workflow.yaml",
  });

  const events = await collect<WorkflowCreateEvent>(
    workflowCreate(createLibSwampContext(), deps, { name: "my-workflow" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const completed = events[1] as Extract<
    WorkflowCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.name, "my-workflow");
  assertEquals(completed.data.path, "/repo/workflows/my-workflow.yaml");
  assertEquals(completed.data.jobs.length, 1);
  assertEquals(completed.data.jobs[0].name, "main");
  assertEquals(completed.data.jobs[0].steps.length, 1);
  assertEquals(completed.data.jobs[0].steps[0].name, "example");
  assertEquals(savedWorkflow !== null, true);
});

Deno.test("workflowCreate: yields error when name already exists", async () => {
  const deps = makeDeps({
    findByName: () =>
      Promise.resolve({
        id: "wf-1",
        name: "existing-workflow",
      } as unknown as Workflow),
  });

  const events = await collect<WorkflowCreateEvent>(
    workflowCreate(createLibSwampContext(), deps, {
      name: "existing-workflow",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<
    WorkflowCreateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "already_exists");
});
