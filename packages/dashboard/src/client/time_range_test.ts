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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  describeTimeRange,
  parseTimeRange,
  requestTimeBounds,
  resolveTimeRange,
  TIME_PRESETS,
} from "./time_range.ts";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

Deno.test("resolveTimeRange: presets look back from now", () => {
  assertEquals(resolveTimeRange({ kind: "preset", preset: "24h" }, NOW), {
    since: "2026-10-11T12:00:00.000Z",
  });
  assertEquals(resolveTimeRange({ kind: "preset", preset: "all" }, NOW), {});
});

Deno.test("resolveTimeRange: custom passes both bounds", () => {
  assertEquals(
    resolveTimeRange({
      kind: "custom",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    }, NOW),
    { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" },
  );
});

Deno.test("requestTimeBounds: presets go as relative durations", () => {
  for (const { preset } of TIME_PRESETS) {
    assertEquals(
      requestTimeBounds({ kind: "preset", preset }),
      preset === "all" ? {} : { since: preset },
    );
  }
});

Deno.test("requestTimeBounds: custom passes both ISO bounds", () => {
  const range = {
    kind: "custom" as const,
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
  };
  assertEquals(requestTimeBounds(range), resolveTimeRange(range, NOW));
});

Deno.test("requestTimeBounds: a preset's request does not move with the clock", () => {
  // The display bounds roll over with the minute; the request must not,
  // or every open page re-sends it once a minute (swamp-club#3444).
  const range = { kind: "preset" as const, preset: "7d" as const };
  const before = Date.UTC(2026, 9, 14, 16, 0, 59, 900);
  const after = before + 200;
  const minute = (t: number) => Math.floor(t / 60_000) * 60_000;
  assertNotEquals(
    resolveTimeRange(range, minute(before)),
    resolveTimeRange(range, minute(after)),
  );
  assertEquals(requestTimeBounds(range), { since: "7d" });
});

Deno.test("parseTimeRange: accepts valid, rejects malformed", () => {
  assertEquals(parseTimeRange('{"kind":"preset","preset":"30d"}'), {
    kind: "preset",
    preset: "30d",
  });
  assertEquals(parseTimeRange('{"kind":"preset","preset":"5y"}'), null);
  assertEquals(parseTimeRange("not json"), null);
  assertEquals(parseTimeRange(null), null);
  assertEquals(
    parseTimeRange(
      '{"kind":"custom","from":"2026-10-02T00:00:00Z","to":"2026-10-01T00:00:00Z"}',
    ),
    null,
  );
});

Deno.test("describeTimeRange: preset labels", () => {
  assertEquals(
    describeTimeRange({ kind: "preset", preset: "7d" }),
    "Last 7 days",
  );
  assertEquals(
    describeTimeRange({ kind: "preset", preset: "all" }),
    "All time",
  );
});

Deno.test("describeTimeRange: whole local days drop the times", () => {
  const range = {
    kind: "custom" as const,
    from: new Date(2026, 9, 3).toISOString(),
    to: new Date(2026, 9, 9, 23, 59, 59, 999).toISOString(),
  };
  assertEquals(describeTimeRange(range, "en-US"), "Oct 3 – Oct 9");
  assertEquals(
    describeTimeRange({
      ...range,
      to: new Date(2026, 9, 3, 23, 59, 59, 999).toISOString(),
    }, "en-US"),
    "Oct 3",
  );
});

Deno.test("describeTimeRange: partial days keep their times", () => {
  const label = describeTimeRange({
    kind: "custom",
    from: new Date(2026, 9, 3, 9, 30).toISOString(),
    to: new Date(2026, 9, 3, 17, 0).toISOString(),
  }, "en-US");
  assertEquals(label.includes("09:30"), true);
  assertEquals(label.includes("05:00") || label.includes("17:00"), true);
});
