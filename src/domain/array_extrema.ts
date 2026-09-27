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
 * Largest and smallest value of a collection of any size.
 *
 * `Math.max(...values)` spreads every element onto the call stack as an
 * argument, and V8 throws `RangeError: Maximum call stack size exceeded`
 * once that passes roughly 125k elements (swamp-club#2565). These walk the
 * values in a loop instead, so they work at any size.
 */

/** Returns the largest value, or `undefined` when there are none. */
export function maxOf(values: Iterable<number>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (result === undefined || value > result) result = value;
  }
  return result;
}

/** Returns the smallest value, or `undefined` when there are none. */
export function minOf(values: Iterable<number>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (result === undefined || value < result) result = value;
  }
  return result;
}
