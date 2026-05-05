// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { parseTimeout } from "./duration_parser.ts";
import { UserError } from "../domain/errors.ts";

Deno.test("parseTimeout: bare integer is interpreted as seconds", () => {
  // Matches `swamp datastore sync --timeout` convention.
  assertEquals(parseTimeout("1"), 1000);
  assertEquals(parseTimeout("1800"), 1_800_000);
});

Deno.test("parseTimeout: rejects non-positive bare integer", () => {
  assertThrows(() => parseTimeout("0"), UserError, "must be positive");
});

Deno.test("parseTimeout: seconds", () => {
  assertEquals(parseTimeout("1s"), 1000);
  assertEquals(parseTimeout("30s"), 30_000);
});

Deno.test("parseTimeout: minutes via libswamp parseDuration", () => {
  assertEquals(parseTimeout("5m"), 5 * 60 * 1000);
});

Deno.test("parseTimeout: hours", () => {
  assertEquals(parseTimeout("1h"), 60 * 60 * 1000);
});

Deno.test("parseTimeout: rejects non-positive seconds", () => {
  assertThrows(() => parseTimeout("0s"), UserError, "must be positive");
});

Deno.test("parseTimeout: rejects unrecognized format", () => {
  assertThrows(() => parseTimeout("forever"), UserError);
});

Deno.test("parseTimeout: trims whitespace", () => {
  assertEquals(parseTimeout(" 1s "), 1000);
});
