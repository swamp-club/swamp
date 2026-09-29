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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { initializeLogging } from "../logging/logger.ts";
import {
  isPidOneOnLinux,
  type ProcessIdentity,
  warnIfRunningAsInit,
} from "./init_process.ts";

/** Runs warnIfRunningAsInit for `identity` and returns what it logged. */
async function captureWarning(identity: ProcessIdentity): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["process", "init"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
    ],
    reset: true,
  });
  try {
    warnIfRunningAsInit(identity);
  } finally {
    await initializeLogging({ _reset: true });
  }
  return records;
}

Deno.test("isPidOneOnLinux: true for PID 1 on Linux", () => {
  assertEquals(isPidOneOnLinux({ os: "linux", pid: 1 }), true);
});

Deno.test("isPidOneOnLinux: false for any other Linux PID", () => {
  assertEquals(isPidOneOnLinux({ os: "linux", pid: 2 }), false);
  assertEquals(isPidOneOnLinux({ os: "linux", pid: 4242 }), false);
});

Deno.test("isPidOneOnLinux: false for PID 1 outside Linux", () => {
  assertEquals(isPidOneOnLinux({ os: "darwin", pid: 1 }), false);
  assertEquals(isPidOneOnLinux({ os: "windows", pid: 1 }), false);
});

Deno.test("warnIfRunningAsInit: warns once with the remedies as PID 1 on Linux", async () => {
  const records = await captureWarning({ os: "linux", pid: 1 });

  assertEquals(records.length, 1);
  assertEquals(records[0].level, "warning");
  const message = records[0].message.map(String).join("");
  assertStringIncludes(message, "PID 1 without an init");
  assertStringIncludes(message, "docker run --init");
  assertStringIncludes(message, "tini -s -- swamp");
});

Deno.test("warnIfRunningAsInit: logs nothing when not PID 1 on Linux", async () => {
  assertEquals(await captureWarning({ os: "linux", pid: 7 }), []);
  assertEquals(await captureWarning({ os: "darwin", pid: 1 }), []);
});
