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

/**
 * Sorts oldest first by the time `timeOf` returns. Items without a usable
 * time keep their relative order after every timed item. Stable.
 */
export function oldestFirst<T>(
  items: readonly T[],
  timeOf: (item: T) => string | undefined,
): T[] {
  const keyed = items.map((item, index) => {
    const raw = timeOf(item);
    const t = raw ? Date.parse(raw) : Number.NaN;
    return { item, index, t: Number.isNaN(t) ? Number.POSITIVE_INFINITY : t };
  });
  keyed.sort((a, b) => (a.t - b.t) || (a.index - b.index));
  return keyed.map((k) => k.item);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * coarser than a run duration on purpose: the value is not ticking, so seconds
 * would read as false precision
 */
export function formatWait(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return "< 1m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const m = Math.floor((ms % HOUR) / MINUTE);
    return `${Math.floor(ms / HOUR)}h ${String(m).padStart(2, "0")}m`;
  }
  const h = Math.floor((ms % DAY) / HOUR);
  return h > 0 ? `${Math.floor(ms / DAY)}d ${h}h` : `${Math.floor(ms / DAY)}d`;
}
