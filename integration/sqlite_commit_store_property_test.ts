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
 * Model-based property test of the SQLite commit store (swamp-club#3236):
 * random command sequences applied through the store must give the same
 * results and the same partition state as the partition reference model,
 * also after the store is closed and reopened, which rebuilds the partition
 * from its snapshot and the commits after it.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import {
  CommitRejectedError,
  Partition,
} from "../src/domain/datastore_v3/partition.ts";
import {
  arbCommand,
  buildOp,
  type Command,
  emptyModel,
  expected,
  type Model,
  modelAppend,
  observe,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  modelCommit,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** A store result in the reference model's shape. */
type Outcome =
  | { kind: "appended"; seq: number }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: string };

/** Drives a store and the reference model with the same commands. */
class Harness {
  model: Model = emptyModel();
  /** The seq each landed txnId landed at. */
  readonly landed = new Map<string, number>();
  #fresh = 0;

  async apply(store: SqliteCommitStore, command: Command): Promise<void> {
    const used = [...this.landed.keys()];
    const txnId = command.reuseTxn !== undefined && used.length > 0
      ? used[command.reuseTxn % used.length]
      : `txn-${this.#fresh++}`;
    const ops: Op[] = [];
    for (const spec of command.ops) ops.push(await buildOp(spec));
    const commit = modelCommit(
      Math.max(1, this.model.seq + 1 + command.seqOffset),
      ops,
      { txnId, fence: command.fence },
    );

    let actual: Outcome;
    try {
      const result = await store.append(commit);
      if (result.kind === "duplicate") {
        assertEquals(result.seq, this.landed.get(txnId));
        actual = { kind: "duplicate" };
      } else {
        actual = result;
      }
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      actual = { kind: "rejected", reason: error.reason };
    }
    const reference = await modelAppend(this.model, commit, command.ops);
    assertEquals(actual, reference.result);
    this.model = reference.model;
    if (actual.kind === "appended") this.landed.set(txnId, actual.seq);
  }

  /**
   * The store's stored commits and head agree with the model, and its
   * snapshot, if it wrote one, is the state those commits give at its seq.
   */
  async check(store: SqliteCommitStore, path: string): Promise<void> {
    const replayed = Partition.empty(modelPartition());
    const commits = await store.readPartition("", modelPartition(), 1, 1000);
    for (const commit of commits) replayed.append(commit);
    assertEquals(observe(replayed), expected(this.model));
    assertEquals(await store.head("", modelPartition()), {
      seq: this.model.seq,
      highestFence: this.model.fence,
    });

    const db = new DatabaseSync(path);
    let row: { body: string } | undefined;
    try {
      row = db.prepare("SELECT body FROM partition_snapshots").get() as
        | { body: string }
        | undefined;
    } finally {
      db.close();
    }
    if (row === undefined) return;
    const body = JSON.parse(row.body);
    const covered = commits.slice(0, body.seq);
    const restored = Partition.restore(
      modelPartition(),
      body,
      (txnId) => covered.some((commit) => commit.txnId === txnId),
    );
    const upToSnapshot = Partition.empty(modelPartition());
    for (const commit of covered) upToSnapshot.append(commit);
    // Compared through the partitions' getters, not snapshot(), which would
    // share any fault of the snapshot it checks.
    assertEquals(observe(restored), observe(upToSnapshot));
    assertEquals(restored.leaseHolder, upToSnapshot.leaseHolder);
  }
}

Deno.test("SqliteCommitStore: agrees with the partition reference model, before and after a reopen", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-commit-property-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCommand, { minLength: 1, maxLength: 20 }),
        fc.array(fc.tuple(arbCommand, fc.boolean()), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 5 }),
        async (before, after, snapshotInterval) => {
          const path = join(dir, `${crypto.randomUUID()}.db`);
          const options = { snapshotInterval, cachedPartitions: 1 };
          const harness = new Harness();

          // The first phase lands as much as it can (the next seq, one
          // fence), so the snapshot the reopen rebuilds from holds real
          // state: deleted top versions, tombstoned records, a raised fence.
          // In the second phase about half the commands do the same, so they
          // test the rebuilt state; the rest are unbiased and mostly refused
          // for their seq or fence.
          const store = SqliteCommitStore.open(path, options);
          try {
            for (const command of before) {
              await harness.apply(store, {
                ...command,
                seqOffset: 0,
                fence: 1,
              });
            }
            await harness.check(store, path);
          } finally {
            await store.close();
          }

          // Reopened, the store rebuilds the partition from the file.
          const reopened = SqliteCommitStore.open(path, options);
          try {
            for (const [command, lands] of after) {
              await harness.apply(
                reopened,
                lands ? { ...command, seqOffset: 0, fence: 1 } : command,
              );
            }
            await harness.check(reopened, path);
          } finally {
            await reopened.close();
          }
        },
      ),
      { numRuns: 150 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
