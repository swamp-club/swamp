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
 * Keeping serve's in-memory state current from the commits it sees, on a v3
 * datastore (swamp-club#4120), in place of v2's pollers.
 *
 * Every commit that lands in this node's copy, its own or the leader's
 * through the commit feed, is classified by what it changes
 * ({@link commitEffectOf}): a definition or runtime record rebuilds the
 * catalog, a grant, group, token or worker reloads the access policy, and
 * the config or the extension lockfile asks the config check to run. A
 * leader's own writes keep its catalog and policy current as they land, so
 * on the leader only the config check runs: a lockfile a forwarded commit
 * changed is seen without an interval. When
 * the copy was replaced (a lineage restore, a compaction past what was
 * read), the individual commits are not seen, so everything is refreshed.
 *
 * A follower applies a commit's effects only from a read model that holds it
 * (swamp-club#4207): the leader's commits land in its copy before its read
 * model catches up, and a policy reloaded in between misses the grants they
 * carry. After a replaced copy its policy is unknown until the refresh that
 * replaced it has rebuilt the read model and pokes; a reload that fails
 * leaves it unknown until one succeeds. Serve's reads on a follower refuse
 * while the policy is unknown ({@link ServeCommitEffects.policyKnown}) and
 * page no further than the commits whose effects were applied
 * ({@link ServeCommitEffects.appliedCursor}).
 *
 * @module
 */

import {
  type CommitEffect,
  commitEffectsOf,
} from "../domain/datastore_v3/commit_effects.ts";
import { CommitsCompactedError } from "../domain/datastore_v3/commit_store.ts";
import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "commit-effects"]);

/** The most commits one pass reads. */
const PAGE = 1000;

/** What {@link ServeCommitEffects} needs. */
export interface ServeCommitEffectsDeps {
  readonly source: Pick<V3CommitFeedSource, "datastore" | "onMoved">;
  /**
   * Brings the read model up to every commit the copy holds: a follower's
   * effects are applied only once it has.
   */
  catchUpReadModel(): Promise<void>;
  catalogInvalidate(): void;
  reloadPolicy(): Promise<unknown>;
  /** Runs the config and extension lockfile check. */
  checkConfig(): void;
  /** Whether this node follows: only a follower applies every effect. */
  isFollower(): boolean;
}

/** Every effect, for a refresh that saw no individual commits. */
const EVERY_EFFECT: ReadonlySet<CommitEffect> = new Set([
  "config",
  "lockfile",
  "access",
  "runtime",
]);

/** See the module documentation. */
export class ServeCommitEffects {
  readonly #deps: ServeCommitEffectsDeps;
  /** The last cursor a pass read. */
  #cursor: number;
  /** The last cursor whose effects were applied. */
  #applied: number;
  /** Effects read and not yet applied. */
  readonly #pending = new Set<CommitEffect>();
  #policyKnown = true;
  /** The copy was replaced: a follower waits for the refresh's poke. */
  #awaitingRefresh = false;
  #running: Promise<void> | undefined;
  #again = false;
  #replaced = false;
  #poked = false;
  #off: (() => void) | undefined;
  readonly #appliedListeners = new Set<() => void>();

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
      if (replaced) this.#replaced = true;
      this.#schedule();
    });
  }

  /** Stops watching, and waits for a pass in flight. */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = undefined;
    await this.settled();
  }

  /**
   * Looks for new commits now, and applies what a replaced copy left
   * pending. A follower on a datastore that does not replicate opens the
   * leader's own `commits.db`, so the leader's commits move no head in this
   * process: the feed and the tick's refresh call this after they caught
   * the copy up.
   */
  poke(): void {
    if (this.#off === undefined) return;
    this.#poked = true;
    this.#schedule();
  }

  /** Settles once no pass is running or queued. */
  async settled(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  /**
   * The last cursor whose effects were applied: on a follower, the last
   * commit serve may page to, since its policy and read model hold
   * everything up to it.
   */
  appliedCursor(): number {
    return this.#applied;
  }

  /**
   * Whether this node's policy was loaded from its copy as it is now: false
   * on a follower after a replaced copy until the refresh's poke reloads
   * it, or while a reload that access commits asked for has not succeeded.
   */
  policyKnown(): boolean {
    return this.#policyKnown;
  }

  /** Calls `listener` whenever {@link appliedCursor} moves. */
  onApplied(listener: () => void): () => void {
    this.#appliedListeners.add(listener);
    return () => this.#appliedListeners.delete(listener);
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
    const poked = this.#poked;
    this.#poked = false;
    if (this.#replaced) {
      this.#replaced = false;
      this.#refreshEverything();
    }
    await this.#read();
    if (this.#deps.isFollower()) {
      await this.#applyAsFollower(poked);
    } else {
      this.#applyAsLeader();
    }
  }

  /** Reads every commit past the cursor into the pending effects. */
  async #read(): Promise<void> {
    const store = this.#deps.source.datastore.commitStore;
    for (;;) {
      const head = store.highWaterMark().cursor;
      if (head < this.#cursor) {
        // The copy was replaced behind what was read: refresh everything.
        this.#cursor = head;
        this.#refreshEverything();
        break;
      }
      if (head === this.#cursor) break;
      let page;
      try {
        page = await store.changesSince(this.#cursor, PAGE);
      } catch (error) {
        if (!(error instanceof CommitsCompactedError)) throw error;
        this.#cursor = head;
        this.#refreshEverything();
        break;
      }
      if (page.length === 0) {
        this.#cursor = head;
        break;
      }
      for (
        const effect of commitEffectsOf(page.map((c) => c.commit.partition))
      ) {
        this.#pending.add(effect);
      }
      this.#cursor = page[page.length - 1].cursor;
    }
  }

  #refreshEverything(): void {
    for (const effect of EVERY_EFFECT) this.#pending.add(effect);
    this.#awaitingRefresh = true;
    // What was applied past the replaced copy's head is gone from it.
    const head = this.#deps.source.datastore.commitStore.highWaterMark()
      .cursor;
    if (head < this.#applied) this.#advance(head);
  }

  #applyAsLeader(): void {
    const effects = this.#pending;
    if (effects.has("config") || effects.has("lockfile")) {
      this.#deps.checkConfig();
    }
    effects.clear();
    this.#awaitingRefresh = false;
    this.#advance(this.#cursor);
  }

  async #applyAsFollower(poked: boolean): Promise<void> {
    if (this.#awaitingRefresh) {
      this.#policyKnown = false;
      // The refresh that replaced the copy rebuilds its read model, then
      // pokes: a reload before that reads the read model mid-rebuild.
      if (!poked) return;
    }
    const cursor = this.#cursor;
    const effects = new Set(this.#pending);
    if (effects.size === 0 && cursor === this.#applied) return;
    try {
      await this.#deps.catchUpReadModel();
      if (effects.has("config") || effects.has("lockfile")) {
        this.#deps.checkConfig();
      }
      if (effects.size > 0) this.#deps.catalogInvalidate();
      if (effects.has("access") || this.#awaitingRefresh) {
        await this.#deps.reloadPolicy();
      }
    } catch (error) {
      // Applied on the next pass: a poke, or the next commit.
      if (effects.has("access") || this.#awaitingRefresh) {
        this.#policyKnown = false;
      }
      throw error;
    }
    this.#pending.clear();
    this.#awaitingRefresh = false;
    this.#policyKnown = true;
    this.#advance(cursor);
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
