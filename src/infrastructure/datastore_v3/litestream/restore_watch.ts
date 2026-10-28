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
 * Watches a v3 copy's restore through its replica's lineage paths
 * (swamp-club#3893), so a replica the storage cannot list stops the restore
 * within seconds instead of after Litestream's own retries.
 *
 * @module
 */

import type { ReplicaPathStore } from "../../../domain/datastore/replica_path_store.ts";
import { UserError } from "../../../domain/errors.ts";
import { getSwampLogger } from "../../logging/logger.ts";
import { isNetworkFailure } from "../network_failure.ts";
import {
  V3RestoredDatabaseRefusedError,
  V3RestoreError,
} from "./litestream_restorer.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

/**
 * How a restore's replica is watched (swamp-club#3893): once the restore
 * has run `graceMs`, swamp lists the replica's lineage paths itself, each
 * listing bounded by `probeMs` and the next `intervalMs` after it, whether
 * it answered or failed (swamp-club#4092). Litestream retries a listing the storage drops for about two minutes on
 * S3; the watch tells that apart from a long, healthy download.
 */
export interface V3RestoreWatchTiming {
  readonly graceMs: number;
  readonly probeMs: number;
  readonly intervalMs: number;
}

const DEFAULT_RESTORE_WATCH: V3RestoreWatchTiming = {
  graceMs: 2_000,
  probeMs: 4_000,
  intervalMs: 2_000,
};

/**
 * Sets each listing's bound, in milliseconds (swamp-club#4092), for a
 * replica whose first listing takes longer than the default 4 s: a far
 * region, a slow S3-compatible store, a cold bucket.
 */
export const RESTORE_PROBE_ENV_VAR = "SWAMP_V3_RESTORE_PROBE_MS";

/**
 * Listings that must fail in a row before a restore is stopped, an
 * interval apart: one dropped request never cuts a healthy restore short.
 * With the default timing a replica that cannot be listed stops the
 * restore within about 12 s: the grace, two bounded listings and the
 * interval between them.
 */
const RESTORE_WATCH_FAILURES = 2;

let timingOverride: V3RestoreWatchTiming | undefined;
let storeOverride: ReplicaPathStore | undefined;

/**
 * The listing bound {@link RESTORE_PROBE_ENV_VAR} sets (a positive integer
 * of milliseconds), else the default 4 s.
 */
export function restoreProbeMs(): number {
  const env = Deno.env.get(RESTORE_PROBE_ENV_VAR);
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESTORE_WATCH.probeMs;
}

/** The timing a restore is watched with, read when the watch starts. */
function restoreWatchTiming(): V3RestoreWatchTiming {
  return timingOverride ??
    { ...DEFAULT_RESTORE_WATCH, probeMs: restoreProbeMs() };
}

/**
 * Test seam: the restore watch's timing, and the store every restore is
 * watched through instead of its provider's, or undefined for the
 * defaults: a file replica, which tests replicate to, has no provider
 * store bound to its root. A timing set here wins over
 * {@link RESTORE_PROBE_ENV_VAR}.
 */
export function setV3RestoreWatchForTesting(
  options: {
    readonly timing?: V3RestoreWatchTiming;
    readonly replicaPaths?: ReplicaPathStore;
  } | undefined,
): void {
  timingOverride = options?.timing;
  storeOverride = options?.replicaPaths;
}

/** The store {@link setV3RestoreWatchForTesting} set, if any. */
export function restoreWatchStoreOverride(): ReplicaPathStore | undefined {
  return storeOverride;
}

/**
 * A restore stopped because its replica could not be listed
 * (swamp-club#3893): the storage is unreachable. Its cause is the network
 * failure, so it is classified as one: a reader fails with
 * `datastore_v3_catch_up_unreachable` instead of reading on after
 * Litestream's own retries, and a writer with the storage-unreachable
 * error.
 */
export class V3ReplicaUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      `the replica's lineage paths could not be listed: ${messageOf(cause)}`,
      { cause },
    );
    this.name = "V3ReplicaUnreachableError";
  }
}

/**
 * Runs `restore` while its replica is watched through `store`
 * ({@link V3RestoreWatchTiming}): when {@link RESTORE_WATCH_FAILURES}
 * listings in a row fail on the network, `restore`'s signal is aborted and
 * a {@link V3ReplicaUnreachableError} thrown. Without a store the restore
 * runs unwatched.
 */
export async function restoreWhileWatched<T>(
  store: ReplicaPathStore | undefined,
  restore: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (store === undefined) return await restore(undefined);
  const stop = new AbortController();
  const cut = new AbortController();
  const watching = watchReplica(store, stop.signal, cut);
  try {
    return await restore(cut.signal);
  } catch (error) {
    if (cut.signal.reason instanceof V3ReplicaUnreachableError) {
      throw cut.signal.reason;
    }
    throw error;
  } finally {
    stop.abort();
    await watching;
  }
}

/**
 * After a restore failed with `failure`, whether `store` can be listed: the
 * error to fail with when one bounded listing fails on the network,
 * undefined otherwise (swamp-club#3893). A restore can fail fast on a
 * listing the storage drops (GCS answers it within seconds, before the
 * watch lists), and a reader would then read its old copy with no word of
 * it in `--json`. A failure that is not about reaching storage lists
 * nothing and stays the error (swamp-club#4092).
 */
export async function replicaUnreachableAfterFailure(
  store: ReplicaPathStore | undefined,
  failure: unknown,
): Promise<V3ReplicaUnreachableError | undefined> {
  if (store === undefined || !mayBeStorage(failure)) return undefined;
  try {
    await listOrAbort(
      store,
      AbortSignal.timeout(restoreWatchTiming().probeMs),
    );
    return undefined;
  } catch (error) {
    return isNetworkFailure(error)
      ? new V3ReplicaUnreachableError(error)
      : undefined;
  }
}

/**
 * Whether a restore failure could be the storage being cut off. Litestream
 * failing to download is a `V3RestoreError` whatever stopped it, so it may
 * be; a refusal of what it downloaded (a newer schema, a lineage mismatch,
 * a corrupt copy) is not, nor is any other `UserError` (a refused config, a
 * refused Litestream binary).
 */
function mayBeStorage(failure: unknown): boolean {
  if (failure instanceof V3RestoredDatabaseRefusedError) return false;
  return !(failure instanceof UserError) || failure instanceof V3RestoreError;
}

/** Lists `store` until `stop`, aborting `cut` when it cannot be reached. */
async function watchReplica(
  store: ReplicaPathStore,
  stop: AbortSignal,
  cut: AbortController,
): Promise<void> {
  const timing = restoreWatchTiming();
  let failures = 0;
  // Once a listing answered, one that only runs past its bound is a slow
  // replica, not a cut one: a refusal still counts, a timeout no longer.
  let answered = false;
  let wait = timing.graceMs;
  while (await sleepUnless(wait, stop)) {
    try {
      await listOrAbort(
        store,
        AbortSignal.any([stop, AbortSignal.timeout(timing.probeMs)]),
      );
      failures = 0;
      answered = true;
      wait = timing.intervalMs;
    } catch (error) {
      if (stop.aborted) return;
      if (answered && isTimeout(error)) {
        wait = timing.intervalMs;
        continue;
      }
      // An answer that is not a network failure (a refusal) says the
      // storage is reachable: the restore's own error, if any, is the one.
      if (!isNetworkFailure(error)) {
        failures = 0;
        wait = timing.intervalMs;
        continue;
      }
      if (++failures >= RESTORE_WATCH_FAILURES) {
        logger
          .debug`Stopping a restore: its replica's lineage paths could not be listed: ${error}`;
        cut.abort(new V3ReplicaUnreachableError(error));
        return;
      }
      // The next listing waits the interval, so the failures that stop a
      // restore are spread over time, not one blip seen twice
      // (swamp-club#4092).
      wait = timing.intervalMs;
    }
  }
}

/** Whether `error` is a listing's bound running out. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * `store`'s listing, rejected when `signal` aborts even if the provider
 * ignores it: a listing that never settles never holds the restore.
 */
async function listOrAbort(
  store: ReplicaPathStore,
  signal: AbortSignal,
): Promise<void> {
  const listing = store.list(signal);
  // Settles on its own after an abort the provider ignored: handled here.
  listing.catch(() => {});
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([listing, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

/** Waits `ms`; resolves false, at once, when `stop` aborts. */
function sleepUnless(ms: number, stop: AbortSignal): Promise<boolean> {
  if (stop.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onStop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      stop.removeEventListener("abort", onStop);
      resolve(true);
    }, ms);
    stop.addEventListener("abort", onStop, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
