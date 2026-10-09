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

import { assertEquals, assertRejects } from "@std/assert";
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
    listRunIds: () => Promise.resolve([]),
    deleteRunSnapshots: () => Promise.resolve(),
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

Deno.test("workflowDelete: collects run IDs first, deletes the runs, then their snapshots", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    listRunIds: (workflowId) => {
      calls.push(`list:${workflowId}`);
      return Promise.resolve(["run-a", "run-b"]);
    },
    deleteRuns: () => {
      calls.push("runs");
      return Promise.resolve(2);
    },
    deleteRunSnapshots: (runIds) => {
      calls.push(`snapshots:${runIds.join(",")}`);
      return Promise.resolve();
    },
  });

  await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  assertEquals(calls, [
    `list:${testWorkflow.id}`,
    "runs",
    "snapshots:run-a,run-b",
  ]);
});

Deno.test("workflowDelete: a failed run delete leaves the snapshots in place", async () => {
  let snapshotsDeleted = false;
  const deps = makeDeps({
    listRunIds: () => Promise.resolve(["run-a"]),
    deleteRuns: () => Promise.reject(new Error("disk error")),
    deleteRunSnapshots: () => {
      snapshotsDeleted = true;
      return Promise.resolve();
    },
  });

  await assertRejects(() =>
    collect<WorkflowDeleteEvent>(
      workflowDelete(createLibSwampContext(), deps, {
        workflowIdOrName: "deploy-workflow",
      }),
    )
  );
  assertEquals(snapshotsDeleted, false);
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

Deno.test("workflowDelete: a UUID is looked up by name first", async () => {
  const deleted: string[] = [];
  const impostor = {
    id: "00000000-0000-4000-8000-000000000000",
    name: testWorkflow.id,
  } as unknown as Workflow;
  const deps = makeDeps({
    findByName: () => Promise.resolve(impostor),
    deleteWorkflow: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  });

  await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
    }),
  );

  assertEquals(deleted, [impostor.id]);
});

Deno.test("workflowDelete: with byId deletes the workflow with that id, never a same-named one", async () => {
  const deleted: string[] = [];
  const impostor = {
    id: "00000000-0000-4000-8000-000000000000",
    name: testWorkflow.id,
  } as unknown as Workflow;
  const deps = makeDeps({
    findByName: () => Promise.resolve(impostor),
    findById: () => Promise.resolve(testWorkflow),
    deleteWorkflow: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  });

  await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      byId: true,
    }),
  );

  assertEquals(deleted, [testWorkflow.id]);
});

Deno.test("workflowDelete: removes the signal wait records of the deleted runs, after the runs", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    listRunIds: () => Promise.resolve(["run-a", "run-b"]),
    deleteRuns: () => {
      calls.push("runs");
      return Promise.resolve(2);
    },
    // The workflow id comes too, for the workflow's key records.
    deleteWaitRecords: (runIds, workflowId) => {
      calls.push(`waits:${runIds.join(",")}@${workflowId}`);
      return Promise.resolve();
    },
  });

  await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  assertEquals(calls, ["runs", `waits:run-a,run-b@${testWorkflow.id}`]);
});

Deno.test("workflowDelete: a failed run delete leaves the signal wait records in place", async () => {
  let removed = false;
  const deps = makeDeps({
    deleteRuns: () => Promise.reject(new Error("disk full")),
    deleteWaitRecords: () => {
      removed = true;
      return Promise.resolve();
    },
  });

  await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  ).catch(() => {});

  assertEquals(removed, false);
});

Deno.test("workflowDelete: an unreachable wait store does not leave the workflow half deleted", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    deleteWaitRecords: () => Promise.reject(new Error("bucket unreachable")),
    deleteEvaluated: () => {
      calls.push("evaluated");
      return Promise.resolve();
    },
    deleteWorkflow: () => {
      calls.push("workflow");
      return Promise.resolve();
    },
  });

  const events = await collect<WorkflowDeleteEvent>(
    workflowDelete(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  assertEquals(calls, ["evaluated", "workflow"]);
  assertEquals(events.at(-1)?.kind, "completed");
});
