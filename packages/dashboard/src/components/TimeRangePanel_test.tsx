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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeRangeButtonContent, TimeRangePanel } from "./TimeRangePanel.tsx";
import type { TimeRange } from "../client/time_range.ts";
import type { DayStats } from "../lib/calendar.ts";

// Oct 12 2026, 15:00 local.
const NOW = new Date(2026, 9, 12, 15).getTime();

const stats = new Map<string, DayStats>([
  ["2026-10-03", { runs: 120, succeeded: 116, failed: 4, cancelled: 0 }],
  ["2026-10-04", { runs: 30, succeeded: 30, failed: 0, cancelled: 0 }],
]);

function render(
  overrides: Partial<Parameters<typeof TimeRangePanel>[0]> = {},
): string {
  const range: TimeRange = {
    kind: "custom",
    from: new Date(2026, 9, 3).toISOString(),
    to: new Date(2026, 9, 9, 23, 59, 59, 999).toISOString(),
  };
  return renderToStaticMarkup(
    <TimeRangePanel
      range={range}
      bounds={{ since: range.from, until: range.to }}
      now={NOW}
      firstMonth={{ year: 2026, month: 8 }}
      monthCount={2}
      onFirstMonthChange={() => {}}
      stats={stats}
      statsLoading={false}
      statsUnavailable={false}
      onApply={() => {}}
      onCancel={() => {}}
      locale="en-US"
      {...overrides}
    />,
  );
}

Deno.test("TimeRangePanel: renders presets, two month grids and the legend", () => {
  const html = render();
  assertStringIncludes(html, 'aria-label="Quick ranges"');
  for (const name of ["Last hour", "Last 7 days", "Last 90 days", "All time"]) {
    assertStringIncludes(html, name);
  }
  assertEquals(html.split('role="grid"').length - 1, 2);
  assertStringIncludes(html, "September 2026");
  assertStringIncludes(html, "October 2026");
  assertStringIncludes(html, "Succeeded");
  assertStringIncludes(html, "Failed");
  assertStringIncludes(html, "Cancelled");
});

Deno.test("TimeRangePanel: days carry accessible run summaries and failure markers", () => {
  const html = render();
  assertStringIncludes(html, 'aria-label="Oct 3: 120 runs, 4 failed"');
  assertStringIncludes(html, 'aria-label="Oct 4: 30 runs"');
  assertStringIncludes(html, 'aria-label="Oct 12: no runs (today)"');
  assertStringIncludes(
    html,
    'class="trp-day is-endpoint has-failures" data-day="2026-10-03"',
  );
  assertStringIncludes(html, 'class="trp-day" data-day="2026-10-04"');
  assertStringIncludes(html, "trp-seg-failed");
});

Deno.test("TimeRangePanel: the custom range is selected and announced", () => {
  const html = render();
  // Oct 3..9 are selected; Oct 10 is not.
  assertEquals(
    html.split('role="gridcell" class="trp-cell in-span').length - 1,
    7,
  );
  assertStringIncludes(html, 'aria-live="polite"');
  assertStringIncludes(html, "Oct 3 – Oct 9");
  // One roving tab stop, on the range's last day.
  assertEquals(html.split('tabindex="0"').length - 1, 1);
  assertStringIncludes(html, 'data-day="2026-10-09" tabindex="0"');
});

Deno.test("TimeRangePanel: future days are disabled and next month is off at the latest month", () => {
  const html = render();
  assertStringIncludes(
    html,
    'data-day="2026-10-13" tabindex="-1" aria-label="Oct 13: no runs" aria-disabled="true"',
  );
  assert(/aria-label="Next month" disabled=""/.test(html));
});

Deno.test("TimeRangePanel: shows skeleton dots while loading and a note when unavailable", () => {
  const loading = render({ stats: null, statsLoading: true });
  assertStringIncludes(loading, "skel trp-skel");
  assertStringIncludes(loading, 'aria-busy="true"');
  const unavailable = render({ stats: null, statsUnavailable: true });
  assertStringIncludes(unavailable, "isn&#x27;t available");
  assertEquals(unavailable.includes("trp-skel"), false);
});

Deno.test("TimeRangePanel: a preset marks its chip and shows its days", () => {
  const html = render({
    range: { kind: "preset", preset: "7d" },
    bounds: { since: new Date(2026, 9, 5, 15).toISOString() },
    firstMonth: { year: 2026, month: 9 },
    monthCount: 1,
  });
  assertStringIncludes(html, 'aria-pressed="true">Last 7 days');
  assertStringIncludes(html, "Oct 5 – Oct 12");
  assertEquals(html.split('role="grid"').length - 1, 1);
});

Deno.test("TimeRangeButtonContent: shows the range label", () => {
  const html = renderToStaticMarkup(
    <TimeRangeButtonContent label="Last 7 days" />,
  );
  assertStringIncludes(html, "Last 7 days");
});
