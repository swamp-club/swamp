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

import { assertEquals } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import {
  getSwampLogger,
  initializeLogging,
} from "../../infrastructure/logging/logger.ts";
import { logTextBlock } from "./log_text_block.ts";

await initializeLogging({});

/**
 * Captures what LogTape's console sink and the JSON renderer write:
 * console.log, console.info, console.warn and console.error.
 */
function capture(run: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (...args: unknown[]) => {
    logs.push(
      stripAnsiCode(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      ),
    );
  };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  return Promise.resolve()
    .then(run)
    .then(() => logs)
    .finally(() => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    });
}

const logger = getSwampLogger(["test", "text-block"]);

Deno.test("logTextBlock: prints one indented log line per text line and drops trailing newlines", async () => {
  const logs = await capture(() =>
    logTextBlock(logger, "info", "first\r\nsecond\n\nfourth\n\n", "  ")
  );
  assertEquals(logs.length, 4);
  assertEquals(logs[0].endsWith(":   first"), true, logs[0]);
  assertEquals(logs[1].endsWith(":   second"), true, logs[1]);
  assertEquals(logs[2].trimEnd().endsWith(":"), true, logs[2]);
  assertEquals(logs[3].endsWith(":   fourth"), true, logs[3]);
});

Deno.test("logTextBlock: prints braces verbatim, whichever of them a line has (swamp-club#3220)", async () => {
  const lines = [
    "7 | +};",
    "2 | +export const model = {",
    "3 | -  args: z.object({}),methods:{}};",
    "} else {",
    "}}",
    "{{",
  ];
  const logs = await capture(() =>
    logTextBlock(logger, "error", lines.join("\n"), "")
  );
  assertEquals(logs.length, lines.length);
  for (const [i, line] of lines.entries()) {
    assertEquals(logs[i].endsWith(`: ${line}`), true, logs[i]);
  }
});
