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

import { LEASE_OPS_FEATURE } from "../infrastructure/datastore_v3/serve_datastore_client.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import type { LeaderLink } from "./leader_link.ts";
import type { FollowerCopyFeed } from "./serve_leadership.ts";

const logger = getSwampLogger(["serve", "follower-feed"]);

export const FOLLOWER_FEED_SILENCE_MS = 15_000;

export const FOLLOWER_FEED_BARRIER_MS = 5_000;

/**
 * how long before a read the feed is behind on is answered as before rather
 * than refused: the readiness bound
 */
export const FOLLOWER_FEED_STUCK_MS = 30_000;

/**
 * caught-up: holds a head the leader named after the caller asked; catching-up:
 * feed is live or recently was; stuck: not live for the stuck bound, so it
 * cannot tell catching up from a log behind the caller
 */
export type FollowerCatchUp = "caught-up" | "catching-up" | "stuck";

export interface FeedChange {
  readonly cursor: number;
  readonly commit: unknown;
}

export interface FollowerFeedOptions {
  readonly link: LeaderLink;
  peerToken(): Promise<string>;
  copyCursor(): number;
  apply(changes: readonly FeedChange[]): Promise<void>;
  onFresh(): void;
  readonly now?: () => number;
}

const SUBSCRIBE_ID = "follower-feed";

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
  #caughtUp: Promise<boolean> | undefined;
  #queuedCaughtUp: Promise<boolean> | undefined;
  #followedAt: number | undefined;
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

  get live(): boolean {
    return this.current(this.#leader);
  }

  follow(leader: ServeLeader | undefined): void {
    this.#close();
    this.#leader = leader;
    this.#failed = false;
    this.#lastFrameAt = undefined;
    this.#followedAt = this.#now();
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
   * returns false at once while the feed is down, the leader named no head, or
   * the wait ran out; true only when the copy holds the head the leader had
   * published when asked
   */
  async barrier(): Promise<boolean> {
    const socket = this.#socket;
    if (!this.live || socket === undefined) return false;
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
    // undefined: the leader named none in time; negative: the feed closed
    if (head === undefined || head < 0) return false;
    while (this.#applied < head && this.live) {
      const left = deadline - this.#now();
      if (left <= 0) return false;
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
    return this.#applied >= head && this.live;
  }

  /**
   * callers share barriers but never one that asked before they arrived, since
   * that head may predate a commit the caller holds; one arriving mid-flight
   * shares the next, which asks once that one settles
   */
  caughtUp(): Promise<FollowerCatchUp> {
    let run: Promise<boolean>;
    if (this.#caughtUp === undefined) {
      run = this.#startCaughtUp();
    } else {
      this.#queuedCaughtUp ??= this.#caughtUp.then(() => {
        this.#queuedCaughtUp = undefined;
        return this.#startCaughtUp();
      });
      run = this.#queuedCaughtUp;
    }
    return run.then((caughtUp) =>
      caughtUp ? "caught-up" : this.#stuck() ? "stuck" : "catching-up"
    );
  }

  #startCaughtUp(): Promise<boolean> {
    const run = this.barrier().finally(() => {
      if (this.#caughtUp === run) this.#caughtUp = undefined;
    });
    this.#caughtUp = run;
    return run;
  }

  /** a feed that follows no leader is stuck */
  #stuck(): boolean {
    if (this.live) return false;
    if (this.#followedAt === undefined) return true;
    const since = Math.max(this.#followedAt, this.#lastFrameAt ?? 0);
    return this.#now() - since > FOLLOWER_FEED_STUCK_MS;
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
        // this copy applies the leader's lease ops
        payload: { cursor: this.#applied, features: [LEASE_OPS_FEATURE] },
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
      // a step the previous socket queued, from a leader this node does not
      // follow, applies nothing and marks nothing fresh
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
