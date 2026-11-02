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

export interface CompactionPolicy {
  readonly minCommits: number;
  readonly retainCommits: number;
  /**
   * with a retention cutoff, commits written within this many ms are never
   * folded; ordinary compaction keeps commits by count only
   */
  readonly retainMs: number;
}

/**
 * 2,500 sits just under where loading the base costs more than replaying;
 * compacted_txns outlives the outbox retry bound, so a retry of a folded commit
 * is still a duplicate
 */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  minCommits: 500,
  retainCommits: 2_500,
  retainMs: 24 * 60 * 60 * 1000,
};

export interface CompactionCandidate {
  readonly point: number;
  readonly through: number | undefined;
  readonly commits: number;
}

export interface CompactionRetention {
  readonly commits: number;
  /**
   * compared to the second; without a retention cutoff it is the time the
   * policy is applied, so only a commit stamped by a clock running ahead is
   * kept by it
   */
  readonly since: string;
}

/**
 * with a retention cutoff, the earlier of the cutoff and now less retainMs, so
 * a commit newer than either is never folded; without one, now
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
 * with a retention cutoff the newest-commits floor does not apply: every commit
 * written before compactionBound may be folded, however few
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
 * with a retention cutoff any commit the retention allows is worth folding: the
 * cutoff asks that nothing older remain, not that compaction pay for itself
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
