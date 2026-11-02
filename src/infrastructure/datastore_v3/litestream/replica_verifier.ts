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
 * restores into a temp file beside commits.db, on the copy's own filesystem,
 * never a tmpfs; only an integrity-check failure is a broken lineage, a restore
 * that could not run records nothing
 */

import {
  type ReplicaVerification,
  snapshotReadAt,
} from "../../../domain/datastore_v3/replica_verification.ts";
import {
  restoreAndCheck,
  V3RestoredDatabaseCorruptError,
} from "./litestream_restorer.ts";
import {
  readCopyState,
  type ReplicationPaths,
  verifyTempFiles,
  verifyTempPath,
  writeReplicaVerification,
} from "./replication_files.ts";
import type { LitestreamReplicaType } from "./sidecar_env.ts";

/**
 * How much of SQLite's findings a verdict keeps: its integrity check can list
 * thousands of pages, and the first few say what is wrong.
 */
const VERDICT_ERROR_CHARS = 400;

/**
 * How long one check may take, as long as a reader's restore may: a restore
 * that stalls past it records nothing, so an idle sidecar can still stop.
 */
export const VERIFY_DEADLINE_MS = 30 * 60 * 1000;

function shortened(message: string): string {
  return message.length <= VERDICT_ERROR_CHARS
    ? message
    : `${message.slice(0, VERDICT_ERROR_CHARS)}…`;
}

export interface VerifyReplicaRequest {
  readonly paths: ReplicationPaths;
  readonly lineageFence: number;
  readonly replicaType: LitestreamReplicaType;
  readonly binary: string;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly deadlineMs?: number;
  readonly snapshotTxid?: string;
}

export async function verifyReplica(
  request: VerifyReplicaRequest,
): Promise<ReplicaVerification | undefined> {
  const { paths, lineageFence } = request;
  const copy = await readCopyState(paths);
  if (copy === undefined || copy.lineageFence !== lineageFence) {
    return undefined;
  }
  // beside the copy, in the shared directory a supervisor trusts only when this
  // user owns it and no one else can write it: the restored file holds what
  // commits.db holds
  const temp = verifyTempPath(paths);
  const read = snapshotReadAt(request.snapshotTxid, copy.txid);
  const snapshot = read !== undefined ? { snapshotTxid: read } : {};
  try {
    let verdict: ReplicaVerification;
    try {
      await restoreAndCheck({
        binary: request.binary,
        config: paths.config,
        source: paths.commitsDb,
        temp,
        txid: copy.txid,
        lineageFence,
        replicaType: request.replicaType,
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(request.deadlineMs ?? VERIFY_DEADLINE_MS),
        ]),
      });
      verdict = {
        lineageFence,
        txid: copy.txid,
        checkedAt: new Date(request.now()).toISOString(),
        ok: true,
        ...snapshot,
      };
    } catch (error) {
      if (!(error instanceof V3RestoredDatabaseCorruptError)) throw error;
      verdict = {
        lineageFence,
        txid: copy.txid,
        checkedAt: new Date(request.now()).toISOString(),
        ok: false,
        error: shortened(error.message),
        ...snapshot,
      };
    }
    await writeReplicaVerification(paths, verdict);
    return verdict;
  } finally {
    // Litestream restores into `<temp>.tmp`, left behind when stopped.
    for (const file of verifyTempFiles(temp)) {
      await Deno.remove(file).catch(() => {});
    }
  }
}
