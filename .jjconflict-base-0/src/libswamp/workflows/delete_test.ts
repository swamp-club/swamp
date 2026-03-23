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
  workflowDelete,
  type WorkflowDeleteDeps,
  type WorkflowDeleteEvent,
  workflowDeletePreview,
} from "./delete.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";

const testWorkflow = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "deploy-workflow",
} as unknown as Workflow;

function makeDeps(
  overrides: Partial<WorkflowDeleteDeps> = {},
): WorkflowDeleteDeps {
  return {
    findById: () => Promise.resolve(testWorkflow),
    findByName: () => Promise.resolve(testWorkflow),
    getPath: () => "/repo/workflows/deploy-workflow/workflow.yaml",
    pathExists: () => Promise.resolve(true),
    countRuns: () => Promise.resolve(0),
    deleteRuns: () => Promise.resolve(0),
    deleteEvaluated: () => Promise.resolve(),
    deleteWorkflow: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("workflowDeletePreview: returns preview data with run count", async () => {
  const deps = makeDeps({ countRuns: () => Promise.resolve(5) });

  const preview = await workflowDeletePreview(
    createLibSwampContext(),
    deps,
    { workflowIdOrName: "deploy-workflow" },
  );

  assertEquals(preview.name, "deploy-workflow");
  assertEquals(preview.runCount, 5);
});

Deno.test("workflowDeletePreview: throws not_found for missing workflow", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
  });

  try {
    await workflowDeletePreview(
      createLibSwampContext(),
      deps,
      { workflowIdOrName: "missing" },
    );
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_found");
  }
});

Deno.test("workflowDeletePreview: throws validation_failed for extension-only workflow", async () => {
  const deps = makeDeps({
    pathExists: () => Promise.resolve(false),
  });

  try {
    await workflowDeletePreview(
      createLibSwampContext(),
      deps,
      { workflowIdOrName: "deploy-workflow" },
    );
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("workflowDelete: yields completed after successful deletion", async () => {
  let workflowDeleted = false;
  const deps = makeDeps({
    deleteRuns: () => Promise.resolve(3),
    deleteWorkflow: () => {
      workflowDeleted = true;
      return Promise.resolve();
    },
  });

  const events = await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    WorkflowDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "deploy-workflow");
  assertEquals(completed.data.runsDeleted, 3);
  assertEquals(workflowDeleted, true);
});

Deno.test("workflowDelete: yields error when workflow not found", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
  });

  const events = await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "missing",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
