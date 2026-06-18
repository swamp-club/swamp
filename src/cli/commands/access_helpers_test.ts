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
import { parseActionsFlag, parseResourceFlag } from "./access_helpers.ts";

Deno.test("parseResourceFlag: parses workflow resource", () => {
  const result = parseResourceFlag("workflow:@acme/*");
  assertEquals(result.kind, "workflow");
  assertEquals(result.pattern, "@acme/*");
});

Deno.test("parseResourceFlag: parses model resource", () => {
  const result = parseResourceFlag("model:@acme/deploy");
  assertEquals(result.kind, "model");
  assertEquals(result.pattern, "@acme/deploy");
});

Deno.test("parseResourceFlag: preserves colons in pattern", () => {
  const result = parseResourceFlag("data:ns:name");
  assertEquals(result.kind, "data");
  assertEquals(result.pattern, "ns:name");
});

Deno.test("parseResourceFlag: throws on missing colon", () => {
  assertThrows(
    () => parseResourceFlag("invalid"),
    Error,
    "expected",
  );
});

Deno.test("parseResourceFlag: throws on invalid kind", () => {
  assertThrows(
    () => parseResourceFlag("unknown:pattern"),
    Error,
    "Invalid resource kind",
  );
});

Deno.test("parseResourceFlag: throws on empty pattern", () => {
  assertThrows(
    () => parseResourceFlag("workflow:"),
    Error,
    "pattern cannot be empty",
  );
});

Deno.test("parseActionsFlag: parses single action", () => {
  assertEquals(parseActionsFlag("run"), ["run"]);
});

Deno.test("parseActionsFlag: parses comma-separated actions", () => {
  assertEquals(parseActionsFlag("run,read,write"), ["run", "read", "write"]);
});

Deno.test("parseActionsFlag: trims whitespace", () => {
  assertEquals(parseActionsFlag("run, read"), ["run", "read"]);
});

Deno.test("parseActionsFlag: throws on invalid action", () => {
  assertThrows(
    () => parseActionsFlag("fly"),
    Error,
    "Invalid action",
  );
});

Deno.test("parseActionsFlag: throws on empty input", () => {
  assertThrows(
    () => parseActionsFlag(""),
    Error,
    "At least one action",
  );
});
