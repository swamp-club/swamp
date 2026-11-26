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
 * a local file lock cannot keep checkouts on different machines apart, so the
 * lock is serve's own. A fenced lease that cannot be renewed has lapsed: onLost
 * fires once and the work is cancelled; unfenced only logs
 */

import { processRuntimeSlot } from "../runtime/process_runtime.ts";
import { UserError } from "../../domain/errors.ts";
import { LEASE_LAPSED_CODE } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ServeNotLeaderError } from "../../domain/datastore_v3/serve_leader.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "../../domain/datastore_v3/writer_lease.ts";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import { withSpan } from "../tracing/tracer.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type {
  CatchUpRequest,
  DeliveredCatchUp,
  LockLease,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  EXPLICIT_LEASE_RENEWAL_RESPONSE_MS,
  type ExplicitLease,
  takeUnrenewedLease,
} from "./explicit_model_leases.ts";
import {
  dropServeLease,
  holdServeLease,
  offerServeLeaseRelease,
  serveLeaseReleasedByCommit,
  withdrawServeLeaseRelease,
} from "./serve_lease_registry.ts";
import {
  ServeLeaseLapsedLatch,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";
import { serveClockOf } from "./serve_offline.ts";
import { describeHolder, outlastsWait } from "./serve_lease_holder.ts";
import { LockCatchUpBehindError } from "./serve_catch_up.ts";
import {
  type CommandLeaseRecords,
  commandLeaseRecordsAt,
} from "./serve_command_leases.ts";
import {
  latchServeUnreachable,
  serveDatastoreClientFor,
} from "./serve_datastore_client.ts";

const logger = getSwampLogger(["datastore", "lock", "serve"]);

export const SERVE_LOCK_TTL_MS = 30_000;
export const SERVE_LOCK_REQUEST_WAIT_MS = 10_000;
/**
 * commits a catch-up under a lock may still have to apply; further behind,
 * the lock is released while the copy catches up
 */
export const LOCK_CATCH_UP_MAX_COMMITS = 128;
const lockCatchUp = processRuntimeSlot(() => ({
  maxCommits: LOCK_CATCH_UP_MAX_COMMITS,
}));

export function setLockCatchUpMaxCommitsForTesting(max?: number): void {
  lockCatchUp().maxCommits = max ?? LOCK_CATCH_UP_MAX_COMMITS;
}
/** bounded rounds before the rest is caught up under the lock, with a warning */
export const LOCK_CATCH_UP_ROUNDS = 3;
const RETRY_INTERVAL_MS = 100;
const MAX_BACKOFF_MS = 1_000;

const MAX_DEADLINE_MARGIN_MS = 2_000;
/** serve frees an unreleased lease at its TTL, so a release never waits long */
const RELEASE_DEADLINE_MS = 5_000;

/**
 * the work under a lapsed fenced lease does not hold the lock, so it is
 * cancelled and serve refuses any commit it still sends
 */
export class ServeLeaseLapsedError extends UserError {
  constructor(readonly lockKey: string, readonly reason: string) {
    super(
      `The lock ${lockKey} at serve lapsed (${reason}), so this work was ` +
        `cancelled: another command may now hold it`,
      LEASE_LAPSED_CODE,
    );
    this.name = "ServeLeaseLapsedError";
  }
}

export type ServeLockClient =
  & Pick<
    ServeDatastoreClient,
    "acquireLock" | "renewLock" | "releaseLock" | "baseUrl" | "timeoutMs"
  >
  & { close?(): void };

export interface ServeLockOptions {
  readonly client: () => ServeLockClient;
  readonly lockKey: string;
  readonly displayKey?: string;
  readonly ttlMs?: number;
  readonly maxWaitMs: number;
  readonly requestWaitMs?: number;
  readonly retryIntervalMs?: number;
  /**
   * Runs once the lease is taken, before `acquire` resolves, with the
   * catch-up serve answered with the lease, if any; a failure releases the
   * lease and rejects `acquire`. With `maxCommits`, a copy further behind
   * rejects with LockCatchUpBehindError.
   */
  readonly onAcquired?: (
    delivered?: DeliveredCatchUp,
    maxCommits?: number,
  ) => Promise<void>;
  /**
   * where the command leases this checkout holds are recorded, so the next
   * command releases one its dead predecessor held instead of waiting its TTL
   */
  readonly commandLeases?: CommandLeaseRecords;
  /** the copy's catch-up with the lock released, for a copy too far behind */
  readonly catchUpOutside?: () => Promise<void>;
  /**
   * the catch-up under the lock found serve unreachable, with a live explicit
   * lease held; true when that put the checkout offline
   */
  readonly onCatchUpUnreachable?: (error: ServeUnreachableError) => boolean;
  /** the acquire failed for good: whatever waited on its catch-up stops waiting */
  readonly onGiveUp?: () => void;
  /** where the checkout's copy stands, for serve to answer with the lease */
  readonly catchUpRequest?: () => CatchUpRequest | undefined;
  /**
   * the first contact found serve unreachable, or leaderless for a live
   * explicit lease; true when that put the checkout offline
   */
  readonly onUnreachable?: (error: ServeUnreachableError) => boolean;
  readonly root?: string;
  readonly onReleased?: () => void;
  readonly onLost?: (error: ServeLeaseLapsedError) => void;
  /**
   * the explicit lease this checkout holds on the key, if any: the hold takes
   * it over instead of asking for another, renews it while held, and leaves it
   * held when released
   */
  readonly adopt?: () => Promise<ExplicitLease | undefined>;
  readonly forget?: (leaseId: string) => Promise<void>;
  /**
   * A lock local to the checkout, held while an explicit lease is adopted:
   * serve no longer keeps two of the checkout's commands apart under it,
   * so this does.
   */
  readonly localLock?: () => DistributedLock;
  readonly now?: () => number;
  readonly monotonic?: () => number;
  /**
   * undefined while online. Offline, the hold never asks serve: it takes the
   * checkout-local lock and adopts the recorded explicit lease until its end by
   * serve's clock less `skewMs`, when the work is cancelled
   */
  readonly offline?: () =>
    | { readonly clockOffsetMs?: number; readonly skewMs: number }
    | undefined;
}

export class ServeLock implements DistributedLock {
  readonly #options: ServeLockOptions;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  #client: ServeLockClient | undefined;
  #lease: LockLease | undefined;
  #acquiredAt: number | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #renewing: Promise<void> | undefined;
  #hold: AbortController | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #lost = false;
  #adopted = false;
  #local: DistributedLock | undefined;
  /** Set while the hold is released: a renewal in flight cannot lapse it. */
  #releasing = false;
  /** a lapse met while releasing: it fires if the hold outlives the release */
  #lapsedWhileReleasing: string | undefined;
  #localOnly = false;
  /** the last acquire failed in onAcquired, after serve granted the lease */
  #settleFailed = false;
  /** the adoption a serve_not_leader refused, while still live */
  #adoptionRefused:
    | { readonly refusal: unknown; readonly offline: ServeUnreachableError }
    | undefined;

  constructor(options: ServeLockOptions) {
    this.#options = options;
    this.#ttlMs = options.ttlMs ?? SERVE_LOCK_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonic ?? (() => performance.now());
  }

  get lease(): LockLease | undefined {
    return this.#lease;
  }

  /**
   * Takes the lock at serve, asking again until `maxWaitMs` has passed.
   *
   * @throws LockTimeoutError when it is still held then
   * @throws ServeUnreachableError when serve cannot be reached: the
   *   command ends before it changes anything
   */
  acquire(signal?: AbortSignal): Promise<void> {
    return withSpan(
      "swamp.datastore.v3.serve.lock.acquire",
      {},
      () => this.#acquire(signal),
    );
  }

  async #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (this.#lease !== undefined || this.#localOnly) return;
    signal?.throwIfAborted();
    const offline = this.#options.offline?.();
    if (offline !== undefined) {
      await this.#acquireOffline(offline);
      return;
    }
    if (await this.#offlineUnrenewed()) return;
    const outside = this.#options.catchUpOutside;
    for (let round = 1;; round++) {
      const maxCommits = outside !== undefined && round <= LOCK_CATCH_UP_ROUNDS
        ? lockCatchUp().maxCommits
        : undefined;
      this.#settleFailed = false;
      try {
        await this.#acquireOnline(signal, maxCommits);
        return;
      } catch (error) {
        if (
          !(error instanceof LockCatchUpBehindError) ||
          maxCommits === undefined || this.#lease !== undefined
        ) {
          await this.#afterFailure(error);
          return;
        }
        this.#settleFailed = false;
        const behind = error.pending === undefined
          ? "behind serve's compaction"
          : `${error.pending} or more commits behind`;
        if (round === LOCK_CATCH_UP_ROUNDS) {
          logger
            .warn`This checkout's copy was still ${behind} serve after ${round} catch-ups outside the lock on ${this.#displayKey()}; the rest is caught up under it`;
        } else {
          logger
            .debug`This checkout's copy is ${behind} serve; catching up with the lock on ${this.#displayKey()} released`;
        }
        try {
          await outside!();
        } catch (outsideError) {
          await this.#afterFailure(outsideError);
          return;
        }
        const now = this.#options.offline?.();
        if (now !== undefined) {
          await this.#acquireOffline(now);
          return;
        }
      }
    }
  }

  /**
   * an unreachable serve goes offline by the offline rules; one met by the
   * catch-up under the lock only with a live explicit lease, the rest exit 75
   */
  async #afterFailure(error: unknown): Promise<void> {
    const refused = this.#adoptionRefused;
    this.#adoptionRefused = undefined;
    const atCatchUp = this.#settleFailed;
    this.#settleFailed = false;
    const unreachable = error instanceof ServeUnreachableError
      ? error
      : refused !== undefined && refused.refusal === error
      ? refused.offline
      : undefined;
    let goneOffline = false;
    if (unreachable !== undefined && this.#lease === undefined) {
      goneOffline = atCatchUp
        ? await this.#explicitLiveFor(unreachable.serveUrl) &&
          this.#options.onCatchUpUnreachable?.(unreachable) === true
        : this.#options.onUnreachable?.(unreachable) === true;
    }
    const now = goneOffline ? this.#options.offline?.() : undefined;
    if (now === undefined) {
      this.#options.onGiveUp?.();
      throw error;
    }
    await this.#acquireOffline(now);
  }

  async #explicitLiveFor(baseUrl: string): Promise<boolean> {
    const explicit = await this.#options.adopt?.();
    return explicit !== undefined && this.#liveFor(explicit, baseUrl);
  }

  /**
   * a live recorded lease the bind could not renew goes offline here, without
   * asking serve a second time; true when it did
   */
  async #offlineUnrenewed(): Promise<boolean> {
    const root = this.#options.root;
    if (root === undefined || this.#options.adopt === undefined) return false;
    const explicit = await this.#options.adopt();
    if (explicit === undefined) return false;
    const failed = takeUnrenewedLease(root, explicit.leaseId);
    if (failed === undefined) return false;
    const { baseUrl, error } = failed;
    const unreachable = !this.#liveFor(explicit, baseUrl)
      ? undefined
      : error instanceof ServeUnreachableError
      ? error
      : error instanceof Error && error.name === "TimeoutError"
      ? new ServeUnreachableError(baseUrl, "maybe", error)
      : this.#noLeaderFor(explicit, baseUrl, error);
    if (
      unreachable === undefined ||
      this.#options.onUnreachable?.(unreachable) !== true
    ) {
      return false;
    }
    const offline = this.#options.offline?.();
    if (offline === undefined) return false;
    await this.#acquireOffline(offline);
    return true;
  }

  async #acquireOnline(
    signal: AbortSignal | undefined,
    maxCommits: number | undefined,
  ): Promise<void> {
    if (await this.#adoptExplicit(maxCommits)) return;
    const client = this.#options.client();
    await this.#releaseDeadPredecessors(client);
    const hold = new AbortController();
    let delivered: DeliveredCatchUp | undefined;
    const started = this.#now();
    let backoff = this.#options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    let heldBy = "another caller";
    try {
      while (true) {
        // checked between asks only: aborting an ask serve may have granted
        // would leave its lease held at serve until the TTL
        signal?.throwIfAborted();
        const remaining = this.#options.maxWaitMs - (this.#now() - started);
        if (remaining <= 0) {
          throw this.#timeout(client, heldBy, this.#now() - started);
        }
        // Inside the request's own timeout, with room for the reply.
        const waitMs = Math.max(
          0,
          Math.min(
            remaining,
            this.#options.requestWaitMs ?? SERVE_LOCK_REQUEST_WAIT_MS,
            Math.floor(client.timeoutMs / 2),
          ),
        );
        const asked = this.#now();
        const askedMonotonic = this.#monotonic();
        const catchUp = this.#options.catchUpRequest?.();
        const reply = await client.acquireLock(
          this.#options.lockKey,
          this.#ttlMs,
          waitMs,
          hold.signal,
          {
            budgetMs: remaining,
            ...(catchUp === undefined ? {} : { catchUp }),
          },
        );
        if (reply.acquired) {
          this.#client = client;
          this.#hold = hold;
          this.#lease = reply.lease;
          delivered = reply.catchUp;
          this.#acquiredAt = this.#now();
          this.#lost = false;
          this.#lapsedWhileReleasing = undefined;
          // Measured from when the request was sent: serve's TTL started
          // no earlier.
          this.#armDeadline(askedMonotonic);
          this.#startHeartbeat();
          break;
        }
        heldBy = describeHolder(reply.heldBy, reply.holder);
        // an explicit lease that ends after this wait would only be waited
        // out to the same refusal
        if (
          outlastsWait(
            reply.holder,
            started + this.#options.maxWaitMs,
            client.baseUrl,
          )
        ) {
          throw this.#timeout(client, heldBy, this.#now() - started);
        }
        // Serve answered before its wait was up (a lock it could not wait
        // on): pause before asking again.
        if (this.#now() - asked < waitMs || waitMs === 0) {
          const pause = Math.min(
            backoff,
            Math.max(0, remaining - (this.#now() - asked)),
          );
          await sleepUnlessAborted(pause, signal);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    } catch (error) {
      if (this.#lease === undefined) client.close?.();
      throw error;
    }
    await this.#recordCommandLease();
    await this.#settleAcquired(delivered, maxCommits);
  }

  /**
   * a lease on this key that a command of this checkout held when its process
   * died is ended at serve, so this one takes the lock with a fence above it
   */
  async #releaseDeadPredecessors(client: ServeLockClient): Promise<void> {
    const leases = this.#options.commandLeases;
    if (leases === undefined) return;
    let dead: readonly string[];
    try {
      dead = await leases.deadOn(this.#options.lockKey);
    } catch (error) {
      logger
        .debug`Could not read the leases this checkout's commands hold: ${error}`;
      return;
    }
    for (const leaseId of dead) {
      try {
        await client.releaseLock(
          leaseId,
          AbortSignal.timeout(RELEASE_DEADLINE_MS),
        );
        await leases.forget(leaseId);
        logger
          .info`Released the lock ${this.#displayKey()} that a command of this checkout held when it stopped`;
      } catch (error) {
        // the ask below waits for its TTL, as without the record
        logger
          .debug`Could not release the lease ${leaseId} a stopped command of this checkout held: ${error}`;
      }
    }
  }

  async #recordCommandLease(): Promise<void> {
    const lease = this.#lease;
    if (lease === undefined || this.#options.commandLeases === undefined) {
      return;
    }
    try {
      await this.#options.commandLeases.record(lease);
    } catch (error) {
      logger
        .debug`Could not record the lease on ${this.#displayKey()}, which a later command then waits out: ${error}`;
    }
  }

  async #adoptExplicit(maxCommits: number | undefined): Promise<boolean> {
    // Read once without the local lock, so a checkout holding no explicit
    // lease never takes it; read again under it below.
    if (
      this.#options.adopt === undefined ||
      await this.#options.adopt() === undefined
    ) {
      return false;
    }
    // Another of the checkout's commands may be using, or releasing, the
    // lease.
    const local = this.#options.localLock?.();
    await local?.acquire();
    let adopted = false;
    try {
      adopted = await this.#adoptRecorded(local);
    } finally {
      if (!adopted) await local?.release();
    }
    if (adopted) await this.#settleAcquired(undefined, maxCommits);
    return adopted;
  }

  async #adoptRecorded(local: DistributedLock | undefined): Promise<boolean> {
    const explicit = await this.#options.adopt!();
    if (explicit === undefined) return false;
    const client = this.#options.client();
    const hold = new AbortController();
    const asked = this.#monotonic();
    let renewed: LockLease | undefined;
    try {
      // Names its hold: a lease recorded before its extension landed is
      // still a command's at serve, whose TTL bounds a long hold.
      renewed = await client.renewLock(
        explicit.leaseId,
        explicit.holdMs,
        hold.signal,
        {
          holdMs: explicit.holdMs,
          responseBaseMs: EXPLICIT_LEASE_RENEWAL_RESPONSE_MS,
        },
      );
    } catch (error) {
      client.close?.();
      const offline = this.#noLeaderFor(explicit, client.baseUrl, error);
      this.#adoptionRefused = offline === undefined
        ? undefined
        : { refusal: error, offline };
      throw error;
    }
    if (renewed === undefined) {
      client.close?.();
      logger
        .warn`The model lease on ${this.#displayKey()} has ended at serve; taking the lock again`;
      await this.#options.forget?.(explicit.leaseId);
      return false;
    }
    this.#client = client;
    this.#hold = hold;
    this.#adopted = true;
    this.#lease = {
      ...renewed,
      leaseId: explicit.leaseId,
      lockKey: explicit.lockKey,
      ttlMs: explicit.holdMs,
      fence: explicit.fence,
      floor: explicit.floor,
      holdMs: explicit.holdMs,
    };
    this.#acquiredAt = this.#now();
    this.#lost = false;
    this.#lapsedWhileReleasing = undefined;
    this.#local = local;
    this.#armDeadline(asked);
    this.#startHeartbeat();
    return true;
  }

  /**
   * a renewal refused as not the leader, of a lease live by serve's clock less
   * the skew, may go offline as if serve were unreachable: one that may have
   * run only extended the lease the offline write lands under
   */
  #noLeaderFor(
    explicit: ExplicitLease,
    baseUrl: string,
    error: unknown,
  ): ServeUnreachableError | undefined {
    if (
      !(error instanceof ServeNotLeaderError) ||
      !this.#liveFor(explicit, baseUrl)
    ) {
      return undefined;
    }
    return new ServeUnreachableError(
      baseUrl,
      error.inFlight ? "maybe" : "never",
      new Error(`serve has no leader right now: ${error.message}`, {
        cause: error,
      }),
    );
  }

  #liveFor(explicit: ExplicitLease, baseUrl: string): boolean {
    const offsetMs = serveClockOf(baseUrl)?.offsetMs ?? 0;
    return Date.parse(explicit.expiresAt) - offsetMs -
        WRITER_LEASE_CLOCK_SKEW_MS - this.#now() > 0;
  }

  /**
   * holds the checkout-local lock and the recorded explicit lease while it
   * lasts; nothing is renewed, but the lease stays registered so queued work
   * records it and lands under it
   */
  async #acquireOffline(
    offline: { readonly clockOffsetMs?: number; readonly skewMs: number },
  ): Promise<void> {
    const local = this.#options.localLock?.();
    await local?.acquire();
    let held = false;
    try {
      const explicit = await this.#options.adopt?.();
      const remaining = explicit === undefined
        ? 0
        : Date.parse(explicit.expiresAt) - (offline.clockOffsetMs ?? 0) -
          offline.skewMs - this.#now();
      if (explicit === undefined || !(remaining > 0)) {
        this.#localOnly = true;
        this.#local = local;
        this.#acquiredAt = this.#now();
        held = true;
        await this.#settleAcquired();
        return;
      }
      this.#adopted = true;
      this.#lease = {
        leaseId: explicit.leaseId,
        lockKey: explicit.lockKey,
        ttlMs: explicit.holdMs,
        expiresAt: explicit.expiresAt,
        fence: explicit.fence,
        floor: explicit.floor,
        holdMs: explicit.holdMs,
      };
      this.#acquiredAt = this.#now();
      this.#lost = false;
      this.#lapsedWhileReleasing = undefined;
      this.#local = local;
      held = true;
      // The recorded end, less the skew allowed for: the work under the
      // lease is cancelled then, as a lapse online cancels it.
      this.#deadline = setTimeout(() => {
        this.#deadline = undefined;
        logger
          .warn`The model lease on ${this.#displayKey()} ran out while serve was unreachable`;
        this.#lapse("it ran out while serve was unreachable");
      }, remaining);
      await this.#settleAcquired();
    } finally {
      if (!held) await local?.release();
    }
  }

  async #settleAcquired(
    delivered?: DeliveredCatchUp,
    maxCommits?: number,
  ): Promise<void> {
    try {
      await this.#options.onAcquired?.(delivered, maxCommits);
    } catch (error) {
      this.#settleFailed = true;
      await this.release();
      throw error;
    }
    // Registered only once acquire has fully succeeded, and only while the
    // lease has not lapsed meanwhile: a commit never names a lease this
    // process does not hold.
    const lease = this.#lease;
    if (
      lease?.fence !== undefined && this.#options.root !== undefined &&
      !this.#lost
    ) {
      holdServeLease(this.#options.root, lease.lockKey, {
        leaseId: lease.leaseId,
        fence: lease.fence,
        floor: lease.floor ?? [],
      });
    }
    // only the command's own lease; an adopted explicit one outlives it
    if (lease !== undefined && !this.#adopted && this.#client !== undefined) {
      offerServeLeaseRelease(
        lease.leaseId,
        () => this.#quiet(),
        () => this.#resume(),
        () => this.#settledUnreleased(),
      );
    }
  }

  #resume(): void {
    if (this.#lease === undefined || this.#lost || !this.#releasing) return;
    this.#releasing = false;
    if (this.#lapseMetWhileReleasing()) return;
    if (this.#heartbeat === undefined) this.#startHeartbeat();
  }

  /**
   * serve may have ended the lease, so it is not renewed, but the hold no
   * longer counts as releasing: its deadline lapses it as any other
   */
  #settledUnreleased(): void {
    if (this.#lease === undefined || this.#lost || !this.#releasing) return;
    this.#releasing = false;
    this.#lapseMetWhileReleasing();
  }

  #lapseMetWhileReleasing(): boolean {
    const reason = this.#lapsedWhileReleasing;
    if (reason === undefined) return false;
    this.#lapsedWhileReleasing = undefined;
    this.#lapse(reason);
    return true;
  }

  /** no renewal from here on: the commit closing the hold may end the lease */
  async #quiet(): Promise<void> {
    this.#releasing = true;
    this.#stopHeartbeat();
    const renewing = this.#renewing;
    if (renewing !== undefined) await renewing;
  }

  release(): Promise<void> {
    return withSpan(
      "swamp.datastore.v3.serve.lock.release",
      {},
      async () => {
        this.#releasing = true;
        try {
          await this.#release();
        } finally {
          this.#releasing = false;
          this.#options.onReleased?.();
        }
      },
    );
  }

  async #release(): Promise<void> {
    this.#stopHeartbeat();
    this.#clearDeadline();
    this.#lapsedWhileReleasing = undefined;
    if (this.#localOnly) {
      this.#localOnly = false;
      this.#acquiredAt = undefined;
      const local = this.#local;
      this.#local = undefined;
      await local?.release();
      return;
    }
    // An adopted explicit lease stays registered: it outlives this hold,
    // and the process's other commits to the behavior still name it.
    const held = this.#lease;
    if (
      held !== undefined && this.#options.root !== undefined && !this.#adopted
    ) {
      dropServeLease(this.#options.root, held.lockKey, held.leaseId);
    }
    this.#hold?.abort();
    this.#hold = undefined;
    const renewing = this.#renewing;
    if (renewing !== undefined) await renewing;
    const lease = this.#lease;
    const client = this.#client;
    const adopted = this.#adopted;
    this.#lease = undefined;
    this.#client = undefined;
    this.#acquiredAt = undefined;
    this.#adopted = false;
    // an explicit lease outlives the command: it ends on an explicit release,
    // or at serve once its hold passes. Adopted offline, no client was opened
    if (adopted && lease !== undefined) {
      client?.close?.();
      const local = this.#local;
      this.#local = undefined;
      await local?.release();
      return;
    }
    if (lease === undefined || client === undefined) return;
    await this.#options.commandLeases?.forget(lease.leaseId).catch(
      (error) =>
        logger
          .debug`Could not remove the record of the lease on ${this.#displayKey()}: ${error}`,
    );
    const releasedByCommit = serveLeaseReleasedByCommit(lease.leaseId);
    withdrawServeLeaseRelease(lease.leaseId);
    if (releasedByCommit) {
      client.close?.();
      return;
    }
    try {
      await client.releaseLock(
        lease.leaseId,
        AbortSignal.timeout(RELEASE_DEADLINE_MS),
      );
    } catch (error) {
      // Serve frees it once its TTL passes without a renewal.
      logger
        .warn`Could not release the lock ${this.#displayKey()} at serve, which frees it within ${lease.ttlMs}ms: ${error}`;
    } finally {
      client.close?.();
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /**
   * This hold, as far as this process knows it: serve answers for its
   * locks, and never says who else holds one, so a lock this process does
   * not hold reads as free.
   */
  inspect(): Promise<LockInfo | null> {
    const lease = this.#lease;
    if (lease === undefined || this.#acquiredAt === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      holder: `serve lease ${lease.leaseId}`,
      hostname: hostOf(this.#client?.baseUrl ?? ""),
      pid: Deno.pid,
      acquiredAt: new Date(this.#acquiredAt).toISOString(),
      ttlMs: lease.ttlMs,
      nonce: lease.leaseId,
    });
  }

  forceRelease(_expectedNonce: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  #holdTtlMs(): number {
    return this.#lease?.holdMs ?? this.#ttlMs;
  }

  #renewIntervalMs(): number {
    return Math.max(1, Math.floor(this.#holdTtlMs() / 3));
  }

  /**
   * one attempt that ends before the next tick, so a stalled renewal never
   * holds up the one after it
   */
  #renewDeadlineMs(client: ServeLockClient): number {
    const interval = this.#renewIntervalMs();
    const margin = Math.min(MAX_DEADLINE_MARGIN_MS, Math.floor(interval / 5));
    return Math.max(1, Math.min(client.timeoutMs, interval - margin));
  }

  #startHeartbeat(): void {
    const interval = this.#renewIntervalMs();
    this.#heartbeat = setInterval(() => {
      if (this.#renewing !== undefined) return;
      this.#renewing = this.#renew().finally(() => {
        this.#renewing = undefined;
      });
    }, interval);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  async #renew(): Promise<void> {
    const lease = this.#lease;
    const client = this.#client;
    const hold = this.#hold;
    if (lease === undefined || client === undefined || hold === undefined) {
      return;
    }
    const asked = this.#monotonic();
    const deadline = AbortSignal.timeout(this.#renewDeadlineMs(client));
    try {
      const renewed = await settledBy(
        client.renewLock(
          lease.leaseId,
          this.#holdTtlMs(),
          AbortSignal.any([hold.signal, deadline]),
        ),
        deadline,
      );
      if (this.#lease !== lease || this.#lost) return;
      if (renewed === undefined) {
        // Serve no longer holds it for this caller: another may take it.
        this.#stopHeartbeat();
        logger
          .warn`Serve no longer holds the lock ${this.#displayKey()} for this command: its lease expired`;
        this.#lapse("serve no longer holds it");
        return;
      }
      // A renewal keeps the fence and floor serve granted with the lease.
      this.#lease = { ...lease, ...renewed };
      this.#armDeadline(asked);
    } catch (error) {
      if (hold.signal.aborted) return;
      // A refused renewal (a revoked grant) ends the lease at serve.
      if (error instanceof ServeUpstreamError && error.status === 403) {
        this.#stopHeartbeat();
        logger
          .warn`Serve refused to renew the lock ${this.#displayKey()}: ${error.message}`;
        this.#lapse("serve refused its renewal");
        return;
      }
      logger
        .warn`Could not renew the lock ${this.#displayKey()} at serve; trying again: ${error}`;
    }
  }

  /**
   * arms the local deadline at the lease's TTL from a monotonic time no later
   * than serve started it, less a margin; serve's clock never decides it, so
   * skew cannot move it
   */
  #armDeadline(asked: number): void {
    this.#clearDeadline();
    if (this.#lease?.fence === undefined) return;
    const from = Math.min(asked, this.#monotonic());
    const ttlMs = this.#holdTtlMs();
    const margin = Math.min(MAX_DEADLINE_MARGIN_MS, Math.floor(ttlMs / 10));
    const due = Math.max(0, from + ttlMs - margin - this.#monotonic());
    this.#deadline = setTimeout(() => {
      this.#deadline = undefined;
      this.#stopHeartbeat();
      logger
        .warn`Could not renew the lock ${this.#displayKey()} at serve before its lease ran out`;
      // serve did not answer for a whole lease: the rest of the command
      // fails at once rather than waiting out a timeout per call
      const baseUrl = this.#client?.baseUrl;
      if (baseUrl !== undefined) {
        latchServeUnreachable(
          baseUrl,
          new ServeLeaseLapsedLatch(this.#displayKey()),
        );
      }
      this.#lapse("it could not be renewed in time");
    }, due);
  }

  #clearDeadline(): void {
    if (this.#deadline !== undefined) {
      clearTimeout(this.#deadline);
      this.#deadline = undefined;
    }
  }

  /**
   * ends a lapsed fenced hold: the lease leaves the registry so no later commit
   * names it, and onLost fires once. An unfenced lease only logs
   */
  #lapse(reason: string): void {
    const lease = this.#lease;
    if (lease === undefined || lease.fence === undefined || this.#lost) return;
    if (this.#releasing) {
      this.#lapsedWhileReleasing ??= reason;
      return;
    }
    this.#lost = true;
    this.#clearDeadline();
    if (this.#options.root !== undefined) {
      dropServeLease(this.#options.root, lease.lockKey, lease.leaseId);
    }
    this.#options.onLost?.(
      new ServeLeaseLapsedError(this.#displayKey(), reason),
    );
  }

  #displayKey(): string {
    return this.#options.displayKey ?? this.#options.lockKey;
  }

  #timeout(
    client: ServeLockClient,
    heldBy: string,
    waitedMs: number,
  ): LockTimeoutError {
    const host = hostOf(client.baseUrl);
    return new LockTimeoutError(this.#displayKey(), null, waitedMs, {
      message: `Lock "${this.#displayKey()}" is held at serve ${host} by ` +
        `${heldBy} — timed out after ${waitedMs}ms`,
    });
  }
}

export type ServeLockFactoryOptions = Omit<ServeLockOptions, "client">;

/**
 * one client per serve and caller for all of a process's locks, off the upload
 * pool; it opens another connection when one is busy, so no renewal waits
 */
const lockClientState = processRuntimeSlot<{
  readonly lockClients: Map<string, ServeLockClient & { close(): void }>;
}>(() => ({
  lockClients: new Map(),
}));

function lockClientFor(
  binding: NonNullable<ReturnType<typeof serveUpstreamAt>>,
): ServeLockClient {
  const key = JSON.stringify([
    binding.target.serverUrl,
    binding.namespace,
    binding.target.token ?? "",
    binding.target.extraHeaders ?? {},
    binding.target.caCerts ?? [],
  ]);
  let client = lockClientState().lockClients.get(key);
  if (client === undefined) {
    client = serveDatastoreClientFor(binding.target, binding.namespace, {
      ownConnection: true,
    });
    lockClientState().lockClients.set(key, client);
  }
  const shared = client;
  // no close: a hold that ends leaves the connection for the next lock
  return {
    acquireLock: (...args) => shared.acquireLock(...args),
    renewLock: (...args) => shared.renewLock(...args),
    releaseLock: (...args) => shared.releaseLock(...args),
    baseUrl: shared.baseUrl,
    timeoutMs: shared.timeoutMs,
  };
}

/** once the process's holds have ended */
export function closeServeLockClients(): void {
  for (const client of lockClientState().lockClients.values()) client.close();
  lockClientState().lockClients.clear();
}

export function createServeLock(
  datastorePath: string,
  options: ServeLockFactoryOptions,
): ServeLock | undefined {
  const binding = serveUpstreamAt(datastorePath);
  if (binding === undefined) return undefined;
  return new ServeLock({
    ...options,
    client: () => lockClientFor(binding),
    commandLeases: commandLeaseRecordsAt(
      datastorePath,
      binding.target.serverUrl,
      binding.target.token,
    ),
  });
}

// a client that misses the abort still frees the heartbeat at the deadline
function settledBy<T>(request: Promise<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onDeadline = () => reject(deadline.reason);
    if (deadline.aborted) onDeadline();
    else deadline.addEventListener("abort", onDeadline, { once: true });
    request.then(
      (value) => {
        deadline.removeEventListener("abort", onDeadline);
        resolve(value);
      },
      (error) => {
        deadline.removeEventListener("abort", onDeadline);
        reject(error);
      },
    );
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** resolves early on abort; the caller's next check throws the reason */
function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
