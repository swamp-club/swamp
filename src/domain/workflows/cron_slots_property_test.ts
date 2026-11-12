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
import fc from "fast-check";
import { Cron } from "croner";
import { nextSlotAfter } from "./cron_slots.ts";
import { arbNear, HOUR_MS, ZONES } from "./schedule_dst_test_helpers.ts";

// Troll's two-hour fall-back stays out of the shared ZONES, where croner's
// fixed-time chain on it would reach the scheduler and catch-up properties
const FALL_BACKS = [
  ...Object.entries(ZONES).flatMap(([timezone, transitions]) =>
    transitions.length === 0 ? [] : [{ timezone, at: transitions[0] }]
  ),
  { timezone: "Antarctica/Troll", at: "2026-10-25T01:00:00Z" },
];

// each matches at least hourly every day, so the oracle's scan is bounded
const WILDCARD = [
  "*/15 * * * *",
  "0 * * * *",
  "*/7 * * * *",
  "*/20 * * * * *",
  "0 0-59/10 * * * *",
];
const FIXED = ["30 1 * * *", "0 30 1 * * *"];

const arbZoneAndInstant = fc.constantFrom(...FALL_BACKS).chain((
  { timezone, at },
) => fc.record({ timezone: fc.constant(timezone), instantMs: arbNear(at) }));

function wallTime(instant: number, timezone: string): number {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  for (const { type, value } of format.formatToParts(new Date(instant))) {
    parts[type] = Number(value);
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/** the first instant after `after` whose wall time matches the pattern */
function firstWallMatch(
  expression: string,
  timezone: string,
  after: number,
): number | null {
  const walls = new Cron(expression, { utcOffset: 0, paused: true });
  const step = expression.split(" ").length === 6 ? 1000 : 60_000;
  for (
    let t = Math.floor(after / step) * step + step;
    t <= after + 2 * HOUR_MS;
    t += step
  ) {
    const wall = wallTime(t, timezone);
    if (walls.nextRun(new Date(wall - 1000))?.getTime() === wall) return t;
  }
  return null;
}

function cronerChain(cron: Cron, after: Date): Date | null {
  let next = cron.nextRun(after);
  while (next && next.getTime() <= after.getTime()) {
    const chained = cron.nextRun(next);
    if (!chained || chained.getTime() <= next.getTime()) return null;
    next = chained;
  }
  return next;
}

Deno.test("nextSlotAfter: near a fall-back a wildcard pattern gives the first instant after whose wall time matches", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...WILDCARD),
      arbZoneAndInstant,
      (expression, { timezone, instantMs }) => {
        const cron = new Cron(expression, { timezone, paused: true });
        const expected = firstWallMatch(expression, timezone, instantMs);
        assert(expected !== null, `${timezone} ${expression} ${instantMs}`);
        assertEquals(
          nextSlotAfter(cron, new Date(instantMs))?.getTime(),
          expected,
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("nextSlotAfter: near a fall-back a wildcard pattern's slot never moves back as the instant moves forward", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...WILDCARD),
      arbZoneAndInstant,
      fc.integer({ min: 0, max: 2 * HOUR_MS }),
      (expression, { timezone, instantMs }, laterByMs) => {
        const cron = new Cron(expression, { timezone, paused: true });
        const earlier = nextSlotAfter(cron, new Date(instantMs))!;
        const later = nextSlotAfter(cron, new Date(instantMs + laterByMs))!;
        assert(earlier.getTime() > instantMs);
        assert(later.getTime() >= earlier.getTime());
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("nextSlotAfter: near a fall-back a fixed time of day gives croner's own chain", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...FIXED),
      arbZoneAndInstant,
      (expression, { timezone, instantMs }) => {
        const cron = new Cron(expression, { timezone, paused: true });
        const after = new Date(instantMs);
        assertEquals(nextSlotAfter(cron, after), cronerChain(cron, after));
      },
    ),
    { numRuns: 200 },
  );
});
