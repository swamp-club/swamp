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
import { InkWorkflowRunRenderer } from "./renderer.tsx";
import type { WorkflowRunEvent } from "../../../libswamp/mod.ts";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCompletedEvent(): Extract<
  WorkflowRunEvent,
  { kind: "completed" }
> {
  return {
    kind: "completed",
    run: {
      id: "run-1",
      workflowId: "wf-1",
      workflowName: "test-wf",
      status: "succeeded",
      jobs: [],
    },
  } as Extract<WorkflowRunEvent, { kind: "completed" }>;
}

function makeSuspendedEvent(): Extract<
  WorkflowRunEvent,
  { kind: "suspended" }
> {
  return {
    kind: "suspended",
    run: {
      id: "run-1",
      workflowId: "wf-1",
      workflowName: "test-wf",
      status: "suspended",
      jobs: [],
    },
    jobId: "job-1",
    stepId: "approve-deploy",
    prompt: "Approve?",
  } as Extract<WorkflowRunEvent, { kind: "suspended" }>;
}

Deno.test({
  name:
    "InkWorkflowRunRenderer: completed handler returns a promise that resolves after cleanup",
  ...inkTestOptions,
  fn: async () => {
    const renderer = new InkWorkflowRunRenderer({
      workflowName: "test-wf",
    });
    const handlers = renderer.handlers();

    // Feed the required started event so the component can transition to done
    handlers.started({
      kind: "started",
      runId: "run-1",
      workflowName: "test-wf",
      jobs: [],
    });
    await tick(100);

    // The completed handler should be async and await cleanup
    const completedResult = handlers.completed(makeCompletedEvent());
    // Should return a promise (async handler)
    assertEquals(completedResult instanceof Promise, true);

    // Await it — if cleanup races, this would hang or the process would
    // exit before cleanup completes (which was the original H11 bug)
    const raceResult = await Promise.race([
      Promise.resolve(completedResult).then(() => "resolved" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);

    assertEquals(raceResult, "resolved");
  },
});

Deno.test({
  name:
    "InkWorkflowRunRenderer: suspended handler resolves without timeout (no deferred cleanup)",
  ...inkTestOptions,
  fn: async () => {
    const renderer = new InkWorkflowRunRenderer({
      workflowName: "my-deploy",
    });
    const handlers = renderer.handlers();

    handlers.started({
      kind: "started",
      runId: "run-1",
      workflowName: "my-deploy",
      jobs: [],
    });
    await tick(100);

    // The suspended handler should be async and resolve deterministically
    // (not deferred behind a setTimeout that races Deno.exit)
    const suspendedResult = handlers.suspended(makeSuspendedEvent());
    assertEquals(suspendedResult instanceof Promise, true);

    const raceResult = await Promise.race([
      Promise.resolve(suspendedResult).then(() => "resolved" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);

    assertEquals(raceResult, "resolved");
  },
});
