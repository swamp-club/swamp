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
  formatAbsoluteTime,
  formatCompactCount,
  formatCount,
  formatDuration,
  formatRelativeTime,
  pluralize,
} from "./format.ts";

Deno.test("formatCount: groups thousands", () => {
  assertEquals(formatCount(0), "0");
  assertEquals(formatCount(64000), "64,000");
  assertEquals(formatCount(1_000_000_000), "1,000,000,000");
});

Deno.test("formatCompactCount: exact below 10k, compact above", () => {
  assertEquals(formatCompactCount(9_999), "9,999");
  assertEquals(formatCompactCount(12_345), "12.3K");
  assertEquals(formatCompactCount(4_500_000), "4.5M");
});

Deno.test("pluralize: singular only for exactly one", () => {
  assertEquals(pluralize(1, "run"), "1 run");
  assertEquals(pluralize(0, "run"), "0 runs");
  assertEquals(pluralize(1200, "run"), "1,200 runs");
  assertEquals(pluralize(2, "entry", "entries"), "2 entries");
});

Deno.test("formatDuration: picks a unit for the size", () => {
  assertEquals(formatDuration(undefined), "—");
  assertEquals(formatDuration(-1), "—");
  assertEquals(formatDuration(420), "420ms");
  assertEquals(formatDuration(4_200), "4.2s");
  assertEquals(formatDuration(42_000), "42s");
  assertEquals(formatDuration(184_000), "3m 04s");
  assertEquals(formatDuration(2 * 3_600_000 + 13 * 60_000), "2h 13m");
  assertEquals(formatDuration(4 * 86_400_000 + 3 * 3_600_000), "4d 3h");
});

Deno.test("formatRelativeTime: past and future", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  assertEquals(formatRelativeTime(now - 10_000, now), "just now");
  assertEquals(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assertEquals(formatRelativeTime(now - 3 * 3_600_000, now), "3h ago");
  assertEquals(formatRelativeTime(now - 2 * 86_400_000, now), "2d ago");
  assertEquals(formatRelativeTime(now + 10_000, now), "in < 1m");
  assertEquals(formatRelativeTime(now + 5 * 60_000, now), "in 5m");
  assertEquals(
    formatRelativeTime(now + 3 * 3_600_000 + 10 * 60_000, now),
    "in 3h 10m",
  );
  assertEquals(formatRelativeTime("not a date", now), "—");
});

Deno.test("formatAbsoluteTime: UTC without milliseconds", () => {
  assertEquals(
    formatAbsoluteTime("2026-10-12T14:03:22.123Z"),
    "2026-10-12 14:03:22 UTC",
  );
});
