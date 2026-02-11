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

import { assertEquals } from "@std/assert";
import { formatDuration } from "./duration_formatter.ts";

Deno.test("formatDuration - milliseconds", () => {
  assertEquals(formatDuration(0), "0ms");
  assertEquals(formatDuration(1), "1ms");
  assertEquals(formatDuration(500), "500ms");
  assertEquals(formatDuration(999), "999ms");
});

Deno.test("formatDuration - seconds with decimal precision", () => {
  assertEquals(formatDuration(1000), "1s");
  assertEquals(formatDuration(1200), "1.2s");
  assertEquals(formatDuration(1500), "1.5s");
  assertEquals(formatDuration(5900), "5.9s");
});

Deno.test("formatDuration - exact seconds", () => {
  assertEquals(formatDuration(2000), "2s");
  assertEquals(formatDuration(5000), "5s");
  assertEquals(formatDuration(59000), "59s");
});

Deno.test("formatDuration - minutes", () => {
  assertEquals(formatDuration(60000), "1m");
  assertEquals(formatDuration(65000), "1m 5s");
  assertEquals(formatDuration(120000), "2m");
  assertEquals(formatDuration(125000), "2m 5s");
  assertEquals(formatDuration(3540000), "59m");
  assertEquals(formatDuration(3599000), "59m 59s");
});

Deno.test("formatDuration - hours", () => {
  assertEquals(formatDuration(3600000), "1h");
  assertEquals(formatDuration(3605000), "1h 5s");
  assertEquals(formatDuration(3660000), "1h 1m");
  assertEquals(formatDuration(3665000), "1h 1m 5s");
  assertEquals(formatDuration(7200000), "2h");
  assertEquals(formatDuration(7320000), "2h 2m");
  assertEquals(formatDuration(7325000), "2h 2m 5s");
});

Deno.test("formatDuration - large values", () => {
  assertEquals(formatDuration(86400000), "24h"); // 1 day
  assertEquals(formatDuration(90061000), "25h 1m 1s"); // 1 day + 1 hour + 1 minute + 1 second
});

Deno.test("formatDuration - edge cases", () => {
  assertEquals(formatDuration(-1), "0ms");
  assertEquals(formatDuration(-1000), "0ms");
});

Deno.test("formatDuration - common workflow durations", () => {
  // Quick tasks
  assertEquals(formatDuration(50), "50ms");
  assertEquals(formatDuration(250), "250ms");

  // Short tasks
  assertEquals(formatDuration(1300), "1.3s");
  assertEquals(formatDuration(2500), "2.5s");

  // Medium tasks
  assertEquals(formatDuration(30000), "30s");
  assertEquals(formatDuration(90000), "1m 30s");

  // Long tasks
  assertEquals(formatDuration(300000), "5m");
  assertEquals(formatDuration(1800000), "30m");
  assertEquals(formatDuration(5400000), "1h 30m");
});
