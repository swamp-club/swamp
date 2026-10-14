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
 * Dormant: every function here does nothing unless the internal replica
 * setting (`replica_setting.ts`) names a replica.
 *
 * @module
 */

import { join } from "@std/path";
import { decideLineage } from "../../../domain/datastore_v3/replication_lineage.ts";
import { getSwampLogger } from "../../logging/logger.ts";
import { COMMITS_DB_FILE } from "../v3_datastore.ts";
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
import {
  ensureSharedDir,
  readLineage,
  removeLineage,
  replicationPathsFor,
  writeLineage,
} from "./replication_files.ts";
import { replicaRootOf, v3ReplicaSetting } from "./replica_setting.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

export type { ReplicationHandle } from "./litestream_replicator.ts";

/** How long a CLI write command's closing sync may take. */
export const DEFAULT_SYNC_DEADLINE_MS = 60_000;

/** The shortest closing sync serve gets, whatever its drain left. */
export const MIN_SERVE_SYNC_DEADLINE_MS = 10_000;

let replicator: LitestreamReplicator | undefined;
let testDeps: Partial<ReplicatorDeps> | undefined;
let syncDeadlineMs: number | undefined;

/** The deadline of the closing sync: serve's budget, or the CLI default. */
export function v3SyncDeadlineMs(): number {
  return syncDeadlineMs ?? DEFAULT_SYNC_DEADLINE_MS;
}

/**
 * Sets the deadline of the next closing sync: serve calls it at shutdown
 * with what its drain left, floored, so a zero drain still syncs. Undefined
 * restores the CLI default.
 */
export function setV3SyncDeadline(ms: number | undefined): void {
  syncDeadlineMs = ms === undefined
    ? undefined
    : Math.max(ms, MIN_SERVE_SYNC_DEADLINE_MS);
}

/**
 * Test seam: replaces parts of the replicator's dependencies, or with
 * undefined restores the real ones. Also sets the closing sync's deadline.
 */
export function setV3ReplicationForTesting(
  deps: Partial<ReplicatorDeps> | undefined,
  options: { readonly syncDeadlineMs?: number } = {},
): void {
  testDeps = deps;
  replicator = undefined;
  syncDeadlineMs = options.syncDeadlineMs;
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

/** Whether replication is on: only when the internal replica setting names one. */
export function v3ReplicationEnabled(): boolean {
  return v3ReplicaSetting() !== undefined;
}

/**
 * Records the lineage of the lease this process took at `fence` on the
 * datastore at `datastorePath`, so a command that crashes is continued by
 * its successor. Best effort: a failure removes the record, which costs one
 * lineage restart, and never the lease.
 */
export async function recordV3Lineage(
  datastorePath: string,
  fence: number,
): Promise<void> {
  const replica = v3ReplicaSetting();
  if (replica === undefined) return;
  let paths;
  try {
    paths = await replicationPathsFor(join(datastorePath, COMMITS_DB_FILE));
    if (await ensureSharedDir(paths) !== "own") return;
    const decided = decideLineage(
      await readLineage(paths),
      replicaRootOf(replica),
      fence,
    );
    await writeLineage(paths, decided.lineage);
  } catch (error) {
    logger
      .warn`Recording the replication lineage of the v3 datastore at ${datastorePath} failed; its next writer starts a new lineage: ${error}`;
    if (paths !== undefined) await removeLineage(paths).catch(() => {});
  }
}

/**
 * Holds the sidecar for this process's writer on the datastore at
 * `datastorePath`, at lease `fence`, or resolves with undefined when
 * replication is off.
 *
 * @throws V3ReplicationUnavailableError
 */
export async function acquireV3Replication(
  datastorePath: string,
  fence: number,
): Promise<ReplicationHandle | undefined> {
  const replica = v3ReplicaSetting();
  if (replica === undefined) return undefined;
  return await theReplicator().acquire({
    commitsDb: join(datastorePath, COMMITS_DB_FILE),
    replica,
    fence,
    // A writer that lost its lease reports nothing as replicated.
    assertLeaseCurrent: () => checkV3WriterLease(datastorePath),
  });
}
