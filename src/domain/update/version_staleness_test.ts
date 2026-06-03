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
import {
  getVersionAgeDays,
  isVersionStale,
  parseDateFromVersion,
  VERSION_STALENESS_THRESHOLD_DAYS,
} from "./version_staleness.ts";

// --- parseDateFromVersion ---

Deno.test("parseDateFromVersion extracts date from valid CalVer version", () => {
  const date = parseDateFromVersion("20260206.200442.0-sha.abc123");
  assertEquals(date, new Date(Date.UTC(2026, 1, 6)));
});

Deno.test("parseDateFromVersion extracts date from version without sha", () => {
  const date = parseDateFromVersion("20260115.120000.0");
  assertEquals(date, new Date(Date.UTC(2026, 0, 15)));
});

Deno.test("parseDateFromVersion returns null for short string", () => {
  assertEquals(parseDateFromVersion("2026"), null);
});

Deno.test("parseDateFromVersion returns null for non-numeric prefix", () => {
  assertEquals(parseDateFromVersion("abcdefgh.200442.0"), null);
});

Deno.test("parseDateFromVersion returns null for invalid month", () => {
  assertEquals(parseDateFromVersion("20261301.200442.0"), null);
});

Deno.test("parseDateFromVersion returns null for invalid day", () => {
  assertEquals(parseDateFromVersion("20260200.200442.0"), null);
});

Deno.test("parseDateFromVersion returns null for Feb 30", () => {
  assertEquals(parseDateFromVersion("20260230.200442.0"), null);
});

Deno.test("parseDateFromVersion returns null for empty string", () => {
  assertEquals(parseDateFromVersion(""), null);
});

// --- getVersionAgeDays ---

Deno.test("getVersionAgeDays returns correct age for recent version", () => {
  const now = new Date(Date.UTC(2026, 1, 16)); // Feb 16, 2026
  const age = getVersionAgeDays("20260206.200442.0-sha.abc123", now);
  assertEquals(age, 10);
});

Deno.test("getVersionAgeDays returns 0 for same-day version", () => {
  const now = new Date(Date.UTC(2026, 1, 6));
  const age = getVersionAgeDays("20260206.200442.0-sha.abc123", now);
  assertEquals(age, 0);
});

Deno.test("getVersionAgeDays returns null for unparseable version", () => {
  const now = new Date();
  assertEquals(getVersionAgeDays("invalid", now), null);
});

// --- isVersionStale ---

Deno.test("isVersionStale returns false for recent version", () => {
  const now = new Date(Date.UTC(2026, 1, 16)); // 10 days after
  assertEquals(
    isVersionStale("20260206.200442.0-sha.abc123", now, 30),
    false,
  );
});

Deno.test("isVersionStale returns true for old version", () => {
  const now = new Date(Date.UTC(2026, 3, 6)); // ~59 days after
  assertEquals(
    isVersionStale("20260206.200442.0-sha.abc123", now, 30),
    true,
  );
});

Deno.test("isVersionStale returns false for exactly threshold days", () => {
  const now = new Date(Date.UTC(2026, 2, 8)); // exactly 30 days after Feb 6
  assertEquals(
    isVersionStale("20260206.200442.0-sha.abc123", now, 30),
    false,
  );
});

Deno.test("isVersionStale returns true for threshold + 1 days", () => {
  const now = new Date(Date.UTC(2026, 2, 9)); // 31 days after Feb 6
  assertEquals(
    isVersionStale("20260206.200442.0-sha.abc123", now, 30),
    true,
  );
});

Deno.test("isVersionStale returns false for unparseable version", () => {
  const now = new Date();
  assertEquals(isVersionStale("invalid", now, 30), false);
});

// --- VERSION_STALENESS_THRESHOLD_DAYS ---

Deno.test("VERSION_STALENESS_THRESHOLD_DAYS is 30", () => {
  assertEquals(VERSION_STALENESS_THRESHOLD_DAYS, 30);
});
