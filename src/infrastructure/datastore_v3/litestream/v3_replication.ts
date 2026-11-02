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
 * every function here does nothing unless the datastore replicates (a bucket
 * always does, a filesystem one only when the internal replica setting names
 * one)
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
import { defaultPrivateRoot } from "./replication_files.ts";
import { v3ReplicaFor } from "../v3_datastore_binding.ts";
import { withSpan } from "../../tracing/tracer.ts";

export type { ReplicationHandle } from "./litestream_replicator.ts";

export const DEFAULT_SYNC_DEADLINE_MS = 60_000;

export const MAX_SYNC_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * a stuck sidecar fails the request rather than holding its reply for the CLI's
 * deadline
 */
export const SERVE_REQUEST_SYNC_DEADLINE_MS = 10_000;

let replicator: LitestreamReplicator | undefined;
let testDeps: Partial<ReplicatorDeps> | undefined;
export interface V3ClosingDeadline {
  remaining(capMs?: number): number;
}

let syncDeadlineMs: number | undefined;
let requestSyncDeadlineMs: number | undefined;
let closingDeadline: V3ClosingDeadline | undefined;

export function v3SyncDeadlineMs(): number {
  if (closingDeadline !== undefined) {
    // capped below what setTimeout can hold, past which it fires at once
    return Math.min(closingDeadline.remaining(), MAX_SYNC_DEADLINE_MS);
  }
  return syncDeadlineMs ?? DEFAULT_SYNC_DEADLINE_MS;
}

export function v3ClosingDeadline(): V3ClosingDeadline | undefined {
  return closingDeadline;
}

export function v3RequestSyncDeadlineMs(): number {
  return requestSyncDeadlineMs ?? SERVE_REQUEST_SYNC_DEADLINE_MS;
}

/**
 * serve calls it at shutdown with its one deadline, so the closing sync and the
 * writer lease release take what is left of it when each starts, not more
 */
export function setV3ClosingDeadline(
  deadline: V3ClosingDeadline | undefined,
): void {
  closingDeadline = deadline;
}

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
  closingDeadline = undefined;
}

export function v3Replicator(): LitestreamReplicator {
  return theReplicator();
}

/**
 * a copy's paths come from the same private root as the replicator, so the two
 * always agree
 */
export function v3PrivateRoot(): string {
  return testDeps?.privateRoot ?? defaultPrivateRoot();
}

/**
 * its span says whether the binary was downloaded: a fresh swamp home pays that
 * on its first restore
 */
export function resolveV3LitestreamBinary(): Promise<string> {
  return withSpan("swamp.datastore.v3.litestream.binary", {}, async (span) => {
    if (testDeps?.resolveBinary !== undefined) {
      return await testDeps.resolveBinary();
    }
    const resolved = await defaultLitestreamBinaryProvider().resolve();
    span.setAttribute("swamp.datastore.v3.binary_source", resolved.source);
    return resolved.path;
  });
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
