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
 * a reader's restore would, into a private temp file it then deletes, and
 * records the verdict in `replica-verify.json`.
 *
 * Only a restore that fails SQLite's integrity check is a broken lineage.
 * One that could not run (the replica unreachable, past
 * {@link VERIFY_DEADLINE_MS}) records nothing: restarting the lineage over a network failure would upload a
 * full snapshot for nothing.
 *
 * @module
 */

import { join } from "@std/path";
import type { ReplicaVerification } from "../../../domain/datastore_v3/replica_verification.ts";
import {
  restoreAndCheck,
  V3RestoredDatabaseCorruptError,
} from "./litestream_restorer.ts";
import {
  readCopyState,
  type ReplicationPaths,
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
  // The private directory: nobody else can read the restored commits.
  const temp = join(paths.privateDir, `verify-${crypto.randomUUID()}.db`);
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
      };
    } catch (error) {
      if (!(error instanceof V3RestoredDatabaseCorruptError)) throw error;
      verdict = {
        lineageFence,
        txid: copy.txid,
        checkedAt: new Date(request.now()).toISOString(),
        ok: false,
        error: shortened(error.message),
      };
    }
    await writeReplicaVerification(paths, verdict);
    return verdict;
  } finally {
    // Litestream restores into `<temp>.tmp`, left behind when stopped.
    for (const file of [temp, `${temp}-wal`, `${temp}-shm`, `${temp}.tmp`]) {
      await Deno.remove(file).catch(() => {});
    }
  }
}
