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

// Runs in its own module so no other test's logging configuration is in
// play. The startup buffer only installs before the first initializeLogging
// call, so the test resets that guard first to stay correct under
// `deno test --repeats`.

import { assertEquals } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { bufferStartupWarnings, initializeLogging } from "./logger.ts";

Deno.test("bufferStartupWarnings: replays startup warnings once logging starts, drops info", async () => {
  const lines: string[] = [];
  const original = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.debug = capture;
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await bufferStartupWarnings({ _reset: true });
    const logger = getLogger(["swamp", "startup-buffer-test"]);
    logger.warn("buffered startup warning");
    logger.info("startup info stays dropped");
    assertEquals(lines, []);

    await initializeLogging({
      logLevel: "info",
      _logsConfig: { exporterKind: "none" },
    });

    assertEquals(
      lines.filter((l) => l.includes("buffered startup warning")).length,
      1,
    );
    assertEquals(
      lines.filter((l) => l.includes("startup info stays dropped")).length,
      0,
    );

    // Once logging is initialised the buffer is not reinstalled.
    await bufferStartupWarnings();
    logger.warn("direct warning after init");
    assertEquals(
      lines.filter((l) => l.includes("direct warning after init")).length,
      1,
    );
  } finally {
    console.debug = original.debug;
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
});
