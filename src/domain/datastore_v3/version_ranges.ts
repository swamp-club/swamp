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
 * A set of data version numbers kept as merged ranges (swamp-club#3532).
 * Retention and version-count GC remove a name's oldest versions in order,
 * so the versions a partition has removed stay a handful of ranges however
 * many there are.
 *
 * @module
 */

/** One inclusive range of versions, `[first, last]`. */
export type VersionRange = readonly [number, number];

/**
 * An immutable set of positive version numbers. Its ranges are sorted,
 * disjoint and never adjacent, so equal sets serialize equally.
 */
export class VersionRanges {
  static readonly EMPTY = new VersionRanges([]);

  private constructor(readonly ranges: readonly VersionRange[]) {}

  /**
   * The set covering `ranges`, which may overlap, touch or come in any
   * order. Throws when a range is not two positive integers in order.
   */
  static of(ranges: readonly (readonly number[])[]): VersionRanges {
    for (const range of ranges) {
      const [first, last] = range;
      if (
        range.length !== 2 || !isVersion(first) || !isVersion(last) ||
        first > last
      ) {
        throw new Error(
          `${JSON.stringify(range)} is not a range of positive versions`,
        );
      }
    }
    const sorted = ranges
      .map(([first, last]): VersionRange => [first, last])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [first, last] of sorted) {
      const previous = merged.at(-1);
      if (previous !== undefined && first <= previous[1] + 1) {
        previous[1] = Math.max(previous[1], last);
      } else {
        merged.push([first, last]);
      }
    }
    return merged.length === 0
      ? VersionRanges.EMPTY
      : new VersionRanges(merged);
  }

  get isEmpty(): boolean {
    return this.ranges.length === 0;
  }

  /** The greatest version in the set; 0 when it is empty. */
  get max(): number {
    return this.ranges.at(-1)?.[1] ?? 0;
  }

  has(version: number): boolean {
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const [first, last] = this.ranges[mid];
      if (version < first) high = mid - 1;
      else if (version > last) low = mid + 1;
      else return true;
    }
    return false;
  }

  /** The set with `version` added. */
  add(version: number): VersionRanges {
    if (this.has(version)) return this;
    return VersionRanges.of([...this.ranges, [version, version]]);
  }

  /** Whether both sets hold the same versions. */
  equals(other: VersionRanges): boolean {
    return this.ranges.length === other.ranges.length &&
      this.ranges.every(([first, last], i) =>
        first === other.ranges[i][0] && last === other.ranges[i][1]
      );
  }

  /** The versions in either set. */
  union(other: VersionRanges): VersionRanges {
    if (other.isEmpty) return this;
    if (this.isEmpty) return other;
    return VersionRanges.of([...this.ranges, ...other.ranges]);
  }

  /** The set without `version`. */
  delete(version: number): VersionRanges {
    if (!this.has(version)) return this;
    const ranges: VersionRange[] = [];
    for (const [first, last] of this.ranges) {
      if (version < first || version > last) {
        ranges.push([first, last]);
        continue;
      }
      if (first < version) ranges.push([first, version - 1]);
      if (version < last) ranges.push([version + 1, last]);
    }
    return ranges.length === 0
      ? VersionRanges.EMPTY
      : new VersionRanges(ranges);
  }

  toJSON(): readonly VersionRange[] {
    return this.ranges;
  }
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
