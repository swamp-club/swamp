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
 * A serve follower following its leader's commit feed (swamp-club#4120).
 *
 * The follower opens one socket to the leader's advertised address with the
 * team's peer key and subscribes from the last cursor its copy holds. Each
 * frame's commits are applied to the copy in order and mark it fresh; a
 * frame with no commits (the leader's heartbeat) marks it fresh too, since
 * the leader sends only what it has published. The feed is current only
 * for the leader it subscribed to: a new leader, a disconnect, a gap or a
 * compacted cursor stops it, and the next tick restores from the lineage
 * and follows again from there.
 *
 * {@link barrier} lets a forwarded write's reply wait, for a bounded time,
 * until the copy holds what the leader had committed, so the caller reads
 * its own write from this node next.
 *
 * @module
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import type { LeaderLink } from "./leader_link.ts";
import type { FollowerCopyFeed } from "./serve_leadership.ts";

const logger = getSwampLogger(["serve", "follower-feed"]);

/** How long a feed may go without a frame before it counts as down. */
export const FOLLOWER_FEED_SILENCE_MS = 15_000;

/** How long a forwarded write's reply waits for the copy to catch up. */
export const FOLLOWER_FEED_BARRIER_MS = 5_000;

/** One commit the leader sent. */
export interface FeedChange {
  readonly cursor: number;
  readonly commit: unknown;
}

/** What a {@link FollowerFeed} needs. */
export interface FollowerFeedOptions {
  readonly link: LeaderLink;
  /** The bearer token the peer key makes. */
  peerToken(): Promise<string>;
  /** The last cursor this node's copy holds. */
  copyCursor(): number;
  /** Applies the leader's commits to the copy, in order. */
  apply(changes: readonly FeedChange[]): Promise<void>;
  /** The copy holds what the leader had published, as of now. */
  onFresh(): void;
  readonly now?: () => number;
}

const SUBSCRIBE_ID = "follower-feed";

/** See the module documentation. */
export class FollowerFeed implements FollowerCopyFeed {
  readonly #options: FollowerFeedOptions;
  readonly #now: () => number;
  #socket: WebSocket | undefined;
  #leader: ServeLeader | undefined;
  #lastFrameAt: number | undefined;
  #applied = 0;
  #failed = false;
  #chain: Promise<void> = Promise.resolve();
  #heads = new Map<string, (cursor: number) => void>();
  #appliedWaiters = new Set<() => void>();
  #generation = 0;

  constructor(options: FollowerFeedOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  current(leader: ServeLeader | undefined): boolean {
    const followed = this.#leader;
    if (
      this.#socket === undefined || this.#failed || followed === undefined ||
      leader === undefined || leader.instanceId !== followed.instanceId ||
      leader.fence !== followed.fence || this.#lastFrameAt === undefined
    ) {
      return false;
    }
    return this.#now() - this.#lastFrameAt <= FOLLOWER_FEED_SILENCE_MS;
  }

  /** Whether the feed is up and applying, for the barrier. */
  get live(): boolean {
    return this.current(this.#leader);
  }

  follow(leader: ServeLeader | undefined): void {
    this.#close();
    this.#leader = leader;
    this.#failed = false;
    this.#lastFrameAt = undefined;
    const generation = ++this.#generation;
    if (leader?.address === undefined) return;
    void this.#open(generation).catch((error) => {
      if (generation !== this.#generation) return;
      this.#failed = true;
      logger.info`Following the leader's commit feed failed: ${error}`;
    });
  }

  stop(): Promise<void> {
    this.#generation++;
    this.#close();
    this.#leader = undefined;
    return this.#chain.catch(() => {});
  }

  /**
   * Waits, for at most {@link FOLLOWER_FEED_BARRIER_MS}, until the copy
   * holds what the leader had published when asked. Returns at once while
   * the feed is down: the reply is not held for a copy that cannot catch up.
   */
  async barrier(): Promise<void> {
    const socket = this.#socket;
    if (!this.live || socket === undefined) return;
    const deadline = this.#now() + FOLLOWER_FEED_BARRIER_MS;
    const id = `feed-head-${crypto.randomUUID()}`;
    const head = await new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#heads.delete(id);
        resolve(undefined);
      }, FOLLOWER_FEED_BARRIER_MS);
      this.#heads.set(id, (cursor) => {
        clearTimeout(timer);
        resolve(cursor);
      });
      try {
        socket.send(JSON.stringify({ type: "commits.head", id }));
      } catch {
        clearTimeout(timer);
        this.#heads.delete(id);
        resolve(undefined);
      }
    });
    if (head === undefined) return;
    while (this.#applied < head && this.live) {
      const left = deadline - this.#now();
      if (left <= 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#appliedWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#appliedWaiters.add(done);
      });
    }
  }

  async #open(generation: number): Promise<void> {
    const token = await this.#options.peerToken();
    if (generation !== this.#generation) return;
    const opened = this.#options.link.openSocket("/", {
      authorization: `Bearer ${token}`,
    });
    if (opened === undefined) {
      this.#failed = true;
      return;
    }
    const socket = opened.socket;
    this.#socket = socket;
    this.#applied = this.#options.copyCursor();
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "commits.subscribe",
        id: SUBSCRIBE_ID,
        payload: { cursor: this.#applied },
      }));
    };
    socket.onmessage = (event) => {
      if (generation !== this.#generation) return;
      if (typeof event.data !== "string") return;
      this.#onFrame(event.data, generation);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (generation !== this.#generation) return;
      this.#socket = undefined;
      this.#failed = true;
      this.#wakeAppliedWaiters();
    };
  }

  #onFrame(data: string, generation: number): void {
    let frame: {
      type?: unknown;
      id?: unknown;
      payload?: { changes?: unknown; cursor?: unknown };
      error?: { code?: unknown; message?: unknown };
    };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === "commits.head" && typeof frame.id === "string") {
      const cursor = frame.payload?.cursor;
      const resolve = this.#heads.get(frame.id);
      this.#heads.delete(frame.id);
      if (resolve !== undefined && typeof cursor === "number") resolve(cursor);
      return;
    }
    if (frame.id !== SUBSCRIBE_ID) return;
    if (frame.type === "error") {
      logger.info`The leader ended its commit feed (${
        String(frame.error?.code)
      }): ${String(frame.error?.message)}`;
      this.#fail();
      return;
    }
    if (frame.type !== "commits.subscribe") return;
    const changes = frame.payload?.changes;
    const cursor = frame.payload?.cursor;
    if (!Array.isArray(changes) || typeof cursor !== "number") {
      this.#fail();
      return;
    }
    this.#chain = this.#chain.then(async () => {
      // A step the previous socket queued, from a leader this node no longer
      // follows, applies nothing and marks nothing fresh (swamp-club#4148).
      if (this.#failed || generation !== this.#generation) return;
      try {
        if (changes.length > 0) {
          await this.#options.apply(changes as FeedChange[]);
        }
        if (generation !== this.#generation) return;
        this.#applied = Math.max(this.#applied, cursor);
        this.#lastFrameAt = this.#now();
        this.#options.onFresh();
        this.#wakeAppliedWaiters();
      } catch (error) {
        if (generation !== this.#generation) return;
        logger
          .info`Applying the leader's commit feed failed; the copy is restored from the lineage instead: ${error}`;
        this.#fail();
      }
    });
  }

  #fail(): void {
    this.#failed = true;
    this.#close();
  }

  #close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    for (const resolve of this.#heads.values()) resolve(-1);
    this.#heads.clear();
    this.#wakeAppliedWaiters();
    if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, "follower feed stopped");
      } catch {
        // Already closing.
      }
    }
  }

  #wakeAppliedWaiters(): void {
    for (const wake of [...this.#appliedWaiters]) wake();
    this.#appliedWaiters.clear();
  }
}
