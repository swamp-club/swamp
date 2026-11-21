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
 * a follower applies commit effects only for commits its read model has
 * applied, since policy and catalog read it; a failed policy reload leaves the
 * policy unknown and the follower refuses reads
 */

import {
  type CommitEffect,
  commitEffectOf,
  POLICY_RELEASE_PARTITION,
} from "../domain/datastore_v3/commit_effects.ts";
import {
  type CommitChange,
  CommitsCompactedError,
} from "../domain/datastore_v3/commit_store.ts";

import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

type Commit = CommitChange["commit"];

const logger = getSwampLogger(["serve", "commit-effects"]);

const PAGE = 1000;

export interface ServeCommitEffectsDeps {
  readonly source: Pick<V3CommitFeedSource, "datastore" | "onMoved">;
  reloadPolicy(): Promise<unknown>;
  /** never rejects: a failed read refuses integration tokens by itself */
  reloadIntegrations?(): Promise<unknown>;
  reloadDelegations?(): Promise<unknown>;
  checkConfig(): void;
  isFollower(): boolean;
  /** without these a follower rebuilds on every grant or group commit */
  readonly releases?: PolicyReleaseFollowing;
}

export interface PolicyReleaseFollowing {
  leaderFence(): number | undefined;
  /** the newest commit to the release record; read from the copy unless given */
  headReleaseCommit?(): Promise<Commit | undefined>;
  /** reads, parses and enforces the release record; throws if it cannot */
  applyRelease(): Promise<void>;
  /** applies a grant commit's revokes and new denies, holding its widenings */
  narrowRelease(): Promise<void>;
}

const EVERY_EFFECT: ReadonlySet<CommitEffect> = new Set([
  "config",
  "lockfile",
  "access",
  "integrations",
  "delegations",
  "policyRelease",
  "runtime",
]);

export class ServeCommitEffects {
  readonly #deps: ServeCommitEffectsDeps;
  #cursor: number;
  #applied: number;
  readonly #pending = new Set<CommitEffect>();
  #policyKnown = true;
  #releaseFence: number | undefined;
  #releaseCommit: Commit | undefined;
  readonly #appliedListeners = new Set<() => void>();
  #running: Promise<void> | undefined;
  #again = false;
  #replaced = false;
  #replacedUnread = false;
  #off: (() => void) | undefined;
  #stopped = false;

  constructor(deps: ServeCommitEffectsDeps) {
    this.#deps = deps;
    this.#cursor = deps.source.datastore.commitStore.highWaterMark().cursor;
    // Serve loaded its policy from this copy before it started watching.
    this.#applied = this.#cursor;
  }

  start(): void {
    this.#off ??= this.#deps.source.onMoved((replaced) => {
      // A replaced copy may have rewritten rows already read: their
      // effects are not seen one by one, so everything is refreshed.
      if (this.#deps.isFollower()) {
        if (replaced) this.#replacedUnread = true;
        return;
      }
      if (replaced) this.#replaced = true;
      this.#schedule();
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#off?.();
    this.#off = undefined;
    await this.#running;
  }

  /**
   * called once the copy and its read model are caught up; a follower's effects
   * wait for it. Without replication the follower opens the leader's
   * commits.db, so leader commits move no head here.
   */
  poke(): void {
    if (this.#replacedUnread) {
      this.#replacedUnread = false;
      this.#replaced = true;
    }
    if (this.#off !== undefined) this.#schedule();
  }

  /**
   * on a follower, the last commit serve may page to: its policy and catalog
   * hold everything up to it
   */
  appliedCursor(): number {
    return this.#applied;
  }

  policyKnown(): boolean {
    return this.#policyKnown;
  }

  onApplied(listener: () => void): () => void {
    this.#appliedListeners.add(listener);
    return () => this.#appliedListeners.delete(listener);
  }

  async settled(): Promise<void> {
    // A pass ending starts the one a poke queued meanwhile.
    while (this.#running !== undefined) await this.#running;
  }

  #schedule(): void {
    if (this.#running !== undefined) {
      this.#again = true;
      return;
    }
    this.#running = this.#pass().catch((error) => {
      logger.warn`Applying the effects of new commits failed: ${error}`;
    }).finally(() => {
      this.#running = undefined;
      if (this.#again && this.#off !== undefined) {
        this.#again = false;
        this.#schedule();
      }
    });
  }

  async #pass(): Promise<void> {
    const store = this.#deps.source.datastore.commitStore;
    const effects = this.#pending;
    if (this.#replaced) {
      this.#replaced = false;
      for (const effect of EVERY_EFFECT) effects.add(effect);
    }
    for (;;) {
      // stopped: what was read stays pending, unapplied
      if (this.#stopped) return;
      const head = this.#deps.isFollower()
        ? this.#deps.source.datastore.readModel.cursor()
        : store.highWaterMark().cursor;
      if (head < this.#cursor) {
        // The copy was replaced behind what was read: refresh everything.
        // What was applied past its head is gone from it.
        this.#cursor = head;
        if (head < this.#applied) this.#advance(head);
        for (const effect of EVERY_EFFECT) effects.add(effect);
        break;
      }
      if (head === this.#cursor) break;
      let page;
      try {
        page = (await store.changesSince(this.#cursor, PAGE))
          .filter((change) => change.cursor <= head);
      } catch (error) {
        if (!(error instanceof CommitsCompactedError)) throw error;
        this.#cursor = head;
        for (const effect of EVERY_EFFECT) effects.add(effect);
        break;
      }
      if (page.length === 0) {
        this.#cursor = head;
        break;
      }
      for (const change of page) {
        const effect = commitEffectOf(change.commit.partition);
        effects.add(effect);
        if (effect === "policyRelease") this.#releaseCommit = change.commit;
      }
      this.#cursor = page[page.length - 1].cursor;
    }
    const cursor = this.#cursor;
    if (this.#stopped) return;
    try {
      await this.#apply(effects);
    } catch (error) {
      // Applied on the next pass: the effects stay pending, and the policy
      // is unknown until a reload succeeds.
      if (effects.has("access") || effects.has("policyRelease")) {
        this.#policyKnown = false;
      }
      throw error;
    }
    effects.clear();
    this.#advance(cursor);
  }

  async #apply(effects: ReadonlySet<CommitEffect>): Promise<void> {
    if (effects.has("config") || effects.has("lockfile")) {
      this.#deps.checkConfig();
    }
    // on a leader too: a stored workflow step or a member's commit can write one
    if (effects.has("integrations")) {
      await this.#deps.reloadIntegrations?.();
    }
    if (effects.has("delegations")) {
      await this.#deps.reloadDelegations?.();
    }
    if (!this.#deps.isFollower()) {
      // A node that took the lead with an unknown policy reloads it: its own
      // writes keep it current only from a known start.
      if (!this.#policyKnown) {
        await this.#deps.reloadPolicy();
        this.#policyKnown = true;
      }
      return;
    }
    // No catalog invalidate: the read model's catch-up before the poke wrote
    // the rows, and a replaced copy's restore rebuilt them.
    if (effects.has("policyRelease")) await this.#followRelease();
    // a grant commit the leader may be holding: only its narrowing applies
    // while this follower enforces the current leader's release
    if (effects.has("access")) {
      if (this.followsLeaderRelease()) {
        await this.#deps.releases!.narrowRelease();
      } else {
        await this.#deps.reloadPolicy();
      }
      this.#policyKnown = true;
    }
  }

  followsLeaderRelease(): boolean {
    const releases = this.#deps.releases;
    if (releases === undefined || this.#releaseFence === undefined) {
      return false;
    }
    return this.#releaseFence === releases.leaderFence();
  }

  async adoptLeaderRelease(): Promise<boolean> {
    if (this.#deps.releases === undefined || !this.#deps.isFollower()) {
      return false;
    }
    await this.#followRelease();
    return this.followsLeaderRelease();
  }

  async #headReleaseCommit(): Promise<Commit | undefined> {
    const { commitStore, namespace } = this.#deps.source.datastore;
    const head = await commitStore.head(namespace, POLICY_RELEASE_PARTITION);
    if (head.seq === 0) return undefined;
    try {
      const [change] = await commitStore.readPartition(
        namespace,
        POLICY_RELEASE_PARTITION,
        head.seq,
        1,
      );
      return change?.commit;
    } catch (error) {
      // compacted away: nothing to verify, so it is not enforced
      if (error instanceof CommitsCompactedError) return undefined;
      throw error;
    }
  }

  async #followRelease(): Promise<void> {
    const releases = this.#deps.releases;
    if (releases === undefined) return;
    const head = () =>
      releases.headReleaseCommit?.() ?? this.#headReleaseCommit();
    let commit = this.#releaseCommit ?? await head();
    this.#releaseCommit = undefined;
    // the content read is the head's, so a head that moves is checked again
    for (let attempt = 0; commit !== undefined && attempt < 3; attempt++) {
      const fence = releases.leaderFence();
      // serve's own commit, under the lease the current leader holds
      if (
        commit.principal !== undefined || commit.fence === undefined ||
        commit.fence !== fence
      ) {
        if (commit.principal !== undefined) {
          logger
            .warn`A policy release committed by ${commit.principal} was refused: only serve publishes the policy`;
        }
        return;
      }
      try {
        await releases.applyRelease();
        // a release built before a revoke must not bring the revoked grant back
        await releases.narrowRelease();
      } catch (error) {
        // unreadable: back to rebuilding from grant commits, at once
        logger.warn`The leader's policy release could not be applied: ${error}`;
        this.#releaseFence = undefined;
        await this.#deps.reloadPolicy();
        this.#policyKnown = true;
        return;
      }
      const now = await head();
      if (now === undefined || now.seq === commit.seq) {
        this.#releaseFence = fence;
        this.#policyKnown = true;
        return;
      }
      commit = now;
    }
  }

  #advance(cursor: number): void {
    if (cursor === this.#applied) return;
    this.#applied = cursor;
    for (const listener of [...this.#appliedListeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}
