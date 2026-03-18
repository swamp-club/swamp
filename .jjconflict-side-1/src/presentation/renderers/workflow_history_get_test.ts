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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { WorkflowHistoryGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createWorkflowHistoryGetRenderer } from "./workflow_history_get.ts";

const testData = {
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "my-workflow",
  status: "succeeded" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
  jobs: [],
  path: ".swamp/runs/run-1",
};

async function* toStream(
  events: WorkflowHistoryGetEvent[],
): AsyncGenerator<WorkflowHistoryGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogWorkflowHistoryGetRenderer - completed event runs without error", async () => {
  const renderer = createWorkflowHistoryGetRenderer("log");
  const events: WorkflowHistoryGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonWorkflowHistoryGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowHistoryGetRenderer("json");
    const events: WorkflowHistoryGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "run-1");
    assertEquals(parsed.workflowName, "my-workflow");
    assertEquals(parsed.status, "succeeded");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogWorkflowHistoryGetRenderer - error event throws UserError", () => {
  const renderer = createWorkflowHistoryGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Workflow run not found" },
      }),
    UserError,
    "Workflow run not found",
  );
});

Deno.test("JsonWorkflowHistoryGetRenderer - error event throws UserError", () => {
  const renderer = createWorkflowHistoryGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Workflow run not found" },
      }),
    UserError,
    "Workflow run not found",
  );
});

Deno.test("createWorkflowHistoryGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createWorkflowHistoryGetRenderer("log");
  const jsonRenderer = createWorkflowHistoryGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
