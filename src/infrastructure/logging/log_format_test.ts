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
import {
  interactiveFormatter,
  type InteractiveFormatterOptions,
  serveTextFormatter,
  textFormatter,
  TIMESTAMP_FORMAT,
} from "./log_format.ts";

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

Deno.test("serveTextFormatter: renders system pipe prefix with message only", () => {
  const fmt = serveTextFormatter(() => 6);
  const line = fmt(makeRecord(["serve"], "Listening on https://0.0.0.0:9090"))
    .trimEnd();
  assertEquals(line, " system │ Listening on https://0.0.0.0:9090");
});

Deno.test("serveTextFormatter: omits timestamp, level, and category", () => {
  const fmt = serveTextFormatter(() => 6);
  const line = fmt(
    makeRecord(["serve", "token-auth"], "authenticated", "debug"),
  )
    .trimEnd();
  assertNotMatch(line, RFC3339);
  assertNotMatch(line, /\[DBG\]/);
  assertNotMatch(line, /token-auth/);
  assertEquals(line, " system │ authenticated");
});

Deno.test("serveTextFormatter: respects dynamic pipe width", () => {
  let width = 8;
  const fmt = serveTextFormatter(() => width);
  const line1 = fmt(makeRecord(["serve"], "msg")).trimEnd();
  assertEquals(line1, "   system │ msg");
  width = 6;
  const line2 = fmt(makeRecord(["serve"], "msg")).trimEnd();
  assertEquals(line2, " system │ msg");
});

function interactive(
  options: Partial<InteractiveFormatterOptions> = {},
) {
  const fmt = interactiveFormatter({
    showCategory: false,
    showProperties: false,
    getPipeWidth: () => undefined,
    ...options,
  });
  return (record: LogRecord) => fmt(record).replace(ANSI, "");
}

/** A record whose message interpolates `values`, as a tagged template does. */
function templateRecord(
  level: LogRecord["level"],
  parts: readonly string[],
  ...values: unknown[]
): LogRecord {
  const message: unknown[] = [];
  parts.forEach((part, index) => {
    message.push(part);
    if (index < values.length) message.push(values[index]);
  });
  return {
    category: ["model", "loader"],
    level,
    message,
    rawMessage: parts.join("{}"),
    timestamp: FIXED_TS,
    properties: {},
  };
}

Deno.test("interactiveFormatter: renders a warning in the status gutter with string values unquoted", () => {
  const path = "/Users/me/ext/tailworm/deno.json";
  const line = interactive()(
    templateRecord(
      "warning",
      ["Using discovered deno config for ", ": ", ""],
      "tailworm.ts",
      path,
    ),
  );
  assertEquals(
    line,
    `    Warning   Using discovered deno config for tailworm.ts: ${path}\n`,
  );
});

Deno.test("interactiveFormatter: labels each level in the gutter", () => {
  const fmt = interactive();
  const labels =
    (["trace", "debug", "info", "warning", "error", "fatal"] as const)
      .map((level) => fmt(templateRecord(level, ["m"])).trimEnd());
  assertEquals(labels, [
    "      Trace   m",
    "      Debug   m",
    "    m",
    "    Warning   m",
    "      Error   m",
    "      Error   m",
  ]);
});

Deno.test("interactiveFormatter: omits the timestamp and the category by default", () => {
  const line = interactive()(templateRecord("info", ["hello"]));
  assertNotMatch(line, RFC3339);
  assertNotMatch(line, /model/);
});

Deno.test("interactiveFormatter: inspects values that are not strings", () => {
  const line = interactive()(
    templateRecord("error", ["Lock held by ", " for ", "ms"], {
      holder: "host-a",
    }, 42),
  );
  assertEquals(
    line,
    `      Error   Lock held by { holder: "host-a" } for 42ms\n`,
  );
});

Deno.test("interactiveFormatter: indents continuation lines under the message", () => {
  const line = interactive()(templateRecord("warning", ["first\nsecond"]));
  assertEquals(line, "    Warning   first\n              second\n");
});

Deno.test("interactiveFormatter: appends the category when asked", () => {
  const line = interactive({ showCategory: true })(
    templateRecord("debug", ["hello"]),
  );
  assertEquals(line, "      Debug   hello · model.loader\n");
});

Deno.test("interactiveFormatter: adds one line per property when asked", () => {
  const record = {
    ...templateRecord("info", ["hello"]),
    properties: { runId: "r-1", count: 2 },
  };
  const line = interactive({ showProperties: true })(record);
  assertEquals(
    line,
    "    hello\n    runId: r-1\n    count: 2\n",
  );
});

Deno.test("interactiveFormatter: renders system pipe lines while a pipe display is active", () => {
  let width: number | undefined = 10;
  const fmt = interactive({ getPipeWidth: () => width });
  assertEquals(
    fmt(templateRecord("warning", ["first\nsecond"])),
    "     system │ Warning first\n     system │ second\n",
  );
  width = undefined;
  assertEquals(fmt(templateRecord("warning", ["m"])), "    Warning   m\n");
});

Deno.test("interactiveFormatter: shows an error as its message with its stack frames below", () => {
  const error = new TypeError("Cannot read properties of undefined", {
    cause: new Error("root cause"),
  });
  error.stack = [
    "TypeError: Cannot read properties of undefined",
    "    at run (file:///src/a.ts:1:2)",
    "    at main (file:///src/b.ts:3:4)",
  ].join("\n");
  const line = interactive()(templateRecord("fatal", ["", ""], error));
  assertEquals(
    line,
    [
      "      Error   Cannot read properties of undefined",
      "              at run (file:///src/a.ts:1:2)",
      "              at main (file:///src/b.ts:3:4)",
      "              caused by: root cause",
      "",
    ].join("\n"),
  );
});

Deno.test("interactiveFormatter: leaves the label out of info lines in a pipe display", () => {
  const fmt = interactive({ getPipeWidth: () => 6 });
  assertEquals(fmt(templateRecord("info", ["hello"])), " system │ hello\n");
});

Deno.test("interactiveFormatter: starts info lines where the Warning label starts", () => {
  const fmt = interactive();
  const info = fmt(templateRecord("info", ["Deleted 6 versions\nsecond"]));
  const warning = fmt(templateRecord("warning", ["m"]));
  assertEquals(info, "    Deleted 6 versions\n    second\n");
  assertEquals(info.indexOf("D"), warning.indexOf("W"));
});
