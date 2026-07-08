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
  GrantSourceSchema,
  isFileSource,
  parseFileSourceFilename,
  parseGrantSource,
} from "./grant_source.ts";

Deno.test("GrantSourceSchema: accepts method", () => {
  assertEquals(GrantSourceSchema.safeParse("method").success, true);
});

Deno.test("GrantSourceSchema: accepts config", () => {
  assertEquals(GrantSourceSchema.safeParse("config").success, true);
});

Deno.test("GrantSourceSchema: accepts file:<filename>", () => {
  assertEquals(
    GrantSourceSchema.safeParse("file:platform-team.yaml").success,
    true,
  );
});

Deno.test("GrantSourceSchema: rejects bare file", () => {
  assertEquals(GrantSourceSchema.safeParse("file").success, false);
});

Deno.test("GrantSourceSchema: rejects bare file:", () => {
  assertEquals(GrantSourceSchema.safeParse("file:").success, false);
});

Deno.test("GrantSourceSchema: accepts extension:<name>", () => {
  assertEquals(
    GrantSourceSchema.safeParse("extension:my-ext").success,
    true,
  );
});

Deno.test("GrantSourceSchema: rejects bare extension:", () => {
  assertEquals(GrantSourceSchema.safeParse("extension:").success, false);
});

Deno.test("GrantSourceSchema: rejects unknown source", () => {
  assertEquals(GrantSourceSchema.safeParse("other").success, false);
});

Deno.test("GrantSourceSchema: rejects empty string", () => {
  assertEquals(GrantSourceSchema.safeParse("").success, false);
});

Deno.test("parseGrantSource: returns valid source", () => {
  assertEquals(parseGrantSource("method"), "method");
  assertEquals(
    parseGrantSource("file:compliance.yaml"),
    "file:compliance.yaml",
  );
});

Deno.test("parseGrantSource: throws on invalid source", () => {
  assertThrows(
    () => parseGrantSource("file"),
    Error,
    "file:<filename>",
  );
});

Deno.test("isFileSource: returns true for file: prefix", () => {
  assertEquals(isFileSource("file:team.yaml"), true);
});

Deno.test("isFileSource: returns false for other sources", () => {
  assertEquals(isFileSource("method"), false);
  assertEquals(isFileSource("config"), false);
  assertEquals(isFileSource("extension:foo"), false);
});

Deno.test("parseFileSourceFilename: extracts filename", () => {
  assertEquals(
    parseFileSourceFilename("file:platform-team.yaml"),
    "platform-team.yaml",
  );
});

Deno.test("parseFileSourceFilename: throws for non-file source", () => {
  assertThrows(
    () => parseFileSourceFilename("method"),
    Error,
    "non-file source",
  );
});
