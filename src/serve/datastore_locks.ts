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
 * The model and workflow-run locks serve holds on behalf of the CLI's serve
 * upstream (swamp-club#3985). Two checkouts on different machines write one
 * datastore through serve, and each picks a model's next data version from
 * its own copy, so their per-model locks must be one lock: serve's own.
 * A lease is serve's per-model (or workflow-run) lock, taken with the same
 * factory serve's handlers take it with, held for the caller until it is
 * released or its TTL passes without a renewal. Client work and serve's own
 * runs therefore exclude each other.
 *
 * A lease the caller asks to be fenced (swamp-club#4121) carries a fence:
 * a number above every lease fence its partition has seen and every fence
 * this process issued for the key. Serve stamps it, as a lease op, on each
 * commit the holder forwards under the lease, and refuses a commit to the
 * partition a live fenced lease covers unless it names that lease.
 *
 * See "Model locks" under "Team mode: the CLI's serve upstream" in
 * `design/enablers/datastores.md`.
 *
 * @module
 */

import type { DataNameMarks } from "../domain/datastore_v3/commit_store.ts";
import type { PartitionKey } from "../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "datastore-locks"]);

/** The shortest lease a caller may ask for. */
export const MIN_LOCK_TTL_MS = 5_000;
/** The longest lease a caller may ask for. */
export const MAX_LOCK_TTL_MS = 120_000;
/** The lease a caller gets when it names no TTL. */
export const DEFAULT_LOCK_TTL_MS = 30_000;
/** The longest one acquire request waits at serve for a held lock. */
export const MAX_LOCK_WAIT_MS = 10_000;
/**
 * The longest an explicit lease (`swamp model lease acquire --for`) is held
 * between renewals (swamp-club#4121). Longer would let a caller keep serve's
 * own runs off a behavior for hours.
 */
export const MAX_HOLD_MS = 3_600_000;
/** The most leases one principal holds at once. */
export const MAX_LEASES_PER_PRINCIPAL = 256;
/** How often a waiting acquire tries the lock again. */
const RETRY_INTERVAL_MS = 100;

/** What a lock key names, parsed and canonical. */
export type LockTarget =
  | {
    readonly kind: "model";
    /** The normalized behavior type. */
    readonly modelType: string;
    /** A lowercase UUID. */
    readonly modelId: string;
  }
  | {
    readonly kind: "workflow-run";
    /** A lowercase UUID. */
    readonly runId: string;
  };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Characters a type never holds that a path could act on. */
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

/** Whether `type` holds a control character or one a path could act on. */
function unsafeType(type: string): boolean {
  for (const char of type) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || UNSAFE_TYPE_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}
/** The longest lock key accepted. */
const MAX_LOCK_KEY_LENGTH = 512;

/**
 * Parses a lock key in the form `modelLockKey` and `workflowRunLockKey`
 * build it without a namespace (`data/{type}/{id}/.lock`,
 * `workflow-run-claims/{runId}/.lock`) into its canonical target: the type
 * normalized, ids lowercased. Anything else, including any key a path could
 * escape the lock directory with, is undefined.
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

/** The canonical lock key of `target`, without a namespace. */
export function lockKeyOf(target: LockTarget): string {
  return target.kind === "model"
    ? `data/${target.modelType}/${target.modelId}/.lock`
    : `workflow-run-claims/${target.runId}/.lock`;
}

/**
 * The lock serve takes for a target: serve's own per-model or workflow-run
 * lock. `tryAcquire` takes it without waiting, as `FileLock` does.
 */
export interface TryLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * `lock` as a {@link TryLock}. Serve's v3 datastore takes its locks as file
 * locks (`lockingConfigOf`), which take one without waiting.
 *
 * @throws Error for a lock that cannot be tried without waiting
 */
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

/** A lease, as the API reports it. */
export interface LeaseView {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly ttlMs: number;
  /** ISO time the lease ends unless renewed. */
  readonly expiresAt: string;
  /** A fenced lease's fence (swamp-club#4121); absent for an unfenced one. */
  readonly fence?: number;
  /**
   * An explicit lease's hold (swamp-club#4121): each renewal extends it by
   * this long. Absent for a command's lease.
   */
  readonly holdMs?: number;
}

/**
 * What a fenced lease's fence and floor start from, read once the lock is
 * taken: the partition's lease fence and its data names' version marks.
 * Undefined fields for a partition serve does not hold yet.
 */
export interface LeaseBase {
  readonly leaseFence: number | undefined;
  readonly names: readonly DataNameMarks[];
}

/** A lease as acquire returns it: a fenced model lease adds its floor. */
export interface AcquiredLease extends LeaseView {
  /**
   * Each data name's version marks when the lease was taken: the holder
   * allocates versions above them (swamp-club#4121). Names and numbers
   * only.
   */
  readonly floor?: readonly DataNameMarks[];
}

/** A live lease, as serve's listing reads it (swamp-club#4121). */
export interface LiveLease {
  readonly lockKey: string;
  readonly target: LockTarget;
  readonly principal: string;
  /** ISO time the lease ends unless renewed. */
  readonly expiresAt: string;
}

/** A live fenced lease, as a commit check reads it. */
export interface FencedLease {
  readonly leaseId: string;
  readonly principal: string;
  readonly fence: number;
}

/** Who holds a lock a caller could not take, as far as it may be told. */
export type LockHolder = "caller" | "other" | "serve";

export type AcquireOutcome =
  | { readonly kind: "acquired"; readonly lease: AcquiredLease }
  | { readonly kind: "held"; readonly heldBy: LockHolder }
  | { readonly kind: "too-many" };

export interface DatastoreLockLeasesOptions {
  /** Serve's own lock for `target`: the one its handlers take. */
  readonly createLock: (target: LockTarget) => Promise<TryLock>;
  readonly now?: () => number;
  readonly minTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly maxWaitMs?: number;
  readonly maxLeasesPerPrincipal?: number;
  readonly maxHoldMs?: number;
  readonly retryIntervalMs?: number;
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
 * The leases serve holds for callers of its datastore API: one per lock
 * key at most, since each holds serve's own lock for the key. A lease ends
 * on release, on its TTL passing without a renewal, or at shutdown
 * ({@link dispose}); every release it starts is awaited by `dispose`.
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
  /** Lease ids by lock key. */
  readonly #byKey = new Map<string, string>();
  /** Releases under way: expiries, and leases taken for a caller gone. */
  readonly #releasing = new Set<Promise<void>>();
  /**
   * The highest fence issued per lock key by this process, so two leases
   * on one key never share a fence even before a commit records one.
   */
  readonly #issued = new Map<string, number>();
  /** Aborted at shutdown: acquires still waiting give up. */
  readonly #lifetime = new AbortController();
  /** Acquires in flight, so shutdown waits for them to settle. */
  readonly #acquiring = new Set<Promise<unknown>>();
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
  }

  /** The TTL bounds, for the API's validation and its messages. */
  get ttlBounds(): { readonly min: number; readonly max: number } {
    return { min: this.#minTtlMs, max: this.#maxTtlMs };
  }

  /** The longest one acquire waits. */
  get maxWaitMs(): number {
    return this.#maxWaitMs;
  }

  /** How many leases are held now. */
  get size(): number {
    return this.#leases.size;
  }

  /**
   * Takes serve's lock for `target` for `principal`, waiting up to `waitMs`
   * (capped at the maximum wait) while another holder has it. `ttlMs` must
   * already be within {@link ttlBounds}. A lock taken after `signal`
   * aborted (the caller hung up) is released again.
   */
  async acquire(request: {
    readonly principal: string;
    readonly target: LockTarget;
    readonly ttlMs: number;
    readonly waitMs: number;
    readonly signal: AbortSignal;
    /**
     * For a fenced lease: reads the partition's lease fence and version
     * marks once the lock is taken. Absent for an unfenced lease.
     */
    readonly fenced?: () => Promise<LeaseBase>;
    /** An explicit lease's hold; `ttlMs` must equal it. */
    readonly holdMs?: number;
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
    /**
     * For a fenced lease: reads the partition's lease fence and version
     * marks once the lock is taken. Absent for an unfenced lease.
     */
    readonly fenced?: () => Promise<LeaseBase>;
    /** An explicit lease's hold; `ttlMs` must equal it. */
    readonly holdMs?: number;
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
      if (signal.aborted || this.#now() >= deadline) {
        return { kind: "held", heldBy: this.#holderOf(key, principal) };
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
    return {
      kind: "acquired",
      lease: {
        ...view(lease),
        ...(floor === undefined ? {} : { floor }),
      },
    };
  }

  /**
   * The lease `leaseId` names when `principal` holds it; undefined for an
   * unknown, ended or another principal's lease.
   */
  lease(
    principal: string,
    leaseId: string,
  ): { readonly view: LeaseView; readonly target: LockTarget } | undefined {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return undefined;
    return { view: view(lease), target: lease.target };
  }

  /** The shortest and longest hold an explicit lease may ask for. */
  get holdBounds(): { readonly min: number; readonly max: number } {
    return { min: this.#minTtlMs, max: this.#maxHoldMs };
  }

  /**
   * The live fenced lease on `target`, if one holds it: what a commit to
   * the partition it covers is judged against (swamp-club#4121). An
   * unfenced lease, or none, is undefined.
   */
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

  /**
   * Every live lease whose lock key starts with `prefix`, in key order:
   * what `GET locks` filters by the caller's access (swamp-club#4121).
   */
  list(prefix = ""): readonly LiveLease[] {
    return [...this.#leases.values()]
      .filter((lease) => lease.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((lease) => ({
        lockKey: lease.key,
        target: lease.target,
        principal: lease.principal,
        expiresAt: new Date(lease.expiresAt).toISOString(),
      }));
  }

  /**
   * Extends `principal`'s lease `leaseId` by `ttlMs` from now; undefined
   * when it holds no such lease (it was released or expired, or is
   * another's), in which case the lock may already be someone else's.
   */
  renew(
    principal: string,
    leaseId: string,
    ttlMs: number,
    holdMs?: number,
  ): LeaseView | undefined {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return undefined;
    // A hold makes it an explicit lease, held that long between renewals
    // from now on (swamp-club#4121); `ttlMs` must equal it.
    if (holdMs !== undefined) lease.holdMs = holdMs;
    lease.ttlMs = ttlMs;
    lease.expiresAt = this.#now() + ttlMs;
    this.#schedule(lease);
    return view(lease);
  }

  /**
   * Releases `principal`'s lease `leaseId`. False when it holds no such
   * lease: an expired or already released lease is not an error to the
   * caller, which ends its hold either way.
   */
  async release(principal: string, leaseId: string): Promise<boolean> {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.principal !== principal) return false;
    await this.#end(lease);
    return true;
  }

  /**
   * Ends every lease and waits for every release under way, and for
   * acquires still waiting to give up. Serve calls it at shutdown.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#lifetime.abort();
    await Promise.allSettled([...this.#acquiring]);
    await Promise.allSettled(
      [...this.#leases.values()].map((lease) => this.#end(lease)),
    );
    await Promise.allSettled([...this.#releasing]);
  }

  #heldBy(principal: string): number {
    let count = 0;
    for (const lease of this.#leases.values()) {
      if (lease.principal === principal) count++;
    }
    return count;
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
      const ending: Promise<void> = this.#end(lease).finally(() => {
        this.#releasing.delete(ending);
      });
      this.#releasing.add(ending);
    }, Math.max(0, lease.expiresAt - this.#now()));
  }

  async #end(lease: Lease): Promise<void> {
    if (lease.timer !== undefined) {
      clearTimeout(lease.timer);
      lease.timer = undefined;
    }
    if (this.#leases.get(lease.id) !== lease) return;
    this.#leases.delete(lease.id);
    // The fence a later lease starts above is the partition's durable one:
    // a commit names its lease by id, so reusing an ended lease's unused
    // fence lets nothing through, and the map stays bounded by live leases.
    this.#issued.delete(lease.key);
    if (this.#byKey.get(lease.key) === lease.id) this.#byKey.delete(lease.key);
    try {
      await lease.lock.release();
    } catch (error) {
      // The lock's own TTL frees it if the release did not.
      logger.warn`Releasing the lock on ${lease.key} failed: ${error}`;
    }
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

/** Waits `ms`, or resolves early once `signal` aborts. */
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
