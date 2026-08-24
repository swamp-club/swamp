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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { isServeOwnedRun } from "./workflow_cancel.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

const WORKFLOW_ID = "a0000000-0000-4000-8000-000000000001";

function makeRun(
  overrides: {
    status?:
      | "pending"
      | "running"
      | "suspended"
      | "succeeded"
      | "failed"
      | "cancelled";
    pid?: number;
    instanceId?: string;
  } = {},
): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: overrides.status ?? "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: overrides.pid,
    instanceId: overrides.instanceId,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [{
        stepName: "step1",
        status: "running",
        startedAt: "2026-07-20T20:00:00.000Z",
      }],
    }],
    tags: {},
  });
}

Deno.test("isServeOwnedRun: returns true when instanceId is set", () => {
  const run = makeRun({ instanceId: crypto.randomUUID() });
  assertEquals(isServeOwnedRun(run), true);
});

Deno.test("isServeOwnedRun: returns false when instanceId is undefined", () => {
  const run = makeRun();
  assertEquals(isServeOwnedRun(run), false);
});

Deno.test("isServeOwnedRun: returns false for CLI-started run with pid", () => {
  const run = makeRun({ pid: 12345 });
  assertEquals(isServeOwnedRun(run), false);
});

Deno.test("isServeOwnedRun: returns true for serve run with both pid and instanceId", () => {
  const run = makeRun({ pid: 12345, instanceId: crypto.randomUUID() });
  assertEquals(isServeOwnedRun(run), true);
});

Deno.test("workflowCancelCommand module loads", async () => {
  const { workflowCancelCommand } = await import("./workflow_cancel.ts");
  assertEquals(workflowCancelCommand.getName(), "cancel");
});
