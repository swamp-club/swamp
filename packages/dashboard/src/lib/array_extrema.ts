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

// The largest value of a collection of any size. `Math.max(...values)`
// puts every element on the call stack and throws a RangeError past about
// 125k of them (swamp-club#2565); this walks them in a loop instead. The
// dashboard's copy of `src/domain/array_extrema.ts`, which it can't import.

/** The largest value, or `undefined` when there are none. */
export function maxOf(values: Iterable<number>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (result === undefined || value > result) result = value;
  }
  return result;
}
