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
 * every commit names the fence its lease holds, so a process that lost the
 * lease lands nothing; the lease is process-scoped, so roots never queue behind
 * a long workflow run
 */

import { join, resolve } from "@std/path";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import {
  type FenceRecord,
  V3_WRITER_BUSY_CODE,
  WriterFencedError,
  WriterLease,
  WriterLeaseBusyError,
  type WriterLeaseHold,
  type WriterLeaseInspection,
  type WriterLeaseState,
  type WriterLeaseStore,
} from "../../domain/datastore_v3/writer_lease.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_LOCK_TTL_MS, FileLock } from "../persistence/file_lock.ts";
import { v3BucketBindingAt, v3ControlPlaneAt } from "./v3_datastore_binding.ts";
import {
  judgeRecordedProcess,
  type ProcessVerdict,
} from "../../domain/datastore_v3/process_liveness.ts";
import { isProcessGone } from "../runtime/process.ts";
import { localProcess } from "./process_identity.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["datastore", "v3"]);

export const V3_WRITER_LEASE_DIR = join("_control", "writer");

/**
 * a swamp from before the lease may still hold it during an upgrade; the lease
 * is refused while it does
 */
export const V3_LEGACY_WRITER_LOCK_KEY = join("_control", "writer.lock");

export { V3_WRITER_BUSY_CODE };

export class V3WriterBusyError extends UserError {
  constructor(datastorePath: string, cause: LockTimeoutError) {
    const holder = cause.holder;
    super(
      `Another swamp process is writing the v3 datastore at ${datastorePath}` +
        (holder ? ` (${holder.holder}, pid ${holder.pid})` : "") +
        ". A v3 datastore takes one writer at a time. Wait for it to finish, " +
        "or, if it is swamp serve, run this command through serve. If that " +
        "process is gone, `swamp datastore lock status` shows the lock and " +
        "`swamp datastore lock release --force` clears it. Nothing was changed.",
      V3_WRITER_BUSY_CODE,
    );
    this.name = "V3WriterBusyError";
    this.cause = cause;
  }
}

export interface V3WriterFenceStore {
  writerFence(): number | undefined;
  raiseWriterFence(fence: number): Promise<void>;
}

interface Held {
  hold?: WriterLeaseHold;
  refs: number;
  acquiring?: Promise<void>;
  renewal?: ReturnType<typeof setInterval>;
  renewing?: Promise<void>;
  retaking?: Promise<void>;
  advancing?: Promise<number | undefined>;
  take?: {
    readonly ttlMs: number;
    readonly fenceStore?: V3WriterFenceStore;
  };
  /**
   * a one-shot command's hold just ends: its later commits are refused too, so
   * it fails as a whole rather than landing part of itself
   */
  retakeLost: boolean;
}

const held = new Map<string, Held>();

export interface AcquireV3WriterLockOptions {
  readonly maxWaitMs?: number;
  readonly ttlMs?: number;
  /**
   * without it the lease's fence is not recorded there, which only tests of the
   * lease itself do
   */
  readonly fenceStore?: V3WriterFenceStore;
  /** the process's first acquire decides; later ones join its hold */
  readonly retakeLost?: boolean;
}

/**
 * a lost one-shot hold is never joined: its commits are refused anyway, and a
 * joiner would act as writer of a checkout another process now writes; the join
 * checks the lease records since renewal may lag
 */
export async function acquireV3WriterLock(
  datastorePath: string,
  options: AcquireV3WriterLockOptions = {},
): Promise<() => Promise<void>> {
  const key = resolve(datastorePath);
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  let entry = held.get(key);
  const joining = entry !== undefined;
  if (entry === undefined) {
    const created: Held = {
      refs: 0,
      retakeLost: options.retakeLost === true,
      take: {
        ttlMs: options.ttlMs ?? DEFAULT_LOCK_TTL_MS,
        ...(options.fenceStore !== undefined
          ? { fenceStore: options.fenceStore }
          : {}),
      },
    };
    created.acquiring = retakeLease(created, datastorePath, maxWaitMs).then(
      () => startRenewal(created, datastorePath),
      (error) => {
        held.delete(key);
        throw error;
      },
    );
    held.set(key, created);
    entry = created;
  }
  entry.refs++;
  try {
    await entry.acquiring;
    // The process's hold was taken over or released: take a fresh lease,
    // waiting for the other writer like any writer does. Callers share
    // the attempt; one the renewal timer made without waiting may leave
    // the hold lost, so look again after it.
    while (entry.hold?.lost !== undefined && entry.retakeLost) {
      const joined = entry.retaking !== undefined;
      try {
        await (entry.retaking ??= retaking(entry, datastorePath, maxWaitMs));
      } catch (error) {
        // An attempt this caller joined may not have waited (the renewal
        // timer's): make one that waits as long as this caller does.
        if (!(joined && error instanceof V3WriterBusyError)) throw error;
      }
    }
    if (joining && !entry.retakeLost) await assertJoinable(entry);
  } catch (error) {
    entry.refs--;
    // Every other caller may have released while this one waited: nothing
    // would end the hold, and its timer would keep taking the lease back.
    if (entry.refs === 0) await endHold(key, entry).catch(() => {});
    throw error;
  }
  const holding = entry;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holding.refs--;
    if (holding.refs > 0) return;
    await endHold(key, holding);
  };
}

/**
 * a check that cannot read the records joins anyway: a fenced commit is still
 * refused
 */
async function assertJoinable(entry: Held): Promise<void> {
  const hold = entry.hold;
  if (hold === undefined) return;
  if (hold.lost !== undefined) throw hold.lost;
  try {
    await hold.assertCurrent();
  } catch (error) {
    if (error instanceof WriterFencedError) throw error;
    logger
      .debug`Could not check the v3 writer lease before joining this process's hold: ${error}`;
  }
}

async function endHold(key: string, entry: Held): Promise<void> {
  if (held.get(key) === entry) held.delete(key);
  if (entry.renewal !== undefined) clearInterval(entry.renewal);
  await entry.renewing;
  await entry.hold?.release();
}

function retaking(
  entry: Held,
  datastorePath: string,
  maxWaitMs: number,
): Promise<void> {
  return retakeLease(entry, datastorePath, maxWaitMs).finally(() => {
    entry.retaking = undefined;
  });
}

/**
 * its fence is higher, so commits units made under the lost hold still name the
 * old fence and are refused, while new units name the new one
 */
async function retakeLease(
  entry: Held,
  datastorePath: string,
  maxWaitMs: number,
): Promise<void> {
  const retake = entry.take!;
  const lost = entry.hold;
  const hold = await takeLease(datastorePath, {
    maxWaitMs,
    ttlMs: retake.ttlMs,
    ...(retake.fenceStore !== undefined
      ? { fenceStore: retake.fenceStore }
      : {}),
  });
  entry.hold = hold;
  if (lost !== undefined) {
    logger
      .info`This process took the writer lease of the v3 datastore at ${datastorePath} again, at fence ${hold.fence}`;
    // A lost hold writes no released marker; this removes its heartbeat.
    await lost.release().catch(() => {});
    await notifyHoldRetaken(datastorePath, hold.fence);
  }
}

/**
 * serve holds one fence for its whole life and uses the retake notice to start
 * a new replication lineage at a fence it never used; commits made under the
 * old fence are refused from then on
 */
export function advanceV3WriterLease(
  datastorePath: string,
): Promise<number | undefined> {
  const entry = held.get(resolve(datastorePath));
  if (entry === undefined || entry.take === undefined) {
    return Promise.resolve(undefined);
  }
  // Callers at once share one move: two would each move the same hold.
  return entry.advancing ??= advanceHold(entry, datastorePath).finally(() => {
    entry.advancing = undefined;
  });
}

async function advanceHold(
  entry: Held,
  datastorePath: string,
): Promise<number | undefined> {
  // One at a time with the renewal, which would read the advance as the
  // hold being lost.
  await entry.renewing;
  const hold = entry.hold;
  if (hold === undefined || hold.lost !== undefined) return undefined;
  const take = entry.take!;
  let advanced: number | undefined;
  const move = (async () => {
    const lease = await writerLease(datastorePath, take.ttlMs);
    const next = await lease.advance(hold);
    if (next === undefined) return;
    try {
      await take.fenceStore?.raiseWriterFence(next.fence);
    } catch (error) {
      await next.release().catch(() => {});
      throw error;
    }
    entry.hold = next;
    advanced = next.fence;
  })();
  // `renewing` never rejects: `endHold` awaits it before it releases the
  // lease, and a failed move must not keep the lease from being released.
  entry.renewing = move.then(() => {}, () => {}).finally(() => {
    entry.renewing = undefined;
  });
  await move;
  if (advanced === undefined) return undefined;
  logger
    .info`This process moved its writer lease of the v3 datastore at ${datastorePath} to fence ${advanced}`;
  await notifyLeaseTaken(datastorePath, advanced);
  await notifyHoldRetaken(datastorePath, advanced);
  return advanced;
}

export type V3HoldRetakenListener = (
  datastorePath: string,
  fence: number,
) => Promise<void> | void;

const holdRetakenListeners = new Set<V3HoldRetakenListener>();

/**
 * unlike onV3LeaseTaken, never for a first take or a read-only recovery's; a
 * listener that throws is logged and the lease is kept
 */
export function onV3HoldRetaken(listener: V3HoldRetakenListener): () => void {
  holdRetakenListeners.add(listener);
  return () => {
    holdRetakenListeners.delete(listener);
  };
}

async function notifyHoldRetaken(
  datastorePath: string,
  fence: number,
): Promise<void> {
  for (const listener of [...holdRetakenListeners]) {
    try {
      await listener(datastorePath, fence);
    } catch (error) {
      logger
        .warn`A listener for the writer lease of the v3 datastore at ${datastorePath} failed: ${error}`;
    }
  }
}

/**
 * the hold is not shared: nothing else in the process joins it, and the caller
 * releases it before reading; undefined when another process holds the lease or
 * this one already does
 */
export async function tryAcquireV3WriterLock(
  datastorePath: string,
  options: {
    readonly fenceStore?: V3WriterFenceStore;
    readonly ttlMs?: number;
  } = {},
): Promise<(() => Promise<void>) | undefined> {
  const key = resolve(datastorePath);
  if (held.has(key)) return undefined;
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  let hold: WriterLeaseHold;
  try {
    hold = await takeLease(datastorePath, {
      maxWaitMs: 0,
      ttlMs,
      ...(options.fenceStore !== undefined
        ? { fenceStore: options.fenceStore }
        : {}),
    });
  } catch (error) {
    if (error instanceof V3WriterBusyError) return undefined;
    throw error;
  }
  // Renewed like any hold: a recovery that outlasts the TTL must not let
  // another writer take over while it still removes files. It is not taken
  // again once lost: the recovery just stops.
  const entry: Held = { hold, refs: 1, retakeLost: false };
  startRenewal(entry, datastorePath, ttlMs);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (entry.renewal !== undefined) clearInterval(entry.renewal);
    await entry.renewing;
    await hold.release();
  };
}

/**
 * a hold another writer took over, which serve's renewal may take back, is not
 * current
 */
export function holdsCurrentV3WriterLease(datastorePath: string): boolean {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0 && entry.hold !== undefined &&
    entry.hold.lost === undefined;
}

export function holdsV3WriterLock(datastorePath: string): boolean {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0;
}

/** every commit names it, and Litestream replicates under it */
export function v3WriterFence(datastorePath: string): number | undefined {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0 ? entry.hold?.fence : undefined;
}

/**
 * checked before each commit, so a holder that knows it lost the lease stops at
 * once
 */
export function assertV3WriterCurrent(datastorePath: string): void {
  const lost = held.get(resolve(datastorePath))?.hold?.lost;
  if (lost !== undefined) throw lost;
}

/**
 * the check a writer runs before it reports a replicated commit; resolves when
 * this process holds no lease
 */
export async function checkV3WriterLease(datastorePath: string): Promise<void> {
  await held.get(resolve(datastorePath))?.hold?.assertCurrent();
}

export interface V3WriterLeaseHolder {
  readonly fence: number;
  readonly record?: FenceRecord;
  /** judged from this process; undefined with no record to judge */
  readonly process?: ProcessVerdict;
  readonly state: WriterLeaseState;
}

/**
 * unlike the inspect of v3WriterLockHandle, which reports only a lease that
 * keeps writers out, it lets a caller protect a released holder's checkout
 * until a higher fence exists
 */
export async function v3WriterLeaseHolder(
  datastorePath: string,
): Promise<V3WriterLeaseHolder | null> {
  const inspection = await (await writerLease(
    datastorePath,
    DEFAULT_LOCK_TTL_MS,
  )).inspect();
  if (inspection === null) return null;
  const record = inspection.record;
  return {
    fence: inspection.fence,
    ...(record !== undefined
      ? {
        record,
        process: judgeRecordedProcess(
          {
            pid: record.pid,
            ...(record.process !== undefined
              ? { process: record.process }
              : {}),
          },
          await localProcess(),
        ),
      }
      : {}),
    state: inspection.state,
  };
}

export type V3WriterLockHandle = Pick<
  DistributedLock,
  "inspect" | "forceRelease"
>;

/**
 * it never acquires; while a swamp from before the lease holds the old writer
 * lock, the handle acts on that lock instead
 */
export function v3WriterLockHandle(datastorePath: string): V3WriterLockHandle {
  const lease = () => writerLease(datastorePath, DEFAULT_LOCK_TTL_MS);
  // A bucket datastore never had a Phase 3 writer lock.
  const legacy = v3BucketBindingAt(datastorePath) === undefined
    ? legacyLock(datastorePath)
    : undefined;
  return {
    async inspect(): Promise<LockInfo | null> {
      const inspection = await (await lease()).inspect();
      if (inspection !== null && inspection.state !== "released") {
        return lockInfoOf(inspection);
      }
      return await legacy?.inspect() ?? null;
    },
    async forceRelease(nonce: string): Promise<boolean> {
      const current = await lease();
      const inspection = await current.inspect();
      if (inspection !== null && inspection.state !== "released") {
        return await current.forceRelease(nonce);
      }
      return await legacy?.forceRelease(nonce) ?? false;
    },
  };
}

async function takeLease(
  datastorePath: string,
  options: {
    readonly maxWaitMs: number;
    readonly ttlMs: number;
    readonly fenceStore?: V3WriterFenceStore;
  },
): Promise<WriterLeaseHold> {
  // a bucket datastore is known to be v3 before its lease is written: every
  // lease taker comes through here
  await v3BucketBindingAt(datastorePath)?.confirmMarker();
  await refuseLiveV3LegacyWriter(datastorePath);
  let hold: WriterLeaseHold;
  try {
    const floor = options.fenceStore?.writerFence();
    hold = await (await writerLease(datastorePath, options.ttlMs)).acquire({
      maxWaitMs: options.maxWaitMs,
      ...(floor !== undefined ? { floor } : {}),
    });
  } catch (error) {
    if (error instanceof WriterLeaseBusyError) {
      throw new V3WriterBusyError(
        datastorePath,
        new LockTimeoutError(
          V3_WRITER_LEASE_DIR,
          lockInfoOf(error.inspection),
          error.waitedMs,
        ),
      );
    }
    throw error;
  }
  try {
    await options.fenceStore?.raiseWriterFence(hold.fence);
  } catch (error) {
    await hold.release().catch(() => {});
    throw error;
  }
  // Outside the release-on-error scope: a listener never costs the lease.
  await notifyLeaseTaken(datastorePath, hold.fence);
  return hold;
}

export type V3LeaseTakenListener = (
  datastorePath: string,
  fence: number,
) => Promise<void> | void;

const leaseTakenListeners = new Set<V3LeaseTakenListener>();

/**
 * covers the first acquire, serve's retake of a lost lease and a read-only
 * recovery hold; listeners run after the fence is raised, and one that throws
 * is logged and the lease is kept
 */
export function onV3LeaseTaken(listener: V3LeaseTakenListener): () => void {
  leaseTakenListeners.add(listener);
  return () => {
    leaseTakenListeners.delete(listener);
  };
}

async function notifyLeaseTaken(
  datastorePath: string,
  fence: number,
): Promise<void> {
  for (const listener of [...leaseTakenListeners]) {
    try {
      await listener(datastorePath, fence);
    } catch (error) {
      logger
        .warn`A listener for the writer lease of the v3 datastore at ${datastorePath} failed: ${error}`;
    }
  }
}

function startRenewal(
  entry: Held,
  datastorePath: string,
  ttlMs = entry.take?.ttlMs ?? DEFAULT_LOCK_TTL_MS,
): void {
  let reported: WriterLeaseHold | undefined;
  entry.renewal = setInterval(() => {
    // One renewal at a time: a slow store must not stack them up.
    if (entry.renewing !== undefined) return;
    const hold = entry.hold;
    if (hold === undefined) return;
    entry.renewing = (async () => {
      if (hold.lost === undefined && await hold.renew() === "held") return;
      if (reported !== hold) {
        reported = hold;
        logger
          .error`This process lost the writer lease of the v3 datastore at ${datastorePath}: ${hold.lost?.message}`;
      }
      // Lost: try once, without waiting, to take a fresh lease, so a
      // long-lived process writes again once the other writer is done.
      if (entry.retakeLost && entry.retaking === undefined) {
        try {
          await (entry.retaking = retaking(entry, datastorePath, 0));
        } catch (error) {
          // Still held by the other writer: the next tick tries again.
          if (!(error instanceof V3WriterBusyError)) throw error;
        }
      }
    })().catch((error) => {
      // The lease stays this process's while no higher fence exists; the
      // next renewal tries again.
      logger.debug`Renewing the v3 writer lease failed: ${error}`;
    }).finally(() => {
      entry.renewing = undefined;
    });
  }, Math.max(1, Math.floor(ttlMs / 3)));
}

function writerLease(
  datastorePath: string,
  ttlMs: number,
): Promise<WriterLease> {
  return v3WriterLease(v3ControlPlaneAt(datastorePath), ttlMs);
}

/**
 * a filesystem datastore's store is its root _control/ directory; any other's
 * is its provider's datastore-wide control plane, so the lease is one per
 * datastore whatever namespace a checkout syncs
 */
export async function v3WriterLease(
  store: WriterLeaseStore,
  ttlMs: number,
): Promise<WriterLease> {
  const host = Deno.hostname();
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  const local = await localProcess();
  return new WriterLease({
    store,
    holder: {
      holder: `${user}@${host}`,
      hostname: host,
      pid: local.pid,
      process: local.identity,
    },
    ttlMs,
    now: () => Date.now(),
    delay: (ms) => new Promise((done) => setTimeout(done, ms)),
    // a holder is gone only when its own kernel says so
    judgeHolder: (record) =>
      judgeRecordedProcess(
        {
          pid: record.pid,
          ...(record.process !== undefined ? { process: record.process } : {}),
        },
        local,
      ),
    nonce: () => crypto.randomUUID(),
  });
}

function lockInfoOf(inspection: WriterLeaseInspection): LockInfo {
  const record = inspection.record;
  if (record === undefined) {
    return {
      holder: "unknown",
      hostname: "unknown",
      pid: 0,
      acquiredAt: new Date().toISOString(),
      ttlMs: DEFAULT_LOCK_TTL_MS,
      holderUnknown: true,
      fence: inspection.fence,
    };
  }
  return {
    holder: record.holder,
    hostname: record.hostname,
    pid: record.pid,
    acquiredAt: inspection.renewedAt ?? record.acquiredAt,
    ttlMs: record.ttlMs,
    nonce: record.nonce,
    fence: inspection.fence,
  };
}

function legacyLock(datastorePath: string): FileLock {
  return new FileLock(resolve(datastorePath), {
    lockKey: V3_LEGACY_WRITER_LOCK_KEY,
    sameHostPidCheck: true,
  });
}

/**
 * the two never write one datastore at once during an upgrade; a legacy holder
 * is alive within its TTL, and on this host only while its process runs
 */
export async function refuseLiveV3LegacyWriter(
  datastorePath: string,
): Promise<void> {
  // v3 on a bucket postdates the lease: no Phase 3 swamp writes one.
  if (v3BucketBindingAt(datastorePath) !== undefined) return;
  const holder = await legacyLock(datastorePath).inspect();
  if (holder === null) return;
  const fresh = Date.parse(holder.acquiredAt) + holder.ttlMs >= Date.now();
  const alive = holder.holderUnknown === true ||
    (fresh &&
      (holder.hostname !== Deno.hostname() || !isProcessGone(holder.pid)));
  if (alive) {
    throw new V3WriterBusyError(
      datastorePath,
      new LockTimeoutError(V3_LEGACY_WRITER_LOCK_KEY, holder, 0),
    );
  }
}
