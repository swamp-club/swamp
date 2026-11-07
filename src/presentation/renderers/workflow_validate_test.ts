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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/stream.ts";
import type {
  WorkflowValidateAllData,
  WorkflowValidateEvent,
} from "../../libswamp/workflows/validate.ts";
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

Deno.test("LogWorkflowValidateRenderer - empty workflows prints informational message", async () => {
  const renderer = createWorkflowValidateRenderer("log");
  await consumeStream(
    toStream([
      { kind: "resolving" },
      {
        kind: "completed",
        data: {
          workflows: [],
          totalPassed: 0,
          totalFailed: 0,
          totalWarnings: 0,
          pulledWorkflowsSkipped: 0,
          passed: true,
        },
      },
    ]),
    renderer.handlers(),
  );
  assertEquals(renderer.passed(), true);
});

Deno.test("JsonWorkflowValidateRenderer - empty workflows outputs valid JSON with passed=true", async () => {
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
            workflows: [],
            totalPassed: 0,
            totalFailed: 0,
            totalWarnings: 0,
            pulledWorkflowsSkipped: 0,
            passed: true,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.passed, true);
    assertEquals(parsed.workflows.length, 0);
    assertEquals(renderer.passed(), true);
  } finally {
    console.log = originalLog;
  }
});

async function renderAllLog(data: WorkflowValidateAllData): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createWorkflowValidateRenderer("log");
    await consumeStream(
      toStream([{ kind: "completed", data }]),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const onePassedWorkflow: WorkflowValidateAllData = {
  workflows: [{
    workflowId: "wf-1",
    workflowName: "own-wf",
    validations: [{ name: "schema", passed: true }],
    totalWarnings: 0,
    passed: true,
  }],
  totalPassed: 1,
  totalFailed: 0,
  totalWarnings: 0,
  pulledWorkflowsSkipped: 0,
  passed: true,
};

Deno.test("LogWorkflowValidateRenderer - names the pulled extension workflows it skipped after the summary", async () => {
  const output = await renderAllLog({
    ...onePassedWorkflow,
    pulledWorkflowsSkipped: 2,
  });
  const lines = output.split("\n");
  const summary = lines.findIndex((l) => l.startsWith("Summary:"));
  assertEquals(
    lines[summary + 1],
    "Skipped: 2 workflows from pulled extensions (validate one by name: swamp workflow validate <name>)",
  );
  assertEquals(lines[summary + 2], "Overall: PASSED");
});

Deno.test("LogWorkflowValidateRenderer - one skipped workflow is singular, and shows with no workflows to validate", async () => {
  const output = await renderAllLog({
    workflows: [],
    totalPassed: 0,
    totalFailed: 0,
    totalWarnings: 0,
    pulledWorkflowsSkipped: 1,
    passed: true,
  });
  assertStringIncludes(output, "No workflows to validate");
  assertStringIncludes(output, "Skipped: 1 workflow from pulled extensions");
});

Deno.test("LogWorkflowValidateRenderer - no skipped line at zero or when a server sends no count", async () => {
  const atZero = await renderAllLog(onePassedWorkflow);
  assertEquals(atZero.includes("Skipped:"), false);

  const { pulledWorkflowsSkipped: _, ...fromOlderServer } = onePassedWorkflow;
  const absent = await renderAllLog(fromOlderServer);
  assertEquals(absent.includes("Skipped:"), false);
});

Deno.test("JsonWorkflowValidateRenderer - all data carries pulledWorkflowsSkipped", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createWorkflowValidateRenderer("json");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: { ...onePassedWorkflow, pulledWorkflowsSkipped: 3 },
      }]),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  assertEquals(JSON.parse(logs[0]).pulledWorkflowsSkipped, 3);
});
