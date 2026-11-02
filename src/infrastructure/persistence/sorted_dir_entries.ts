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
 * readdir order is sorted on APFS and NTFS but hash order on ext4, so listing
 * in read order differs per machine; sort by UTF-16 code unit, which no locale
 * can change
 */
export function sortDirEntriesByName<T extends { name: string }>(
  entries: Iterable<T>,
): T[] {
  return [...entries].sort((a, b) => compareCodeUnits(a.name, b.name));
}

export async function readDirSorted(dir: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  return sortDirEntriesByName(entries);
}

/**
 * compares segment by segment because sorting whole path strings lets the
 * platform separator decide the order of a/x and a1/x
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
