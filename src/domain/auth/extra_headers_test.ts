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
import { UserError } from "../errors.ts";
import { parseExtraHeaders, resolveExtraHeaders } from "./extra_headers.ts";

Deno.test("parseExtraHeaders: parses single header", () => {
  assertEquals(parseExtraHeaders("X-Token: abc123"), { "X-Token": "abc123" });
});

Deno.test("parseExtraHeaders: parses multiple newline-separated headers", () => {
  assertEquals(
    parseExtraHeaders("X-Token: abc123\nX-Proxy-Auth: def456"),
    { "X-Token": "abc123", "X-Proxy-Auth": "def456" },
  );
});

Deno.test("parseExtraHeaders: preserves colons in value", () => {
  assertEquals(
    parseExtraHeaders("X-Token: abc:def:ghi"),
    { "X-Token": "abc:def:ghi" },
  );
});

Deno.test("parseExtraHeaders: trims whitespace around name and value", () => {
  assertEquals(
    parseExtraHeaders("  X-Token  :  abc123  "),
    { "X-Token": "abc123" },
  );
});

Deno.test("parseExtraHeaders: skips blank lines", () => {
  assertEquals(
    parseExtraHeaders("\nX-Token: abc123\n\nX-Other: val\n"),
    { "X-Token": "abc123", "X-Other": "val" },
  );
});

Deno.test("parseExtraHeaders: last value wins for duplicate names", () => {
  assertEquals(
    parseExtraHeaders("X-Token: first\nX-Token: second"),
    { "X-Token": "second" },
  );
});

Deno.test("parseExtraHeaders: allows empty value", () => {
  assertEquals(parseExtraHeaders("X-Token:"), { "X-Token": "" });
});

Deno.test("parseExtraHeaders: throws on missing colon", () => {
  assertThrows(
    () => parseExtraHeaders("InvalidHeader"),
    UserError,
    "Invalid header format",
  );
});

Deno.test("parseExtraHeaders: throws on colon at position 0 (empty name)", () => {
  assertThrows(
    () => parseExtraHeaders(": value"),
    UserError,
    "Invalid header format",
  );
});

Deno.test("parseExtraHeaders: throws on control chars in name", () => {
  assertThrows(
    () => parseExtraHeaders("X-Bad\x00Name: value"),
    UserError,
    "contains control characters",
  );
});

Deno.test("parseExtraHeaders: throws on control chars in value", () => {
  assertThrows(
    () => parseExtraHeaders("X-Token: bad\x0dvalue"),
    UserError,
    "contains control characters",
  );
});

Deno.test("parseExtraHeaders: throws on reserved name Authorization", () => {
  assertThrows(
    () => parseExtraHeaders("Authorization: Bearer token"),
    UserError,
    "reserved",
  );
});

Deno.test("parseExtraHeaders: throws on reserved name Host (case-insensitive)", () => {
  assertThrows(
    () => parseExtraHeaders("host: evil.example.com"),
    UserError,
    "reserved",
  );
});

Deno.test("parseExtraHeaders: throws on reserved name Upgrade", () => {
  assertThrows(
    () => parseExtraHeaders("Upgrade: h2c"),
    UserError,
    "reserved",
  );
});

Deno.test("parseExtraHeaders: throws on reserved name Connection", () => {
  assertThrows(
    () => parseExtraHeaders("Connection: close"),
    UserError,
    "reserved",
  );
});

Deno.test("resolveExtraHeaders: returns empty when env var is unset", () => {
  assertEquals(resolveExtraHeaders(() => undefined), {});
});

Deno.test("resolveExtraHeaders: returns empty when env var is empty string", () => {
  assertEquals(resolveExtraHeaders(() => ""), {});
});

Deno.test("resolveExtraHeaders: parses env var value", () => {
  assertEquals(
    resolveExtraHeaders(() => "Tunnel-Token: secret123"),
    { "Tunnel-Token": "secret123" },
  );
});
