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

/** The retention a policy asks for at `now`. */
export function retentionOf(
  policy: CompactionPolicy,
  now: Date,
): CompactionRetention {
  return {
    commits: policy.retainCommits,
    since: new Date(now.getTime() - policy.retainMs).toISOString(),
  };
}

/**
 * The cursor to compact through, or undefined when the candidate folds
 * fewer commits than the policy's minimum.
 */
export function compactionTarget(
  candidate: CompactionCandidate,
  policy: CompactionPolicy,
): number | undefined {
  if (candidate.through === undefined) return undefined;
  return candidate.commits >= policy.minCommits ? candidate.through : undefined;
}
