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
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  isUuid,
  workflowGet,
  type WorkflowGetDeps,
  type WorkflowGetEvent,
} from "./get.ts";

const testWorkflow = {
  id: "550e8400-e29b-41d4-a716-446655440000" as unknown as WorkflowId,
  name: "my-workflow",
  version: 1,
  jobs: [{
    name: "job1",
    steps: [{ name: "step1", task: { toData: () => ({ type: "model/run" }) } }],
  }],
};

function makeDeps(overrides: {
  workflow?: typeof testWorkflow | null;
  workflowPath?: string;
}): WorkflowGetDeps {
  return {
    findWorkflow: () =>
      Promise.resolve(
        overrides.workflow as Awaited<
          ReturnType<WorkflowGetDeps["findWorkflow"]>
        >,
      ),
    getWorkflowPath: () =>
      overrides.workflowPath ?? "/workflows/my-workflow.yaml",
  };
}

Deno.test("workflowGet yields resolving -> completed with workflow data on success", async () => {
  const deps = makeDeps({
    workflow: testWorkflow,
    workflowPath: "/workflows/my-workflow.yaml",
  });

  const events = await collect<WorkflowGetEvent>(
    workflowGet(createLibSwampContext(), deps, "my-workflow"),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "my-workflow",
        description: undefined,
        version: 1,
        jobs: [{
          name: "job1",
          description: undefined,
          steps: [{
            name: "step1",
            description: undefined,
            task: { type: "model/run" },
          }],
        }],
        path: "/workflows/my-workflow.yaml",
      },
    },
  ]);
});

Deno.test("workflowGet yields resolving -> error with not_found when workflow does not exist", async () => {
  const deps = makeDeps({ workflow: null });

  const events = await collect<WorkflowGetEvent>(
    workflowGet(createLibSwampContext(), deps, "missing-workflow"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("isUuid returns true for a valid UUID", () => {
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
});

Deno.test("isUuid returns false for a non-UUID string", () => {
  assertEquals(isUuid("my-workflow"), false);
});
