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

import { SEPARATOR_PATTERN } from "@std/path";

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The entries sorted by name in UTF-16 code-unit order (the default string
 * sort, which no locale can change).
 *
 * readdir order is sorted on APFS and NTFS but hash order on ext4, so a
 * repository that returns entries in the order it read them lists the same
 * repo differently per machine (swamp-club#3067).
 */
export function sortDirEntriesByName<T extends { name: string }>(
  entries: Iterable<T>,
): T[] {
  return [...entries].sort((a, b) => compareCodeUnits(a.name, b.name));
}

/** {@link sortDirEntriesByName} of `dir`; NotFound propagates. */
export async function readDirSorted(dir: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  return sortDirEntriesByName(entries);
}

/**
 * Compares two paths segment by segment in UTF-16 code-unit order, a parent
 * before its children. Sorting whole path strings would let the platform
 * separator decide the order of `a/x` and `a1/x`; comparing segments gives
 * the order a walk sorted at every level visits them in.
 */
export function comparePathsBySegment(a: string, b: string): number {
  const aSegments = a.split(SEPARATOR_PATTERN);
  const bSegments = b.split(SEPARATOR_PATTERN);
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const order = compareCodeUnits(aSegments[i], bSegments[i]);
    if (order !== 0) return order;
  }
  return aSegments.length - bSegments.length;
}
