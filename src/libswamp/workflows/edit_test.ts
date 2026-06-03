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
  workflowEdit,
  type WorkflowEditDeps,
  type WorkflowEditEvent,
} from "./edit.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";

function makeDeps(
  overrides: Partial<WorkflowEditDeps> = {},
): WorkflowEditDeps {
  return {
    findById: () => Promise.resolve(null),
    findByName: () => Promise.resolve(null),
    getPath: () => "/fake/path/workflow.yaml",
    resolveSymlink: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(true),
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
    updateFromStdin: () =>
      Promise.resolve(
        {
          name: "updated",
          id: "00000000-0000-4000-8000-000000000000",
        } as unknown as Workflow,
      ),
    ...overrides,
  };
}

const testWorkflow = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "deploy-workflow",
  description: "Deploy to production",
  jobs: [],
} as unknown as Workflow;

Deno.test("workflowEdit: yields error when workflow not found by name", async () => {
  const deps = makeDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "missing-workflow",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowEdit: yields error when workflow not found by UUID", async () => {
  const deps = makeDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowEdit: opens editor when workflow found by name", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    getPath: () => "/repo/workflows/deploy-workflow/workflow.yaml",
    openEditor: () => Promise.resolve({ editor: "Neovim" }),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        path: "/repo/workflows/deploy-workflow/workflow.yaml",
        editor: "Neovim",
        status: "opened",
        name: "deploy-workflow",
        id: "550e8400-e29b-41d4-a716-446655440000",
      },
    },
  ]);
});

Deno.test("workflowEdit: falls back to symlink when name lookup fails", async () => {
  const deps = makeDeps({
    findByName: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/extensions/workflows/broken/workflow.yaml"),
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "broken",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        path: "/repo/extensions/workflows/broken/workflow.yaml",
        editor: "VS Code",
        status: "opened",
        name: "broken",
        id: "unknown",
      },
    },
  ]);
});

Deno.test("workflowEdit: resolves symlink for extension workflows when file missing", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    getPath: () => "/repo/workflows/deploy-workflow/workflow.yaml",
    fileExists: () => Promise.resolve(false),
    resolveSymlink: () =>
      Promise.resolve(
        "/repo/extensions/workflows/deploy-workflow/workflow.yaml",
      ),
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowEditEvent,
    { kind: "completed" }
  >;
  assertEquals(
    completed.data.path,
    "/repo/extensions/workflows/deploy-workflow/workflow.yaml",
  );
});

Deno.test("workflowEdit: yields error for broken workflow with stdin", async () => {
  const deps = makeDeps({
    findByName: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/workflows/broken/workflow.yaml"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "broken",
      stdinContent: "name: foo\n",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});
