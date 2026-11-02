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
 * N counts observations, not restatements; walking down from the highest,
 * versions are kept until N observations are kept and the rest removed, so the
 * highest is kept whenever N is at least 1
 */

import { RESTATES_TAG } from "./data.ts";

export function isRestatement(
  tags: Readonly<Record<string, string>> | undefined,
): boolean {
  return tags !== undefined && RESTATES_TAG in tags;
}

/**
 * restates is asked only about versions above the cut, newest first, so cost is
 * bounded by keep plus the restatements among them; a keep of 0 removes every
 * version
 */
export async function versionsBeyondKeep(
  versions: readonly number[],
  keep: number,
  restates: (version: number) => boolean | Promise<boolean>,
): Promise<number[]> {
  const descending = [...versions].sort((a, b) => b - a);
  let kept = 0;
  let cut = 0;
  while (cut < descending.length && kept < keep) {
    if (!(await restates(descending[cut]))) kept++;
    cut++;
  }
  return descending.slice(cut).reverse();
}

export function versionsBeyondKeepSync(
  versions: readonly number[],
  keep: number,
  restates: (version: number) => boolean,
): number[] {
  const descending = [...versions].sort((a, b) => b - a);
  let kept = 0;
  let cut = 0;
  while (cut < descending.length && kept < keep) {
    if (!restates(descending[cut])) kept++;
    cut++;
  }
  return descending.slice(cut).reverse();
}
