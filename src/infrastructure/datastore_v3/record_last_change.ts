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

import {
  CommitsCompactedError,
  type CommitStore,
} from "../../domain/datastore_v3/commit_store.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

/** How many commits back the newest change to a refused key is looked for. */
const CHANGED_BY_SCAN = 200;

/** Who last changed a record and when, as far as recent history tells. */
export interface RecordLastChange {
  /** The commit's principal, else its writer's host. */
  readonly changedBy?: string;
  /** When the single writer accepted the commit. */
  readonly changedAt?: string;
}

/**
 * The newest of the last {@link CHANGED_BY_SCAN} commits of `partition`
 * that put or tombstoned `key`, as who and when; empty when none of them
 * did or that history is compacted away.
 */
export async function recordLastChange(
  commitStore: Pick<CommitStore, "head" | "readPartition">,
  namespace: string,
  partition: PartitionKey,
  key: string,
): Promise<RecordLastChange & { readonly seq: number }> {
  const head = await commitStore.head(namespace, partition);
  try {
    const recent = await commitStore.readPartition(
      namespace,
      partition,
      Math.max(1, head.seq - CHANGED_BY_SCAN + 1),
      CHANGED_BY_SCAN,
    );
    for (const { commit } of [...recent].reverse()) {
      const touched = commit.ops.some((op) =>
        (op.kind === "put" || op.kind === "tombstone") &&
        op.key.toString() === key
      );
      if (!touched) continue;
      return {
        seq: head.seq,
        changedBy: commit.principal ?? commit.writer.host,
        changedAt: commit.at,
      };
    }
  } catch (readError) {
    if (!(readError instanceof CommitsCompactedError)) throw readError;
  }
  return { seq: head.seq };
}
