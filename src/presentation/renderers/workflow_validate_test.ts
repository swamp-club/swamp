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
import type { WorkflowValidateEvent } from "../../libswamp/mod.ts";
import { createWorkflowValidateRenderer } from "./workflow_validate.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: WorkflowValidateEvent[],
): AsyncGenerator<WorkflowValidateEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("JsonWorkflowValidateRenderer - single outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createWorkflowValidateRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            workflowId: "wf-1",
            workflowName: "my-wf",
            validations: [{ name: "schema", passed: true }],
            totalWarnings: 0,
            passed: true,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    assertEquals(renderer.passed(), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("WorkflowValidateRenderer - error throws UserError", () => {
  const renderer = createWorkflowValidateRenderer("log");
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
