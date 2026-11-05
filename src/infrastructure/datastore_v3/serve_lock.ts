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

import { UserError } from "../../domain/errors.ts";
import { LEASE_LAPSED_CODE } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import { withSpan } from "../tracing/tracer.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type {
  LockLease,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import type { ExplicitLease } from "./explicit_model_leases.ts";
import { dropServeLease, holdServeLease } from "./serve_lease_registry.ts";
import { ServeUpstreamError } from "./serve_upstream_errors.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";
import {
  latchServeUnreachable,
  serveDatastoreClientFor,
} from "./serve_datastore_client.ts";

const logger = getSwampLogger(["datastore", "lock", "serve"]);

export const SERVE_LOCK_TTL_MS = 30_000;
export const SERVE_LOCK_REQUEST_WAIT_MS = 10_000;
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
   * Runs once the lease is taken, before `acquire` resolves; a failure
   * releases the lease and rejects `acquire`.
   */
  readonly onAcquired?: () => Promise<void>;
  readonly root?: string;
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
  #localOnly = false;

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
    if (await this.#adoptExplicit()) return;
    const client = this.#options.client();
    const hold = new AbortController();
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
          await sleepUnlessAborted(pause, signal);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    } catch (error) {
      if (this.#lease === undefined) client.close?.();
      throw error;
    }
    await this.#settleAcquired();
  }

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
      // Names its hold: a lease recorded before its extension landed is
      // still a command's at serve, whose TTL bounds a long hold.
      renewed = await client.renewLock(
        explicit.leaseId,
        explicit.holdMs,
        hold.signal,
        { holdMs: explicit.holdMs },
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
        }
      },
    );
  }

  async #release(): Promise<void> {
    this.#stopHeartbeat();
    this.#clearDeadline();
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
    try {
      const renewed = await client.renewLock(
        lease.leaseId,
        this.#holdTtlMs(),
        AbortSignal.any([
          hold.signal,
          AbortSignal.timeout(this.#renewDeadlineMs(client)),
        ]),
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
          new Error(`the lease on ${this.#displayKey()} lapsed unrenewed`),
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

export type ServeLockFactoryOptions = Omit<ServeLockOptions, "client">;

export function createServeLock(
  datastorePath: string,
  options: ServeLockFactoryOptions,
): ServeLock | undefined {
  const binding = serveUpstreamAt(datastorePath);
  if (binding === undefined) return undefined;
  return new ServeLock({
    ...options,
    // a renewal on the pool an upload is using could queue behind it
    client: () =>
      serveDatastoreClientFor(binding.target, binding.namespace, {
        ownConnection: true,
      }),
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
