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
 * checkouts share serve's own per-model lock, so client work and serve's runs
 * exclude each other; a covered partition refuses commits not naming its fenced
 * lease; shutdown never touches kept leases
 */

import type { DataNameMarks } from "../domain/datastore_v3/commit_store.ts";
import type { PartitionKey } from "../domain/datastore_v3/partition_key.ts";
import {
  type PersistedLease,
  persistedLeaseExpiresAt,
  type PersistedLeaseStore,
} from "../domain/datastore_v3/persisted_lease.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "../domain/datastore_v3/writer_lease.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "datastore-locks"]);

export const MIN_LOCK_TTL_MS = 5_000;
export const MAX_LOCK_TTL_MS = 120_000;
export const DEFAULT_LOCK_TTL_MS = 30_000;
export const MAX_LOCK_WAIT_MS = 10_000;
/**
 * a day, so a member can check one out before working offline; such a lease
 * keeps serve's own runs off the behavior until it ends, so an admin can end an
 * abandoned one
 */
export const MAX_HOLD_MS = 86_400_000;
export const MAX_LEASES_PER_PRINCIPAL = 256;
export const MAX_ADOPT_RETRY_MS = 30_000;
const RECORD_REMOVE_ATTEMPTS = 3;
const ADOPT_RETRY_MS = 1_000;
const RETRY_INTERVAL_MS = 100;

export type LockTarget =
  | {
    readonly kind: "model";
    readonly modelType: string;
    readonly modelId: string;
  }
  | {
    readonly kind: "workflow-run";
    readonly runId: string;
  };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE_TYPE_CHARS = new Set([
  "\\",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
  "%",
]);

function unsafeType(type: string): boolean {
  for (const char of type) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || UNSAFE_TYPE_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}
const MAX_LOCK_KEY_LENGTH = 512;

/**
 * anything but the canonical key forms, including any key a path could escape
 * the lock directory with, is undefined
 */
export function parseLockKey(raw: unknown): LockTarget | undefined {
  if (
    typeof raw !== "string" || raw.length === 0 ||
    raw.length > MAX_LOCK_KEY_LENGTH
  ) {
    return undefined;
  }
  const parts = raw.split("/");
  if (parts[parts.length - 1] !== ".lock") return undefined;
  if (parts[0] === "workflow-run-claims" && parts.length === 3) {
    return UUID.test(parts[1])
      ? { kind: "workflow-run", runId: parts[1].toLowerCase() }
      : undefined;
  }
  if (parts[0] !== "data" || parts.length < 4) return undefined;
  const id = parts[parts.length - 2];
  const type = parts.slice(1, parts.length - 2).join("/");
  if (!UUID.test(id)) return undefined;
  let normalized: string;
  try {
    normalized = ModelType.create(type).normalized;
  } catch {
    return undefined;
  }
  if (
    unsafeType(normalized) ||
    normalized.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    return undefined;
  }
  return { kind: "model", modelType: normalized, modelId: id.toLowerCase() };
}

/**
 * The lock target whose lease covers `partition`: a behavior's partition
 * is covered by its model lock, a run's by its claim. Undefined for any
 * other partition, which no lease covers.
 */
export function lockTargetOfPartition(
  partition: PartitionKey,
): LockTarget | undefined {
  const identity = partition.identity;
  if (identity.kind === "model") {
    return {
      kind: "model",
      modelType: identity.type,
      modelId: identity.id.toLowerCase(),
    };
  }
  if (identity.kind === "run") {
    return { kind: "workflow-run", runId: identity.runId.toLowerCase() };
  }
  return undefined;
}

export function lockKeyOf(target: LockTarget): string {
  return target.kind === "model"
    ? `data/${target.modelType}/${target.modelId}/.lock`
    : `workflow-run-claims/${target.runId}/.lock`;
}

export interface TryLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

export function asTryLock(lock: object): TryLock {
  const candidate = lock as Partial<TryLock>;
  if (
    typeof candidate.tryAcquire !== "function" ||
    typeof candidate.release !== "function"
  ) {
    throw new Error(
      "Internal error: serve's datastore lock cannot be taken without waiting",
    );
  }
  return lock as TryLock;
}

export interface LeaseView {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly ttlMs: number;
  readonly expiresAt: string;
  readonly fence?: number;
  readonly holdMs?: number;
}

export interface LeaseBase {
  readonly leaseFence: number | undefined;
  readonly names: readonly DataNameMarks[];
}

export interface AcquiredLease extends LeaseView {
  readonly floor?: readonly DataNameMarks[];
}

export interface LiveLease {
  readonly lockKey: string;
  readonly target: LockTarget;
  readonly principal: string;
  readonly expiresAt: string;
  readonly explicit: boolean;
}

export interface FencedLease {
  readonly leaseId: string;
  readonly principal: string;
  readonly fence: number;
}

/**
 * ended the lease here but could not remove its kept record, so the next leader
 * would adopt it again; forcing the release again removes it
 */
export class LeaseRecordNotRemovedError extends Error {
  constructor(readonly lockKey: string, cause: unknown) {
    super(
      `The lease on ${lockKey} ended, but its kept record could not be ` +
        `removed, so the lease may return at the next leader takeover. ` +
        `Force the release again once the control plane is reachable.`,
      { cause },
    );
    this.name = "LeaseRecordNotRemovedError";
  }
}

export type LockHolder = "caller" | "other" | "serve";

/** who holds a lease, said to callers who may take its lock */
export interface LeaseHolder {
  readonly principal: string;
  readonly explicit: boolean;
  readonly expiresAt: string;
}

export type AcquireOutcome =
  | { readonly kind: "acquired"; readonly lease: AcquiredLease }
  | {
    readonly kind: "held";
    readonly heldBy: LockHolder;
    /** absent when serve's own work holds it */
    readonly holder?: LeaseHolder;
  }
  | { readonly kind: "too-many" }
  // an explicit lease the leader could not record, so a takeover would end it:
  // refused rather than granted
  | { readonly kind: "not-kept" };

export interface LeasePersistence {
  readonly store: PersistedLeaseStore;
  readonly leaderFence: () => number | undefined;
  readonly skewMs?: number;
}

export interface DatastoreLockLeasesOptions {
  readonly createLock: (target: LockTarget) => Promise<TryLock>;
  readonly now?: () => number;
  readonly minTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly maxWaitMs?: number;
  readonly maxLeasesPerPrincipal?: number;
  readonly maxHoldMs?: number;
  readonly retryIntervalMs?: number;
  readonly persistence?: LeasePersistence;
  readonly adoptRetryMs?: number;
}

interface Lease {
  readonly id: string;
  readonly principal: string;
  readonly key: string;
  readonly target: LockTarget;
  readonly lock: TryLock;
  ttlMs: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly fence: number | undefined;
  holdMs: number | undefined;
}

/**
 * one per lock key at most; ends on release, TTL passing without renewal, or
 * shutdown; dispose awaits every release it starts
 */
export class DatastoreLockLeases {
  readonly #createLock: (target: LockTarget) => Promise<TryLock>;
  readonly #now: () => number;
  readonly #minTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #maxWaitMs: number;
  readonly #maxPerPrincipal: number;
  readonly #maxHoldMs: number;
  readonly #retryIntervalMs: number;
  readonly #leases = new Map<string, Lease>();
  readonly #byKey = new Map<string, string>();
  readonly #releasing = new Set<Promise<void>>();
  /**
   * The highest fence issued per lock key by this process, so two leases
   * on one key never share a fence even before a commit records one.
   */
  readonly #issued = new Map<string, number>();
  readonly #lifetime = new AbortController();
  readonly #acquiring = new Set<Promise<unknown>>();
  readonly #persistence: LeasePersistence | undefined;
  /**
   * until adopted, no lease may be taken, renewed, released or judged, or a
   * caller could take a key an adopted lease holds
   */
  #adopting = false;
  /**
   * While adopting, the lock keys of kept leases not adopted yet: every key
   * when the kept leases could not even be read. Serve's own runs wait on
   * them ({@link whenAdopted}).
   */
  #pendingAdoption: ReadonlySet<string> | "all" = new Set();
  #pendingLeaseIds: ReadonlySet<string> = new Set();
  readonly #adoptRetryMs: number;
  #adoptRetry: Promise<void> | undefined;
  /**
   * Each lock key's last record write or removal: writes for one key run
   * one at a time, so a renewal's write never lands after the removal of
   * a lease that ended meanwhile.
   */
  readonly #recordWrites = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(options: DatastoreLockLeasesOptions) {
    this.#createLock = options.createLock;
    this.#now = options.now ?? Date.now;
    this.#minTtlMs = options.minTtlMs ?? MIN_LOCK_TTL_MS;
    this.#maxTtlMs = options.maxTtlMs ?? MAX_LOCK_TTL_MS;
    this.#maxWaitMs = options.maxWaitMs ?? MAX_LOCK_WAIT_MS;
    this.#maxPerPrincipal = options.maxLeasesPerPrincipal ??
      MAX_LEASES_PER_PRINCIPAL;
    this.#maxHoldMs = options.maxHoldMs ?? MAX_HOLD_MS;
    this.#retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    this.#persistence = options.persistence;
    this.#adopting = options.persistence !== undefined;
    if (this.#adopting) this.#pendingAdoption = "all";
    this.#adoptRetryMs = options.adoptRetryMs ?? ADOPT_RETRY_MS;
  }

  /**
   * until kept leases are adopted the API answers the lease listing, and each
   * write to a still-pending key, with serve_not_leader
   */
  get adopting(): boolean {
    return this.#adopting;
  }

  /** a kept lease on the key, or possibly on it, is not adopted yet */
  adoptionPending(lockKey: string): boolean {
    if (!this.#adopting) return false;
    const pending = this.#pendingAdoption;
    return pending === "all" || pending.has(lockKey);
  }

  /**
   * its key's kept lease is not adopted yet, or kept leases could not be read
   * so any key may hold one; a target no lease covers waits only in the second
   * case
   */
  adoptionPendingFor(target: LockTarget | undefined): boolean {
    if (!this.#adopting) return false;
    if (this.#pendingAdoption === "all") return true;
    return target !== undefined && this.#pendingAdoption.has(lockKeyOf(target));
  }

  /**
   * it is a kept lease not adopted yet, or kept leases could not be read so it
   * may be one; any other lease not live here is answered as lost
   */
  leaseAdoptionPending(leaseId: string): boolean {
    if (!this.#adopting) return false;
    return this.#pendingAdoption === "all" ||
      (this.#pendingLeaseIds.has(leaseId) && !this.#leases.has(leaseId));
  }

  /**
   * serve's runs take their locks apart from the lease API, so without this a
   * run could take the lock of a behavior whose holder still holds its kept
   * lease
   */
  async whenAdopted(lockKey: string, maxWaitMs: number): Promise<void> {
    const started = this.#now();
    while (this.adoptionPending(lockKey)) {
      if (this.#disposed || this.#now() - started >= maxWaitMs) {
        throw new LockTimeoutError(lockKey, null, this.#now() - started, {
          message:
            `Lock "${lockKey}" waits for a lease kept before this serve led to be adopted — timed out after ${
              this.#now() - started
            }ms`,
        });
      }
      await delay(this.#retryIntervalMs, this.#lifetime.signal);
    }
  }

  get ttlBounds(): { readonly min: number; readonly max: number } {
    return { min: this.#minTtlMs, max: this.#maxTtlMs };
  }

  get maxWaitMs(): number {
    return this.#maxWaitMs;
  }

  get size(): number {
    return this.#leases.size;
  }

  /**
   * a lock taken after the signal aborted (the caller hung up) is released
   * again; ttlMs must already be within the TTL bounds
   */
  async acquire(request: {
    readonly principal: string;
    readonly target: LockTarget;
    readonly ttlMs: number;
    readonly waitMs: number;
    readonly signal: AbortSignal;
    readonly fenced?: () => Promise<LeaseBase>;
    readonly holdMs?: number;
    readonly budgetMs?: number;
  }): Promise<AcquireOutcome> {
    if (this.#disposed) return { kind: "held", heldBy: "serve" };
    const attempt = this.#acquire(request);
    this.#acquiring.add(attempt);
    try {
      return await attempt;
    } finally {
      this.#acquiring.delete(attempt);
    }
  }

  async #acquire(request: {
    readonly principal: string;
    readonly target: LockTarget;
    readonly ttlMs: number;
    readonly waitMs: number;
    readonly signal: AbortSignal;
    readonly fenced?: () => Promise<LeaseBase>;
    readonly holdMs?: number;
    readonly budgetMs?: number;
  }): Promise<AcquireOutcome> {
    const { principal, target, ttlMs } = request;
    if (this.#heldBy(principal) >= this.#maxPerPrincipal) {
      return { kind: "too-many" };
    }
    const key = lockKeyOf(target);
    const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
    const deadline = this.#now() + Math.min(
      Math.max(0, request.waitMs),
      this.#maxWaitMs,
    );
    const lock = await this.#createLock(target);
    while (true) {
      if (!this.#byKey.has(key) && await lock.tryAcquire()) break;
      // waiting helps only for a lease that may end within the caller's
      // whole wait: an explicit lease that outlasts it is answered now
      const outlasts = request.budgetMs !== undefined &&
        this.#explicitUntil(key) > this.#now() + request.budgetMs;
      if (signal.aborted || outlasts || this.#now() >= deadline) {
        return this.#held(key, principal);
      }
      await delay(this.#retryIntervalMs, signal);
    }
    // Taken for a caller that hung up, or during shutdown: nobody will
    // renew or release it, so it goes now.
    if (signal.aborted || this.#disposed) {
      await lock.release();
      return { kind: "held", heldBy: "serve" };
    }
    // Checked again now the lock is taken: concurrent acquires by one
    // principal must not pass the cap together.
    if (this.#heldBy(principal) >= this.#maxPerPrincipal) {
      await lock.release();
      return { kind: "too-many" };
    }
    let fence: number | undefined;
    let floor: readonly DataNameMarks[] | undefined;
    if (request.fenced !== undefined) {
      let base: LeaseBase;
      try {
        base = await request.fenced();
      } catch (error) {
        await lock.release();
        throw error;
      }
      fence = Math.max(base.leaseFence ?? 0, this.#issued.get(key) ?? 0) + 1;
      this.#issued.set(key, fence);
      floor = base.names;
    }
    // Checked again after the read: the caller may have hung up, or
    // shutdown begun, meanwhile; nobody would renew or release the lease.
    if (signal.aborted || this.#disposed) {
      await lock.release();
      return { kind: "held", heldBy: "serve" };
    }
    const lease: Lease = {
      id: crypto.randomUUID(),
      principal,
      key,
      target,
      lock,
      ttlMs,
      expiresAt: this.#now() + ttlMs,
      timer: undefined,
      fence,
      holdMs: request.holdMs,
    };
    this.#leases.set(lease.id, lease);
    this.#byKey.set(key, lease.id);
    this.#schedule(lease);
    // Recorded pending first, so a write that landed though its reply did
    // not names a lease no leader adopts; refused, its record goes if it
    // can. Then confirmed: a confirmation that fails keeps the lease, which
    // a takeover may end, and the next renewal confirms it.
    const pending = await this.#keep(lease, { pending: true });
    if (pending === "failed") {
      await this.#forget(lease);
      await this.#end(lease, { forget: false });
      return { kind: "not-kept" };
    }
    // Ended meanwhile (a forced release): its record went with it, and the
    // caller was never granted it.
    if (pending === "ended") return { kind: "not-kept" };
    const confirmed = await this.#keep(lease);
    if (confirmed === "ended") return { kind: "not-kept" };
    if (confirmed === "failed") {
      logger
        .warn`The lease on ${lease.key} is granted, but a leader takeover before its next renewal ends it: its record could not be confirmed`;
    }
    return {
      kind: "acquired",
      lease: {
        ...view(lease),
        ...(floor === undefined ? {} : { floor }),
      },
    };
  }

  lease(
    principal: string,
    leaseId: string,
  ): { readonly view: LeaseView; readonly target: LockTarget } | undefined {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return undefined;
    return { view: view(lease), target: lease.target };
  }

  get holdBounds(): { readonly min: number; readonly max: number } {
    return { min: this.#minTtlMs, max: this.#maxHoldMs };
  }

  fencedLeaseOn(target: LockTarget): FencedLease | undefined {
    const id = this.#byKey.get(lockKeyOf(target));
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease === undefined || lease.fence === undefined) return undefined;
    return {
      leaseId: lease.id,
      principal: lease.principal,
      fence: lease.fence,
    };
  }

  list(prefix = ""): readonly LiveLease[] {
    return [...this.#leases.values()]
      .filter((lease) => lease.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((lease) => ({
        lockKey: lease.key,
        target: lease.target,
        principal: lease.principal,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        explicit: lease.holdMs !== undefined,
      }));
  }

  /**
   * undefined when it holds no such lease, so the lock may already be someone
   * else's
   */
  async renew(
    principal: string,
    leaseId: string,
    ttlMs: number,
    holdMs?: number,
  ): Promise<LeaseView | undefined> {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return undefined;
    if (holdMs !== undefined) lease.holdMs = holdMs;
    lease.ttlMs = ttlMs;
    lease.expiresAt = this.#now() + ttlMs;
    this.#schedule(lease);
    // A renewal the leader could not record keeps the lease here; the
    // record keeps its older expiry until the next renewal records it. One
    // that ended while it was recorded (a forced release) renews nothing.
    if (await this.#keep(lease) === "ended") return undefined;
    return view(lease);
  }

  /**
   * an expired or already released lease is not an error to the caller, which
   * ends its hold either way
   */
  async release(principal: string, leaseId: string): Promise<boolean> {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return false;
    await this.#end(lease, { forget: true });
    return true;
  }

  /**
   * an admin's way to recover an abandoned lease; its kept record goes too; the
   * holder's next commit naming it is refused as lost and its queued work is
   * later sent without it
   */
  async forceRelease(
    target: LockTarget,
  ): Promise<{ readonly principal: string } | undefined> {
    const key = lockKeyOf(target);
    const id = this.#byKey.get(key);
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease === undefined) {
      // A record an earlier forced release could not remove still goes.
      const failure = await this.#removeRecord(key);
      if (failure !== undefined) {
        throw new LeaseRecordNotRemovedError(key, failure);
      }
      return undefined;
    }
    logger
      .info`Lease on ${lease.key} held for ${lease.principal} force-released`;
    const failure = await this.#end(lease, { forget: true });
    if (failure !== undefined) {
      throw new LeaseRecordNotRemovedError(lease.key, failure);
    }
    return { principal: lease.principal };
  }

  /**
   * adopts the previous leader's explicit leases on taking the lead; one below
   * its partition's fence was superseded; lease requests wait, and a failed
   * adoption is retried until it succeeds or shutdown
   */
  async adopt(options: {
    readonly leaseFenceOf?: (target: LockTarget) => Promise<number | undefined>;
  } = {}): Promise<void> {
    const persistence = this.#persistence;
    const leaderFence = persistence?.leaderFence();
    if (persistence === undefined || leaderFence === undefined) {
      this.#adopting = false;
      return;
    }
    // Each lead adopts afresh: lease requests wait until it has, even in a
    // process that led before.
    this.#adopting = true;
    this.#pendingAdoption = "all";
    const attempt = () =>
      this.#tryAdopt(persistence, leaderFence, options.leaseFenceOf);
    if (await attempt()) {
      this.#adopting = false;
      return;
    }
    this.#adoptRetry = this.#retryAdopt(attempt);
  }

  async #tryAdopt(
    persistence: LeasePersistence,
    leaderFence: number,
    leaseFenceOf:
      | ((target: LockTarget) => Promise<number | undefined>)
      | undefined,
  ): Promise<boolean> {
    try {
      const kept = await persistence.store.adopt(leaderFence, {
        signal: this.#lifetime.signal,
      });
      const skewMs = persistence.skewMs ?? WRITER_LEASE_CLOCK_SKEW_MS;
      // known now: only these keys may hold a kept lease; one this leader
      // already holds under the record's own id is not pending, so a retry
      // never holds back its writes
      const waiting = kept.filter((record) =>
        this.#byKey.get(record.lockKey) !== record.leaseId
      );
      const pending = new Set(waiting.map((record) => record.lockKey));
      const pendingIds = new Set(waiting.map((record) => record.leaseId));
      this.#pendingAdoption = pending;
      this.#pendingLeaseIds = pendingIds;
      let finished = true;
      for (const record of kept) {
        if (this.#disposed) return false;
        // A lease whose lock serve could not take yet is still live: its
        // record stays, and the adoption is tried again for it.
        if (
          !await this.#adoptOne(record, leaderFence, skewMs, leaseFenceOf)
        ) {
          finished = false;
        } else {
          pending.delete(record.lockKey);
          pendingIds.delete(record.leaseId);
        }
      }
      return finished;
    } catch (error) {
      // Which keys hold a kept lease is not known: serve's own runs wait
      // on every key until it is.
      this.#pendingAdoption = "all";
      logger
        .warn`Could not adopt the leases kept before this leader; lease requests wait while it is tried again: ${error}`;
      return false;
    }
  }

  async #retryAdopt(attempt: () => Promise<boolean>): Promise<void> {
    let wait = this.#adoptRetryMs;
    while (!this.#disposed) {
      await delay(wait, this.#lifetime.signal);
      if (this.#disposed) return;
      if (await attempt()) {
        this.#adopting = false;
        logger.info`Adopted the leases kept before this leader`;
        return;
      }
      wait = Math.min(wait * 2, MAX_ADOPT_RETRY_MS);
    }
  }

  async #adoptOne(
    record: PersistedLease,
    leaderFence: number,
    skewMs: number,
    leaseFenceOf:
      | ((target: LockTarget) => Promise<number | undefined>)
      | undefined,
  ): Promise<boolean> {
    const store = this.#persistence!.store;
    const forget = async (why: string) => {
      // A shutdown deletes nothing: the lease may be live, and the next
      // leader adopts it.
      if (this.#disposed) return;
      logger.info`Not adopting the lease on ${record.lockKey}: ${why}`;
      try {
        await store.remove(leaderFence, record.lockKey);
      } catch (error) {
        logger
          .warn`Removing the lease record for ${record.lockKey} failed: ${error}`;
      }
    };
    const target = parseLockKey(record.lockKey);
    if (target === undefined || lockKeyOf(target) !== record.lockKey) {
      await forget("its lock key is not canonical");
      return true;
    }
    const expiresAt = persistedLeaseExpiresAt(record, skewMs);
    if (expiresAt <= this.#now()) {
      await forget("it expired");
      return true;
    }
    const holding = this.#byKey.get(record.lockKey);
    // Adopted by an earlier try that did not finish: kept as it is.
    if (holding === record.leaseId) return true;
    if (holding !== undefined) {
      await forget("this leader already holds its lock");
      return true;
    }
    let partitionFence: number | undefined;
    try {
      partitionFence = await leaseFenceOf?.(target);
    } catch (error) {
      logger
        .warn`Reading the lease fence of ${record.lockKey} failed: ${error}`;
    }
    if (partitionFence !== undefined && partitionFence > record.fence) {
      await forget("a later lease superseded it");
      return true;
    }
    const lock = await this.#createLock(target);
    const deadline = this.#now() + this.#maxWaitMs;
    let taken = await lock.tryAcquire();
    while (!taken && this.#now() < deadline && !this.#disposed) {
      await delay(this.#retryIntervalMs, this.#lifetime.signal);
      taken = await lock.tryAcquire();
    }
    if (!taken) {
      // The lease is live: a lock still held here (a run of the leader
      // before, not yet past its TTL) must not cost its holder the lease.
      logger
        .info`Serve's own lock for ${record.lockKey} is held; adopting its lease is tried again`;
      return false;
    }
    const lease: Lease = {
      id: record.leaseId,
      principal: record.principal,
      key: record.lockKey,
      target,
      lock,
      ttlMs: record.holdMs,
      expiresAt,
      timer: undefined,
      fence: record.fence,
      holdMs: record.holdMs,
    };
    this.#leases.set(lease.id, lease);
    this.#byKey.set(lease.key, lease.id);
    this.#issued.set(
      lease.key,
      Math.max(record.fence, this.#issued.get(lease.key) ?? 0),
    );
    this.#schedule(lease);
    logger
      .info`Adopted the lease on ${lease.key} held for ${lease.principal} (fence ${lease.fence})`;
    return true;
  }

  /**
   * the kept records stay: a leader shuts down when it loses the lead and its
   * successor holds those leases
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#lifetime.abort();
    await this.#adoptRetry;
    await Promise.allSettled([...this.#acquiring]);
    await Promise.allSettled(
      [...this.#leases.values()].map((lease) =>
        this.#end(lease, { forget: false })
      ),
    );
    await Promise.allSettled([...this.#releasing]);
  }

  /**
   * a command's lease is never recorded; the write runs after earlier writes
   * and removals for its key and only while the lease is live, so it never
   * lands after its own removal
   */
  async #keep(
    lease: Lease,
    options: { readonly pending?: true } = {},
  ): Promise<"kept" | "failed" | "ended"> {
    const persistence = this.#persistence;
    if (
      persistence === undefined || lease.holdMs === undefined ||
      lease.fence === undefined
    ) {
      return "kept";
    }
    const holdMs = lease.holdMs;
    const fence = lease.fence;
    return await this.#serialized(lease.key, async () => {
      if (this.#leases.get(lease.id) !== lease) return "ended";
      const leaderFence = persistence.leaderFence();
      if (leaderFence === undefined) return "kept";
      const now = this.#now();
      try {
        await persistence.store.save(leaderFence, {
          leaseId: lease.id,
          lockKey: lease.key,
          principal: lease.principal,
          fence,
          holdMs,
          remainingMs: Math.max(0, lease.expiresAt - now),
          recordedAt: new Date(now).toISOString(),
          leaderFence,
          ...options,
        });
        // Ended while it was written: the removal its end queued runs after
        // this write, so the record goes; the lease was not kept.
        return this.#leases.get(lease.id) === lease ? "kept" : "ended";
      } catch (error) {
        logger.warn`Recording the lease on ${lease.key} failed: ${error}`;
        return "failed";
      }
    });
  }

  async #serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#recordWrites.get(key) ?? Promise.resolve();
    const run = before.then(fn);
    const settled = run.then(() => {}, () => {});
    this.#recordWrites.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#recordWrites.get(key) === settled) {
        this.#recordWrites.delete(key);
      }
    }
  }

  async #forget(lease: Lease): Promise<unknown> {
    if (lease.holdMs === undefined) return undefined;
    return await this.#removeRecord(lease.key);
  }

  async #removeRecord(key: string): Promise<unknown> {
    const persistence = this.#persistence;
    if (persistence === undefined) return undefined;
    const leaderFence = persistence.leaderFence();
    if (leaderFence === undefined) return undefined;
    const failure = await this.#serialized(key, async () => {
      let last: unknown;
      for (let attempt = 1; attempt <= RECORD_REMOVE_ATTEMPTS; attempt++) {
        try {
          await persistence.store.remove(leaderFence, key);
          return undefined;
        } catch (error) {
          last = error;
        }
      }
      return last ?? new Error("the lease record could not be removed");
    });
    if (failure === undefined) return undefined;
    logger
      .warn`Removing the lease record for ${key} failed, so the lease may return at the next leader takeover: ${failure}`;
    return failure;
  }

  #heldBy(principal: string): number {
    let count = 0;
    for (const lease of this.#leases.values()) {
      if (lease.principal === principal) count++;
    }
    return count;
  }

  #held(key: string, principal: string): AcquireOutcome {
    const id = this.#byKey.get(key);
    const lease = id === undefined ? undefined : this.#leases.get(id);
    return {
      kind: "held",
      heldBy: this.#holderOf(key, principal),
      ...(lease === undefined ? {} : {
        holder: {
          principal: lease.principal,
          explicit: lease.holdMs !== undefined,
          expiresAt: new Date(lease.expiresAt).toISOString(),
        },
      }),
    };
  }

  /** when the key's explicit lease ends, or 0 when none holds it */
  #explicitUntil(key: string): number {
    const id = this.#byKey.get(key);
    const lease = id === undefined ? undefined : this.#leases.get(id);
    return lease?.holdMs === undefined ? 0 : lease.expiresAt;
  }

  #holderOf(key: string, principal: string): LockHolder {
    const id = this.#byKey.get(key);
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease === undefined) return "serve";
    return lease.principal === principal ? "caller" : "other";
  }

  #schedule(lease: Lease): void {
    if (lease.timer !== undefined) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      lease.timer = undefined;
      if (this.#leases.get(lease.id) !== lease) return;
      logger
        .info`Lease on ${lease.key} held for ${lease.principal} expired without a renewal; releasing it`;
      const ending: Promise<void> = this.#end(lease, { forget: true })
        .then(() => {})
        .finally(() => {
          this.#releasing.delete(ending);
        });
      this.#releasing.add(ending);
    }, Math.max(0, lease.expiresAt - this.#now()));
  }

  /**
   * forget removes the kept record too: on release, expiry or forced release,
   * never at shutdown
   */
  async #end(lease: Lease, options: { forget: boolean }): Promise<unknown> {
    if (lease.timer !== undefined) {
      clearTimeout(lease.timer);
      lease.timer = undefined;
    }
    if (this.#leases.get(lease.id) !== lease) return undefined;
    this.#leases.delete(lease.id);
    // The fence a later lease starts above is the partition's durable one:
    // a commit names its lease by id, so reusing an ended lease's unused
    // fence lets nothing through, and the map stays bounded by live leases.
    this.#issued.delete(lease.key);
    if (this.#byKey.get(lease.key) === lease.id) this.#byKey.delete(lease.key);
    const failure = options.forget ? await this.#forget(lease) : undefined;
    try {
      await lease.lock.release();
    } catch (error) {
      // The lock's own TTL frees it if the release did not.
      logger.warn`Releasing the lock on ${lease.key} failed: ${error}`;
    }
    return failure;
  }
}

function view(lease: Lease): LeaseView {
  return {
    leaseId: lease.id,
    lockKey: lease.key,
    ttlMs: lease.ttlMs,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    ...(lease.fence === undefined ? {} : { fence: lease.fence }),
    ...(lease.holdMs === undefined ? {} : { holdMs: lease.holdMs }),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
