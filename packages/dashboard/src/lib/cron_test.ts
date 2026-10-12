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

import { assert, assertEquals } from "@std/assert";
import {
  CRON_PRESETS,
  describeCron,
  fireTimeLabels,
  formatFireTime,
  nextFireTimes,
  parseCron,
} from "./cron.ts";

Deno.test("describeCron: describes frequency patterns", () => {
  const cases: Array<[string, string]> = [
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at :15"],
    ["0,30 * * * *", "Every 30 minutes"],
    ["5,35 * * * *", "Every hour at :05 and :35"],
    ["0 */2 * * *", "Every 2 hours"],
    ["30 */6 * * *", "Every 6 hours at :30"],
    [
      "*/15 9-17 * * 1-5",
      "Every 15 minutes between 09:00 and 17:59 on weekdays",
    ],
    ["* 9 * * *", "Every minute from 09:00 to 09:59"],
  ];
  for (const [expr, text] of cases) {
    assertEquals(describeCron(expr), text, expr);
  }
});

Deno.test("describeCron: describes times of day and days", () => {
  const cases: Array<[string, string]> = [
    ["0 9 * * *", "Every day at 09:00"],
    ["30 17 * * *", "Every day at 17:30"],
    ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["0 9 * * MON", "Every Monday at 09:00"],
    ["0 9 * * 1-5", "Every weekday at 09:00"],
    ["0 9 * * MON-FRI", "Every weekday at 09:00"],
    ["0 10 * * 0,6", "Every Saturday and Sunday at 10:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday and Friday at 09:00"],
    ["0 0 * * 7", "Every Sunday at 00:00"],
    ["0 0 1 * *", "On the 1st of every month at 00:00"],
    ["0 12 15 * *", "On the 15th of every month at 12:00"],
    ["0 6 1,15 * *", "On the 1st and 15th of every month at 06:00"],
    ["0 0 1 1 *", "Every year on January 1 at 00:00"],
    ["0 0 * 7 *", "Every day in July at 00:00"],
    ["*/10 * * * 1", "Every 10 minutes on Mondays"],
    ["0 * * * 0,6", "Every hour on weekends"],
    ["0 0 22 * *", "On the 22nd of every month at 00:00"],
    ["0 0 13 * *", "On the 13th of every month at 00:00"],
  ];
  for (const [expr, text] of cases) {
    assertEquals(describeCron(expr), text, expr);
  }
});

Deno.test("describeCron: expands nicknames", () => {
  assertEquals(describeCron("@hourly"), "Every hour");
  assertEquals(describeCron("@daily"), "Every day at 00:00");
  assertEquals(describeCron("@midnight"), "Every day at 00:00");
  assertEquals(describeCron("@weekly"), "Every Sunday at 00:00");
  assertEquals(describeCron("@monthly"), "On the 1st of every month at 00:00");
  assertEquals(describeCron("@yearly"), "Every year on January 1 at 00:00");
  assertEquals(describeCron("@ANNUALLY"), "Every year on January 1 at 00:00");
});

Deno.test("describeCron: handles a seconds field", () => {
  assertEquals(describeCron("*/30 * * * * *"), "Every 30 seconds");
  assertEquals(describeCron("* * * * * *"), "Every second");
  assertEquals(describeCron("0 */5 * * * *"), "Every 5 minutes");
  assertEquals(describeCron("0 0 9 * * 1"), "Every Monday at 09:00");
  assertEquals(describeCron("15 0 9 * * *"), null);
});

Deno.test("describeCron: returns null for what it can't say clearly", () => {
  for (
    const expr of [
      "not cron",
      "",
      "0 9 1 * 1", // day-of-month OR day-of-week
      "*/7 * * * *", // resets every hour, not "every 7 minutes"
      "0 0,3,6,9,12,15,18,21 * * *".replace("21", "22"),
      "1,2,3,4,5,6,7 * * * *",
      "0 0 L * *",
    ]
  ) assertEquals(describeCron(expr), null, expr);
});

Deno.test("parseCron: rejects malformed expressions with a reason", () => {
  const bad: Array<[string, string]> = [
    ["", "Enter a cron expression"],
    ["* * *", "Expected 5 fields (minute hour day month weekday), got 3"],
    ["60 * * * *", "minute 60 is out of range (0–59)"],
    ["* 24 * * *", "hour 24 is out of range (0–23)"],
    ["* * 0 * *", "day of month 0 is out of range (1–31)"],
    ["* * * 13 *", "month 13 is out of range (1–12)"],
    ["*/0 * * * *", 'Step "0" must be a positive number'],
    ["5-1 * * * *", 'Range "5-1" runs backwards'],
    ["a * * * *", '"a" is not a valid minute'],
    ["1,,2 * * * *", "Empty item in minute"],
    ["@often", 'Unknown shortcut "@often"'],
  ];
  for (const [expr, error] of bad) {
    const parsed = parseCron(expr);
    assertEquals(parsed.ok, false, expr);
    if (!parsed.ok) assertEquals(parsed.error, error, expr);
  }
});

Deno.test("parseCron: flags syntax it can't preview as unsupported", () => {
  for (const expr of ["0 0 L * *", "0 0 15W * *", "0 0 * * 5#3"]) {
    const parsed = parseCron(expr);
    assertEquals(parsed.ok, false, expr);
    if (!parsed.ok) assertEquals(parsed.unsupported, true, expr);
  }
});

Deno.test("parseCron: expands lists, ranges, steps and names", () => {
  const parsed = parseCron("5/20 1-3,8 ? JAN-MAR SUN,7");
  assert(parsed.ok);
  if (!parsed.ok) return;
  assertEquals(parsed.schedule.minutes, [5, 25, 45]);
  assertEquals(parsed.schedule.hours, [1, 2, 3, 8]);
  assertEquals(parsed.schedule.daysAny, true);
  assertEquals(parsed.schedule.months, [1, 2, 3]);
  assertEquals(parsed.schedule.weekdays, [0]);
  assertEquals(parsed.schedule.weekdaysAny, false);
  assertEquals(parsed.schedule.hasSeconds, false);
});

Deno.test("parseCron: every preset parses and has a description", () => {
  for (const preset of CRON_PRESETS) {
    assert(parseCron(preset.expression).ok, preset.expression);
    assert(describeCron(preset.expression) !== null, preset.expression);
  }
});

function fires(expr: string, from: string, count: number): string[] {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return nextFireTimes(parsed.schedule, new Date(from), count, { utc: true })
    .map((d) => d.toISOString());
}

Deno.test("nextFireTimes: steps through minutes strictly after `from`", () => {
  assertEquals(fires("*/5 * * * *", "2026-10-12T20:30:00.000Z", 3), [
    "2026-10-12T20:35:00.000Z",
    "2026-10-12T20:40:00.000Z",
    "2026-10-12T20:45:00.000Z",
  ]);
  assertEquals(fires("*/5 * * * *", "2026-10-12T20:31:12.345Z", 1), [
    "2026-10-12T20:35:00.000Z",
  ]);
});

Deno.test("nextFireTimes: weekly and monthly schedules cross boundaries", () => {
  // 2026-10-12 is a Monday.
  assertEquals(fires("0 9 * * 1", "2026-10-12T09:00:00.000Z", 2), [
    "2026-10-19T09:00:00.000Z",
    "2026-10-26T09:00:00.000Z",
  ]);
  assertEquals(fires("0 0 31 * *", "2026-10-31T00:00:00.000Z", 2), [
    "2026-12-31T00:00:00.000Z",
    "2027-01-31T00:00:00.000Z",
  ]);
  assertEquals(fires("0 9 * * 1-5", "2026-10-16T10:00:00.000Z", 2), [
    "2026-10-19T09:00:00.000Z",
    "2026-10-20T09:00:00.000Z",
  ]);
});

Deno.test("nextFireTimes: both day fields restricted fire on either", () => {
  // The 15th (a Thursday) or any Monday.
  assertEquals(fires("0 0 15 * 1", "2026-10-12T01:00:00.000Z", 3), [
    "2026-10-15T00:00:00.000Z",
    "2026-10-19T00:00:00.000Z",
    "2026-10-26T00:00:00.000Z",
  ]);
});

Deno.test("nextFireTimes: seconds and impossible dates", () => {
  assertEquals(fires("*/20 * * * * *", "2026-10-12T20:30:05.000Z", 3), [
    "2026-10-12T20:30:20.000Z",
    "2026-10-12T20:30:40.000Z",
    "2026-10-12T20:31:00.000Z",
  ]);
  assertEquals(fires("0 0 30 2 *", "2026-01-01T00:00:00.000Z", 2), []);
});

Deno.test("nextFireTimes: leap day", () => {
  assertEquals(fires("0 0 29 2 *", "2026-01-01T00:00:00.000Z", 1), [
    "2028-02-29T00:00:00.000Z",
  ]);
});

function firesIn(
  timeZone: string,
  expr: string,
  from: string,
  count: number,
): string[] {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return nextFireTimes(parsed.schedule, new Date(from), count, { timeZone })
    .map((d) => d.toISOString());
}

Deno.test("nextFireTimes: reads the expression in an IANA time zone", () => {
  // 09:00 in New York (EDT, UTC-4) is 13:00 UTC.
  assertEquals(
    firesIn("America/New_York", "0 9 * * *", "2026-10-12T12:00:00.000Z", 2),
    ["2026-10-12T13:00:00.000Z", "2026-10-13T13:00:00.000Z"],
  );
  // Half-hour offsets: 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
  assertEquals(
    firesIn("Asia/Kolkata", "0 9 * * 1", "2026-10-12T00:00:00.000Z", 1),
    ["2026-10-12T03:30:00.000Z"],
  );
  // Hourly steps stay on the zone's hour boundaries.
  assertEquals(
    firesIn("Asia/Kolkata", "0 * * * *", "2026-10-12T03:31:00.000Z", 1),
    ["2026-10-12T04:30:00.000Z"],
  );
});

Deno.test("nextFireTimes: crosses a DST change in the zone", () => {
  // London leaves BST on 2026-10-25: 09:00 is 08:00 UTC before, 09:00 after.
  assertEquals(
    firesIn("Europe/London", "0 9 * * *", "2026-10-24T09:00:00.000Z", 2),
    ["2026-10-25T09:00:00.000Z", "2026-10-26T09:00:00.000Z"],
  );
  assertEquals(
    firesIn("Europe/London", "0 0 1 * *", "2026-03-15T00:00:00.000Z", 2),
    ["2026-03-31T23:00:00.000Z", "2026-04-30T23:00:00.000Z"],
  );
});

Deno.test("nextFireTimes: an unknown zone falls back to the browser's", () => {
  const parsed = parseCron("*/5 * * * *");
  if (!parsed.ok) throw new Error(parsed.error);
  const from = new Date("2026-10-12T20:30:00.000Z");
  assertEquals(
    nextFireTimes(parsed.schedule, from, 2, { timeZone: "Not/A_Zone" }),
    nextFireTimes(parsed.schedule, from, 2),
  );
});

Deno.test("fireTimeLabels: adds the viewer's time only when it reads differently", () => {
  const d = new Date("2026-10-12T13:00:00.000Z");
  const ny = fireTimeLabels(d, "America/New_York", "UTC");
  assertEquals(ny.primary, formatFireTime(d, "America/New_York"));
  assertEquals(ny.local, formatFireTime(d, "UTC"));
  assert(ny.primary !== ny.local);
  assertEquals(fireTimeLabels(d, "UTC", "UTC").local, null);
  // Different names, same wall time.
  assertEquals(fireTimeLabels(d, "Etc/UTC", "UTC").local, null);
  // Serve's zone unknown: the viewer's time alone.
  assertEquals(fireTimeLabels(d, undefined, "UTC"), {
    primary: formatFireTime(d),
    local: null,
  });
});
