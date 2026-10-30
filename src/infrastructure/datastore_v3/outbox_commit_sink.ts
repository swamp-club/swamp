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
 * The commit sink of a v3 datastore handle (swamp-club#3490): the commit
 * store's append behind the writer lease's check, with the commit outbox.
 * Built in one place, `openV3Datastore`, so every unit the handle opens
 * prepares its commits.
 *
 * Phase 5's team-mode sink, which forwards commits to serve's leader, is
 * this sink over a store whose append goes to serve: `serve_commit_sink.ts`
 * (swamp-club#3985).
 *
 * @module
 */

import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type {
  CommitOutbox,
  OutboxKey,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type { CommitStoreAppendResult } from "../../domain/datastore_v3/commit_store.ts";
import type { CommitSink } from "./commit_log_unit_of_work.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

/** What {@link createOutboxCommitSink} composes. */
export interface OutboxCommitSinkOptions {
  readonly commitStore: Pick<
    SqliteCommitStore,
    "append" | "head" | "headIdentity" | "dataHighWater" | "landedSeq"
  >;
  readonly outbox: CommitOutbox;
  /**
   * The chunk sweep batch this process is running on the outbox's copy, if
   * any (swamp-club#3586): resolves once it has deleted and re-checked.
   */
  readonly sweepBatch?: () => Promise<void>;
  /**
   * Throws once this process's writer lease was taken over or released:
   * checked before each prepare and each append.
   */
  readonly assertWriterCurrent?: () => void;
  readonly clock?: () => Date;
}

/** A {@link CommitSink} with an outbox, and the removals it still owes. */
export interface OutboxCommitSink extends CommitSink {
  /**
   * Retries the removals of entries that failed (a unit's discard after a
   * failure, usually for the same cause): called when the handle closes.
   * An entry that cannot be removed is marked abandoned instead, which
   * recovery honours (swamp-club#3586). Rejects when neither can be written.
   */
  retryOwedRemovals(): Promise<void>;
}

/** Builds the sink a v3 datastore handle gives every unit it opens. */
export function createOutboxCommitSink(
  options: OutboxCommitSinkOptions,
): OutboxCommitSink {
  const { commitStore, outbox } = options;
  const assertWriterCurrent = options.assertWriterCurrent ?? (() => {});
  const clock = options.clock ?? (() => new Date());
  const owed = new Map<string, OutboxKey>();
  const keyOf = (key: OutboxKey) =>
    JSON.stringify([key.namespace, key.partition, key.txnId]);
  const removeOwing = async (
    keys: readonly OutboxKey[],
    remove: (keys: readonly OutboxKey[]) => Promise<void>,
  ) => {
    try {
      await remove(keys);
    } catch (error) {
      for (const key of keys) owed.set(keyOf(key), key);
      throw error;
    }
    for (const key of keys) owed.delete(keyOf(key));
  };
  return {
    head: (namespace, partition) => commitStore.head(namespace, partition),
    dataHighWater: (namespace, partition, name) =>
      commitStore.dataHighWater(namespace, partition, name),
    append: (commit: Commit): Promise<CommitStoreAppendResult> => {
      assertWriterCurrent();
      return commitStore.append(commit);
    },
    outbox: {
      headIdentity: (namespace, partition) =>
        commitStore.headIdentity(namespace, partition),
      prepare: async (preparation) => {
        // A writer that lost its lease prepares nothing: its entry could
        // only be dropped later.
        assertWriterCurrent();
        await outbox.prepare(preparation);
      },
      settle: (keys) => removeOwing(keys, (owing) => outbox.settle(owing)),
      discard: (keys) => removeOwing(keys, (owing) => outbox.discard(owing)),
      abandon: (keys) => outbox.abandon(keys),
      queue: (keys) => outbox.markState(keys, "offline"),
      landedSeq: (namespace, partition, txnId) =>
        commitStore.landedSeq(namespace, partition, txnId),
      sweepState: () => outbox.sweepState(clock().getTime()),
      sweepBatch: () => options.sweepBatch?.() ?? Promise.resolve(),
    },
    async retryOwedRemovals() {
      if (owed.size === 0) return;
      const keys = [...owed.values()];
      // Most owed removals are discards, whose failure was reported: retried
      // durably, as a settle may be too. An abandoned mark is enough when
      // the removal fails again: recovery drops the entry.
      try {
        await outbox.discard(keys);
      } catch (error) {
        try {
          await outbox.abandon(keys);
        } catch {
          throw error;
        }
      }
      owed.clear();
    },
  };
}
