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
import type { WorkflowGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createWorkflowGetRenderer } from "./workflow_get.ts";

const testData = {
  id: "wf-1",
  name: "my-workflow",
  version: 1,
  jobs: [],
  path: "/repo/workflows/my-workflow.yaml",
};

async function* toStream(
  events: WorkflowGetEvent[],
): AsyncGenerator<WorkflowGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogWorkflowGetRenderer - completed event runs without error", async () => {
  const renderer = createWorkflowGetRenderer("log");
  const events: WorkflowGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonWorkflowGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowGetRenderer("json");
    const events: WorkflowGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "wf-1");
    assertEquals(parsed.name, "my-workflow");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogWorkflowGetRenderer - error event throws UserError", () => {
  const renderer = createWorkflowGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Workflow not found" },
      }),
    UserError,
    "Workflow not found",
  );
});

Deno.test("JsonWorkflowGetRenderer - error event throws UserError", () => {
  const renderer = createWorkflowGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Workflow not found" },
      }),
    UserError,
    "Workflow not found",
  );
});

Deno.test("createWorkflowGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createWorkflowGetRenderer("log");
  const jsonRenderer = createWorkflowGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
