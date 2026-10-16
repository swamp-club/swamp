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
 * Replication for a v3 datastore's writer (swamp-club#3416, Phase 4 D1): the
 * one place the writer path reaches the Litestream sidecar.
 *
 * Every function here does nothing unless the datastore replicates
 * (`v3ReplicatesAt`): a v3 datastore on a bucket always does
 * (swamp-club#3534), a filesystem one only while the internal replica
 * setting (`replica_setting.ts`) names a replica.
 *
 * @module
 */

import { checkV3WriterLease } from "../v3_writer_lock.ts";
import { defaultLitestreamBinaryProvider } from "./litestream_binary_provider.ts";
import { unixLitestreamControl } from "./litestream_control_client.ts";
import { hostLitestreamProcesses } from "./litestream_processes.ts";
import {
  DEFAULT_REPLICATOR_TIMINGS,
  hostSupervisorCommand,
  LitestreamReplicator,
  type ReplicationHandle,
  type ReplicatorDeps,
} from "./litestream_replicator.ts";
import { v3ReplicaFor } from "../v3_datastore_binding.ts";

export type { ReplicationHandle } from "./litestream_replicator.ts";

/** How long a CLI write command's closing sync may take. */
export const DEFAULT_SYNC_DEADLINE_MS = 60_000;

/** The shortest closing sync serve gets, whatever its drain left. */
export const MIN_SERVE_SYNC_DEADLINE_MS = 10_000;

/** The longest closing sync: a day, well inside what setTimeout holds. */
export const MAX_SYNC_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * How long the sync confirming a serve write request may take
 * (swamp-club#3489): a stuck sidecar fails the request rather than holding
 * its reply for the CLI's minute.
 */
export const SERVE_REQUEST_SYNC_DEADLINE_MS = 10_000;

let replicator: LitestreamReplicator | undefined;
let testDeps: Partial<ReplicatorDeps> | undefined;
let syncDeadlineMs: number | undefined;
let requestSyncDeadlineMs: number | undefined;

/** The deadline of the closing sync: serve's budget, or the CLI default. */
export function v3SyncDeadlineMs(): number {
  return syncDeadlineMs ?? DEFAULT_SYNC_DEADLINE_MS;
}

/** The deadline of the sync confirming a serve write request. */
export function v3RequestSyncDeadlineMs(): number {
  return requestSyncDeadlineMs ?? SERVE_REQUEST_SYNC_DEADLINE_MS;
}

/**
 * Sets the deadline of the next closing sync: serve calls it at shutdown
 * with what its drain left, floored, so a zero drain still syncs. Undefined
 * restores the CLI default.
 */
export function setV3SyncDeadline(ms: number | undefined): void {
  // Floored so a zero drain still syncs, and capped below what setTimeout
  // can hold (about 24.8 days), past which it fires at once.
  syncDeadlineMs = ms === undefined
    ? undefined
    : Math.min(Math.max(ms, MIN_SERVE_SYNC_DEADLINE_MS), MAX_SYNC_DEADLINE_MS);
}

/**
 * Test seam: replaces parts of the replicator's dependencies, or with
 * undefined restores the real ones. Also sets the closing sync's deadline
 * and a serve write request's.
 */
export function setV3ReplicationForTesting(
  deps: Partial<ReplicatorDeps> | undefined,
  options: {
    readonly syncDeadlineMs?: number;
    readonly requestSyncDeadlineMs?: number;
  } = {},
): void {
  testDeps = deps;
  replicator = undefined;
  syncDeadlineMs = options.syncDeadlineMs;
  requestSyncDeadlineMs = options.requestSyncDeadlineMs;
}

/** This process's replicator: one per process, shared by every writer. */
export function v3Replicator(): LitestreamReplicator {
  return theReplicator();
}

/** The hash-checked Litestream binary, or the test seam's. */
export async function resolveV3LitestreamBinary(): Promise<string> {
  return testDeps?.resolveBinary !== undefined
    ? await testDeps.resolveBinary()
    : (await defaultLitestreamBinaryProvider().resolve()).path;
}

function theReplicator(): LitestreamReplicator {
  replicator ??= new LitestreamReplicator({
    processes: hostLitestreamProcesses,
    control: unixLitestreamControl,
    async resolveBinary() {
      return (await defaultLitestreamBinaryProvider().resolve()).path;
    },
    supervisor: hostSupervisorCommand(),
    timings: DEFAULT_REPLICATOR_TIMINGS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    ...testDeps,
  });
  return replicator;
}

/**
 * Holds the sidecar for this process's writer of the copy `commitsDb` of
 * the datastore at `datastorePath`, at lease `fence`, or resolves with
 * undefined when replication is off. The writer's lineage was prepared
 * (`prepareV3WriterLineage`) once its copy was current.
 *
 * @throws V3ReplicationUnavailableError
 */
export async function acquireV3Replication(
  commitsDb: string,
  datastorePath: string,
  fence: number,
): Promise<ReplicationHandle | undefined> {
  const replica = v3ReplicaFor(datastorePath);
  if (replica === undefined) return undefined;
  return await theReplicator().acquire({
    commitsDb,
    replica,
    fence,
    // A writer that lost its lease reports nothing as replicated.
    assertLeaseCurrent: () => checkV3WriterLease(datastorePath),
  });
}
