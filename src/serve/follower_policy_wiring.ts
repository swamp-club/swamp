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
 * a follower answers a commit only once its effects are applied, and refuses
 * reads while the policy is unknown: a page filtered under an older policy
 * would move the caller's cursor past commits it may read
 */

import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { FOLLOWER_FEED_BARRIER_MS } from "./follower_feed.ts";
import type { FollowerGate } from "./follower_requests.ts";
import {
  ServeCommitEffects,
  type ServeCommitEffectsDeps,
} from "./serve_commit_effects.ts";

export interface FollowerPolicyDeps
  extends Omit<ServeCommitEffectsDeps, "source"> {
  readonly source: V3CommitFeedSource;
}

export interface FollowerPolicyWiring {
  readonly effects: ServeCommitEffects;
  readonly commitFeed: V3CommitFeedSource;
  gate(leadership: FollowerGate): FollowerGate;
  barrier(feedBarrier: () => Promise<unknown>): () => Promise<void>;
  /**
   * pinned to what the read model holds now, so a feed that keeps landing
   * commits cannot keep it from passing
   */
  effectsReachNow(): () => boolean;
}

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
      leadUnconfirmed: () => leadership.leadUnconfirmed?.() ?? false,
      isStale: () =>
        leadership.isStale() ||
        (leadership.role === "follower" && !effects.policyKnown()),
    }),
    // a follower's effects follow its read model, which the feed's catch-up
    // brings up with the copy
    effectsReachNow: () => {
      const target = source.datastore.readModel.cursor();
      return () => effects.policyKnown() && effects.appliedCursor() >= target;
    },
    barrier: (feedBarrier) => async () => {
      await feedBarrier();
      if (!deps.isFollower()) return;
      await appliedThrough(
        effects,
        source.datastore.commitStore.highWaterMark().cursor,
        FOLLOWER_FEED_BARRIER_MS,
      );
    },
  };
}

/**
 * a busy feed keeps queueing passes, so waiting for them all to settle could
 * hold a reply indefinitely; the reply goes out at the limit, as the feed
 * barrier's does
 */
function appliedThrough(
  effects: ServeCommitEffects,
  cursor: number,
  timeoutMs: number,
): Promise<void> {
  if (effects.appliedCursor() >= cursor) return Promise.resolve();
  return new Promise<void>((done) => {
    const finish = () => {
      clearTimeout(timer);
      off();
      done();
    };
    const timer = setTimeout(finish, timeoutMs);
    const off = effects.onApplied(() => {
      if (effects.appliedCursor() >= cursor) finish();
    });
  });
}
