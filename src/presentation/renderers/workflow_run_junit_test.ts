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
import { escapeXml } from "./workflow_run_junit.ts";

Deno.test("escapeXml: escapes ampersand", () => {
  assertEquals(escapeXml("a & b"), "a &amp; b");
});

Deno.test("escapeXml: escapes angle brackets", () => {
  assertEquals(escapeXml("<tag>"), "&lt;tag&gt;");
});

Deno.test("escapeXml: escapes quotes", () => {
  assertEquals(escapeXml('say "hello"'), "say &quot;hello&quot;");
  assertEquals(escapeXml("it's"), "it&apos;s");
});

Deno.test("escapeXml: handles empty string", () => {
  assertEquals(escapeXml(""), "");
});

Deno.test("escapeXml: passes through safe strings", () => {
  assertEquals(escapeXml("hello world 123"), "hello world 123");
});

Deno.test("escapeXml: strips XML 1.0 illegal control characters", () => {
  assertEquals(escapeXml("hello\x00world"), "helloworld");
  assertEquals(escapeXml("tab\x08here"), "tabhere");
  assertEquals(escapeXml("a\x0Bb"), "ab");
});

Deno.test("escapeXml: preserves legal whitespace", () => {
  assertEquals(escapeXml("line\nbreak"), "line\nbreak");
  assertEquals(escapeXml("tab\there"), "tab\there");
  assertEquals(escapeXml("cr\rhere"), "cr\rhere");
});
