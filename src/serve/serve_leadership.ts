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
 * the lease holder leads, others follow and retry the lease. A leader that
 * loses it shuts down and restarts as a fresh follower so no leader state
 * carries over. The lease and fence alone decide who commits.
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

export const DEFAULT_LEADERSHIP_TICK_MS = 10_000;

/**
 * Past the old lease's computed expiry before a follower tries it: take()
 * judges expiry strictly, and an early try that loses restores as a follower.
 */
const LEASE_EXPIRY_MARGIN_MS = 1_000;

/** past it, a leader that never let go is ticked as before */
export const AWAIT_NEW_LEADER_MS = 120_000;

const AWAITING_LEASE_TRY_MS = 1_000;

/** a step of a promotion that waits on the old leader's feed gives way after it */
const PROMOTION_FEED_STOP_MS = 5_000;

/**
 * A restore runs to its end, since take() would only redo it; past the
 * holder's lapse by this much it is taken for hung and aborted.
 */
export const REFRESH_PAST_LAPSE_MS = 60_000;

/**
 * How long a follower's copy may go without a refresh before it stops
 * answering reads: three ticks, so a revoked grant stops allowing reads on a
 * follower within it.
 */
export const DEFAULT_FOLLOWER_STALE_AFTER_MS = 3 * DEFAULT_LEADERSHIP_TICK_MS;

export type ServeRole = "leader" | "follower";

export interface LeadershipLease {
  holdsCurrent(): boolean;
  fence(): number | undefined;
  /**
   * `follow`, when given, bounds the copy work a busy lease leaves; the lease
   * decision itself is never cut short
   */
  take(follow?: AbortSignal): Promise<"writer" | "follower">;
  /**
   * whether the store confirmed the lease within its TTL; false asks for a
   * renewal. Absent, a held lease is taken as confirmed.
   */
  confirmed?(): boolean;
  /**
   * the highest fence whoever holds it, undefined when unreadable; a follower
   * forwards to a leader record's address only at this fence
   */
  currentFence?(): Promise<number | undefined>;
  /** when the holder's lease lapses by this clock; timing only, take() decides */
  expiresAt(): Promise<number | undefined>;
  /** calls the listener when this node finds its lease lost; returns an unsubscribe */
  onLost?(listener: () => void): () => void;
}

/**
 * while current for the leader the record names, a tick restores nothing, and
 * each applied batch marks the copy fresh
 */
export interface FollowerCopyFeed {
  current(leader: ServeLeader | undefined): boolean;
  staleReason(leader: ServeLeader | undefined): string | undefined;
  follow(leader: ServeLeader | undefined): void;
  stop(): Promise<void>;
}

export interface ServeLeadershipDeps {
  readonly instanceId: string;
  readonly address?: string;
  readonly lease: LeadershipLease;
  readonly store: ControlPlaneStore;
  /** signal aborts only when serve stops; honoured until a restore is installed */
  refreshCopy(signal: AbortSignal): Promise<void>;
  /**
   * a follower applies it instead of restoring every tick, and restores only
   * when it is not current. Absent, every tick restores.
   */
  readonly feed?: FollowerCopyFeed;
  /**
   * signs this node's leader record with the team's peer key. Absent, the
   * record carries no proof.
   */
  prove?(leader: ServeLeader): Promise<string | undefined>;
  /**
   * Whether a leader record holds the team's proof. A record that does not
   * names the leader without its address, so nothing is forwarded to it.
   * Absent, every record is taken as written.
   */
  trust?(leader: ServeLeader): Promise<boolean>;
  /**
   * Called when a follower takes the lease, and again as its role becomes
   * leader: forwards still in flight to the old leader end, as it can no
   * longer land them.
   */
  abortForwards?(): void;
  /** stopped turns true once stop() is called: a promotion then ends early */
  onLead(stopped: () => boolean): Promise<void>;
  /**
   * Called after a promoted node's role becomes leader, for work that must run
   * as the leader rather than while it settles; not called for a boot lead.
   * It runs inside the tick, so the lease goes unchecked until it returns.
   */
  onLed?(): Promise<void>;
  /**
   * Called once, when this node finds it lost the lead: serve shuts down.
   * Ticking has stopped by then.
   */
  onLostLead(): Promise<void>;
  readonly tickMs?: number;
  readonly refreshPastLapseMs?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

export class ServeLeadership {
  readonly #deps: ServeLeadershipDeps;
  readonly #tickMs: number;
  readonly #refreshPastLapseMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #role: ServeRole = "follower";
  #since: string | undefined;
  #leader: ServeLeader | undefined;
  #refreshedAt: number | undefined;
  #recordedFence: number | undefined;
  #recordedProof: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #scheduled: Promise<void> | undefined;
  #ticking: Promise<void> | undefined;
  #refreshing: AbortController | undefined;
  /** a refresh a tick stopped waiting for, which may still install its restore */
  #leftRefresh: Promise<unknown> | undefined;
  /**
   * This node took the lease but could not write its leader record: the
   * next tick retries the record, not the lease.
   */
  #leadPending = false;
  #lastTakeAt: number | undefined;
  #lostLead: Promise<void> | undefined;
  #leaseLost = false;
  #leadCheck: Promise<void> | undefined;
  #unsubscribeLost: (() => void) | undefined;
  #stopped = false;
  #awaitingUntil: number | undefined;
  #awaitingPast: number | undefined;
  #awaitingAfter: "frame" | "closed" | undefined;

  constructor(deps: ServeLeadershipDeps) {
    this.#deps = deps;
    this.#tickMs = deps.tickMs ?? DEFAULT_LEADERSHIP_TICK_MS;
    this.#refreshPastLapseMs = deps.refreshPastLapseMs ?? REFRESH_PAST_LAPSE_MS;
    this.#staleAfterMs = deps.staleAfterMs ?? DEFAULT_FOLLOWER_STALE_AFTER_MS;
    this.#now = deps.now ?? Date.now;
  }

  get role(): ServeRole {
    return this.#role;
  }

  leader(): ServeLeader | undefined {
    return this.#role === "leader" ? this.#ownRecord() : this.#leader;
  }

  markRefreshed(): void {
    if (this.#role === "follower") this.#refreshedAt = this.#now();
  }

  /**
   * a leader whose lease the store has not confirmed within its TTL, as after
   * the process was stopped, may already have been taken over: it answers
   * nothing as the leader until a renewal confirms it
   */
  leadUnconfirmed(): boolean {
    return this.#role === "leader" &&
      this.#deps.lease.confirmed !== undefined &&
      !this.#deps.lease.confirmed();
  }

  /**
   * a leader whose lease the hold reported lost, from then until serve stops;
   * a hold still retaking it may win it back, so that alone never counts
   */
  leadLost(): boolean {
    if (this.#lostLead !== undefined) return true;
    return this.#role === "leader" && this.#leaseLost;
  }

  isStale(): boolean {
    if (this.#role === "leader") return false;
    return this.#refreshedAt === undefined ||
      this.#now() - this.#refreshedAt > this.#staleAfterMs;
  }

  async start(initial: "writer" | "follower"): Promise<void> {
    this.#unsubscribeLost ??= this.#deps.lease.onLost?.(() => {
      this.#leaseLost = true;
      this.#checkLeadNow();
    });
    if (initial === "writer") {
      // Serve's boot did the leader's work before it listened, so a node
      // that took the lease at boot leads from the first request: it never
      // answers as a follower while its record is written.
      this.#role = "leader";
      this.#since = new Date(this.#now()).toISOString();
      logger.info`This serve node leads the datastore`;
      await this.#writeRecord();
      await this.#deps.onLead(() => this.#stopped);
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
    this.#schedule(await this.#nextDelay());
  }

  /** a hint only: the lease, tried every second until a higher fence is named, decides */
  leaderGoing(after: "frame" | "closed" = "frame"): void {
    if (this.#stopped || this.#role !== "follower") return;
    const fence = this.#leader?.fence;
    if (this.#awaitingUntil === undefined || this.#awaitingPast !== fence) {
      logger
        .info`The leader is going away; this node tries the writer lease every ${AWAITING_LEASE_TRY_MS} ms until a new leader is named`;
    }
    this.#awaitingUntil = this.#now() + AWAIT_NEW_LEADER_MS;
    this.#awaitingPast = fence;
    // a frame outranks a close: the leader said so
    if (this.#awaitingAfter !== "frame") this.#awaitingAfter = after;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#schedule(AWAITING_LEASE_TRY_MS);
    }
  }

  get awaitingNewLeader(): boolean {
    if (this.#awaitingUntil === undefined) return false;
    const named = this.#leader?.fence;
    return this.#role === "follower" && this.#now() < this.#awaitingUntil &&
      (named === undefined || this.#awaitingPast === undefined ||
        named <= this.#awaitingPast);
  }

  #endAwaiting(): void {
    this.#awaitingUntil = undefined;
    this.#awaitingPast = undefined;
    this.#awaitingAfter = undefined;
  }

  lostLeadHandled(): Promise<void> {
    return this.#lostLead ?? Promise.resolve();
  }

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
   * aborts a follower refresh before its install but awaits a take() in
   * flight, so the lease release never races a promotion
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribeLost?.();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#refreshing?.abort(new Error("serve is stopping"));
    await this.#ticking;
    await this.#leftRefresh;
    await this.#leadCheck;
    await this.#scheduled;
    const feed = this.#deps.feed;
    if (feed !== undefined) {
      await this.#within(
        this.#now() + PROMOTION_FEED_STOP_MS,
        "stopping the commit feed",
        feed.stop(),
      );
    }
  }

  /**
   * After any tick in flight, which may have read the lease before it was
   * lost; it never rejects, and stop() waits for it.
   */
  #checkLeadNow(): void {
    if (this.#stopped || this.#role !== "leader") return;
    if (this.#leadCheck !== undefined) return;
    this.#leadCheck = (this.#ticking ?? Promise.resolve())
      .then(() => this.tick())
      .finally(() => {
        this.#leadCheck = undefined;
      });
  }

  /** A tick never rejects, and stop() waits for the one in flight. */
  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#scheduled = (async () => {
        try {
          await this.tick();
        } finally {
          // the next tick is armed whatever this one or the delay did
          this.#schedule(
            await this.#nextDelay().catch((error) => {
              logger.warn`Timing the next leadership check failed: ${error}`;
              return this.#tickMs;
            }),
          );
        }
      })();
    }, delay);
  }

  /**
   * Past it a follower's tick stops waiting for anything but the lease: the
   * next tick, at most a tick later, tries the lease again.
   */
  async #followerDeadline(): Promise<number> {
    const start = this.#now();
    const tickEnd = start + this.#tickMs;
    const expiresAt = await this.#within(
      tickEnd,
      "reading when the writer lease lapses",
      Promise.resolve().then(() => this.#deps.lease.expiresAt()).catch(() =>
        undefined
      ),
    );
    if (
      expiresAt.done && expiresAt.value !== undefined &&
      Number.isFinite(expiresAt.value) && expiresAt.value > start
    ) {
      return Math.min(tickEnd, expiresAt.value + LEASE_EXPIRY_MARGIN_MS);
    }
    return tickEnd;
  }

  /**
   * waits for work only until the deadline; work that outlasts it goes on,
   * its outcome logged, and onLate tells it to stop if it can
   */
  async #within<T>(
    deadline: number,
    what: string,
    work: Promise<T>,
    onLate?: () => void,
  ): Promise<
    { readonly done: true; readonly value: T } | { readonly done: false }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ readonly done: false }>((resolve) => {
      timer = setTimeout(
        () => resolve({ done: false }),
        Math.max(0, deadline - this.#now()),
      );
    });
    try {
      const outcome = await Promise.race([
        work.then((value) => ({ done: true as const, value })),
        late,
      ]);
      if (!outcome.done) {
        logger
          .warn`Following the leader: ${what} did not finish in time; the writer lease is tried again on the next check`;
        onLate?.();
        work.catch((error) => {
          logger
            .debug`Following the leader: ${what} failed after it was left: ${error}`;
        });
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** capped at the tick, which also detects a lost lead and drives refreshes */
  async #nextDelay(): Promise<number> {
    if (this.#stopped || this.#role === "leader") return this.#tickMs;
    if (this.awaitingNewLeader) return AWAITING_LEASE_TRY_MS;
    this.#endAwaiting();
    const expiresAt = await Promise.resolve().then(() =>
      this.#deps.lease.expiresAt()
    ).catch(() => undefined);
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
      return this.#tickMs;
    }
    const untilExpiry = expiresAt - this.#now();
    if (untilExpiry <= 0) {
      // a lapse no take has tried yet, as when a refresh outlasted it, is
      // tried at once; once a take after it has lost, the tick paces retries
      const tried = this.#lastTakeAt !== undefined &&
        this.#lastTakeAt >= expiresAt;
      return tried ? this.#tickMs : LEASE_EXPIRY_MARGIN_MS;
    }
    return Math.min(this.#tickMs, untilExpiry + LEASE_EXPIRY_MARGIN_MS);
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
      if (this.#timer !== undefined) clearTimeout(this.#timer);
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
    this.#lastTakeAt = this.#now();
    const deadline = await this.#followerDeadline();
    const follow = new AbortController();
    const followTimer = setTimeout(
      () => follow.abort(new Error("the leadership check ran out of time")),
      Math.max(0, deadline - this.#now()),
    );
    let taken: "writer" | "follower";
    try {
      taken = this.#leadPending && lease.holdsCurrent()
        ? "writer"
        : await lease.take(follow.signal);
    } finally {
      clearTimeout(followTimer);
    }
    if (this.#stopped) return;
    if (taken === "writer") {
      this.#deps.abortForwards?.();
      const feed = this.#deps.feed;
      if (feed !== undefined) {
        await this.#within(
          this.#now() + PROMOTION_FEED_STOP_MS,
          "stopping the old leader's commit feed",
          feed.stop(),
        );
      }
      // a restore installed after the lead would replace the leader's copy
      if (this.#leftRefresh !== undefined) {
        await this.#within(
          this.#now() + PROMOTION_FEED_STOP_MS,
          "a copy restore left running",
          this.#leftRefresh,
        );
      }
      await this.#lead();
      return;
    }
    const feed = this.#deps.feed;
    if (feed !== undefined) {
      // the feed keeps the copy current while following the leader the record
      // names. A new leader, or a stopped feed, restores from the lineage first
      // so no commit an old leader never published stays in the copy.
      if (
        !(await this.#within(
          deadline,
          "reading the leader record",
          this.#readLeader(),
        )).done
      ) return;
      // a wait begun with no leader known takes the first one named as the old
      if (this.awaitingNewLeader && this.#awaitingPast === undefined) {
        this.#awaitingPast = this.#leader?.fence;
      }
      if (feed.current(this.#leader)) {
        // a dropped feed back on the same leader was a blip, not a handover
        if (
          this.#awaitingAfter === "closed" &&
          this.#leader?.fence === this.#awaitingPast
        ) this.#endAwaiting();
        return;
      }
      // the fast cadence is for the lease; the copy is restored once a tick
      if (
        this.awaitingNewLeader && this.#refreshedAt !== undefined &&
        this.#now() - this.#refreshedAt < this.#tickMs
      ) return;
      logger
        .info`Restoring this node's copy instead of following the leader's commit feed: ${
        feed.staleReason(this.#leader) ?? "it is not current"
      }`;
      // stopped before the restore so nothing the old socket delivers is queued
      // to apply after it
      if (
        !(await this.#within(deadline, "stopping the commit feed", feed.stop()))
          .done
      ) return;
    }
    if (this.#stopped) return;
    if (!await this.#refresh()) return;
    if (this.#stopped || this.#role !== "follower") return;
    this.#refreshedAt = this.#now();
    if (
      !(await this.#within(
        deadline,
        "reading the leader record",
        this.#readLeader(),
      )).done
    ) return;
    if (this.#stopped || this.#role !== "follower") return;
    feed?.follow(this.#leader);
  }

  /**
   * false when stop() aborted the refresh, or it ran past the holder's lapse
   * by the cap: a refresh honours its abort until its restore is installed
   */
  async #refresh(): Promise<boolean> {
    const refresh = new AbortController();
    this.#refreshing = refresh;
    const started = this.#now();
    try {
      const work = this.#deps.refreshCopy(refresh.signal);
      for (;;) {
        // the holder may renew while the restore runs: its lapse is read again
        const lapse = await this.#holderLapse();
        const cap = lapse === undefined
          ? this.#now() + this.#tickMs
          : lapse + this.#refreshPastLapseMs;
        if (lapse !== undefined && this.#now() >= cap) {
          logger
            .warn`Restoring this node's copy has run ${
            this.#now() - started
          } ms, past the cap after the writer lease of the leader at fence ${
            this.#leader?.fence ?? "unknown"
          } lapsed; it is aborted so the lease can be tried`;
          refresh.abort(new Error("the restore ran past the lease's lapse"));
          const left = work.catch(() => {}).finally(() => {
            if (this.#leftRefresh === left) this.#leftRefresh = undefined;
          });
          this.#leftRefresh = left;
          return false;
        }
        const outcome = await this.#waitUntil(cap, work);
        if (outcome.done) return true;
        if (this.#stopped) return false;
      }
    } catch (error) {
      if (error === refresh.signal.reason) return false;
      throw error;
    } finally {
      this.#refreshing = undefined;
    }
  }

  /** when the holder's lease lapses, if it can be read now; past it nobody renewed */
  async #holderLapse(): Promise<number | undefined> {
    const read = await this.#waitUntil(
      this.#now() + this.#tickMs,
      Promise.resolve().then(() => this.#deps.lease.expiresAt()).catch(() =>
        undefined
      ),
    );
    const lapse = read.done ? read.value : undefined;
    return lapse !== undefined && Number.isFinite(lapse) && lapse > 0
      ? lapse
      : undefined;
  }

  /** like #within, without giving up on the work: it may still be waited for */
  async #waitUntil<T>(
    deadline: number,
    work: Promise<T>,
  ): Promise<
    { readonly done: true; readonly value: T } | { readonly done: false }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ readonly done: false }>((resolve) => {
      timer = setTimeout(
        () => resolve({ done: false }),
        Math.max(0, deadline - this.#now()),
      );
    });
    try {
      return await Promise.race([
        work.then((value) => ({ done: true as const, value })),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * the leader's work runs first while the node still answers as a follower;
   * the role, which opens request gates, changes after, so what it settles and
   * sweeps on taking the lead is never work it just accepted
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
    // stopped mid-promotion: the lease taken goes with the closing release
    if (this.#stopped) return;
    await this.#deps.onLead(() => this.#stopped);
    if (this.#stopped) return;
    // what was forwarded while the leader work ran went to the old leader too
    this.#deps.abortForwards?.();
    this.#role = "leader";
    logger.info`This serve node leads the datastore`;
    try {
      await this.#deps.onLed?.();
    } catch (error) {
      logger.warn`Work after taking the lead failed: ${error}`;
    }
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
      // forward only at the lease's current fence: an earlier leader's record
      // may name an address it does not own; any other fence, or a record
      // without the team's proof, names no address and followers refuse
      if (leader?.address !== undefined && this.#deps.trust !== undefined) {
        const current = await this.#deps.lease.currentFence?.()
          .catch(() => undefined);
        const atCurrentFence = this.#deps.lease.currentFence === undefined ||
          current === leader.fence;
        if (!atCurrentFence || !(await this.#deps.trust(leader))) {
          if (atCurrentFence) {
            logger
              .warn`The serve leader record names ${leader.address} without the team's proof; nothing is forwarded to it`;
          } else {
            logger
              .warn`The serve leader record names ${leader.address} at fence ${leader.fence}, not the lease's; nothing is forwarded to it until the leader records itself`;
          }
          const { address: _address, ...unproven } = leader;
          leader = unproven;
        }
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
