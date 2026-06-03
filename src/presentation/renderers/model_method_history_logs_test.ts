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
  type ModelMethodHistoryLogsEvent,
} from "../../libswamp/mod.ts";
import { createModelMethodHistoryLogsRenderer } from "./model_method_history_logs.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ModelMethodHistoryLogsEvent[],
): AsyncGenerator<ModelMethodHistoryLogsEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogModelMethodHistoryLogsRenderer - completed with log data outputs lines", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodHistoryLogsRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            type: "log",
            log: { lines: ["entry1", "entry2"], path: "logs/output.log" },
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs, ["entry1", "entry2"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodHistoryLogsRenderer - completed with log data outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodHistoryLogsRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            type: "log",
            log: { lines: ["entry1", "entry2"], path: "logs/output.log" },
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.path, "logs/output.log");
    assertEquals(parsed.lineCount, 2);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ModelMethodHistoryLogsRenderer - error throws UserError", () => {
  const renderer = createModelMethodHistoryLogsRenderer("log");
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
