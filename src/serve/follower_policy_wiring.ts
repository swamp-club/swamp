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
 * How serve keeps a v3 node's reads in step with its access policy
 * (swamp-club#4207), composed once for serve and its tests: the commit
 * effects ({@link ServeCommitEffects}), the commit feed serve answers from,
 * the read gate, and the barrier a forwarded write's reply waits on.
 *
 * On a follower a commit is answered only once its effects are applied: the
 * feed ends at {@link ServeCommitEffects.appliedCursor}, and reads are
 * refused as a stale follower's while the policy is unknown. A page filtered
 * under a policy older than its commits would move the caller's cursor past
 * commits it may read. The leader's feed and gate are unchanged.
 *
 * @module
 */

import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import type { FollowerGate } from "./follower_requests.ts";
import {
  ServeCommitEffects,
  type ServeCommitEffectsDeps,
} from "./serve_commit_effects.ts";

/** What {@link wireFollowerPolicy} needs. */
export interface FollowerPolicyDeps
  extends Omit<ServeCommitEffectsDeps, "source"> {
  readonly source: V3CommitFeedSource;
}

/** See the module documentation. */
export interface FollowerPolicyWiring {
  readonly effects: ServeCommitEffects;
  /**
   * The commit feed serve's reads answer from: a follower's ends at the
   * last commit whose effects were applied, and moves when they are.
   */
  readonly commitFeed: V3CommitFeedSource;
  /** `leadership`, refusing a follower's reads while its policy is unknown. */
  gate(leadership: FollowerGate): FollowerGate;
  /**
   * `feedBarrier`, then the effects of what it brought in: a caller reads
   * its own forwarded write from this node next.
   */
  barrier(feedBarrier: () => Promise<void>): () => Promise<void>;
}

/** See the module documentation. */
export function wireFollowerPolicy(
  deps: FollowerPolicyDeps,
): FollowerPolicyWiring {
  const effects = new ServeCommitEffects(deps);
  const source = deps.source;
  return {
    effects,
    commitFeed: {
      datastore: source.datastore,
      bound: () =>
        deps.isFollower()
          ? Math.min(source.bound(), effects.appliedCursor())
          : source.bound(),
      onMoved: (listener) => {
        const offSource = source.onMoved(listener);
        const offApplied = effects.onApplied(() => listener(false));
        return () => {
          offSource();
          offApplied();
        };
      },
    },
    gate: (leadership) => ({
      get role() {
        return leadership.role;
      },
      leader: () => leadership.leader(),
      isStale: () =>
        leadership.isStale() ||
        (leadership.role === "follower" && !effects.policyKnown()),
    }),
    barrier: (feedBarrier) => async () => {
      await feedBarrier();
      await effects.settled();
    },
  };
}
