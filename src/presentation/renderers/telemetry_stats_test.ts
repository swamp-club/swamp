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
import type { TelemetryStatsEvent } from "../../libswamp/mod.ts";
import { createTelemetryStatsRenderer } from "./telemetry_stats.ts";
import { UserError } from "../../domain/errors.ts";

function makeStatsData() {
  return {
    totalInvocations: 10,
    successCount: 8,
    errorCount: 1,
    userErrorCount: 1,
    successRate: 80,
    errorRate: 10,
    commandFrequency: {},
    optionFrequency: {},
    averageDurationByCommand: {},
    platformDistribution: {},
    daysAnalyzed: 2,
  };
}

async function* toStream(
  events: TelemetryStatsEvent[],
): AsyncGenerator<TelemetryStatsEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogTelemetryStatsRenderer - completed with data outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTelemetryStatsRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        { kind: "completed", data: makeStatsData() },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.totalInvocations, 10);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonTelemetryStatsRenderer - completed with null outputs no-data message", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTelemetryStatsRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        { kind: "completed", data: null },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.message, "No telemetry data found");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("TelemetryStatsRenderer - error throws UserError", () => {
  const renderer = createTelemetryStatsRenderer("log");
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
