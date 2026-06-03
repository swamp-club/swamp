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

Deno.test("CalVer.isValid rejects impossible days for the month", () => {
  assertEquals(CalVer.isValid("2026.02.31.1"), false); // Feb 31
  assertEquals(CalVer.isValid("2026.02.30.1"), false); // Feb 30
  assertEquals(CalVer.isValid("2026.02.29.1"), false); // Feb 29 non-leap year
  assertEquals(CalVer.isValid("2026.04.31.1"), false); // Apr has 30 days
  assertEquals(CalVer.isValid("2026.06.31.1"), false); // Jun has 30 days
  assertEquals(CalVer.isValid("2026.09.31.1"), false); // Sep has 30 days
  assertEquals(CalVer.isValid("2026.11.31.1"), false); // Nov has 30 days
});

Deno.test("CalVer.isValid accepts leap year Feb 29", () => {
  assertEquals(CalVer.isValid("2024.02.29.1"), true); // 2024 is a leap year
  assertEquals(CalVer.isValid("2028.02.29.1"), true); // 2028 is a leap year
});

Deno.test("CalVer.isValid accepts valid last days of months", () => {
  assertEquals(CalVer.isValid("2026.01.31.1"), true); // Jan 31
  assertEquals(CalVer.isValid("2026.02.28.1"), true); // Feb 28 non-leap
  assertEquals(CalVer.isValid("2026.03.31.1"), true); // Mar 31
  assertEquals(CalVer.isValid("2026.04.30.1"), true); // Apr 30
  assertEquals(CalVer.isValid("2026.06.30.1"), true); // Jun 30
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

// --- bump ---

Deno.test("CalVer.bump with no previous returns today with micro 1", () => {
  const result = CalVer.bump();
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  assertEquals(result.value, `${yyyy}.${mm}.${dd}.1`);
});

Deno.test("CalVer.bump increments micro when previous has same date", () => {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const previous = CalVer.create(`${yyyy}.${mm}.${dd}.3`);
  const result = CalVer.bump(previous);
  assertEquals(result.value, `${yyyy}.${mm}.${dd}.4`);
});

Deno.test("CalVer.bump resets micro to 1 when previous has different date", () => {
  const previous = CalVer.create("2020.01.01.5");
  const result = CalVer.bump(previous);
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  assertEquals(result.value, `${yyyy}.${mm}.${dd}.1`);
});

// --- toString ---

Deno.test("CalVer.toString returns the raw string", () => {
  const cv = CalVer.create("2025.06.01.3");
  assertEquals(cv.toString(), "2025.06.01.3");
  assertEquals(`${cv}`, "2025.06.01.3");
});
