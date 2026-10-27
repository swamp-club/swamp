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
  readonly now?: () => number;
}

/** A lock held at serve; see the module documentation. */
export class ServeLock implements DistributedLock {
  readonly #options: ServeLockOptions;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #client: ServeLockClient | undefined;
  #lease: LockLease | undefined;
  #acquiredAt: number | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** The renewal in flight, awaited by `release`. */
  #renewing: Promise<void> | undefined;
  /** Aborted when the hold ends: a renewal in flight gives up. */
  #hold: AbortController | undefined;

  constructor(options: ServeLockOptions) {
    this.#options = options;
    this.#ttlMs = options.ttlMs ?? SERVE_LOCK_TTL_MS;
    this.#now = options.now ?? Date.now;
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
    try {
      await this.#options.onAcquired?.();
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  /** Releases the lease; safe to call again, or without a hold. */
  async release(): Promise<void> {
    this.#stopHeartbeat();
    this.#hold?.abort();
    this.#hold = undefined;
    const renewing = this.#renewing;
    if (renewing !== undefined) await renewing;
    const lease = this.#lease;
    const client = this.#client;
    this.#lease = undefined;
    this.#client = undefined;
    this.#acquiredAt = undefined;
    if (lease === undefined || client === undefined) return;
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

  #startHeartbeat(): void {
    const interval = Math.max(1, Math.floor(this.#ttlMs / 3));
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
    try {
      const renewed = await client.renewLock(
        lease.leaseId,
        this.#ttlMs,
        hold.signal,
      );
      if (this.#lease !== lease) return;
      if (renewed === undefined) {
        // Serve no longer holds it for this caller: another may take it.
        this.#stopHeartbeat();
        logger
          .warn`Serve no longer holds the lock ${this.#displayKey()} for this command: its lease expired`;
        return;
      }
      this.#lease = renewed;
    } catch (error) {
      if (hold.signal.aborted) return;
      logger
        .warn`Could not renew the lock ${this.#displayKey()} at serve; trying again: ${error}`;
    }
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
