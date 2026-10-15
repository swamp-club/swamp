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
 * When history compaction (swamp-club#3258) is worth running, and how much
 * history it keeps uncompacted. Pure: the commit store measures the
 * candidate history ({@link CompactionCandidate}) for a retention, and the
 * single writer (solo, or the serve leader) compacts through the target.
 * Wiring it into a command is the v3 opt-in's job.
 *
 * @module
 */

/** When compaction is worth running, and how much history it keeps. */
export interface CompactionPolicy {
  /** Compact only when at least this many commits would be folded. */
  readonly minCommits: number;
  /** Keep at least this many of the newest commits uncompacted. */
  readonly retainCommits: number;
  /**
   * Keep every commit written within this many milliseconds, so a checkout
   * a little behind replays commits instead of loading the base.
   */
  readonly retainMs: number;
}

/**
 * The default policy: fold at least 10,000 commits at a time, and keep the
 * newest 10,000 and the last 7 days.
 */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  minCommits: 10_000,
  retainCommits: 10_000,
  retainMs: 7 * 24 * 60 * 60 * 1000,
};

/** The history a compaction may fold, as the store measures it. */
export interface CompactionCandidate {
  /** The current compaction point; 0 before any compaction. */
  readonly point: number;
  /**
   * The highest cursor the retention allows compacting through, or
   * undefined when it allows nothing past the point.
   */
  readonly through: number | undefined;
  /** How many stored commits lie above the point and at or below `through`. */
  readonly commits: number;
}

/** What the store keeps uncompacted, for a policy applied at `now`. */
export interface CompactionRetention {
  /** The newest commits kept. */
  readonly commits: number;
  /**
   * Commits whose `at` is at or after this instant are kept. Compared to the
   * second, which is far below any retention period.
   */
  readonly since: string;
}

/**
 * The instant before which a compaction may fold commits at `now`. Without
 * `before` it is the policy's own bound, `now` less `retainMs`. With
 * `before` (a retention cutoff, swamp-club#3473) it is the earlier of the
 * two: a commit newer than the cutoff is never folded, and neither is one
 * inside the policy's period, however old the cutoff asks for.
 *
 * The period is the safety window: the default keeps 7 days, the outbox's
 * retry bound (`OUTBOX_RETRY_BOUND_MS`), so a commit a writer may still
 * retry, or a checkout a little behind may still replay, stays a commit.
 */
export function compactionBound(
  policy: CompactionPolicy,
  now: Date,
  before?: Date,
): Date {
  const bound = now.getTime() - policy.retainMs;
  return new Date(
    before === undefined ? bound : Math.min(bound, before.getTime()),
  );
}

/**
 * The retention a policy asks for at `now`. With `before`, a retention
 * cutoff, the newest-commits floor no longer applies: every commit written
 * before {@link compactionBound} may be folded, however few there are.
 */
export function retentionOf(
  policy: CompactionPolicy,
  now: Date,
  before?: Date,
): CompactionRetention {
  return {
    commits: before === undefined ? policy.retainCommits : 0,
    since: compactionBound(policy, now, before).toISOString(),
  };
}

/**
 * The cursor to compact through, or undefined when the candidate folds
 * fewer commits than the policy's minimum. With `before`, a retention
 * cutoff, any commit the retention allows is worth folding: the cutoff asks
 * that nothing older than it remain, not that compaction pay for itself.
 */
export function compactionTarget(
  candidate: CompactionCandidate,
  policy: CompactionPolicy,
  before?: Date,
): number | undefined {
  if (candidate.through === undefined) return undefined;
  const minCommits = before === undefined ? policy.minCommits : 1;
  return candidate.commits >= minCommits ? candidate.through : undefined;
}
