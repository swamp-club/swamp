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
 * What the commit store gives the commit outbox (swamp-club#3490): head
 * identities, landed txnIds, and the pruning of compacted txnIds.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

async function withStore(
  fn: (store: SqliteCommitStore, path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-commit-store-outbox-" });
  const path = join(dir, "commits.db");
  const store = SqliteCommitStore.open(path);
  try {
    await fn(store, path);
  } finally {
    await store.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Commit `seq` of the fixture model, made `days` after T0. */
async function save(seq: number, days = seq) {
  return modelCommit(seq, [await savePut("x", seq)], {
    at: new Date(T0 + days * DAY).toISOString(),
  });
}

function txnRows(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT txn_id FROM compacted_txns ORDER BY seq")
      .all() as {
        txn_id: string;
      }[]).map((row) => row.txn_id);
  } finally {
    db.close();
  }
}

Deno.test("SqliteCommitStore.headIdentity: the head's txnId, stored, compacted, or unknown once pruned", async () => {
  await withStore(async (store) => {
    const partition = modelPartition();
    assertEquals(await store.headIdentity("", partition), {
      seq: 0,
      txnId: undefined,
    });
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    assertEquals(await store.headIdentity("", partition), {
      seq: 3,
      txnId: "txn-3",
    });
    // Every commit folded: the head's txnId comes from compacted_txns.
    await store.compactHistory(3);
    assertEquals(await store.headIdentity("", partition), {
      seq: 3,
      txnId: "txn-3",
    });
    // Another partition's commit becomes the point, and the head's txnId is
    // pruned: only its seq is known.
    await store.append(
      modelCommit(1, [await runPut("r")], {
        partition: runPartition(),
        txnId: "run-1",
        at: new Date(T0 + 9 * DAY).toISOString(),
      }),
    );
    await store.compactHistory(4, {
      pruneTxnsBefore: new Date(T0 + 5 * DAY),
    });
    assertEquals(await store.headIdentity("", partition), {
      seq: 3,
      txnId: undefined,
    });
  });
});

Deno.test("SqliteCommitStore.landedSeq: finds a txnId stored or compacted", async () => {
  await withStore(async (store) => {
    const partition = modelPartition();
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    await store.compactHistory(2);
    assertEquals(await store.landedSeq("", partition, "txn-1"), 1);
    assertEquals(await store.landedSeq("", partition, "txn-3"), 3);
    assertEquals(await store.landedSeq("", partition, "txn-9"), undefined);
  });
});

Deno.test("SqliteCommitStore.compactHistory: prunes compacted txnIds made before the cutoff, never the compaction point's", async () => {
  await withStore(async (store, path) => {
    for (let seq = 1; seq <= 6; seq++) await store.append(await save(seq));
    const report = await store.compactHistory(3, {
      pruneTxnsBefore: new Date(T0 + 10 * DAY),
    });
    // Commits 1 to 3 were made on days 1 to 3, all before the cutoff; the
    // point's own (3) stays.
    assertEquals(report.prunedTxns, 2);
    assertEquals(txnRows(path), ["txn-3"]);
    assertEquals(
      store.checkMark({
        cursor: 3,
        commit: {
          namespace: "",
          partition: modelPartition().toString(),
          seq: 3,
          txnId: "txn-3",
        },
      }),
      "match",
    );
    // Commit 3 is no longer the point; commit 4, made on day 4, is newer
    // than the cutoff; commit 5 is the point.
    await store.compactHistory(5, {
      pruneTxnsBefore: new Date(T0 + 3.5 * DAY),
    });
    assertEquals(txnRows(path), ["txn-4", "txn-5"]);
  });
});

Deno.test("SqliteCommitStore.compactHistory: reports prunedTxns only when pruning was asked for", async () => {
  await withStore(async (store, path) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    const report = await store.compactHistory(2);
    assertEquals(report, { point: 2, compacted: 2, batches: 1, released: 0 });
    assertEquals(txnRows(path), ["txn-1", "txn-2"]);
  });
});

Deno.test("SqliteCommitStore: a schema 4 store migrates, and its compacted txnIds count from the migration", async () => {
  await withStore(async (store, path) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    await store.compactHistory(2);
    await store.close();
    // Back to what schema 4 held.
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE compacted_txn_times");
    db.exec("DROP TABLE compaction_point_commit");
    db.exec("DROP INDEX compacted_txns_by_seq");
    db.exec("PRAGMA user_version=4");
    db.close();
    const reopened = SqliteCommitStore.open(path);
    try {
      const migrated = new DatabaseSync(path, { readOnly: true });
      assertEquals(
        (migrated.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        COMMIT_STORE_SCHEMA_VERSION,
      );
      const times = migrated.prepare(
        "SELECT committed_at FROM compacted_txn_times",
      ).all() as { committed_at: number }[];
      migrated.close();
      assertEquals(times.length, 2);
      for (const { committed_at } of times) {
        // Old commits, but timed from the migration: a retry still finds them.
        assertEquals(Math.abs(committed_at - Date.now()) < 60_000, true);
      }
      // With no point commit recorded, pruning past them all keeps nothing
      // it cannot judge: the next batch records the point first.
      const report = await reopened.compactHistory(3, {
        pruneTxnsBefore: new Date(Date.now() + DAY),
      });
      assertEquals(report.prunedTxns, 2);
      assertEquals(txnRows(path), ["txn-3"]);
    } finally {
      await reopened.close();
    }
  });
});
