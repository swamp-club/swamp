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

// Bars for the Overview's executions chart: one per local day across the
// selected time range (empty days included, so gaps read as gaps), or one
// per week once a range is too long for daily bars to stay legible.

import {
  addDays,
  bucketByDay,
  type DayKey,
  dayKeyFormatter,
} from "../lib/calendar.ts";

export interface ChartBucket {
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface ChartBar {
  /** First day the bar covers. */
  day: DayKey;
  /** "10-12" for a day, "10-06…" for a week. */
  label: string;
  data: { succeeded: number; failed: number; cancelled: number; other: number };
}

export const MAX_DAILY_BARS = 45;

function dayCount(from: DayKey, to: DayKey): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

/**
 * Daily (or weekly) bars from the summary's hourly timeline. `since` and
 * `until` bound the range; without `since` the range starts at the first
 * bucket, and without `until` it ends at `now`.
 */
export function chartBars(
  timeline: readonly ChartBucket[],
  bounds: { since?: string; until?: string },
  now: number = Date.now(),
  keyOf: (iso: string) => DayKey = dayKeyFormatter(),
): ChartBar[] {
  const byDay = bucketByDay(timeline, keyOf);
  const first = bounds.since
    ? keyOf(bounds.since)
    : [...byDay.keys()].sort()[0];
  if (!first) return [];
  // `until` is exclusive: a range ending at midnight ends the day before.
  const last = keyOf(
    new Date((bounds.until ? Date.parse(bounds.until) : now) - 1).toISOString(),
  );
  if (last < first) return [];
  const span = dayCount(first, last);
  const step = span > MAX_DAILY_BARS ? 7 : 1;
  const bars: ChartBar[] = [];
  for (let day = first; day <= last; day = addDays(day, step)) {
    const data = { succeeded: 0, failed: 0, cancelled: 0, other: 0 };
    for (let i = 0; i < step; i++) {
      const d = byDay.get(addDays(day, i));
      if (!d) continue;
      data.succeeded += d.succeeded;
      data.failed += d.failed;
      data.cancelled += d.cancelled;
      data.other += Math.max(0, d.runs - d.succeeded - d.failed - d.cancelled);
    }
    bars.push({
      day,
      label: step === 1 ? day.slice(5) : `${day.slice(5)}…`,
      data,
    });
  }
  return bars;
}
