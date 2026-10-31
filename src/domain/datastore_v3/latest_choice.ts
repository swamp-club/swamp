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
 * Which version is a data name's `latest` after an offline write is rebased
 * (swamp-club#4195). Versions follow commit order, but `latest` is the
 * newest observation: a rebased version becomes latest only when it was
 * observed more than {@link LATEST_WINDOW_MS} after the current latest.
 * Within that window, or when it was observed earlier, the current latest
 * stays; the rebase restates it as a new, higher version
 * (`offline_rebase.ts`), so the highest live version is still latest for
 * every reader.
 *
 * Observation times:
 *
 * - An offline write's is its `executedAt` corrected by the clock offset
 *   from serve recorded at the last contact.
 * - A committed version's is the earlier of the serve-stamped `at` of the
 *   commit that recorded it and its metadata `createdAt`. The commit time is
 *   an upper bound no caller can move: an offline write lands long after it
 *   ran, so its `createdAt`, which the rebase sets to the corrected
 *   execution time, is the earlier one. A `createdAt` can only make a
 *   version look older, never newer. Once compaction removed the commit,
 *   `createdAt` alone stands in: the writer's clock, so it can be off by
 *   that writer's skew. A restatement is followed to the version it
 *   restates, so flushing again never makes old content look new.
 *
 * The restated version is named by the reserved tag {@link RESTATES_TAG},
 * which holds only a version number. A time is never read from a tag: tags
 * reach a commit from its caller, so a time there could be anything.
 *
 * @module
 */

import { minOf } from "../array_extrema.ts";
import { RESTATES_TAG } from "../data/data.ts";

/** How much later an offline write must be observed to become latest. */
export const LATEST_WINDOW_MS = 5 * 60_000;

export { RESTATES_TAG };

/** The most restatements followed before a chain is judged broken. */
const MAX_RESTATEMENT_DEPTH = 64;

/** What is known of one committed version of a data name. */
export interface VersionObservation {
  /**
   * The serve-stamped `at` of the commit that recorded the version;
   * undefined once compaction removed that commit.
   */
  readonly committedAt?: string;
  /** The version's metadata `createdAt`, by its writer's clock. */
  readonly createdAt: string;
  /** The version's {@link RESTATES_TAG}, when it carries one. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** Looks up a committed version of the data name being judged. */
export type ObservationLookup = (
  version: number,
) => VersionObservation | undefined;

/**
 * The version `tags` restate, or undefined: the reserved tag's value when it
 * is a positive integer.
 */
export function restatedVersionOf(
  tags: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const raw = tags?.[RESTATES_TAG];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const version = Number(raw);
  return Number.isSafeInteger(version) ? version : undefined;
}

/**
 * The version whose content `version` holds: itself, or, for a
 * restatement, the version the chain of restatements started from. A chain
 * that loops, runs past {@link MAX_RESTATEMENT_DEPTH} or names a version
 * the lookup does not know ends at the last version it could read.
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

/**
 * When the content of committed `version` was observed, in epoch
 * milliseconds: for its source version, the earlier of the serve-stamped
 * commit time and `createdAt`, or `createdAt` alone once the commit was
 * compacted. Undefined when the lookup does not know the version or holds
 * no readable time.
 */
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

/**
 * An offline write's observation time by serve's clock, in epoch
 * milliseconds: `executedAt` plus the offset from serve recorded at the
 * last contact (none when unknown). Undefined for an unreadable time.
 */
export function correctedExecutionTime(
  executedAt: string,
  clockOffsetMs?: number,
): number | undefined {
  const at = Date.parse(executedAt);
  if (!Number.isFinite(at)) return undefined;
  return at + (Number.isFinite(clockOffsetMs) ? clockOffsetMs as number : 0);
}

/** Which version holds `latest` once a rebased version lands. */
export type LatestChoice =
  /** The rebased version, observed clearly after the current latest. */
  | "rebased"
  /** The current latest, restated above the rebased version. */
  | "current";

/**
 * Chooses `latest` between a rebased offline write and the name's current
 * latest. The rebased version wins only when it was observed more than
 * `windowMs` after the current latest; a name with no latest, or whose
 * latest has no known observation time, takes the rebased version. An
 * offline write with no known time never displaces a latest that has one.
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
