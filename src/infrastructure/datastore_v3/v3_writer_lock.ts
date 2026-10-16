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
 * The writer of a filesystem v3 datastore: its fenced writer lease
 * (swamp-club#3359), which replaced the Phase 3 writer lock
 * (swamp-club#3279). One process at a time may write a v3 datastore, and
 * every commit it makes names the fence its lease holds, so a process that
 * lost the lease (paused past its expiry, then woken after another writer
 * took over) lands nothing.
 *
 * The lease's records are files under `<datastore>/_control/writer/`,
 * created exclusively through `FileSystemControlPlaneStore`, or on a bucket
 * datastore (swamp-club#3534) the records under `_control/writer/` in its
 * provider's datastore-wide control plane; see `writer_lease.ts` for the
 * scheme. Taking it also raises the store-wide
 * writer fence in `commits.db`, which refuses any commit naming a lower
 * fence, inside the commit's own transaction.
 *
 * It is process-scoped. The first writer in a process takes it and the last
 * one to finish releases it: serve holds it from start-up to shutdown, a CLI
 * write command for as long as it runs, and both renew it every third of its
 * TTL. Roots never take it themselves, so a long workflow run does not queue
 * every other root in serve behind it. Read-only commands take it only to
 * recover a checkout whose writer ended without tearing down, without
 * waiting, and release it before they read (swamp-club#3299).
 *
 * A holder on another host is alive until its last renewal is older than its
 * TTL plus the clock-skew allowance, never judged by its pid. A holder on
 * this host whose process is gone is taken over at once.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import {
  WriterLease,
  WriterLeaseBusyError,
  type WriterLeaseHold,
  type WriterLeaseInspection,
  type WriterLeaseStore,
} from "../../domain/datastore_v3/writer_lease.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_LOCK_TTL_MS, FileLock } from "../persistence/file_lock.ts";
import { v3BucketBindingAt, v3ControlPlaneAt } from "./v3_datastore_binding.ts";
import { isProcessDead } from "../runtime/process.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/** Where the lease's records live under the datastore root. */
export const V3_WRITER_LEASE_DIR = join("_control", "writer");

/**
 * The Phase 3 writer lock's key under the datastore root. A swamp from
 * before the lease may still hold it during an upgrade; the lease is
 * refused while it does.
 */
export const V3_LEGACY_WRITER_LOCK_KEY = join("_control", "writer.lock");

/** Error code for a second process refused as a v3 datastore's writer. */
export const V3_WRITER_BUSY_CODE = "datastore_v3_writer_busy";

/** Thrown when another process holds a v3 datastore's writer lease. */
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

/**
 * The store-wide writer fence of the datastore's `commits.db`: the floor
 * for the next fence, raised once the lease is taken.
 */
export interface V3WriterFenceStore {
  writerFence(): number | undefined;
  raiseWriterFence(fence: number): Promise<void>;
}

interface Held {
  hold?: WriterLeaseHold;
  refs: number;
  /** The acquire in flight, which later callers in the process share. */
  acquiring?: Promise<void>;
  renewal?: ReturnType<typeof setInterval>;
  renewing?: Promise<void>;
  /** A fresh lease being taken for a lost hold, which callers share. */
  retaking?: Promise<void>;
  /** How this hold takes the lease. */
  take?: {
    readonly ttlMs: number;
    readonly fenceStore?: V3WriterFenceStore;
  };
  /**
   * Whether a fresh lease is taken once this hold is lost, so a long-lived
   * process (serve) writes again after another writer has finished. A
   * one-shot command's hold just ends: its later commits are refused too,
   * so it fails as a whole rather than landing part of itself.
   */
  retakeLost: boolean;
}

const held = new Map<string, Held>();

/** Options for {@link acquireV3WriterLock}. */
export interface AcquireV3WriterLockOptions {
  /** How long to wait for another process to finish (`SWAMP_LOCK_TIMEOUT_MS`). */
  readonly maxWaitMs?: number;
  /** The lease's TTL; renewals keep it. */
  readonly ttlMs?: number;
  /**
   * The datastore's `commits.db`. Without it the lease's fence is not
   * recorded there, which only tests of the lease itself do.
   */
  readonly fenceStore?: V3WriterFenceStore;
  /**
   * Take a fresh lease once this hold is lost (serve's lifetime hold). The
   * process's first acquire decides; later ones join its hold.
   */
  readonly retakeLost?: boolean;
}

/**
 * Takes the writer lease of the v3 datastore at `datastorePath` for this
 * process, or joins the hold it already has. Resolves with the release for
 * this caller; the lease is released when every caller has released.
 *
 * Taking the lease and raising the fence in `commits.db` are one step: when
 * either fails, the lease is released and nothing in the process holds it.
 *
 * @throws V3WriterBusyError when another process holds it past the wait
 * @throws WriterFencedError when `commits.db` has seen a higher fence
 */
export async function acquireV3WriterLock(
  datastorePath: string,
  options: AcquireV3WriterLockOptions = {},
): Promise<() => Promise<void>> {
  const key = resolve(datastorePath);
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  let entry = held.get(key);
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

/** Ends the process's hold once no caller holds it. */
async function endHold(key: string, entry: Held): Promise<void> {
  if (held.get(key) === entry) held.delete(key);
  if (entry.renewal !== undefined) clearInterval(entry.renewal);
  await entry.renewing;
  await entry.hold?.release();
}

/** A shared {@link retakeLease} for `entry`, cleared when it settles. */
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
 * Takes a fresh lease for `entry`, replacing a lost hold: its fence is
 * higher, so commits units made under the lost one still name the old fence
 * and are refused, while units opened from now on name the new one.
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
  }
}

/**
 * Takes the writer lease of the v3 datastore at `datastorePath` without
 * waiting, for a read-only command that must recover an interrupted
 * writer's checkout (swamp-club#3299). Resolves with the release, or
 * undefined when another process holds the lease or this process already
 * does (its writer path recovers instead). The hold is not shared: nothing
 * else in the process joins it, and the caller releases it before reading.
 */
export async function tryAcquireV3WriterLock(
  datastorePath: string,
  options: {
    readonly fenceStore?: V3WriterFenceStore;
    /** The lease's TTL; renewals keep it while the recovery runs. */
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

/** Whether this process holds the writer lease of the datastore at `datastorePath`. */
export function holdsV3WriterLock(datastorePath: string): boolean {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0;
}

/**
 * The fence this process's writer lease on the datastore at `datastorePath`
 * holds, or undefined when it holds none. Every commit names it, and
 * Litestream replicates under it (Phase 4).
 */
export function v3WriterFence(datastorePath: string): number | undefined {
  const entry = held.get(resolve(datastorePath));
  return entry !== undefined && entry.refs > 0 ? entry.hold?.fence : undefined;
}

/**
 * Throws when this process's writer lease on the datastore at
 * `datastorePath` was taken over or released since it was taken: checked
 * before each commit, so a holder that knows it lost the lease stops at once.
 *
 * @throws WriterFencedError
 */
export function assertV3WriterCurrent(datastorePath: string): void {
  const lost = held.get(resolve(datastorePath))?.hold?.lost;
  if (lost !== undefined) throw lost;
}

/**
 * Checks the lease's records for a higher fence or this hold's release, and
 * throws when it finds either: the check a writer runs before it reports a
 * replicated commit (Phase 4). Resolves when this process holds no lease on
 * the datastore.
 *
 * @throws WriterFencedError
 */
export async function checkV3WriterLease(datastorePath: string): Promise<void> {
  await held.get(resolve(datastorePath))?.hold?.assertCurrent();
}

/** What `swamp datastore lock status|release` act on. */
export type V3WriterLockHandle = Pick<
  DistributedLock,
  "inspect" | "forceRelease"
>;

/**
 * A handle on the writer lease of the v3 datastore at `datastorePath` for
 * inspecting or force-releasing it (`swamp datastore lock status|release`).
 * It never acquires. While a Phase 3 swamp holds the old writer lock, the
 * handle acts on that lock instead.
 */
export function v3WriterLockHandle(datastorePath: string): V3WriterLockHandle {
  const lease = writerLease(datastorePath, DEFAULT_LOCK_TTL_MS);
  // A bucket datastore never had a Phase 3 writer lock.
  const legacy = v3BucketBindingAt(datastorePath) === undefined
    ? legacyLock(datastorePath)
    : undefined;
  return {
    async inspect(): Promise<LockInfo | null> {
      const inspection = await lease.inspect();
      if (inspection !== null && inspection.state !== "released") {
        return lockInfoOf(inspection);
      }
      return await legacy?.inspect() ?? null;
    },
    async forceRelease(nonce: string): Promise<boolean> {
      const inspection = await lease.inspect();
      if (inspection !== null && inspection.state !== "released") {
        return await lease.forceRelease(nonce);
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
  // A bucket datastore is known to be v3 before its lease is written
  // (swamp-club#3534): every lease taker comes through here.
  await v3BucketBindingAt(datastorePath)?.confirmMarker();
  await refuseLiveV3LegacyWriter(datastorePath);
  let hold: WriterLeaseHold;
  try {
    const floor = options.fenceStore?.writerFence();
    hold = await writerLease(datastorePath, options.ttlMs).acquire({
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

/** Called whenever this process takes a v3 datastore's writer lease. */
export type V3LeaseTakenListener = (
  datastorePath: string,
  fence: number,
) => Promise<void> | void;

const leaseTakenListeners = new Set<V3LeaseTakenListener>();

/**
 * Calls `listener` each time this process takes a writer lease: the first
 * acquire, serve's retake of a lost lease, and a read-only command's
 * recovery hold (swamp-club#3416, where a Litestream lineage is recorded at
 * every fence). Listeners run after the fence is raised; one that throws is
 * logged and the lease is kept. Returns the unsubscribe.
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

function writerLease(datastorePath: string, ttlMs: number): WriterLease {
  return v3WriterLease(v3ControlPlaneAt(datastorePath), ttlMs);
}

/**
 * This process's writer lease over `store`, whose keys are relative to the
 * datastore-wide `_control/`. A filesystem datastore's store is its root
 * `_control/` directory; any other datastore's is its provider's writable
 * datastore-wide control plane (`datastoreWriterLeaseStore`), so the lease
 * is one per datastore whatever namespace a checkout syncs.
 */
export function v3WriterLease(
  store: WriterLeaseStore,
  ttlMs: number,
): WriterLease {
  const host = Deno.hostname();
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  return new WriterLease({
    store,
    holder: { holder: `${user}@${host}`, hostname: host, pid: Deno.pid },
    ttlMs,
    now: () => Date.now(),
    delay: (ms) => new Promise((done) => setTimeout(done, ms)),
    processGone: isProcessDead,
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
 * Refuses the lease while a swamp from before it holds the Phase 3 writer
 * lock, so the two never write one datastore at once during an upgrade. A
 * holder is alive by Phase 3's own rule: within its TTL, and on this host
 * only while its process runs.
 *
 * @throws V3WriterBusyError
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
      (holder.hostname !== Deno.hostname() || !isProcessDead(holder.pid)));
  if (alive) {
    throw new V3WriterBusyError(
      datastorePath,
      new LockTimeoutError(V3_LEGACY_WRITER_LOCK_KEY, holder, 0),
    );
  }
}
