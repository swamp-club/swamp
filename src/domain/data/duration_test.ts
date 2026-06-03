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
import { parseDataDuration } from "./duration.ts";

Deno.test("parseDataDuration: parses minutes", () => {
  assertEquals(parseDataDuration("5m"), 5 * 60 * 1000);
});

Deno.test("parseDataDuration: parses hours", () => {
  assertEquals(parseDataDuration("2h"), 2 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: parses days", () => {
  assertEquals(parseDataDuration("7d"), 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: parses weeks", () => {
  assertEquals(parseDataDuration("3w"), 3 * 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: parses months as 30 days", () => {
  assertEquals(parseDataDuration("1mo"), 30 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: parses years as 365 days", () => {
  assertEquals(parseDataDuration("1y"), 365 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: multi-digit values", () => {
  assertEquals(parseDataDuration("100d"), 100 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDataDuration: rejects missing unit", () => {
  assertThrows(
    () => parseDataDuration("5"),
    Error,
    "Invalid duration format",
  );
});

Deno.test("parseDataDuration: rejects unknown unit", () => {
  assertThrows(
    () => parseDataDuration("5s"),
    Error,
    "Invalid duration format",
  );
});

Deno.test("parseDataDuration: rejects negative values", () => {
  assertThrows(
    () => parseDataDuration("-5d"),
    Error,
    "Invalid duration format",
  );
});

Deno.test("parseDataDuration: rejects empty string", () => {
  assertThrows(
    () => parseDataDuration(""),
    Error,
    "Invalid duration format",
  );
});

Deno.test("parseDataDuration: rejects whitespace-padded input", () => {
  assertThrows(
    () => parseDataDuration(" 5d "),
    Error,
    "Invalid duration format",
  );
});
