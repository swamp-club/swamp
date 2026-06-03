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
import {
  consumeStream,
  type ModelOutputLogsEvent,
} from "../../libswamp/mod.ts";
import { createModelOutputLogsRenderer } from "./model_output_logs.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ModelOutputLogsEvent[],
): AsyncGenerator<ModelOutputLogsEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogModelOutputLogsRenderer - completed outputs lines", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelOutputLogsRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            outputId: "abc-123",
            methodName: "start",
            logArtifacts: ["log"],
            lines: ["log line 1", "log line 2"],
            totalLines: 2,
            showingLines: 2,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs, ["log line 1", "log line 2"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelOutputLogsRenderer - completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelOutputLogsRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            outputId: "abc-123",
            methodName: "start",
            logArtifacts: ["log"],
            lines: ["log line 1"],
            totalLines: 1,
            showingLines: 1,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.outputId, "abc-123");
    assertEquals(parsed.totalLines, 1);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ModelOutputLogsRenderer - error throws UserError", () => {
  const renderer = createModelOutputLogsRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Output not found" },
      }),
    UserError,
    "Output not found",
  );
});
