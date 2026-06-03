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
import { EventBridge } from "./workflow_run_tree.tsx";
import type { TreeAction } from "./state.ts";

Deno.test("EventBridge: buffers events before connect and flushes as batch", () => {
  const bridge = new EventBridge();
  const received: TreeAction[] = [];

  bridge.push({
    kind: "started",
    runId: "r1",
    workflowName: "test",
    jobs: [],
  });
  bridge.push({ kind: "job_started", jobId: "j1" });

  bridge.connect((action) => received.push(action));

  // Buffered events are flushed as a single batch action
  assertEquals(received.length, 1);
  const action = received[0];
  assertEquals("type" in action && action.type, "batch");
  if ("type" in action && action.type === "batch") {
    assertEquals(action.events.length, 2);
    assertEquals(action.events[0].kind, "started");
    assertEquals(action.events[1].kind, "job_started");
  }
});

Deno.test("EventBridge: batches rapid events via microtask", async () => {
  const bridge = new EventBridge();
  const received: TreeAction[] = [];

  bridge.connect((action) => received.push(action));

  // Push multiple events synchronously — they should batch
  bridge.push({
    kind: "started",
    runId: "r1",
    workflowName: "test",
    jobs: [],
  });
  bridge.push({ kind: "job_started", jobId: "j1" });
  bridge.push({ kind: "job_started", jobId: "j2" });

  // Nothing dispatched yet (pending microtask)
  assertEquals(received.length, 0);

  // Wait for microtask to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(received.length, 1);
  const action = received[0];
  if ("type" in action && action.type === "batch") {
    assertEquals(action.events.length, 3);
  }
});

Deno.test("EventBridge: close flushes pending events", () => {
  const bridge = new EventBridge();
  const received: TreeAction[] = [];

  bridge.connect((action) => received.push(action));

  bridge.push({
    kind: "started",
    runId: "r1",
    workflowName: "test",
    jobs: [],
  });
  // Close before microtask fires — should flush immediately
  bridge.close();

  assertEquals(received.length, 1);

  // Further pushes are ignored
  bridge.push({ kind: "job_started", jobId: "j1" });
  assertEquals(received.length, 1);
});
