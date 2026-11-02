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
 * The writer's check of its own replica (swamp-club#3935): the sidecar
 * restores its lineage at the TXID the writer last acknowledged, exactly as
 * a reader's restore would, into a temp file beside `commits.db` it then
 * deletes, and records the verdict in `replica-verify.json`. Beside the
 * copy, not under `/tmp`: on the copy's own filesystem, never a tmpfs
 * holding a second copy of the commit log in memory (swamp-club#4261).
 *
 * Only a restore that fails SQLite's integrity check is a broken lineage.
 * One that could not run (the replica unreachable, past
 * {@link VERIFY_DEADLINE_MS}) records nothing: restarting the lineage over a network failure would upload a
 * full snapshot for nothing.
 *
 * @module
 */

import type { ReplicaVerification } from "../../../domain/datastore_v3/replica_verification.ts";
import { normalizeTxid } from "../../../domain/datastore_v3/published_lineage.ts";
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

/**
 * The snapshot a restore at `txid` reads through, as a verdict records it:
 * only one at or below that TXID. A newer one, written after the writer's
 * last acknowledgement, is read only by later restores, so the verdict
 * leaves it out and the next check sees it as new.
 */
function coveredSnapshot(
  snapshotTxid: string | undefined,
  txid: string,
): { snapshotTxid?: string } {
  const snapshot = normalizeTxid(snapshotTxid);
  const restored = normalizeTxid(txid);
  return snapshot !== undefined && restored !== undefined &&
      snapshot <= restored
    ? { snapshotTxid: snapshot }
    : {};
}

function shortened(message: string): string {
  return message.length <= VERDICT_ERROR_CHARS
    ? message
    : `${message.slice(0, VERDICT_ERROR_CHARS)}…`;
}

/** What {@link verifyReplica} checks. */
export interface VerifyReplicaRequest {
  readonly paths: ReplicationPaths;
  /** The lineage the sidecar replicates. */
  readonly lineageFence: number;
  readonly replicaType: LitestreamReplicaType;
  /** The hash-checked Litestream binary. */
  readonly binary: string;
  readonly now: () => number;
  readonly signal: AbortSignal;
  /** {@link VERIFY_DEADLINE_MS} when absent. */
  readonly deadlineMs?: number;
  /**
   * The replica's newest snapshot when the check started (swamp-club#4261),
   * recorded in the verdict when it is at or below the restored TXID;
   * absent when it was not known.
   */
  readonly snapshotTxid?: string;
}

/**
 * Restores the sidecar's lineage the way a reader would and records the
 * verdict. Resolves with it, or undefined when the writer acknowledged
 * nothing on this lineage, so there is nothing a reader would restore.
 *
 * @throws when the restore could not run; nothing is recorded then
 */
export async function verifyReplica(
  request: VerifyReplicaRequest,
): Promise<ReplicaVerification | undefined> {
  const { paths, lineageFence } = request;
  const copy = await readCopyState(paths);
  if (copy === undefined || copy.lineageFence !== lineageFence) {
    return undefined;
  }
  // Beside the copy (swamp-club#4261), in the shared directory a supervisor
  // trusts only when this user owns it and nobody else can write to it: the
  // restored file holds what `commits.db` beside it holds.
  const temp = verifyTempPath(paths);
  const snapshot = coveredSnapshot(request.snapshotTxid, copy.txid);
  try {
    let verdict: ReplicaVerification;
    try {
      await restoreAndCheck({
        binary: request.binary,
        // The sidecar's own config names `commits.db` and its replica; the
        // restore writes only to the temp file.
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
