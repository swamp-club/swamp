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
import { CalVer } from "./calver.ts";

// --- Validation ---

Deno.test("CalVer.isValid accepts valid CalVer strings", () => {
  assertEquals(CalVer.isValid("2025.01.15.1"), true);
  assertEquals(CalVer.isValid("2025.06.01.3"), true);
  assertEquals(CalVer.isValid("2026.02.09.1"), true);
  assertEquals(CalVer.isValid("2025.12.31.100"), true);
  assertEquals(CalVer.isValid("2025.01.01.0"), true);
});

Deno.test("CalVer.isValid rejects invalid formats", () => {
  assertEquals(CalVer.isValid("1"), false);
  assertEquals(CalVer.isValid("2025"), false);
  assertEquals(CalVer.isValid("2025.01"), false);
  assertEquals(CalVer.isValid("2025.01.15"), false);
  assertEquals(CalVer.isValid("2025.1.15.1"), false); // month not zero-padded
  assertEquals(CalVer.isValid("2025.01.1.1"), false); // day not zero-padded
  assertEquals(CalVer.isValid("25.01.15.1"), false); // year not 4 digits
  assertEquals(CalVer.isValid("v2025.01.15.1"), false); // leading v
  assertEquals(CalVer.isValid("2025.01.15.1.extra"), false); // too many segments
  assertEquals(CalVer.isValid(""), false);
  assertEquals(CalVer.isValid("abc"), false);
});

Deno.test("CalVer.isValid rejects invalid date ranges", () => {
  assertEquals(CalVer.isValid("2025.13.01.1"), false); // month 13
  assertEquals(CalVer.isValid("2025.00.01.1"), false); // month 0
  assertEquals(CalVer.isValid("2025.01.00.1"), false); // day 0
  assertEquals(CalVer.isValid("2025.01.32.1"), false); // day 32
  assertEquals(CalVer.isValid("2025.13.45.1"), false); // month 13, day 45
});

Deno.test("CalVer.create returns instance for valid version", () => {
  const cv = CalVer.create("2025.01.15.1");
  assertEquals(cv.value, "2025.01.15.1");
});

Deno.test("CalVer.create throws for invalid version", () => {
  assertThrows(
    () => CalVer.create("not-a-version"),
    Error,
    'Invalid CalVer version: "not-a-version"',
  );
});

// --- Comparison ---

Deno.test("CalVer.compare returns 0 for equal versions", () => {
  const a = CalVer.create("2025.01.15.1");
  const b = CalVer.create("2025.01.15.1");
  assertEquals(CalVer.compare(a, b), 0);
});

Deno.test("CalVer.compare handles different years", () => {
  const a = CalVer.create("2024.06.01.1");
  const b = CalVer.create("2025.06.01.1");
  assertEquals(CalVer.compare(a, b), -1);
  assertEquals(CalVer.compare(b, a), 1);
});

Deno.test("CalVer.compare handles different months", () => {
  const a = CalVer.create("2025.01.15.1");
  const b = CalVer.create("2025.06.15.1");
  assertEquals(CalVer.compare(a, b), -1);
  assertEquals(CalVer.compare(b, a), 1);
});

Deno.test("CalVer.compare handles different days", () => {
  const a = CalVer.create("2025.06.01.1");
  const b = CalVer.create("2025.06.15.1");
  assertEquals(CalVer.compare(a, b), -1);
  assertEquals(CalVer.compare(b, a), 1);
});

Deno.test("CalVer.compare handles micro segment as numeric (not string)", () => {
  const a = CalVer.create("2025.01.15.2");
  const b = CalVer.create("2025.01.15.10");
  assertEquals(CalVer.compare(a, b), -1);
  assertEquals(CalVer.compare(b, a), 1);
});

Deno.test("CalVer.compare same date different micro", () => {
  const a = CalVer.create("2025.01.15.1");
  const b = CalVer.create("2025.01.15.3");
  assertEquals(CalVer.compare(a, b), -1);
  assertEquals(CalVer.compare(b, a), 1);
});

// --- Equality ---

Deno.test("CalVer.equals returns true for same value", () => {
  const a = CalVer.create("2025.01.15.1");
  const b = CalVer.create("2025.01.15.1");
  assertEquals(a.equals(b), true);
});

Deno.test("CalVer.equals returns false for different values", () => {
  const a = CalVer.create("2025.01.15.1");
  const b = CalVer.create("2025.01.15.2");
  assertEquals(a.equals(b), false);
});

// --- toString ---

Deno.test("CalVer.toString returns the raw string", () => {
  const cv = CalVer.create("2025.06.01.3");
  assertEquals(cv.toString(), "2025.06.01.3");
  assertEquals(`${cv}`, "2025.06.01.3");
});
