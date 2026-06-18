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
import {
  parseActionsFlag,
  parseFieldFlags,
  parseResourceFlag,
  validateServerRepoExclusivity,
} from "./access_helpers.ts";

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

Deno.test("validateServerRepoExclusivity: throws when both specified", () => {
  assertThrows(
    () => validateServerRepoExclusivity("ws://host:1234", "/some/dir"),
    Error,
    "Cannot specify both",
  );
});

Deno.test("validateServerRepoExclusivity: allows server only", () => {
  validateServerRepoExclusivity("ws://host:1234", undefined);
});

Deno.test("validateServerRepoExclusivity: allows repo-dir only", () => {
  validateServerRepoExclusivity(undefined, "/some/dir");
});

Deno.test("validateServerRepoExclusivity: allows neither", () => {
  validateServerRepoExclusivity(undefined, undefined);
});

Deno.test("parseFieldFlags: returns empty object for undefined", () => {
  assertEquals(parseFieldFlags(undefined), {});
});

Deno.test("parseFieldFlags: returns empty object for empty array", () => {
  assertEquals(parseFieldFlags([]), {});
});

Deno.test("parseFieldFlags: parses simple key=value", () => {
  const result = parseFieldFlags(["env=staging"]);
  assertEquals(result["env"], "staging");
});

Deno.test("parseFieldFlags: parses nested dotted key", () => {
  const result = parseFieldFlags(["tags.env=staging"]);
  const tags = result["tags"] as Record<string, unknown>;
  assertEquals(tags["env"], "staging");
});

Deno.test("parseFieldFlags: parses deeply nested key", () => {
  const result = parseFieldFlags(["a.b.c=deep"]);
  const a = result["a"] as Record<string, unknown>;
  const b = a["b"] as Record<string, unknown>;
  assertEquals(b["c"], "deep");
});

Deno.test("parseFieldFlags: handles multiple fields", () => {
  const result = parseFieldFlags(["tags.env=staging", "tags.team=platform"]);
  const tags = result["tags"] as Record<string, unknown>;
  assertEquals(tags["env"], "staging");
  assertEquals(tags["team"], "platform");
});

Deno.test("parseFieldFlags: value can contain equals signs", () => {
  const result = parseFieldFlags(["expr=a==b"]);
  assertEquals(result["expr"], "a==b");
});

Deno.test("parseFieldFlags: throws on missing equals sign", () => {
  assertThrows(
    () => parseFieldFlags(["noequals"]),
    Error,
    'expected "key=value"',
  );
});

Deno.test("parseFieldFlags: throws on empty key", () => {
  assertThrows(
    () => parseFieldFlags(["=value"]),
    Error,
    "key cannot be empty",
  );
});

Deno.test("parseFieldFlags: throws on empty segment in dotted path", () => {
  assertThrows(
    () => parseFieldFlags(["a..b=value"]),
    Error,
    "empty segment",
  );
});

Deno.test("parseFieldFlags: throws on leading dot", () => {
  assertThrows(
    () => parseFieldFlags([".a=value"]),
    Error,
    "empty segment",
  );
});

Deno.test("parseFieldFlags: rejects __proto__ key", () => {
  assertThrows(
    () => parseFieldFlags(["__proto__.polluted=true"]),
    Error,
    '"__proto__" is not allowed',
  );
});

Deno.test("parseFieldFlags: rejects constructor key", () => {
  assertThrows(
    () => parseFieldFlags(["constructor.name=evil"]),
    Error,
    '"constructor" is not allowed',
  );
});

Deno.test("parseFieldFlags: rejects prototype key", () => {
  assertThrows(
    () => parseFieldFlags(["prototype.fn=bad"]),
    Error,
    '"prototype" is not allowed',
  );
});

Deno.test("parseFieldFlags: does not pollute Object.prototype", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).length;
  try {
    parseFieldFlags(["__proto__.polluted=true"]);
  } catch { /* expected */ }
  assertEquals(
    Object.getOwnPropertyNames(Object.prototype).length,
    before,
  );
});
