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
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/mod.ts";
import type { SummariseEvent } from "../../libswamp/mod.ts";
import type { ActivitySummary } from "../../domain/summary/summary_types.ts";
import { createSummariseRenderer } from "./summarise.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: SummariseEvent[],
): AsyncGenerator<SummariseEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeSummary(
  overrides: Partial<ActivitySummary> = {},
): ActivitySummary {
  return {
    since: "2026-01-01T00:00:00Z",
    methodExecutions: [],
    workflows: [],
    data: {
      totalItems: 0,
      totalVersions: 0,
      uniqueModels: 0,
      byModelType: [],
    },
    ...overrides,
  };
}

Deno.test("renderMethodExecutions: error line aligns dynamically with short method name", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const summary = makeSummary({
      methodExecutions: [{
        modelName: "test-model",
        type: "@test/type",
        succeeded: 0,
        failed: 1,
        total: 1,
        methods: [{
          method: "run",
          succeeded: 0,
          failed: 1,
          total: 1,
          runs: [{
            id: "r1",
            definitionId: "d1",
            startedAt: "2026-01-01T00:00:00Z",
            status: "failed",
            error: "something broke",
            triggeredBy: "cli",
          }],
        }],
      }],
    });

    const renderer = createSummariseRenderer("log", "normal");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: { status: "summary", summary, sinceLabel: "24 hours" },
      }]),
      renderer.handlers(),
    );

    const plain = logs.map(stripAnsiCode);
    // Find the method row and the error row
    const methodRow = plain.find((l) => l.includes("run"));
    const errorRow = plain.find((l) => l.includes("last error"));
    assertEquals(methodRow !== undefined, true, "should have method row");
    assertEquals(errorRow !== undefined, true, "should have error row");

    // Both should start with 4-space indent and the error text should start
    // at the same column as the status indicators on the method row
    const methodIndent = methodRow!.indexOf("run");
    const methodStatusCol = methodRow!.indexOf("\u2717");
    // The error row uses "".padEnd(maxMethod + 3) after 4 spaces of indent,
    // so its content starts at the same column as the status column
    const errorContentCol = errorRow!.indexOf("last error");
    assertEquals(
      errorContentCol,
      methodStatusCol,
      "error text should align with status column",
    );
    assertEquals(methodIndent, 4, "method name should be at 4-space indent");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderMethodExecutions: error line aligns with longest method name", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const summary = makeSummary({
      methodExecutions: [{
        modelName: "test-model",
        type: "@test/type",
        succeeded: 1,
        failed: 1,
        total: 2,
        methods: [
          {
            method: "a_very_long_method_name",
            succeeded: 1,
            failed: 0,
            total: 1,
            runs: [{
              id: "r1",
              definitionId: "d1",
              startedAt: "2026-01-01T00:00:00Z",
              status: "succeeded",
              triggeredBy: "cli",
            }],
          },
          {
            method: "run",
            succeeded: 0,
            failed: 1,
            total: 1,
            runs: [{
              id: "r2",
              definitionId: "d1",
              startedAt: "2026-01-01T00:00:00Z",
              status: "failed",
              error: "something broke",
              triggeredBy: "cli",
            }],
          },
        ],
      }],
    });

    const renderer = createSummariseRenderer("log", "normal");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: { status: "summary", summary, sinceLabel: "24 hours" },
      }]),
      renderer.handlers(),
    );

    const plain = logs.map(stripAnsiCode);
    const longMethodRow = plain.find((l) =>
      l.includes("a_very_long_method_name")
    );
    const shortMethodRow = plain.find((l) =>
      l.includes("run") && !l.includes("a_very_long_method_name") &&
      !l.includes("last error") && !l.includes("Executions")
    );
    const errorRow = plain.find((l) => l.includes("last error"));

    assertEquals(
      longMethodRow !== undefined,
      true,
      "should have long method row",
    );
    assertEquals(
      shortMethodRow !== undefined,
      true,
      "should have short method row",
    );
    assertEquals(errorRow !== undefined, true, "should have error row");

    // Status indicators should all start at the same column
    const longMethodStatusCol = longMethodRow!.indexOf("\u2713");
    const shortMethodStatusCol = shortMethodRow!.indexOf("\u2717");
    const errorContentCol = errorRow!.indexOf("last error");

    assertEquals(
      longMethodStatusCol,
      shortMethodStatusCol,
      "status columns should align across methods",
    );
    assertEquals(
      errorContentCol,
      shortMethodStatusCol,
      "error text should align with status column",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("SummariseRenderer: error throws UserError", () => {
  const renderer = createSummariseRenderer("log", "normal");
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

Deno.test("SummariseRenderer: no_activity does not write to console output", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createSummariseRenderer("log", "normal");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: { status: "no_activity", sinceLabel: "24 hours" },
      }]),
      renderer.handlers(),
    );
    // no_activity messages go through the logger, not writeOutput/console.log
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonSummariseRenderer: completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const summary = makeSummary();
    const renderer = createSummariseRenderer("json", "normal");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: { status: "summary", summary, sinceLabel: "24 hours" },
      }]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.since, "2026-01-01T00:00:00Z");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogSummariseRenderer: verbose mode does not show last error line", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createSummariseRenderer("log", "verbose");
    await consumeStream(
      toStream([
        {
          kind: "completed",
          data: {
            status: "summary",
            sinceLabel: "24 hours",
            summary: makeSummary({
              methodExecutions: [
                {
                  modelName: "my-server",
                  type: "aws/ec2",
                  total: 2,
                  succeeded: 1,
                  failed: 1,
                  methods: [
                    {
                      method: "deploy",
                      succeeded: 1,
                      failed: 1,
                      total: 2,
                      runs: [
                        {
                          id: "run-1",
                          definitionId: "def-1",
                          startedAt: "2026-01-01T10:00:00Z",
                          status: "failed",
                          error: "Timeout exceeded",
                          triggeredBy: "cli",
                        },
                        {
                          id: "run-2",
                          definitionId: "def-1",
                          startedAt: "2026-01-01T11:00:00Z",
                          status: "succeeded",
                          triggeredBy: "cli",
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          },
        },
      ]),
      renderer.handlers(),
    );

    const combined = stripAnsiCode(logs.join("\n"));
    // Verbose mode shows per-run detail, not the "last error:" summary line
    assertEquals(combined.includes("last error:"), false);
    // But it shows the error inline with the run detail
    assertEquals(combined.includes("Timeout exceeded"), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogSummariseRenderer: compact mode shows last error for failed workflow step", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createSummariseRenderer("log", "normal");
    await consumeStream(
      toStream([
        {
          kind: "completed",
          data: {
            status: "summary",
            sinceLabel: "24 hours",
            summary: makeSummary({
              workflows: [
                {
                  workflowName: "deploy-all",
                  total: 2,
                  succeeded: 1,
                  failed: 1,
                  runs: [
                    {
                      id: "wf-run-1",
                      startedAt: "2026-01-01T10:00:00Z",
                      status: "succeeded",
                      steps: [],
                    },
                    {
                      id: "wf-run-2",
                      startedAt: "2026-01-01T11:00:00Z",
                      status: "failed",
                      firstFailedStep: "build > compile",
                      steps: [
                        {
                          jobName: "build",
                          stepName: "compile",
                          status: "failed",
                          error: "Compilation failed: missing import",
                        },
                        {
                          jobName: "build",
                          stepName: "test",
                          status: "skipped",
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          },
        },
      ]),
      renderer.handlers(),
    );

    const combined = stripAnsiCode(logs.join("\n"));
    // Should show the last error from the failed step
    assertEquals(
      combined.includes('last error: "Compilation failed: missing import"'),
      true,
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogSummariseRenderer: compact mode no error line when all methods succeed", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createSummariseRenderer("log", "normal");
    await consumeStream(
      toStream([
        {
          kind: "completed",
          data: {
            status: "summary",
            sinceLabel: "24 hours",
            summary: makeSummary({
              methodExecutions: [
                {
                  modelName: "my-server",
                  type: "aws/ec2",
                  total: 2,
                  succeeded: 2,
                  failed: 0,
                  methods: [
                    {
                      method: "deploy",
                      succeeded: 2,
                      failed: 0,
                      total: 2,
                      runs: [
                        {
                          id: "run-1",
                          definitionId: "def-1",
                          startedAt: "2026-01-01T10:00:00Z",
                          status: "succeeded",
                          triggeredBy: "cli",
                        },
                        {
                          id: "run-2",
                          definitionId: "def-1",
                          startedAt: "2026-01-01T11:00:00Z",
                          status: "succeeded",
                          triggeredBy: "cli",
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          },
        },
      ]),
      renderer.handlers(),
    );

    const combined = stripAnsiCode(logs.join("\n"));
    assertEquals(combined.includes("last error:"), false);
  } finally {
    console.log = originalLog;
  }
});
