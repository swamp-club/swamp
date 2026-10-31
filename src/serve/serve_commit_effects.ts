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
 * A follower's copy moves before its read model catches up, and the policy
 * and catalog read the read model. So a follower applies effects only when
 * told its copy is caught up ({@link ServeCommitEffects.poke}), and only of
 * the commits that had landed by then: a reload any sooner reads the files
 * as they were, and no later commit would correct it.
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
  #cursor: number;
  /** The head when a follower's copy was last caught up. */
  #caughtUp: number;
  #running: Promise<void> | undefined;
  #again = false;
  #replaced = false;
  #off: (() => void) | undefined;

  constructor(deps: ServeCommitEffectsDeps) {
    this.#deps = deps;
    this.#cursor = deps.source.datastore.commitStore.highWaterMark().cursor;
    this.#caughtUp = this.#cursor;
  }

  start(): void {
    this.#off ??= this.#deps.source.onMoved((replaced) => {
      // A replaced copy may have rewritten rows already read: their
      // effects are not seen one by one, so everything is refreshed.
      if (replaced) this.#replaced = true;
      if (!this.#deps.isFollower()) this.#schedule();
    });
  }

  /** Stops watching, and waits for a pass in flight. */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = undefined;
    await this.#running;
  }

  /**
   * Looks for new commits now: the copy and its read model are caught up.
   * The feed and the tick's refresh call this after catching the copy up.
   * A follower's effects wait for it, and on a datastore that does not
   * replicate the follower opens the leader's own `commits.db`, so the
   * leader's commits move no head in this process.
   */
  poke(): void {
    this.#caughtUp =
      this.#deps.source.datastore.commitStore.highWaterMark().cursor;
    if (this.#off !== undefined) this.#schedule();
  }

  /** Settles once no pass is running. */
  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
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
    const effects = new Set<CommitEffect>();
    if (this.#replaced) {
      this.#replaced = false;
      for (const effect of EVERY_EFFECT) effects.add(effect);
    }
    for (;;) {
      const head = this.#deps.isFollower()
        ? this.#caughtUp
        : store.highWaterMark().cursor;
      if (head < this.#cursor) {
        // The copy was replaced behind what was read: refresh everything.
        this.#cursor = head;
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
    await this.#apply(effects);
  }

  async #apply(effects: ReadonlySet<CommitEffect>): Promise<void> {
    if (effects.size === 0) return;
    if (effects.has("config") || effects.has("lockfile")) {
      this.#deps.checkConfig();
    }
    if (!this.#deps.isFollower()) return;
    this.#deps.catalogInvalidate();
    if (effects.has("access")) await this.#deps.reloadPolicy();
  }
}
