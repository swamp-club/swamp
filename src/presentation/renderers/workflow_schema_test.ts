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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { WorkflowSchemaEvent } from "../../libswamp/mod.ts";
import { createWorkflowSchemaRenderer } from "./workflow_schema.ts";
import { UserError } from "../../domain/errors.ts";

function makeSchemaData() {
  return {
    workflow: { type: "object" },
    job: { type: "object" },
    jobDependency: { type: "object" },
    step: { type: "object" },
    stepDependency: { type: "object" },
    stepTask: { type: "object" },
    triggerCondition: { type: "object" },
  };
}

async function* toStream(
  events: WorkflowSchemaEvent[],
): AsyncGenerator<WorkflowSchemaEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogWorkflowSchemaRenderer - completed event outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowSchemaRenderer("log");
    await consumeStream(
      toStream([{ kind: "completed", data: makeSchemaData() }]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.workflow, { type: "object" });
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonWorkflowSchemaRenderer - completed event outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowSchemaRenderer("json");
    await consumeStream(
      toStream([{ kind: "completed", data: makeSchemaData() }]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.job, { type: "object" });
  } finally {
    console.log = originalLog;
  }
});

Deno.test("WorkflowSchemaRenderer - error throws UserError", () => {
  const renderer = createWorkflowSchemaRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});
