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
 * A per-model or workflow-run lock a serve-mode checkout takes at serve
 * (swamp-club#3985). Checkouts on different machines that write one
 * datastore through serve each pick a model's next data version from their
 * own copy, so a local file lock cannot keep them apart: the lock must be
 * serve's own, the one serve's runs take. {@link ServeLock} holds a lease
 * on it through serve's datastore API (`POST locks`), renews it at a third
 * of its TTL, and releases it.
 *
 * Once the lease is taken, `onAcquired` brings the checkout's copy up to
 * serve's log, so the work done under the lock reads every version written
 * before it, whichever machine wrote it.
 *
 * It asks for a fenced lease (swamp-club#4121). Serve answers with a fence,
 * and for a behavior a data-version floor; the hold registers the lease, so
 * the checkout's commits to the partition name it and allocate above the
 * floor. A fenced lease that cannot be renewed (serve answers that it no
 * longer holds it, refuses the renewal, or cannot be reached before the
 * lease's local deadline) has lapsed: `onLost` fires once, and the work
 * under it is cancelled. An older serve grants an unfenced lease, which
 * behaves as before: a lapse is only logged.
 *
 * See "Model locks" under "Team mode: the CLI's serve upstream" in
 * `design/enablers/datastores.md`.
 *
 * @module
 */

import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type {
  LockLease,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import type { ExplicitLease } from "./explicit_model_leases.ts";
import { dropServeLease, holdServeLease } from "./serve_lease_registry.ts";
import { ServeUpstreamError } from "./serve_upstream_errors.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";

const logger = getSwampLogger(["datastore", "lock", "serve"]);

/** The lease a hold asks serve for. */
export const SERVE_LOCK_TTL_MS = 30_000;
/** The longest one acquire request asks serve to wait. */
export const SERVE_LOCK_REQUEST_WAIT_MS = 10_000;
/** The first pause after serve answers "held" at once. */
const RETRY_INTERVAL_MS = 100;
/** The longest pause between acquire requests. */
const MAX_BACKOFF_MS = 1_000;

/** The most a lease's local deadline keeps back from its TTL. */
const MAX_DEADLINE_MARGIN_MS = 2_000;

/**
 * A fenced lease at serve lapsed (swamp-club#4121): the work under it no
 * longer holds the lock, so it is cancelled, and serve refuses any commit
 * it still sends.
 */
export class ServeLeaseLapsedError extends Error {
  constructor(readonly lockKey: string, readonly reason: string) {
    super(
      `The lock ${lockKey} at serve lapsed (${reason}), so this work was ` +
        `cancelled: another command may now hold it`,
    );
    this.name = "ServeLeaseLapsedError";
  }
}

/** What a {@link ServeLock} needs of the datastore API client. */
export type ServeLockClient =
  & Pick<
    ServeDatastoreClient,
    "acquireLock" | "renewLock" | "releaseLock" | "baseUrl" | "timeoutMs"
  >
  & { close?(): void };

export interface ServeLockOptions {
  /** Opens the client one hold uses; closed when the hold ends. */
  readonly client: () => ServeLockClient;
  /** The lock key serve takes, with no namespace. */
  readonly lockKey: string;
  /** The key errors name; `lockKey` when omitted. */
  readonly displayKey?: string;
  readonly ttlMs?: number;
  /** How long `acquire` keeps asking before {@link LockTimeoutError}. */
  readonly maxWaitMs: number;
  /** The most one request asks serve to wait. */
  readonly requestWaitMs?: number;
  readonly retryIntervalMs?: number;
  /**
   * Runs once the lease is taken, before `acquire` resolves; a failure
   * releases the lease and rejects `acquire`.
   */
  readonly onAcquired?: () => Promise<void>;
  /**
   * The checkout root the lease is registered under while held, so its
   * commits name it (swamp-club#4121); no registration when omitted.
   */
  readonly root?: string;
  /** Fires once when a fenced lease lapses; see the module documentation. */
  readonly onLost?: (error: ServeLeaseLapsedError) => void;
  /**
   * The explicit lease this checkout holds on the key, if any
   * (swamp-club#4121): the hold takes it over instead of asking for
   * another, renews it while held, and leaves it held when released.
   */
  readonly adopt?: () => Promise<ExplicitLease | undefined>;
  /** Forgets an adopted explicit lease serve no longer holds. */
  readonly forget?: (leaseId: string) => Promise<void>;
  /**
   * A lock local to the checkout, held while an explicit lease is adopted:
   * serve no longer keeps two of the checkout's commands apart under it,
   * so this does.
   */
  readonly localLock?: () => DistributedLock;
  readonly now?: () => number;
  /** A monotonic clock in milliseconds, for the lease's local deadline. */
  readonly monotonic?: () => number;
}

/** A lock held at serve; see the module documentation. */
export class ServeLock implements DistributedLock {
  readonly #options: ServeLockOptions;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  #client: ServeLockClient | undefined;
  #lease: LockLease | undefined;
  #acquiredAt: number | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** The renewal in flight, awaited by `release`. */
  #renewing: Promise<void> | undefined;
  /** Aborted when the hold ends: a renewal in flight gives up. */
  #hold: AbortController | undefined;
  /** Fires when a fenced lease's local deadline passes without a renewal. */
  #deadline: ReturnType<typeof setTimeout> | undefined;
  /** Whether this hold's fenced lease lapsed; `onLost` fired. */
  #lost = false;
  /** Whether this hold took over an explicit lease, which outlives it. */
  #adopted = false;
  /** The checkout-local lock held with an adopted lease. */
  #local: DistributedLock | undefined;
  /** Set while the hold is released: a renewal in flight cannot lapse it. */
  #releasing = false;

  constructor(options: ServeLockOptions) {
    this.#options = options;
    this.#ttlMs = options.ttlMs ?? SERVE_LOCK_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonic ?? (() => performance.now());
  }

  /** The lease serve granted this hold, while it holds one. */
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
  async acquire(): Promise<void> {
    if (this.#lease !== undefined) return;
    if (await this.#adoptExplicit()) return;
    const client = this.#options.client();
    const hold = new AbortController();
    const started = this.#now();
    let backoff = this.#options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    let heldBy = "another caller";
    try {
      while (true) {
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
        const reply = await client.acquireLock(
          this.#options.lockKey,
          this.#ttlMs,
          waitMs,
          hold.signal,
        );
        if (reply.acquired) {
          this.#client = client;
          this.#hold = hold;
          this.#lease = reply.lease;
          this.#acquiredAt = this.#now();
          this.#lost = false;
          // Measured from when the request was sent: serve's TTL started
          // no earlier.
          this.#armDeadline(askedMonotonic);
          this.#startHeartbeat();
          break;
        }
        heldBy = reply.heldBy === "caller"
          ? "another command of this caller"
          : reply.heldBy === "serve"
          ? "serve's own work"
          : "another caller";
        // Serve answered before its wait was up (a lock it could not wait
        // on): pause before asking again.
        if (this.#now() - asked < waitMs || waitMs === 0) {
          const pause = Math.min(
            backoff,
            Math.max(0, remaining - (this.#now() - asked)),
          );
          await new Promise((resolve) => setTimeout(resolve, pause));
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    } catch (error) {
      if (this.#lease === undefined) client.close?.();
      throw error;
    }
    await this.#settleAcquired();
  }

  /**
   * Takes over the explicit lease this checkout holds on the key, renewing
   * it at serve first. False when there is none, or serve no longer holds
   * it (its record is forgotten): the hold then asks as usual.
   */
  async #adoptExplicit(): Promise<boolean> {
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
    if (adopted) await this.#settleAcquired();
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
      renewed = await client.renewLock(
        explicit.leaseId,
        explicit.holdMs,
        hold.signal,
      );
    } catch (error) {
      client.close?.();
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
    this.#local = local;
    this.#armDeadline(asked);
    this.#startHeartbeat();
    return true;
  }

  /** Runs `onAcquired`, then registers a fenced lease for its commits. */
  async #settleAcquired(): Promise<void> {
    try {
      await this.#options.onAcquired?.();
    } catch (error) {
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
  }

  /** Releases the lease; safe to call again, or without a hold. */
  async release(): Promise<void> {
    this.#releasing = true;
    try {
      await this.#release();
    } finally {
      this.#releasing = false;
    }
  }

  async #release(): Promise<void> {
    this.#stopHeartbeat();
    this.#clearDeadline();
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
    if (lease === undefined || client === undefined) return;
    // An explicit lease outlives the command that used it: it ends on
    // `swamp model lease release`, or at serve once its hold passes.
    if (adopted) {
      client.close?.();
      const local = this.#local;
      this.#local = undefined;
      await local?.release();
      return;
    }
    try {
      // Bounded by the client's own per-request timeout.
      await client.releaseLock(lease.leaseId, new AbortController().signal);
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

  /** Serve's locks are never broken from a checkout. */
  forceRelease(_expectedNonce: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** The TTL the held lease renews with: an explicit lease's hold. */
  #holdTtlMs(): number {
    return this.#lease?.holdMs ?? this.#ttlMs;
  }

  #startHeartbeat(): void {
    const interval = Math.max(1, Math.floor(this.#holdTtlMs() / 3));
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
    try {
      const renewed = await client.renewLock(
        lease.leaseId,
        this.#holdTtlMs(),
        hold.signal,
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
   * Arms the lease's local deadline: its TTL from `from` (a monotonic time
   * no later than serve started the TTL), less a margin. Serve's own clock
   * never decides it, so skew cannot move it.
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
   * Ends a fenced hold that lapsed: the lease leaves the registry, so no
   * later commit names it, and `onLost` fires once. An unfenced lease only
   * logs, as before swamp-club#4121.
   */
  #lapse(reason: string): void {
    const lease = this.#lease;
    if (
      lease === undefined || lease.fence === undefined || this.#lost ||
      this.#releasing
    ) {
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

/** Options {@link createServeLock} passes on to {@link ServeLock}. */
export type ServeLockFactoryOptions = Omit<ServeLockOptions, "client">;

/**
 * The lock serve takes for `options.lockKey`, when the v3 local root
 * `datastorePath` is a checkout's copy of a datastore written through serve;
 * undefined for any other datastore, whose locks stay local.
 */
export function createServeLock(
  datastorePath: string,
  options: ServeLockFactoryOptions,
): ServeLock | undefined {
  const binding = serveUpstreamAt(datastorePath);
  if (binding === undefined) return undefined;
  return new ServeLock({ ...options, client: binding.client });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
