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
 * Serve's role in team mode on a v3 datastore (swamp-club#4096). The node
 * that holds the datastore's writer lease leads: it writes, runs the work
 * and its timers, and records itself as the leader. The others follow: they
 * keep their copy current, answer reads from it, refuse writes, and try the
 * lease on every tick, so one takes over once the leader's lease expires.
 * A leader whose lease another node took over does not follow: it shuts down
 * (`onLostLead`), and its supervisor starts it again as a fresh follower, so
 * no state of its time as leader carries into following.
 *
 * The lease and its fence alone decide who commits; this service only
 * tracks the role so serve starts and stops the leader's work.
 *
 * @module
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  parseServeLeader,
  serializeServeLeader,
  SERVE_LEADER_KEY,
  type ServeLeader,
} from "../domain/datastore_v3/serve_leader.ts";

const logger = getSwampLogger(["serve", "leadership"]);

/** How often a node checks the lease and refreshes its copy. */
export const DEFAULT_LEADERSHIP_TICK_MS = 10_000;

/**
 * How long a follower's copy may go without a refresh before it stops
 * answering reads: three ticks, so a revoked grant stops allowing reads on a
 * follower within it.
 */
export const DEFAULT_FOLLOWER_STALE_AFTER_MS = 3 * DEFAULT_LEADERSHIP_TICK_MS;

/** Serve's role on the datastore. */
export type ServeRole = "leader" | "follower";

/** The writer lease, as this node sees it. */
export interface LeadershipLease {
  /** Whether this process holds the current lease. */
  holdsCurrent(): boolean;
  /** The fence this process holds, if any. */
  fence(): number | undefined;
  /**
   * Tries the lease once, without waiting. A `writer` result holds it with
   * the copy made current, so the node can lead at once.
   */
  take(): Promise<"writer" | "follower">;
}

/**
 * The leader's commit feed, as a follower follows it (swamp-club#4120):
 * while it is current for the leader the record names, a tick restores
 * nothing, and each batch it applies marks the copy fresh
 * ({@link ServeLeadership.markRefreshed}).
 */
export interface FollowerCopyFeed {
  /** Whether the feed keeps the copy current for `leader`. */
  current(leader: ServeLeader | undefined): boolean;
  /** Follows `leader`'s feed from the copy as it is now. */
  follow(leader: ServeLeader | undefined): void;
  /** Stops following. */
  stop(): Promise<void>;
}

/** What {@link ServeLeadership} needs. */
export interface ServeLeadershipDeps {
  readonly instanceId: string;
  /** This node's own address, published in the leader record. */
  readonly address?: string;
  readonly lease: LeadershipLease;
  /** The control plane every node shares, where the leader record lives. */
  readonly store: ControlPlaneStore;
  /** Brings this node's copy up to the leader's commits. */
  refreshCopy(): Promise<void>;
  /**
   * The leader's commit feed (swamp-club#4120): a follower applies it in
   * place of restoring on every tick, and restores only when it is not
   * current. Absent, every tick restores.
   */
  readonly feed?: FollowerCopyFeed;
  /**
   * Signs this node's leader record with the team's peer key
   * (swamp-club#4120). Absent, the record carries no proof.
   */
  prove?(leader: ServeLeader): Promise<string | undefined>;
  /**
   * Whether a leader record holds the team's proof. A record that does not
   * names the leader without its address, so nothing is forwarded to it.
   * Absent, every record is taken as written.
   */
  trust?(leader: ServeLeader): Promise<boolean>;
  /** Starts the leader's work; called when this node takes the lead. */
  onLead(): Promise<void>;
  /**
   * Called once, when this node finds it lost the lead: serve shuts down.
   * Ticking has stopped by then.
   */
  onLostLead(): Promise<void>;
  readonly tickMs?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

/** See the module documentation. */
export class ServeLeadership {
  readonly #deps: ServeLeadershipDeps;
  readonly #tickMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #role: ServeRole = "follower";
  #since: string | undefined;
  #leader: ServeLeader | undefined;
  #refreshedAt: number | undefined;
  #recordedFence: number | undefined;
  #recordedProof: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;
  /**
   * This node took the lease but could not write its leader record: the
   * next tick retries the record, not the lease.
   */
  #leadPending = false;
  /** The lost-lead handler, started outside any tick. */
  #lostLead: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: ServeLeadershipDeps) {
    this.#deps = deps;
    this.#tickMs = deps.tickMs ?? DEFAULT_LEADERSHIP_TICK_MS;
    this.#staleAfterMs = deps.staleAfterMs ?? DEFAULT_FOLLOWER_STALE_AFTER_MS;
    this.#now = deps.now ?? Date.now;
  }

  /** This node's role. */
  get role(): ServeRole {
    return this.#role;
  }

  /**
   * The leader as this node knows it: itself while it leads, otherwise the
   * last record it read, if any.
   */
  leader(): ServeLeader | undefined {
    return this.#role === "leader" ? this.#ownRecord() : this.#leader;
  }

  /**
   * The copy was brought up to the leader's commits just now, by the
   * leader's commit feed (swamp-club#4120).
   */
  markRefreshed(): void {
    if (this.#role === "follower") this.#refreshedAt = this.#now();
  }

  /**
   * Whether this node's copy is too old to answer reads from: only a
   * follower's, once it went without a refresh for longer than the bound.
   */
  isStale(): boolean {
    if (this.#role === "leader") return false;
    return this.#refreshedAt === undefined ||
      this.#now() - this.#refreshedAt > this.#staleAfterMs;
  }

  /**
   * Starts in the role serve's first hold gave it (`writer` when it took the
   * lease), then checks on every tick.
   */
  async start(initial: "writer" | "follower"): Promise<void> {
    if (initial === "writer") {
      // Serve's boot did the leader's work before it listened, so a node
      // that took the lease at boot leads from the first request: it never
      // answers as a follower while its record is written.
      this.#role = "leader";
      this.#since = new Date(this.#now()).toISOString();
      logger.info`This serve node leads the datastore`;
      await this.#writeRecord();
      await this.#deps.onLead();
    } else {
      this.#refreshedAt = this.#now();
      await this.#readLeader();
      const leader = this.#leader;
      this.#deps.feed?.follow(leader);
      if (leader === undefined) {
        logger
          .info`Another serve node leads this datastore; this node follows it`;
      } else if (leader.address === undefined) {
        logger
          .info`Serve instance ${leader.instanceId} leads this datastore; this node follows it`;
      } else {
        logger
          .info`Serve instance ${leader.instanceId} leads this datastore at ${leader.address}; this node follows it`;
      }
    }
    // A tick never rejects, and stop() waits for the one in flight.
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#tickMs);
  }

  /**
   * Settles once the lost-lead handler has run; resolves at once while this
   * node has not lost the lead.
   */
  lostLeadHandled(): Promise<void> {
    return this.#lostLead ?? Promise.resolve();
  }

  /** One check of the lease, one at a time; ticks during one are skipped. */
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#ticking !== undefined) return this.#ticking;
    this.#ticking = this.#tickOnce().catch((error) => {
      logger.warn`Checking serve's lead on the datastore failed: ${error}`;
    }).finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  /**
   * Stops ticking and waits for a tick in flight. The leader record is left:
   * the lease decides, and the next leader overwrites it.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#ticking;
    await this.#deps.feed?.stop();
  }

  async #tickOnce(): Promise<void> {
    const lease = this.#deps.lease;
    if (this.#role === "leader") {
      if (lease.holdsCurrent()) {
        await this.#writeRecordIfMoved();
        return;
      }
      logger
        .error`This serve node lost the datastore's writer lease to another node; it stops, to start again as a follower`;
      this.#stopped = true;
      if (this.#timer !== undefined) clearInterval(this.#timer);
      // Its gates close while it stops: it takes nothing more.
      this.#role = "follower";
      this.#since = undefined;
      // Started outside this tick, which then ends: the handler shuts serve
      // down, and the shutdown waits for stop(), which waits for this tick.
      this.#lostLead = Promise.resolve().then(() => this.#deps.onLostLead())
        .catch((error) => {
          logger.error`Stopping after losing the lead failed: ${error}`;
        });
      return;
    }
    // A lease already taken, whose record write failed, is not taken again:
    // only the record is retried.
    const taken = this.#leadPending && lease.holdsCurrent()
      ? "writer"
      : await lease.take();
    if (this.#stopped) return;
    if (taken === "writer") {
      await this.#deps.feed?.stop();
      await this.#lead();
      return;
    }
    const feed = this.#deps.feed;
    if (feed !== undefined) {
      // The feed keeps the copy current while it follows the leader the
      // record names. A new leader, or a feed that stopped, restores from
      // the lineage first, so no commit an old leader never published
      // stays in the copy (swamp-club#4120).
      await this.#readLeader();
      if (feed.current(this.#leader)) return;
    }
    await this.#deps.refreshCopy();
    this.#refreshedAt = this.#now();
    await this.#readLeader();
    feed?.follow(this.#leader);
  }

  /**
   * Takes the lead: the leader's work runs first, while the node still
   * answers as a follower, and the role (which opens the request gates)
   * changes only once it is done, so what the leader settles and sweeps on
   * taking the lead is never work it has just accepted.
   */
  async #lead(): Promise<void> {
    this.#since = new Date(this.#now()).toISOString();
    // Not before the record is written: a leader that took the lead from
    // this node, and has not noticed yet, judges its peers by it. The next
    // tick, still holding the lease, tries again.
    if (!await this.#writeRecord()) {
      this.#since = undefined;
      this.#leadPending = true;
      return;
    }
    this.#leadPending = false;
    await this.#deps.onLead();
    this.#role = "leader";
    logger.info`This serve node leads the datastore`;
  }

  async #writeRecordIfMoved(): Promise<void> {
    if (this.#deps.lease.fence() !== this.#recordedFence) {
      await this.#writeRecord();
      return;
    }
    // A record whose proof no longer holds (the team's key was made or
    // replaced since) is signed again, so followers go on forwarding to it.
    if (this.#deps.prove !== undefined) {
      const record = this.#ownRecord();
      if (record === undefined) return;
      const proof = await this.#deps.prove(record).catch(() => undefined);
      if (proof !== undefined && proof !== this.#recordedProof) {
        await this.#writeRecord();
      }
    }
  }

  /** Writes the leader record; false when it could not be written. */
  async #writeRecord(): Promise<boolean> {
    let record = this.#ownRecord();
    if (record === undefined) return false;
    // A proof that cannot be made leaves the record unproven, never
    // unwritten: it still names the leader, and is signed on a later tick.
    const proof = await this.#deps.prove?.(record).catch((error) => {
      logger.warn`Signing this serve node's leader record failed: ${error}`;
      return undefined;
    });
    if (proof !== undefined) record = { ...record, proof };
    try {
      await this.#deps.store.put(
        SERVE_LEADER_KEY,
        serializeServeLeader(record),
      );
      this.#recordedFence = record.fence;
      this.#recordedProof = proof;
      return true;
    } catch (error) {
      logger.warn`Recording this serve node as the leader failed: ${error}`;
      return false;
    }
  }

  #ownRecord(): ServeLeader | undefined {
    const fence = this.#deps.lease.fence();
    if (fence === undefined || this.#since === undefined) return undefined;
    return {
      instanceId: this.#deps.instanceId,
      fence,
      ...(this.#deps.address !== undefined
        ? { address: this.#deps.address }
        : {}),
      since: this.#since,
    };
  }

  async #readLeader(): Promise<void> {
    try {
      const data = await this.#deps.store.get(SERVE_LEADER_KEY);
      let leader = data === null ? undefined : parseServeLeader(data);
      if (
        leader?.address !== undefined && this.#deps.trust !== undefined &&
        !(await this.#deps.trust(leader))
      ) {
        logger
          .warn`The serve leader record names ${leader.address} without the team's proof; nothing is forwarded to it`;
        const { address: _address, ...unproven } = leader;
        leader = unproven;
      }
      // A record this node left from when it led names no leader now.
      this.#leader = leader?.instanceId === this.#deps.instanceId
        ? undefined
        : leader;
    } catch (error) {
      logger.debug`Reading the serve leader record failed: ${error}`;
    }
  }
}
