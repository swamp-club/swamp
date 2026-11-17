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
import {
  formatListeningLine,
  parseListeningLine,
  type ServeListeningLine,
} from "./listening_line.ts";

const LINE: ServeListeningLine = {
  host: "127.0.0.1",
  port: 41_234,
  url: "ws://127.0.0.1:41234",
  schedulingEnabled: true,
  detachRuns: true,
  mode: "local",
  authMode: "token",
};

Deno.test("formatListeningLine: prints the status first and every field serve reported before", () => {
  assertEquals(JSON.parse(formatListeningLine(LINE)), {
    status: "listening",
    host: "127.0.0.1",
    port: 41_234,
    url: "ws://127.0.0.1:41234",
    schedulingEnabled: true,
    detachRuns: true,
    mode: "local",
    authMode: "token",
  });
});

Deno.test("parseListeningLine: reads the port and auth mode from a formatted line", () => {
  assertEquals(parseListeningLine(formatListeningLine(LINE)), {
    port: 41_234,
    authMode: "token",
  });
});

Deno.test("parseListeningLine: refuses a line that is not a listening line", () => {
  const refused = [
    "",
    "not json",
    "null",
    "42",
    '"listening"',
    JSON.stringify({ status: "ready", port: 1, authMode: "none" }),
    JSON.stringify({ status: "listening", authMode: "none" }),
    JSON.stringify({ status: "listening", port: 1 }),
    JSON.stringify({ status: "listening", port: 0, authMode: "none" }),
    JSON.stringify({ status: "listening", port: 65_536, authMode: "none" }),
    JSON.stringify({ status: "listening", port: 1.5, authMode: "none" }),
    JSON.stringify({ status: "listening", port: "80", authMode: "none" }),
    JSON.stringify({ status: "listening", port: 1, authMode: "basic" }),
    JSON.stringify({ status: "listening", port: 1, authMode: 1 }),
  ];
  for (const line of refused) {
    assertEquals(parseListeningLine(line), null, line);
  }
});
