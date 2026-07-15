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

import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import type { LogRecord } from "@logtape/logtape";
import { textFormatter, TIMESTAMP_FORMAT } from "./log_format.ts";

// A fixed instant so timestamp assertions are deterministic:
// 2026-07-15T10:18:15.912Z.
const FIXED_TS = Date.UTC(2026, 6, 15, 10, 18, 15, 912);

// Matches an RFC3339 UTC timestamp with millisecond precision and a `Z`.
const RFC3339 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

// Any ANSI SGR escape sequence. The ESC byte is built via String.fromCharCode
// so the pattern carries no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function makeRecord(
  category: string[],
  message: string,
  level: "info" | "debug" | "warning" | "error" = "info",
): LogRecord {
  return {
    category,
    level,
    message: [message],
    rawMessage: message,
    timestamp: FIXED_TS,
    properties: {},
  };
}

Deno.test("TIMESTAMP_FORMAT is rfc3339", () => {
  assertEquals(TIMESTAMP_FORMAT, "rfc3339");
});

Deno.test("textFormatter: renders an RFC3339 timestamp and bracketed level", () => {
  const line = textFormatter()(makeRecord(["model", "get"], "hello")).trimEnd();
  assertMatch(line, RFC3339);
  assertEquals(line, "2026-07-15T10:18:15.912Z [INF] model·get: hello");
});

Deno.test("textFormatter: emits no ANSI escape codes", () => {
  // Non-interactive output must stay clean for piping/redirection.
  const line = textFormatter()(
    makeRecord(["model", "method", "run"], "acquiring lock", "warning"),
  );
  assertNotMatch(line, ANSI);
});
