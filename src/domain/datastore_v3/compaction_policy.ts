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
   * With a retention cutoff, keep every commit written within this many
   * milliseconds: the floor a retention pass, which asks to fold everything
   * before it is run, never folds into. Ordinary compaction keeps commits by
   * count only (swamp-club#3916).
   */
  readonly retainMs: number;
}

/**
 * The default policy (swamp-club#3916): fold at least 500 commits at a
 * time and keep the newest 2,500, so a fresh clone replays at most about
 * 3,000 commits after the base; a retention pass keeps the last day.
 *
 * 2,500 is just under where loading the base costs what replaying does: on
 * a filesystem v3 repo of 5,500 commits a base load took 10-14 s, replay
 * about 4.5 ms a commit. A checkout up to 2,500 commits behind replays,
 * never slower than before; a fresh clone's replay stops growing with
 * history.
 *
 * No time window is needed for retries: `compacted_txns` keeps a compacted
 * commit's txnId for `COMPACTED_TXN_RETENTION_MS`, longer than the outbox's
 * retry bound, so a retry of a commit folded a moment after it landed is
 * still a duplicate, and one that never landed appends at the new head.
 */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  minCommits: 500,
  retainCommits: 2_500,
  retainMs: 24 * 60 * 60 * 1000,
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
   * second, which is far below any retention period. Without a retention
   * cutoff it is the time the policy is applied, so only a commit stamped by
   * a clock running ahead is kept by it.
   */
  readonly since: string;
}

/**
 * The instant before which a compaction may fold commits at `now`. Without
 * `before` it is `now`: ordinary compaction keeps commits by count only.
 * With `before` (a retention cutoff, swamp-club#3473) it is the earlier of
 * the cutoff and `now` less `retainMs`: a commit newer than the cutoff is
 * never folded, and neither is one inside the policy's period, however old
 * the cutoff asks for.
 *
 * Retries need no period (swamp-club#3916): `compacted_txns` keeps a
 * compacted commit's txnId past the outbox's retry bound, so a retry still
 * finds it whenever its commit was folded.
 */
export function compactionBound(
  policy: CompactionPolicy,
  now: Date,
  before?: Date,
): Date {
  if (before === undefined) return new Date(now.getTime());
  return new Date(
    Math.min(now.getTime() - policy.retainMs, before.getTime()),
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
