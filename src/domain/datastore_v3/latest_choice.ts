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
 * a rebased version becomes latest only if observed over LATEST_WINDOW_MS after
 * the current latest, else the current one is restated higher; a time is never
 * read from a tag, since callers set tags
 */

import { minOf } from "../array_extrema.ts";
import { RESTATES_TAG } from "../data/data.ts";

export const LATEST_WINDOW_MS = 5 * 60_000;

export { RESTATES_TAG };

const MAX_RESTATEMENT_DEPTH = 64;

export interface VersionObservation {
  readonly committedAt?: string;
  readonly createdAt: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export type ObservationLookup = (
  version: number,
) => VersionObservation | undefined;

export function restatedVersionOf(
  tags: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const raw = tags?.[RESTATES_TAG];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const version = Number(raw);
  return Number.isSafeInteger(version) ? version : undefined;
}

/**
 * a restatement chain that loops, runs past MAX_RESTATEMENT_DEPTH or names an
 * unknown version ends at the last version it could read
 */
export function sourceVersionOf(
  version: number,
  lookup: ObservationLookup,
): number {
  let current = version;
  const seen = new Set<number>([current]);
  for (let depth = 0; depth < MAX_RESTATEMENT_DEPTH; depth++) {
    const restated = restatedVersionOf(lookup(current)?.tags);
    if (
      restated === undefined || seen.has(restated) ||
      lookup(restated) === undefined
    ) {
      return current;
    }
    seen.add(restated);
    current = restated;
  }
  return current;
}

export function observationTimeOf(
  version: number,
  lookup: ObservationLookup,
): number | undefined {
  const source = lookup(sourceVersionOf(version, lookup));
  if (source === undefined) return undefined;
  const committed = source.committedAt === undefined
    ? NaN
    : Date.parse(source.committedAt);
  const created = Date.parse(source.createdAt);
  const known = [committed, created].filter(Number.isFinite);
  return minOf(known);
}

export function correctedExecutionTime(
  executedAt: string,
  clockOffsetMs?: number,
): number | undefined {
  const at = Date.parse(executedAt);
  if (!Number.isFinite(at)) return undefined;
  return at + (Number.isFinite(clockOffsetMs) ? clockOffsetMs as number : 0);
}

export type LatestChoice =
  | "rebased"
  | "current";

/**
 * a name with no latest, or whose latest has no known time, takes the rebased
 * version; an offline write with no known time never displaces a latest that
 * has one
 */
export function chooseLatest(props: {
  readonly rebasedObservedAt: number | undefined;
  readonly currentObservedAt: number | undefined;
  readonly windowMs?: number;
}): LatestChoice {
  const { rebasedObservedAt, currentObservedAt } = props;
  if (currentObservedAt === undefined) return "rebased";
  if (rebasedObservedAt === undefined) return "current";
  const window = props.windowMs ?? LATEST_WINDOW_MS;
  return rebasedObservedAt - currentObservedAt > window ? "rebased" : "current";
}
