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
import { SwampVersion } from "./swamp_version.ts";
import { UserError } from "../errors.ts";

Deno.test("SwampVersion.create parses valid version", () => {
  const version = SwampVersion.create("1.2.3");
  assertEquals(version.major, 1);
  assertEquals(version.minor, 2);
  assertEquals(version.patch, 3);
  assertEquals(version.toString(), "1.2.3");
});

Deno.test("SwampVersion.create parses zero version", () => {
  const version = SwampVersion.create("0.0.0");
  assertEquals(version.major, 0);
  assertEquals(version.minor, 0);
  assertEquals(version.patch, 0);
});

Deno.test("SwampVersion.create parses typical initial version", () => {
  const version = SwampVersion.create("0.1.0");
  assertEquals(version.toString(), "0.1.0");
});

Deno.test("SwampVersion.create trims whitespace", () => {
  const version = SwampVersion.create("  1.0.0  ");
  assertEquals(version.toString(), "1.0.0");
});

Deno.test("SwampVersion.create throws on empty string", () => {
  assertThrows(
    () => SwampVersion.create(""),
    UserError,
    "Version cannot be empty",
  );
});

Deno.test("SwampVersion.create throws on invalid format - no dots", () => {
  assertThrows(
    () => SwampVersion.create("100"),
    UserError,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create throws on invalid format - two parts", () => {
  assertThrows(
    () => SwampVersion.create("1.0"),
    UserError,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create throws on invalid format - four parts", () => {
  assertThrows(
    () => SwampVersion.create("1.0.0.0"),
    UserError,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create accepts pre-release suffix", () => {
  // Pre-release suffixes like -beta, -dev are now allowed
  const v = SwampVersion.create("1.0.0-beta");
  assertEquals(v.major, 1);
  assertEquals(v.minor, 0);
  assertEquals(v.patch, 0);
});

Deno.test("SwampVersion.create accepts calver format with sha suffix", () => {
  // Calver format: YYYYMMDD.HHMMSS.patch-sha.commit
  const v = SwampVersion.create("20260204.165928.0-sha.06db816c");
  assertEquals(v.major, 20260204);
  assertEquals(v.minor, 165928);
  assertEquals(v.patch, 0);
});

Deno.test("SwampVersion.create preserves leading zeros in calver time component", () => {
  const v = SwampVersion.create("20260224.003901.0");
  assertEquals(v.toString(), "20260224.003901.0");
  assertEquals(v.minor, 3901);
});

Deno.test("SwampVersion.create preserves leading zeros with sha suffix", () => {
  const v = SwampVersion.create("20260224.003901.0-sha.abc123");
  assertEquals(v.toString(), "20260224.003901.0");
});

Deno.test("SwampVersion.create accepts dev version", () => {
  const v = SwampVersion.create("0.0.0-dev");
  assertEquals(v.major, 0);
  assertEquals(v.minor, 0);
  assertEquals(v.patch, 0);
});

Deno.test("SwampVersion.create throws on invalid format - letters only", () => {
  assertThrows(
    () => SwampVersion.create("abc"),
    UserError,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.equals returns true for same versions", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.equals(v2), true);
});

Deno.test("SwampVersion.equals returns false for different major", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("2.2.3");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.equals returns false for different minor", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.3.3");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.equals returns false for different patch", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.4");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.compareTo returns 0 for equal versions", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.compareTo(v2), 0);
});

Deno.test("SwampVersion.compareTo compares major first", () => {
  const v1 = SwampVersion.create("2.0.0");
  const v2 = SwampVersion.create("1.9.9");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.compareTo compares minor second", () => {
  const v1 = SwampVersion.create("1.2.0");
  const v2 = SwampVersion.create("1.1.9");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.compareTo compares patch third", () => {
  const v1 = SwampVersion.create("1.2.4");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.isNewerThan returns true when newer", () => {
  const v1 = SwampVersion.create("1.1.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isNewerThan(v2), true);
});

Deno.test("SwampVersion.isNewerThan returns false when older", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.1.0");
  assertEquals(v1.isNewerThan(v2), false);
});

Deno.test("SwampVersion.isNewerThan returns false when equal", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isNewerThan(v2), false);
});

Deno.test("SwampVersion.isOlderThan returns true when older", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.1.0");
  assertEquals(v1.isOlderThan(v2), true);
});

Deno.test("SwampVersion.isOlderThan returns false when newer", () => {
  const v1 = SwampVersion.create("1.1.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isOlderThan(v2), false);
});

Deno.test("SwampVersion.isOlderThan returns false when equal", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isOlderThan(v2), false);
});
