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

/** Local monotonic intervals only; never subtract clocks from different hosts. */
export interface PhaseInterval {
  readonly start: number;
  readonly end: number;
}

/** Union child intervals, clipping to the enclosing phase without double counting. */
export function phaseCoverage(
  start: number,
  end: number,
  intervals: readonly PhaseInterval[],
) {
  const total = Math.max(0, end - start);
  const sorted = intervals.filter((v) =>
    Number.isFinite(v.start) && Number.isFinite(v.end) && v.end >= v.start
  )
    .map((v) => ({
      start: Math.max(start, v.start),
      end: Math.min(end, v.end),
    }))
    .filter((v) => v.end > v.start).sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = start;
  for (const interval of sorted) {
    covered += Math.max(0, interval.end - Math.max(cursor, interval.start));
    cursor = Math.max(cursor, interval.end);
  }
  return { total, covered, uncovered: Math.max(0, total - covered) };
}
