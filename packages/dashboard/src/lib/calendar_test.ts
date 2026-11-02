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
  addDays,
  addMonths,
  bucketByDay,
  dayBar,
  dayKeyFormatter,
  dayOfWeek,
  describeDay,
  describeSelection,
  localDayKey,
  localInstant,
  makeDayKey,
  monthGrid,
  monthMaxRuns,
  monthsToShow,
  monthsWindow,
  moveDay,
  previewSpan,
  rangeToSelection,
  selectDay,
  selectionToRange,
} from "./calendar.ts";

const hour = (start: string, runs: number, failed = 0, cancelled = 0) => ({
  start,
  runs,
  succeeded: runs - failed - cancelled,
  failed,
  cancelled,
});

Deno.test("makeDayKey: pads and normalizes overflow", () => {
  assertEquals(makeDayKey(2026, 0, 5), "2026-01-05");
  assertEquals(makeDayKey(2026, 0, 32), "2026-02-01");
  assertEquals(makeDayKey(2026, 11, 32), "2027-01-01");
});

Deno.test("addDays: crosses month, year and DST boundaries by whole days", () => {
  assertEquals(addDays("2026-02-28", 1), "2026-03-01");
  assertEquals(addDays("2028-02-28", 1), "2028-02-29");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  // US DST starts 2026-03-08, EU 2026-03-29: day keys never skip.
  assertEquals(addDays("2026-03-07", 1), "2026-03-08");
  assertEquals(addDays("2026-03-29", -1), "2026-03-28");
  assertEquals(addDays("2026-11-01", 7), "2026-11-08");
});

Deno.test("addMonths: wraps years both ways", () => {
  assertEquals(addMonths({ year: 2026, month: 11 }, 1), {
    year: 2027,
    month: 0,
  });
  assertEquals(addMonths({ year: 2026, month: 0 }, -1), {
    year: 2025,
    month: 11,
  });
});

Deno.test("monthGrid: pads to whole weeks starting Sunday or Monday", () => {
  // October 2026 starts on a Thursday and has 31 days.
  const sunday = monthGrid({ year: 2026, month: 9 });
  assertEquals(sunday[0], [
    null,
    null,
    null,
    null,
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
  ]);
  assertEquals(sunday.length, 5);
  assert(sunday.every((w) => w.length === 7));
  assertEquals(sunday.flat().filter((d) => d !== null).length, 31);
  const monday = monthGrid({ year: 2026, month: 9 }, 1);
  assertEquals(monday[0].indexOf("2026-10-01"), 3);
  assertEquals(dayOfWeek("2026-10-01"), 4);
});

Deno.test("bucketByDay: folds UTC hours into New York days across the fall-back change", () => {
  const ny = dayKeyFormatter("America/New_York");
  const days = bucketByDay([
    // 2026-11-01 03:00Z is Oct 31 23:00 EDT.
    hour("2026-11-01T03:00:00.000Z", 5, 1),
    // 04:00Z is Nov 1 00:00 EDT.
    hour("2026-11-01T04:00:00.000Z", 2),
    // Clocks fall back at 06:00Z; 05:00Z and 06:00Z are both 01:00 local.
    hour("2026-11-01T05:00:00.000Z", 3, 0, 1),
    hour("2026-11-01T06:00:00.000Z", 4),
    // 2026-11-02 04:00Z is Nov 1 23:00 EST — still Nov 1.
    hour("2026-11-02T04:00:00.000Z", 1, 1),
    // 05:00Z is Nov 2 00:00 EST.
    hour("2026-11-02T05:00:00.000Z", 6),
  ], ny);
  assertEquals(days.get("2026-10-31"), {
    runs: 5,
    succeeded: 4,
    failed: 1,
    cancelled: 0,
  });
  assertEquals(days.get("2026-11-01"), {
    runs: 10,
    succeeded: 8,
    failed: 1,
    cancelled: 1,
  });
  assertEquals(days.get("2026-11-02")?.runs, 6);
});

Deno.test("bucketByDay: spring-forward day in Berlin keeps its 23 hours", () => {
  const berlin = dayKeyFormatter("Europe/Berlin");
  // 2026-03-29: clocks jump 02:00 → 03:00 CET→CEST (01:00Z).
  const buckets = [];
  for (let h = -1; h < 23; h++) {
    buckets.push(
      hour(new Date(Date.UTC(2026, 2, 29, h)).toISOString(), 1),
    );
  }
  const days = bucketByDay(buckets, berlin);
  // Mar 28 23:00Z is Mar 29 00:00 CET; Mar 29 22:00Z is Mar 30 00:00 CEST.
  assertEquals(days.get("2026-03-28"), undefined);
  assertEquals(days.get("2026-03-29")?.runs, 23);
  assertEquals(days.get("2026-03-30")?.runs, 1);
});

Deno.test("bucketByDay: a half-hour zone counts a straddling hour on the day it starts", () => {
  const kolkata = dayKeyFormatter("Asia/Kolkata");
  // 18:00Z is 23:30 IST, so the hour spans midnight; it counts on Oct 3.
  const days = bucketByDay([hour("2026-10-03T18:00:00.000Z", 2)], kolkata);
  assertEquals(days.get("2026-10-03")?.runs, 2);
});

Deno.test("bucketByDay: the default formatter uses the viewer's local day", () => {
  const start = new Date(2026, 9, 3, 12).toISOString();
  const days = bucketByDay([hour(start, 1)]);
  assertEquals([...days.keys()], ["2026-10-03"]);
});

Deno.test("bucketByDay: skips malformed bucket starts", () => {
  assertEquals(bucketByDay([hour("nope", 3)]).size, 0);
});

Deno.test("monthMaxRuns: only counts the month's own days", () => {
  const days = new Map([
    ["2026-09-30", { runs: 900, succeeded: 900, failed: 0, cancelled: 0 }],
    ["2026-10-01", { runs: 40, succeeded: 40, failed: 0, cancelled: 0 }],
    ["2026-10-20", { runs: 120, succeeded: 100, failed: 20, cancelled: 0 }],
  ]);
  assertEquals(monthMaxRuns(days, { year: 2026, month: 9 }), 120);
  assertEquals(monthMaxRuns(days, { year: 2026, month: 10 }), 0);
});

Deno.test("dayBar: scales to the busiest day and keeps failures visible", () => {
  assertEquals(dayBar(undefined, 10).total, 0);
  const busiest = dayBar(
    { runs: 100, succeeded: 100, failed: 0, cancelled: 0 },
    100,
  );
  assertEquals(busiest.total, 1);
  assertEquals(busiest.succeeded, 1);
  const quiet = dayBar({ runs: 1, succeeded: 1, failed: 0, cancelled: 0 }, 100);
  assert(quiet.total >= 0.2 && quiet.total < 1);
  // 1 failure in 100 runs still gets a sliver.
  const incident = dayBar(
    { runs: 100, succeeded: 99, failed: 1, cancelled: 0 },
    100,
  );
  assert(incident.failed >= 0.18 * incident.total - 1e-9);
  const sum = incident.succeeded + incident.failed + incident.cancelled;
  assert(Math.abs(sum - incident.total) < 1e-9);
});

Deno.test("describeDay: names runs and failures for screen readers", () => {
  assertEquals(
    describeDay(
      "2026-10-03",
      { runs: 120, succeeded: 116, failed: 4, cancelled: 0 },
      "en-US",
    ),
    "Oct 3: 120 runs, 4 failed",
  );
  assertEquals(
    describeDay(
      "2026-10-03",
      { runs: 1, succeeded: 0, failed: 0, cancelled: 1 },
      "en-US",
    ),
    "Oct 3: 1 run, 1 cancelled",
  );
  assertEquals(describeDay("2026-10-03", undefined, "en-US"), "Oct 3: no runs");
});

Deno.test("selectDay: start, end (swapped when earlier), then start over", () => {
  let sel = selectDay({ start: null, end: null }, "2026-10-09");
  assertEquals(sel, { start: "2026-10-09", end: null });
  sel = selectDay(sel, "2026-10-03");
  assertEquals(sel, { start: "2026-10-03", end: "2026-10-09" });
  sel = selectDay(sel, "2026-10-12");
  assertEquals(sel, { start: "2026-10-12", end: null });
  assertEquals(selectDay(sel, "2026-10-12"), {
    start: "2026-10-12",
    end: "2026-10-12",
  });
});

Deno.test("previewSpan: follows the hovered day until an end is picked", () => {
  assertEquals(previewSpan({ start: null, end: null }, "2026-10-03"), null);
  assertEquals(previewSpan({ start: "2026-10-05", end: null }, "2026-10-02"), {
    start: "2026-10-02",
    end: "2026-10-05",
  });
  assertEquals(
    previewSpan({ start: "2026-10-05", end: "2026-10-07" }, "2026-10-20"),
    { start: "2026-10-05", end: "2026-10-07" },
  );
});

Deno.test("moveDay: arrows, week edges and months, never past today", () => {
  const today = "2026-10-12";
  assertEquals(moveDay("2026-10-01", "ArrowLeft", today), "2026-09-30");
  assertEquals(moveDay("2026-10-01", "ArrowDown", today), "2026-10-08");
  assertEquals(moveDay("2026-10-08", "ArrowDown", today), "2026-10-12");
  assertEquals(moveDay("2026-10-01", "ArrowUp", today), "2026-09-24");
  // Oct 1 2026 is a Thursday.
  assertEquals(moveDay("2026-10-01", "Home", today), "2026-09-27");
  assertEquals(moveDay("2026-10-01", "End", today), "2026-10-03");
  assertEquals(moveDay("2026-10-01", "Home", today, 1), "2026-09-28");
  assertEquals(moveDay("2026-03-31", "PageUp", today), "2026-02-28");
  assertEquals(moveDay("2026-09-30", "PageDown", today), "2026-10-12");
  assertEquals(moveDay("2026-10-12", "ArrowRight", today), "2026-10-12");
});

Deno.test("monthsToShow: pages only when focus leaves the visible months", () => {
  const first = { year: 2026, month: 8 };
  assertEquals(monthsToShow(first, 2, "2026-10-04"), first);
  assertEquals(monthsToShow(first, 2, "2026-11-01"), { year: 2026, month: 9 });
  assertEquals(monthsToShow(first, 2, "2026-08-31"), { year: 2026, month: 7 });
  assertEquals(monthsToShow(first, 1, "2026-10-01"), { year: 2026, month: 9 });
});

Deno.test("monthsWindow: local midnights bounding the visible months", () => {
  const w = monthsWindow({ year: 2026, month: 8 }, 2);
  assertEquals(w.since, new Date(2026, 8, 1).toISOString());
  assertEquals(w.until, new Date(2026, 10, 1).toISOString());
});

Deno.test("selectionToRange: default times cover whole local days", () => {
  const result = selectionToRange(
    { start: "2026-10-03", end: "2026-10-09" },
    "00:00",
    "23:59",
  );
  assert(result.ok);
  if (result.range.kind !== "custom") throw new Error("expected custom");
  assertEquals(result.range.from, new Date(2026, 9, 3).toISOString());
  assertEquals(
    result.range.to,
    new Date(2026, 9, 9, 23, 59, 59, 999).toISOString(),
  );
});

Deno.test("selectionToRange: one picked day, bad times and inverted times", () => {
  const single = selectionToRange(
    { start: "2026-10-03", end: null },
    "09:00",
    "17:30",
  );
  assert(single.ok);
  assertEquals(
    selectionToRange({ start: null, end: null }, "00:00", "23:59").ok,
    false,
  );
  assertEquals(
    selectionToRange({ start: "2026-10-03", end: null }, "9am", "23:59").ok,
    false,
  );
  const inverted = selectionToRange(
    { start: "2026-10-03", end: "2026-10-03" },
    "18:00",
    "09:00",
  );
  assertEquals(inverted.ok, false);
});

Deno.test("rangeToSelection: round-trips a custom range and maps presets", () => {
  const picked = selectionToRange(
    { start: "2026-10-03", end: "2026-10-09" },
    "08:15",
    "18:45",
  );
  assert(picked.ok);
  const back = rangeToSelection(picked.range, {});
  assertEquals(back, {
    selection: { start: "2026-10-03", end: "2026-10-09" },
    startTime: "08:15",
    endTime: "18:45",
  });

  const now = new Date(2026, 9, 12, 15).getTime();
  const preset = rangeToSelection(
    { kind: "preset", preset: "7d" },
    { since: new Date(2026, 9, 5, 15).toISOString() },
    now,
  );
  assertEquals(preset.selection, { start: "2026-10-05", end: "2026-10-12" });
  assertEquals(
    rangeToSelection({ kind: "preset", preset: "all" }, {}, now).selection,
    { start: null, end: null },
  );
});

Deno.test("localInstant / localDayKey: agree on the local day", () => {
  assertEquals(localDayKey(localInstant("2026-03-08", "02:30")), "2026-03-08");
  assertEquals(localDayKey(localInstant("2026-11-01", "23:59")), "2026-11-01");
});

Deno.test("describeSelection: prompts until both ends are picked", () => {
  assertEquals(
    describeSelection({ start: null, end: null }),
    "Pick a start day",
  );
  assertEquals(
    describeSelection({ start: "2026-10-03", end: null }, "en-US"),
    "Oct 3 – pick an end day",
  );
  assertEquals(
    describeSelection({ start: "2026-10-03", end: "2026-10-09" }, "en-US"),
    "Oct 3 – Oct 9",
  );
  assertEquals(
    describeSelection({ start: "2026-10-03", end: "2026-10-03" }, "en-US"),
    "Oct 3",
  );
});
