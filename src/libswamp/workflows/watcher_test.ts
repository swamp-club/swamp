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
import { join } from "@std/path";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { WorkflowWatcher } from "./watcher.ts";

function repoWith(workflows: Workflow[]): WorkflowRepository {
  return {
    findAll: () => Promise.resolve(workflows),
    getPath: (id: WorkflowId) => join("workflows", `workflow-${id}.yaml`),
  } as unknown as WorkflowRepository;
}

Deno.test("WorkflowWatcher.scanExisting: reports only workflows with a schedule", async () => {
  const scheduled = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "nightly",
    schedule: "0 0 * * *",
  } as unknown as Workflow;
  const unscheduled = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    name: "manual",
  } as unknown as Workflow;
  const changes: Array<[string, string | null, string]> = [];

  const watcher = new WorkflowWatcher(
    "workflows",
    repoWith([scheduled, unscheduled]),
    (id, schedule, name) => changes.push([id, schedule, name]),
  );
  await watcher.scanExisting();

  assertEquals(changes, [[scheduled.id, "0 0 * * *", "nightly"]]);
});

Deno.test("WorkflowWatcher.start: skips watching when the directory does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_watcher_" });
  try {
    const watcher = new WorkflowWatcher(
      join(dir, "missing"),
      repoWith([]),
      () => {},
    );
    await watcher.start();
    await watcher.stop();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
