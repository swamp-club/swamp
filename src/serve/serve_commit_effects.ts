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
  commitEffectsOf,
} from "../domain/datastore_v3/commit_effects.ts";
import { CommitsCompactedError } from "../domain/datastore_v3/commit_store.ts";
import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "commit-effects"]);

const PAGE = 1000;

export interface ServeCommitEffectsDeps {
  readonly source: Pick<V3CommitFeedSource, "datastore" | "onMoved">;
  reloadPolicy(): Promise<unknown>;
  checkConfig(): void;
  isFollower(): boolean;
}

const EVERY_EFFECT: ReadonlySet<CommitEffect> = new Set([
  "config",
  "lockfile",
  "access",
  "runtime",
]);

export class ServeCommitEffects {
  readonly #deps: ServeCommitEffectsDeps;
  #cursor: number;
  #applied: number;
  readonly #pending = new Set<CommitEffect>();
  #policyKnown = true;
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
      for (
        const effect of commitEffectsOf(page.map((c) => c.commit.partition))
      ) {
        effects.add(effect);
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
      if (effects.has("access")) this.#policyKnown = false;
      throw error;
    }
    effects.clear();
    this.#advance(cursor);
  }

  async #apply(effects: ReadonlySet<CommitEffect>): Promise<void> {
    if (effects.has("config") || effects.has("lockfile")) {
      this.#deps.checkConfig();
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
    if (effects.has("access")) {
      await this.#deps.reloadPolicy();
      this.#policyKnown = true;
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
