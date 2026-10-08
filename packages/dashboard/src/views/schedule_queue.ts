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

/** The queue fields a health schedule entry carries (swamp-club#3046). */
export interface ScheduleQueueFields {
  queued?: number;
  oldestQueuedAt?: string | null;
}

/**
 * What the Schedules view shows next to a schedule's status while fires are
 * waiting, e.g. "2 queued · waiting 12m". Null when nothing is waiting, or
 * for a server that does not report queue state, so those rows render as
 * they did before.
 */
export function scheduleQueueLabel(
  entry: ScheduleQueueFields,
  now: number,
): string | null {
  const queued = entry.queued ?? 0;
  if (queued <= 0) return null;
  const oldest = entry.oldestQueuedAt
    ? new Date(entry.oldestQueuedAt).getTime()
    : NaN;
  if (Number.isNaN(oldest)) return `${queued} queued`;
  return `${queued} queued · waiting ${formatWait(now - oldest)}`;
}

/** Fires waiting across the given schedules. */
export function totalQueued(entries: readonly ScheduleQueueFields[]): number {
  return entries.reduce(
    (sum, entry) => sum + Math.max(0, entry.queued ?? 0),
    0,
  );
}

function formatWait(ms: number): string {
  if (ms < 60_000) return "< 1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
