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
import { chartBars, MAX_DAILY_BARS } from "./overview_chart.ts";

// Day keys in UTC so the test doesn't depend on the machine's zone.
const utcKey = (iso: string) => iso.slice(0, 10);

const bucket = (start: string, s: number, f: number, c = 0, other = 0) => ({
  start,
  runs: s + f + c + other,
  succeeded: s,
  failed: f,
  cancelled: c,
});

Deno.test("chartBars: one bar per day in range, empty days included", () => {
  const bars = chartBars(
    [
      bucket("2026-10-10T03:00:00Z", 2, 1),
      bucket("2026-10-10T09:00:00Z", 1, 0, 1, 2),
      bucket("2026-10-12T00:00:00Z", 4, 0),
    ],
    { since: "2026-10-09T12:00:00Z" },
    Date.parse("2026-10-12T18:00:00Z"),
    utcKey,
  );
  assertEquals(bars.map((b) => b.label), ["10-09", "10-10", "10-11", "10-12"]);
  assertEquals(bars[0].data, {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
  });
  assertEquals(bars[1].data, {
    succeeded: 3,
    failed: 1,
    cancelled: 1,
    other: 2,
  });
  assertEquals(bars[3].data.succeeded, 4);
});

Deno.test("chartBars: until is exclusive", () => {
  const bars = chartBars(
    [],
    { since: "2026-10-01T00:00:00Z", until: "2026-10-03T00:00:00Z" },
    0,
    utcKey,
  );
  assertEquals(bars.map((b) => b.day), ["2026-10-01", "2026-10-02"]);
});

Deno.test("chartBars: no since starts at the first bucket", () => {
  const bars = chartBars(
    [bucket("2026-10-11T05:00:00Z", 1, 0)],
    {},
    Date.parse("2026-10-12T05:00:00Z"),
    utcKey,
  );
  assertEquals(bars.map((b) => b.day), ["2026-10-11", "2026-10-12"]);
  assertEquals(chartBars([], {}, 0, utcKey), []);
});

Deno.test("chartBars: long ranges switch to weekly bars", () => {
  const bars = chartBars(
    [
      bucket("2026-07-02T00:00:00Z", 3, 1),
      bucket("2026-07-08T00:00:00Z", 2, 0),
    ],
    { since: "2026-07-01T00:00:00Z" },
    Date.parse("2026-10-01T00:00:00Z"),
    utcKey,
  );
  assertEquals(bars.length <= Math.ceil(93 / 7), true);
  assertEquals(bars.length > MAX_DAILY_BARS / 7, true);
  assertEquals(bars[0].label, "07-01…");
  // Jul 1–7 holds the first bucket; Jul 8–14 the second.
  assertEquals(bars[0].data.succeeded, 3);
  assertEquals(bars[1].data.succeeded, 2);
});
