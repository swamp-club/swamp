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
 * a replica the storage cannot list stops the restore within seconds instead of
 * after Litestream's own retries
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
 * once the restore has run graceMs, swamp lists the replica's lineage paths
 * itself, each listing bounded by probeMs and the next intervalMs after it;
 * this tells a dropped listing from a long healthy download
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
 * sets each listing's bound in milliseconds, for a replica whose first listing
 * is slow: a far region, a slow S3-compatible store, a cold bucket
 */
export const RESTORE_PROBE_ENV_VAR = "SWAMP_V3_RESTORE_PROBE_MS";

/**
 * listings that must fail in a row before a restore is stopped: one dropped
 * request never cuts a healthy restore short
 */
const RESTORE_WATCH_FAILURES = 2;

let timingOverride: V3RestoreWatchTiming | undefined;
let storeOverride: ReplicaPathStore | undefined;

export function restoreProbeMs(): number {
  const env = Deno.env.get(RESTORE_PROBE_ENV_VAR);
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESTORE_WATCH.probeMs;
}

function restoreWatchTiming(): V3RestoreWatchTiming {
  return timingOverride ??
    { ...DEFAULT_RESTORE_WATCH, probeMs: restoreProbeMs() };
}

/**
 * test seam: the watch's timing, and the store every restore is watched through
 * instead of its provider's, since a file replica has no provider store; a
 * timing set here wins over the env var
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

export function restoreWatchStoreOverride(): ReplicaPathStore | undefined {
  return storeOverride;
}

/**
 * the replica could not be listed, so the storage is unreachable: a reader
 * fails with datastore_v3_catch_up_unreachable instead of reading on, and a
 * writer with the storage-unreachable error
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
 * when consecutive listings fail on the network, restore's signal is aborted
 * and V3ReplicaUnreachableError thrown; without a store the restore runs
 * unwatched
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
 * a restore can fail fast on a listing the storage drops, before the watch
 * lists, and a reader would then read its old copy silently; a failure not
 * about reaching storage stays the error
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
 * a Litestream download failure is a V3RestoreError whatever stopped it, so it
 * may be storage; a refusal of what it downloaded, or any other UserError, is
 * not
 */
function mayBeStorage(failure: unknown): boolean {
  if (failure instanceof V3RestoredDatabaseRefusedError) return false;
  return !(failure instanceof UserError) || failure instanceof V3RestoreError;
}

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
      // the next listing waits the interval, so the failures that stop a
      // restore are spread over time, not one blip seen twice
      wait = timing.intervalMs;
    }
  }
}

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
