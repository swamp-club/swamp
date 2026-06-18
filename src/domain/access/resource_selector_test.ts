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
  parseResourceSelector,
  resourceSelectorMatches,
  resourceSelectorToString,
} from "./resource_selector.ts";

Deno.test("parseResourceSelector: parses workflow selector", () => {
  const s = parseResourceSelector("workflow:@acme/*");
  assertEquals(s, { kind: "workflow", pattern: "@acme/*" });
});

Deno.test("parseResourceSelector: parses model selector", () => {
  const s = parseResourceSelector("model:@acme/deploy");
  assertEquals(s, { kind: "model", pattern: "@acme/deploy" });
});

Deno.test("parseResourceSelector: parses data selector", () => {
  const s = parseResourceSelector("data:@acme/reports-*");
  assertEquals(s, { kind: "data", pattern: "@acme/reports-*" });
});

Deno.test("parseResourceSelector: parses access selector", () => {
  const s = parseResourceSelector("access:*");
  assertEquals(s, { kind: "access", pattern: "*" });
});

Deno.test("parseResourceSelector: rejects missing colon", () => {
  assertThrows(
    () => parseResourceSelector("workflow"),
    Error,
    "expected",
  );
});

Deno.test("parseResourceSelector: rejects empty pattern", () => {
  assertThrows(
    () => parseResourceSelector("workflow:"),
    Error,
    "pattern cannot be empty",
  );
});

Deno.test("parseResourceSelector: rejects invalid kind", () => {
  assertThrows(
    () => parseResourceSelector("secret:my-secret"),
    Error,
    'expected "workflow", "model", "data", or "access"',
  );
});

Deno.test("resourceSelectorToString: roundtrips with parseResourceSelector", () => {
  const original = "data:@acme/reports-*";
  const parsed = parseResourceSelector(original);
  assertEquals(resourceSelectorToString(parsed), original);
});

Deno.test("resourceSelectorMatches: exact match", () => {
  const selector = parseResourceSelector("workflow:@acme/deploy");
  assertEquals(resourceSelectorMatches(selector, "@acme/deploy"), true);
  assertEquals(resourceSelectorMatches(selector, "@acme/build"), false);
});

Deno.test("resourceSelectorMatches: suffix wildcard", () => {
  const selector = parseResourceSelector("workflow:@acme/*");
  assertEquals(resourceSelectorMatches(selector, "@acme/deploy"), true);
  assertEquals(resourceSelectorMatches(selector, "@acme/build"), true);
  assertEquals(resourceSelectorMatches(selector, "@other/deploy"), false);
});

Deno.test("resourceSelectorMatches: global wildcard", () => {
  const selector = parseResourceSelector("model:*");
  assertEquals(resourceSelectorMatches(selector, "@acme/deploy"), true);
  assertEquals(resourceSelectorMatches(selector, "anything"), true);
});

Deno.test("resourceSelectorMatches: prefix wildcard does not match mid-string", () => {
  const selector = parseResourceSelector("data:@acme/reports-*");
  assertEquals(resourceSelectorMatches(selector, "@acme/reports-q1"), true);
  assertEquals(resourceSelectorMatches(selector, "@acme/reports-"), true);
  assertEquals(resourceSelectorMatches(selector, "@acme/other"), false);
});

Deno.test("parseResourceSelector: rejects wildcard in middle of pattern", () => {
  assertThrows(
    () => parseResourceSelector("data:@acme/*pii*"),
    Error,
    "wildcard * is only supported at the end of a pattern",
  );
});

Deno.test("parseResourceSelector: rejects wildcard at start of pattern", () => {
  assertThrows(
    () => parseResourceSelector("workflow:*deploy"),
    Error,
    "wildcard * is only supported at the end of a pattern",
  );
});

Deno.test("parseResourceSelector: allows trailing wildcard", () => {
  const s = parseResourceSelector("workflow:@acme/*");
  assertEquals(s, { kind: "workflow", pattern: "@acme/*" });
});

Deno.test("parseResourceSelector: allows lone wildcard", () => {
  const s = parseResourceSelector("model:*");
  assertEquals(s, { kind: "model", pattern: "*" });
});
