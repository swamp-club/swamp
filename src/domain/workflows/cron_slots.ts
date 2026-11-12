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

import { Cron } from "croner";

// holds the widest fall-back in tzdata and at most one transition either side
const TRANSITION_WINDOW_MS = 3 * 60 * 60 * 1000;

interface FallBack {
  /** the first instant on the standard offset */
  readonly at: number;
  readonly dropMs: number;
}

// a fall-back's repeated range fires in both copies when the minute or hour
// field starts with an asterisk, as in vixie cron, else once in croner's copy;
// the text decides, so 0-59 1 * * * fires once and */1 1 * * * twice
export function nextSlotAfter(cron: Cron, after: Date): Date | null {
  if (!firesInBothCopies(cron)) return cronerSlotAfter(cron, after);
  const timezone = cron.options.timezone;
  const instant = after.getTime();
  const near = fallBackNear(instant, timezone);
  const inside = near !== null && instant >= near.at - near.dropMs &&
    instant < near.at + near.dropMs;
  // from inside the range croner's chain walks a whole copy slot by slot
  const base = cronerSlotAfter(
    cron,
    inside ? new Date(near.at + near.dropMs - 1) : after,
  );
  let best = base?.getTime() ?? Infinity;
  const nearBase = base ? fallBackNear(base.getTime(), timezone) : null;
  for (const fallBack of [near, nearBase]) {
    if (!fallBack) continue;
    const slot = repeatedSlotAfter(cron, fallBack, instant, timezone);
    if (slot !== null && slot < best) best = slot;
  }
  return best === Infinity ? null : new Date(best);
}

/**
 * across a DST fall-back croner's nextRun can land at or before its argument,
 * so follow croner's own chain from there
 */
function cronerSlotAfter(cron: Cron, after: Date): Date | null {
  let next = cron.nextRun(after);
  while (next && next.getTime() <= after.getTime()) {
    const chained = cron.nextRun(next);
    // a chain that stalls would never pass `after`
    if (!chained || chained.getTime() <= next.getTime()) return null;
    next = chained;
  }
  return next;
}

function firesInBothCopies(cron: Cron): boolean {
  const pattern = cron.getPattern();
  // croner fills a question mark from the clock in the cron's own zone
  if (!pattern || pattern.includes("?")) return false;
  const fields = pattern.trim().split(/\s+/);
  const [minute, hour] = fields.length === 5 ? fields : fields.slice(1);
  return minute.startsWith("*") || hour.startsWith("*");
}

/**
 * the first slot after `instant` in the range `fallBack` repeats, found by
 * wall time so it does not depend on which copy croner resolves to
 */
function repeatedSlotAfter(
  cron: Cron,
  fallBack: FallBack,
  instant: number,
  timezone: string | undefined,
): number | null {
  const { at, dropMs } = fallBack;
  if (instant >= at + dropMs) return null;
  const standard = utcOffsetMs(at, timezone);
  const daylight = standard + dropMs;
  const wallStart = at + standard;
  const wallEnd = wallStart + dropMs;
  const walls = wallClockCron(cron);
  const wallAfter = (wall: number) =>
    walls.nextRun(new Date(wall))?.getTime() ?? Infinity;

  if (instant >= at) {
    const wall = wallAfter(instant + standard);
    return wall < wallEnd ? wall - standard : null;
  }
  const first = wallAfter(
    instant < at - dropMs ? wallStart - 1 : instant + daylight,
  );
  if (first < wallEnd) return first - daylight;
  const second = wallAfter(wallStart - 1);
  return second < wallEnd ? second - standard : null;
}

const wallClockCrons = new WeakMap<Cron, Cron>();

/** the same pattern matched against wall time written as UTC */
function wallClockCron(cron: Cron): Cron {
  let walls = wallClockCrons.get(cron);
  if (!walls) {
    walls = new Cron(cron.getPattern()!, {
      utcOffset: 0,
      legacyMode: cron.options.legacyMode,
      paused: true,
    });
    wallClockCrons.set(cron, walls);
  }
  return walls;
}

/** the fall-back within the window around `instant`, located to the second */
function fallBackNear(
  instant: number,
  timezone: string | undefined,
): FallBack | null {
  let lo = Math.floor((instant - TRANSITION_WINDOW_MS) / 1000) * 1000;
  let hi = lo + 2 * TRANSITION_WINDOW_MS;
  const before = utcOffsetMs(lo, timezone);
  const after = utcOffsetMs(hi, timezone);
  if (before <= after) return null;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (utcOffsetMs(mid, timezone) === after) hi = mid;
    else lo = mid;
  }
  return { at: hi, dropMs: before - after };
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function utcOffsetMs(instant: number, timezone: string | undefined): number {
  const date = new Date(instant);
  if (timezone === undefined) return -date.getTimezoneOffset() * 60_000;
  let format = offsetFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    offsetFormats.set(timezone, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(date)) {
    part[type] = Number(value);
  }
  const wall = Date.UTC(
    part.year,
    part.month - 1,
    part.day,
    part.hour,
    part.minute,
    part.second,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}
