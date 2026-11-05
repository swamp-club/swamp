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
import { consumeStream } from "../../libswamp/stream.ts";
import type { TelemetryStatsEvent } from "../../libswamp/telemetry/stats.ts";
import {
  createTelemetryStatsRenderer,
  describeEmptyTelemetry,
} from "./telemetry_stats.ts";
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

const SUCCESS = {
  lastAttemptAt: "2026-11-05T10:00:00.000Z",
  lastAttemptOk: true,
  lastSuccessAt: "2026-11-05T10:00:00.000Z",
  lastSentCount: 3,
};

Deno.test("describeEmptyTelemetry: names each opt-out and how to undo it", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: false,
    disabledBy: ["telemetry.collection", "SWAMP_NO_TELEMETRY"],
    lastFlush: SUCCESS,
    daysAnalyzed: 2,
  }).join("\n");
  assertStringIncludes(
    text,
    "turned off by telemetry.collection, SWAMP_NO_TELEMETRY",
  );
  assertStringIncludes(text, "swamp config set telemetry.collection enabled");
  assertStringIncludes(text, "unset SWAMP_NO_TELEMETRY");
});

Deno.test("describeEmptyTelemetry: a successful flush explains the empty spool and the keep key", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush: SUCCESS,
    daysAnalyzed: 2,
  }).join("\n");
  assertStringIncludes(text, "No user-level or environment opt-out is set");
  assertStringIncludes(text, "sent 3 entries at 2026-11-05T10:00:00.000Z");
  assertStringIncludes(text, "telemetryKeepFlushed: true");
});

Deno.test("describeEmptyTelemetry: a failed last attempt says entries are queued outside the window", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush: {
      ...SUCCESS,
      lastAttemptAt: "2026-11-05T11:00:00.000Z",
      lastAttemptOk: false,
      lastFailureReason: "HTTP 500",
    },
    daysAnalyzed: 1,
  }).join("\n");
  assertStringIncludes(text, "at 2026-11-05T11:00:00.000Z failed (HTTP 500)");
  assertStringIncludes(text, "older than the last 1 day.");
  assertStringIncludes(text, "--days 7");
  assertStringIncludes(text, "Before that, the last successful flush sent 3");
});

Deno.test("describeEmptyTelemetry: no record says nothing has been flushed yet", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush: null,
    daysAnalyzed: 2,
  }).join("\n");
  assertStringIncludes(text, "no flush has been recorded on this machine yet");
});

Deno.test("JsonTelemetryStatsRenderer - empty state keeps the message and adds fields", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTelemetryStatsRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: null,
          emptyState: {
            telemetryEnabled: true,
            disabledBy: [],
            lastFlush: SUCCESS,
            daysAnalyzed: 2,
          },
        },
      ]),
      renderer.handlers(),
    );
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed, {
      message: "No telemetry data found",
      telemetryEnabled: true,
      disabledBy: [],
      lastFlush: SUCCESS,
      daysAnalyzed: 2,
      keepFlushedKey: "telemetryKeepFlushed",
    });
  } finally {
    console.log = originalLog;
  }
});

Deno.test("describeEmptyTelemetry: one sent entry reads in the singular", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush: { ...SUCCESS, lastSentCount: 1 },
    daysAnalyzed: 2,
  }).join("\n");
  assertStringIncludes(text, "sent 1 entry at");
});

Deno.test("describeEmptyTelemetry: no --days hint when the window already covers queued entries", () => {
  const text = describeEmptyTelemetry({
    telemetryEnabled: true,
    disabledBy: [],
    lastFlush: {
      lastAttemptAt: "2026-11-05T11:00:00.000Z",
      lastAttemptOk: false,
    },
    daysAnalyzed: 7,
  }).join("\n");
  assertStringIncludes(text, "older than the last 7 days.");
  assertEquals(text.includes("--days"), false);
});
