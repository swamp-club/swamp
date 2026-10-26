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
 * The SQLite commit store (swamp-club#3236) on a real `commits.db` in a temp
 * directory.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { CommitStoreCorruptError } from "../src/domain/datastore_v3/commit_store.ts";
import { leaseOp, putOp } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { WriterFencedError } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  blobPut,
  dataKey,
  deleteVersion,
  MODEL_TYPE,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  sha256Of,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  openCommitsDatabase,
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-commit-store-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/** Runs `fn` with a store on a fresh `commits.db`, closing it after. */
async function withStore(
  fn: (store: SqliteCommitStore, path: string) => Promise<void>,
  options: SqliteCommitStoreOptions = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path, options);
    try {
      await fn(store, path);
    } finally {
      await store.close();
    }
  });
}

/** Commit `seq` of the fixture model: saves version `seq` of data `a`. */
async function save(
  seq: number,
  overrides: Parameters<typeof modelCommit>[2] = {},
): Promise<Commit> {
  return modelCommit(
    seq,
    [await savePut("a", seq), versionOp("a", seq)],
    { fence: 1, ...overrides },
  );
}

/** Another model's partition, which only lease ops can be written to here. */
function otherPartition(): PartitionKey {
  return partitionOf({ kind: "model", type: MODEL_TYPE, id: OTHER_MODEL_ID });
}
const OTHER_MODEL_ID = "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b";

/** A lease-only commit in any partition. */
function leaseCommit(
  partition: PartitionKey,
  seq: number,
  namespace = "",
): Commit {
  return modelCommit(seq, [leaseOp({ holder: "serve", fence: seq })], {
    partition,
    namespace,
    fence: seq,
    txnId: `${namespace}-${partition}-${seq}`,
  });
}

/** Everything a store holds: every commit in cursor order, as JSON. */
async function contents(store: SqliteCommitStore) {
  const changes = await store.changesSince(0, 1_000_000);
  return changes.map((change) => ({
    cursor: change.cursor,
    commit: change.commit.toJSON(),
  }));
}

/** Rewrites a stored row's body behind the store's back. */
function editRow(path: string, seq: number, body: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE commits SET body = ? WHERE seq = ?").run(body, seq);
  } finally {
    db.close();
  }
}

Deno.test("SqliteCommitStore: appends commits and reads them back in seq order", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 5; seq++) {
      assertEquals(await store.append(await save(seq)), {
        kind: "appended",
        seq,
      });
    }
    const all = await store.readPartition("", modelPartition(), 1, 100);
    assertEquals(all.map((change) => change.commit.seq), [1, 2, 3, 4, 5]);
    assert(all[2].commit.equals(await save(3)));
    const tail = await store.readPartition("", modelPartition(), 3, 2);
    assertEquals(tail.map((change) => change.commit.seq), [3, 4]);
    assertEquals(await store.head("", modelPartition()), {
      seq: 5,
      highestFence: 1,
    });
  });
});

Deno.test("SqliteCommitStore: a partition never written has seq 0 and no fence", async () => {
  await withStore(async (store) => {
    assertEquals(await store.head("", modelPartition()), {
      seq: 0,
      highestFence: undefined,
    });
    assertEquals(await store.readPartition("", modelPartition(), 1, 10), []);
    assertEquals(await store.changesSince(0, 10), []);
  });
});

Deno.test("SqliteCommitStore: every refusal is the domain error and writes nothing", async () => {
  // A partition-mismatch refusal cannot arise through the store: it routes
  // each commit to the partition the commit names.
  const refusals: [string, () => Promise<Commit>][] = [
    ["seq-gap", () => save(4)],
    ["stale-fence", () => save(3, { fence: 0 })],
    ["unfenced", () => save(3, { fence: undefined })],
    [
      "expect-failed",
      async () =>
        modelCommit(3, [await savePut("a", 2, "again", "absent")], {
          fence: 1,
        }),
    ],
    [
      "version-live",
      () => Promise.resolve(modelCommit(3, [versionOp("a", 2)], { fence: 1 })),
    ],
  ];
  for (const [reason, build] of refusals) {
    await withStore(async (store) => {
      await store.append(await save(1));
      await store.append(await save(2));
      const before = await contents(store);
      const headBefore = await store.head("", modelPartition());

      const error = await assertRejects(
        async () => await store.append(await build()),
        CommitRejectedError,
      );
      assertEquals(error.reason, reason);
      assertEquals(await contents(store), before);
      assertEquals(await store.head("", modelPartition()), headBefore);

      // The partition still takes its next commit.
      assertEquals(await store.append(await save(3)), {
        kind: "appended",
        seq: 3,
      });
    });
  }
});

Deno.test("SqliteCommitStore: a retried txnId returns the seq it landed at and writes nothing", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    await store.append(await save(2));
    const before = await contents(store);
    assertEquals(await store.append(await save(1)), {
      kind: "duplicate",
      seq: 1,
    });
    // A retry carries the txnId alone as its identity, whatever its seq.
    assertEquals(
      await store.append(await save(3, { txnId: "txn-2" })),
      { kind: "duplicate", seq: 2 },
    );
    assertEquals(await contents(store), before);
  });
});

Deno.test("SqliteCommitStore: concurrent appends in one process serialize", async () => {
  await withStore(async (store) => {
    const commits = await Promise.all(
      Array.from({ length: 20 }, (_, i) => save(i + 1)),
    );
    const results = await Promise.all(
      commits.map((commit) => store.append(commit)),
    );
    assertEquals(
      results,
      commits.map((commit) => ({ kind: "appended", seq: commit.seq })),
    );

    // Two writers racing for the same seq: one lands, the other is refused.
    const racing = await Promise.allSettled([
      store.append(await save(21, { txnId: "racer-1" })),
      store.append(await save(21, { txnId: "racer-2" })),
    ]);
    assertEquals(racing[0], {
      status: "fulfilled",
      value: { kind: "appended", seq: 21 },
    });
    assert(racing[1].status === "rejected");
    assert(racing[1].reason instanceof CommitRejectedError);
    assertEquals(racing[1].reason.reason, "seq-gap");
    assertEquals((await store.head("", modelPartition())).seq, 21);
  });
});

Deno.test("SqliteCommitStore: a reopened store keeps its commits, heads and cursor", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const first = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 3; seq++) await first.append(await save(seq));
    await first.append(leaseCommit(otherPartition(), 1));
    const before = await contents(first);
    await first.close();

    const second = SqliteCommitStore.open(path);
    try {
      assertEquals(await contents(second), before);
      assertEquals((await second.head("", modelPartition())).seq, 3);
      assertEquals(await second.append(await save(1)), {
        kind: "duplicate",
        seq: 1,
      });
      assertEquals(await second.append(await save(4)), {
        kind: "appended",
        seq: 4,
      });
      const after = await contents(second);
      assertEquals(after.slice(0, before.length), before);
      assert(after[after.length - 1].cursor > before[before.length - 1].cursor);
    } finally {
      await second.close();
    }
  });
});

Deno.test("SqliteCommitStore: the change cursor is complete and ordered from every position", async () => {
  await withStore(async (store) => {
    const appended: Commit[] = [];
    const add = async (commit: Commit) => {
      await store.append(commit);
      appended.push(commit);
    };
    // Interleave two namespaces and two partitions.
    for (let seq = 1; seq <= 4; seq++) {
      await add(await save(seq));
      await add(leaseCommit(otherPartition(), seq));
      await add(leaseCommit(modelPartition(), seq, "team-a"));
    }

    const all = await store.changesSince(0, 1000);
    assertEquals(
      all.map((change) => change.commit.toJSON()),
      appended.map((commit) => commit.toJSON()),
    );
    for (let i = 1; i < all.length; i++) {
      assert(all[i].cursor > all[i - 1].cursor);
    }
    for (const [index, change] of [{ cursor: 0 }, ...all].entries()) {
      const rest = await store.changesSince(change.cursor, 1000);
      assertEquals(rest, all.slice(index));
    }
    // Paging by limit visits every change once.
    const paged = [];
    let cursor = 0;
    while (true) {
      const page = await store.changesSince(cursor, 5);
      if (page.length === 0) break;
      paged.push(...page);
      cursor = page[page.length - 1].cursor;
    }
    assertEquals(paged, all);
  });
});

Deno.test("SqliteCommitStore: a partition read gives each commit its change feed position", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 3; seq++) {
      await store.append(await save(seq));
      await store.append(leaseCommit(otherPartition(), seq));
      await store.append(leaseCommit(modelPartition(), seq, "team-a"));
    }
    const feed = await store.changesSince(0, 1000);
    for (
      const [namespace, partition] of [
        ["", modelPartition()],
        ["", otherPartition()],
        ["team-a", modelPartition()],
      ] as const
    ) {
      const read = await store.readPartition(namespace, partition, 1, 1000);
      assertEquals(
        read,
        feed.filter((change) =>
          change.commit.namespace === namespace &&
          change.commit.partition.equals(partition)
        ),
      );
      const tail = await store.readPartition(namespace, partition, 2, 1);
      assertEquals(tail, [read[1]]);
    }
  });
});

Deno.test("SqliteCommitStore: namespaces with the same partition key are independent", async () => {
  await withStore(async (store) => {
    assertEquals(await store.append(await save(1)), {
      kind: "appended",
      seq: 1,
    });
    assertEquals(await store.append(await save(1, { namespace: "team-a" })), {
      kind: "appended",
      seq: 1,
    });
    assertEquals(await store.append(await save(2, { namespace: "team-a" })), {
      kind: "appended",
      seq: 2,
    });
    assertEquals((await store.head("", modelPartition())).seq, 1);
    assertEquals((await store.head("team-a", modelPartition())).seq, 2);
    const teamA = await store.readPartition("team-a", modelPartition(), 1, 10);
    assertEquals(teamA.map((change) => change.commit.namespace), [
      "team-a",
      "team-a",
    ]);
  });
});

Deno.test("SqliteCommitStore: a lease op raises the head's highest fence", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    await store.append(
      modelCommit(2, [leaseOp({ holder: "serve-2", fence: 7 })], { fence: 1 }),
    );
    assertEquals(await store.head("", modelPartition()), {
      seq: 2,
      highestFence: 7,
    });
  });
});

Deno.test("SqliteCommitStore: opens with WAL, synchronous FULL and the default auto-checkpoint", async () => {
  await withTempDir((dir) => {
    const db = openCommitsDatabase(join(dir, "commits.db"));
    try {
      const pragma = (name: string) =>
        Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
      assertEquals(pragma("journal_mode"), "wal");
      // 2 is FULL.
      assertEquals(pragma("synchronous"), 2);
      assertEquals(pragma("wal_autocheckpoint"), 1000);
      assertEquals(pragma("user_version"), COMMIT_STORE_SCHEMA_VERSION);
      assert((pragma("busy_timeout") as number) > 0);
    } finally {
      db.close();
    }
  });
});

Deno.test("SqliteCommitStore: a replicated store never checkpoints its own WAL (swamp-club#3935)", async () => {
  // Past SQLite's 1000-frame auto-checkpoint: each commit writes the commits
  // table and its indexes.
  const commits = 600;
  const mainFileGrowth = async (options: SqliteCommitStoreOptions) => {
    let growth = 0;
    await withStore(async (store, path) => {
      const before = (await Deno.stat(path)).size;
      for (let seq = 1; seq <= commits; seq++) {
        await store.append(leaseCommit(otherPartition(), seq));
      }
      growth = (await Deno.stat(path)).size - before;
    }, options);
    return growth;
  };
  // Only Litestream may move frames into the file of a replicated copy.
  assertEquals(await mainFileGrowth({ replicated: true }), 0);
  assert(await mainFileGrowth({}) > 0);
});

Deno.test("SqliteCommitStore: a replicated store turns auto-checkpoint off", async () => {
  await withTempDir((dir) => {
    const db = openCommitsDatabase(join(dir, "commits.db"), {
      replicated: true,
    });
    try {
      assertEquals(
        (db.prepare("PRAGMA wal_autocheckpoint").get() as {
          wal_autocheckpoint: number;
        }).wal_autocheckpoint,
        0,
      );
    } finally {
      db.close();
    }
  });
});

Deno.test("SqliteCommitStore: refuses a database from a newer schema", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "commits.db");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${COMMIT_STORE_SCHEMA_VERSION + 1}`);
    db.close();
    let error: unknown;
    try {
      SqliteCommitStore.open(path);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof UserError);
    assertStringIncludes(error.message, "newer than this swamp's");
    assertEquals(error.code, "datastore_v3_schema_newer");
  });
});

Deno.test("SqliteCommitStore: a store whose snapshots carry removed versions is at a schema older swamps refuse (swamp-club#3532)", async () => {
  // Schema 5 is the last whose Partition.restore rejects a snapshot's
  // `removed` field as unknown, so a swamp at 5 must see a newer schema and
  // ask to be upgraded, not report the store corrupt.
  const LAST_SCHEMA_WITHOUT_REMOVED = 5;
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path, { snapshotInterval: 2 });
    try {
      await store.append(await save(1));
      await store.append(modelCommit(2, [deleteVersion("a", 1)], { fence: 1 }));
    } finally {
      await store.close();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const { body } = db.prepare(
        "SELECT body FROM partition_snapshots",
      ).get() as { body: string };
      assertEquals(JSON.parse(body).names[0].removed, [[1, 1]]);
      const { user_version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      assertEquals(user_version, COMMIT_STORE_SCHEMA_VERSION);
      assert(user_version > LAST_SCHEMA_WITHOUT_REMOVED);
    } finally {
      db.close();
    }
  });
});

Deno.test("SqliteCommitStore: a put's file access survives the commit body and the compacted base, at a schema older swamps refuse (swamp-club#3693)", async () => {
  // Schema 6 is the last whose opFromJSON rejects a put's `access` field as
  // unknown, so a swamp at 6 must see a newer schema and ask to be
  // upgraded, not report the store corrupt.
  const LAST_SCHEMA_WITHOUT_ACCESS = 6;
  await withStore(async (store, path) => {
    const blob = BlobRef.create({ sha256: "b".repeat(64), size: 9000 });
    const inline = await savePut("x", 1);
    const ops = [
      await putOp({
        intent: inline.intent,
        key: inline.key,
        inline: (inline.content as { inline: string }).inline,
        access: "executable",
      }),
      await putOp({
        intent: modelIntent({ kind: "data.save", name: "p", version: 1 }),
        key: dataKey("p", 1),
        blob,
        access: "private",
      }),
      await savePut("plain", 1),
    ];
    await store.append(modelCommit(1, ops));
    const [change] = await store.changesSince(0, 10);
    assertEquals(
      change.commit.ops.map((op) => op.kind === "put" ? op.access : "?"),
      ["executable", "private", undefined],
    );
    await store.compactHistory(1);
    const records = new Map(
      (await store.readCompactedBase(undefined, 100)).entries.flatMap((
        entry,
      ) => entry.kind === "record" ? [[entry.key, entry.record]] : []),
    );
    assertEquals(records.get(dataKey("x", 1).toString())?.access, "executable");
    assertEquals(records.get(dataKey("p", 1).toString())?.access, "private");
    assertEquals(
      "access" in records.get(dataKey("plain", 1).toString())!,
      false,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const { user_version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      assertEquals(user_version, COMMIT_STORE_SCHEMA_VERSION);
      assert(user_version > LAST_SCHEMA_WITHOUT_ACCESS);
    } finally {
      db.close();
    }
  });
});

Deno.test("SqliteCommitStore: a store rolled back to schema 6 still holding the access column migrates again (swamp-club#3693)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await SqliteCommitStore.open(path).close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=6");
    db.close();
    const store = SqliteCommitStore.open(path);
    await store.close();
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(
        (check.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        COMMIT_STORE_SCHEMA_VERSION,
      );
    } finally {
      check.close();
    }
  });
});

Deno.test("SqliteCommitStore: notices a write from another connection", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const a = SqliteCommitStore.open(path);
    const b = SqliteCommitStore.open(path);
    try {
      await a.append(await save(1));
      // b rebuilds from the file, sees seq 1, and appends seq 2 behind a's
      // back.
      await b.append(await save(2));
      // a's cached partition is at seq 1; the head check makes it rebuild
      // rather than refuse seq 3 as a gap.
      assertEquals(await a.append(await save(3)), {
        kind: "appended",
        seq: 3,
      });
      assertEquals((await a.head("", modelPartition())).seq, 3);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

Deno.test("SqliteCommitStore: an evicted partition is rebuilt from the file", async () => {
  await withStore(async (store) => {
    const third = partitionOf({
      kind: "model",
      type: MODEL_TYPE,
      id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
    });
    await store.append(await save(1));
    await store.append(leaseCommit(otherPartition(), 1));
    assertEquals(store.cachedPartitionCount, 2);
    // The cache holds two partitions, so this evicts the fixture model's.
    await store.append(leaseCommit(third, 1));
    assertEquals(store.cachedPartitionCount, 2);
    assertEquals(await store.append(await save(1)), {
      kind: "duplicate",
      seq: 1,
    });
    assertEquals(await store.append(await save(2)), {
      kind: "appended",
      seq: 2,
    });
    await assertRejects(
      async () => await store.append(await save(2, { txnId: "late" })),
      CommitRejectedError,
    );
    assertEquals(await store.append(leaseCommit(otherPartition(), 2)), {
      kind: "appended",
      seq: 2,
    });
    assertEquals(store.cachedPartitionCount, 2);
  }, { cachedPartitions: 2 });
});

Deno.test("SqliteCommitStore: snapshots a partition every interval and rebuilds from it", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const first = SqliteCommitStore.open(path, { snapshotInterval: 3 });
    for (let seq = 1; seq <= 7; seq++) await first.append(await save(seq));
    await first.close();

    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT seq FROM partition_snapshots").get() as {
      seq: number;
    };
    db.close();
    assertEquals(row.seq, 6);

    // Break a commit the snapshot covers: a rebuild that starts from the
    // snapshot never reads it.
    editRow(path, 2, "{");
    const second = SqliteCommitStore.open(path, { snapshotInterval: 3 });
    try {
      assertEquals(await second.append(await save(2)), {
        kind: "duplicate",
        seq: 2,
      });
      assertEquals(await second.append(await save(8)), {
        kind: "appended",
        seq: 8,
      });
    } finally {
      await second.close();
    }
  });
});

Deno.test("SqliteCommitStore: a damaged row or snapshot is reported as corruption, not a refusal", async () => {
  // An unparseable body.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    editRow(path, 2, "{");
    const reopened = SqliteCommitStore.open(path);
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertEquals(error.seq, 2);
      assertEquals(error.partition, modelPartition().toString());
      await assertRejects(
        () => reopened.readPartition("", modelPartition(), 1, 10),
        CommitStoreCorruptError,
      );
    } finally {
      await reopened.close();
    }
  });

  // A body that parses but breaks a rule against the commits before it.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    const reused = modelCommit(2, [versionOp("a", 1)], {
      fence: 1,
      txnId: "txn-2",
    });
    editRow(path, 2, JSON.stringify(reused.toJSON()));
    const reopened = SqliteCommitStore.open(path);
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertEquals(error.seq, 2);
      assertStringIncludes(error.message, "already live");
    } finally {
      await reopened.close();
    }
  });

  // A body whose txnId is not the row's.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    editRow(
      path,
      2,
      JSON.stringify((await save(2, { txnId: "other" })).toJSON()),
    );
    const reopened = SqliteCommitStore.open(path);
    try {
      const error = await assertRejects(
        () => reopened.readPartition("", modelPartition(), 1, 10),
        CommitStoreCorruptError,
      );
      assertEquals(error.seq, 2);
      assertStringIncludes(error.message, "txnId other");
    } finally {
      await reopened.close();
    }
  });

  // A head row behind its commits.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM partition_heads");
    db.close();
    const reopened = SqliteCommitStore.open(path);
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertStringIncludes(error.message, "head row");
    } finally {
      await reopened.close();
    }
  });

  // A head row ahead of its commits.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE partition_heads SET seq = 5");
    db.close();
    const reopened = SqliteCommitStore.open(path);
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertStringIncludes(error.message, "commits end at seq 2");
    } finally {
      await reopened.close();
    }
  });

  // A snapshot row whose seq is not the seq its body holds.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path, { snapshotInterval: 2 });
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE partition_snapshots SET seq = 1");
    db.close();
    const reopened = SqliteCommitStore.open(path, { snapshotInterval: 2 });
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertStringIncludes(error.message, "snapshot row is for seq 1");
    } finally {
      await reopened.close();
    }
  });

  // A commit row deleted under a store that has the partition cached.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(await save(1));
      const db = new DatabaseSync(path);
      db.exec("DELETE FROM commits");
      db.close();
      const error = await assertRejects(
        async () => await store.append(await save(1)),
        CommitStoreCorruptError,
      );
      assertStringIncludes(error.message, "no stored commit carries it");
    } finally {
      await store.close();
    }
  });

  // A damaged snapshot.
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path, { snapshotInterval: 2 });
    for (let seq = 1; seq <= 2; seq++) await store.append(await save(seq));
    await store.close();
    const db = new DatabaseSync(path);
    db.exec(`UPDATE partition_snapshots SET body = '{"v":1}'`);
    db.close();
    const reopened = SqliteCommitStore.open(path, { snapshotInterval: 2 });
    try {
      const error = await assertRejects(
        async () => await reopened.append(await save(3)),
        CommitStoreCorruptError,
      );
      assertStringIncludes(error.message, "snapshot");
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore: close lets queued appends finish, then every call rejects", async () => {
  await withTempDir(async (dir) => {
    const store = SqliteCommitStore.open(join(dir, "commits.db"));
    const commits = await Promise.all([1, 2, 3].map((seq) => save(seq)));
    const pending = commits.map((commit) => store.append(commit));
    await store.close();
    assertEquals(
      (await Promise.all(pending)).map((result) => result.seq),
      [1, 2, 3],
    );
    await assertRejects(() => store.append(commits[0]), Error, "closed");
    await assertRejects(
      () => store.head("", modelPartition()),
      Error,
      "closed",
    );
    await assertRejects(
      () => store.readPartition("", modelPartition(), 1, 10),
      Error,
      "closed",
    );
    await assertRejects(() => store.changesSince(0, 10), Error, "closed");
    await store.close();
  });
});

Deno.test("SqliteCommitStore: refuses invalid read bounds", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () => store.readPartition("", modelPartition(), 0, 10),
      Error,
      "fromSeq",
    );
    await assertRejects(
      () => store.readPartition("", modelPartition(), 1, 0),
      Error,
      "limit",
    );
    await assertRejects(() => store.changesSince(-1, 10), Error, "cursor");
  });
});

Deno.test("SqliteCommitStore: stores each commit's digest-free JSON", async () => {
  await withStore(async (store, path) => {
    await store.append(await save(1));
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare(
        "SELECT namespace, partition, seq, txn_id, fence, at, body FROM commits",
      ).get() as Record<string, unknown>;
      const body = JSON.parse(row.body as string);
      assertEquals(body, (await save(1)).toJSON());
      assertEquals(
        [row.namespace, row.partition, row.seq, row.txn_id, row.fence, row.at],
        ["", modelPartition().toString(), 1, "txn-1", 1, body.at],
      );
      // The inline put's digest is recomputed on read, never stored.
      assert(!(row.body as string).includes(await sha256Of("a@1")));
    } finally {
      db.close();
    }
  });
});

/** A 64-hex-character digest made of one repeated character. */
function hash(char: string): string {
  return char.repeat(64);
}

/** Content stored as one chunk, keyed by its own digest. */
const ONE_CHUNK = BlobRef.create({ sha256: hash("a"), size: 10 });
/** Content stored as two chunks; its whole digest names no chunk. */
const TWO_CHUNKS = BlobRef.create({
  sha256: hash("b"),
  size: 3,
  parts: [{ sha256: hash("c"), size: 1 }, { sha256: hash("d"), size: 2 }],
});
const EVERY_HASH = [..."abcdef"].map(hash);

/** The `chunk_refs` rows, read behind the store's back. */
function chunkRefRows(path: string): { namespace: string; sha256: string }[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(
      "SELECT namespace, sha256 FROM chunk_refs ORDER BY namespace, sha256",
    ).all() as unknown as { namespace: string; sha256: string }[];
  } finally {
    db.close();
  }
}

Deno.test("SqliteCommitStore: indexes the chunks each put names, and no inline content", async () => {
  await withStore(async (store) => {
    await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
    await store.append(
      modelCommit(2, [
        await blobPut("y", 1, TWO_CHUNKS),
        await savePut("z", 1),
      ]),
    );
    assertEquals(
      [...await store.referencedChunks("", EVERY_HASH)].sort(),
      [hash("a"), hash("c"), hash("d")],
    );
    // The partition key is the same in another namespace; its refs are not.
    assertEquals(await store.referencedChunks("acme", EVERY_HASH), new Set());
    await store.append(
      modelCommit(1, [await blobPut("w", 1, TWO_CHUNKS)], {
        namespace: "acme",
      }),
    );
    assertEquals(
      [...await store.referencedChunks("acme", EVERY_HASH)].sort(),
      [hash("c"), hash("d")],
    );
    assertEquals(await store.referencedChunks("", []), new Set());
  });
});

Deno.test("SqliteCommitStore: a chunk stays referenced after its record is overwritten or deleted", async () => {
  await withStore(async (store) => {
    await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
    await store.append(modelCommit(2, [await savePut("x", 1, "replaced")]));
    await store.append(modelCommit(3, [deleteVersion("x", 1)]));
    assertEquals(
      await store.referencedChunks("", [hash("a")]),
      new Set([hash("a")]),
    );
  });
});

Deno.test("SqliteCommitStore: a refused or repeated append indexes nothing", async () => {
  await withStore(async (store, path) => {
    await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
    const refused = modelCommit(3, [await blobPut("y", 1, TWO_CHUNKS)]);
    await assertRejects(() => store.append(refused), CommitRejectedError);
    const retried = modelCommit(1, [await blobPut("y", 1, TWO_CHUNKS)]);
    assertEquals(await store.append(retried), { kind: "duplicate", seq: 1 });
    assertEquals(chunkRefRows(path), [{ namespace: "", sha256: hash("a") }]);
  });
});

Deno.test("SqliteCommitStore: looks up more hashes than one query takes", async () => {
  await withStore(async (store) => {
    await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
    const many = Array.from(
      { length: 1200 },
      (_, i) => i.toString(16).padStart(64, "0"),
    );
    many.push(hash("a"));
    assertEquals(await store.referencedChunks("", many), new Set([hash("a")]));
  });
});

Deno.test("SqliteCommitStore: migrating a schema-1 database backfills the same index a fresh store builds", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
      await store.append(
        modelCommit(2, [
          await blobPut("y", 1, TWO_CHUNKS),
          await savePut("z", 1),
          versionOp("z", 1),
        ]),
      );
      await store.append(
        modelCommit(1, [await blobPut("w", 1, ONE_CHUNK)], {
          namespace: "acme",
        }),
      );
      await store.append(leaseCommit(otherPartition(), 1));
    } finally {
      await store.close();
    }
    const fresh = chunkRefRows(path);
    assertEquals(fresh.length, 4);

    // Schema 1 is schema 2 without the index: take it back to version 1.
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE chunk_refs; PRAGMA user_version=1");
    db.close();

    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(chunkRefRows(path), fresh);
      assertEquals(
        [...await reopened.referencedChunks("", EVERY_HASH)].sort(),
        [hash("a"), hash("c"), hash("d")],
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore: referencedChunks rejects once the store is closed", async () => {
  await withTempDir(async (dir) => {
    const store = SqliteCommitStore.open(join(dir, "commits.db"));
    await store.close();
    await assertRejects(
      () => store.referencedChunks("", [hash("a")]),
      Error,
      "closed",
    );
  });
});

Deno.test("SqliteCommitStore: migrating a schema-1 database skips a damaged commit body, which is still reported on rebuild", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)]));
      await store.append(modelCommit(2, [await blobPut("y", 1, TWO_CHUNKS)]));
    } finally {
      await store.close();
    }
    editRow(path, 2, "{not json");
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE chunk_refs; PRAGMA user_version=1");
    db.close();

    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(
        await reopened.referencedChunks("", EVERY_HASH),
        new Set([hash("a")]),
      );
      await assertRejects(
        () => reopened.readPartition("", modelPartition(), 1, 10),
        CommitStoreCorruptError,
      );
    } finally {
      await reopened.close();
    }
  });
});

// --- The store-wide writer fence (swamp-club#3359) ---

Deno.test("SqliteCommitStore: a raised writer fence refuses lower-fenced and unfenced commits on every partition", async () => {
  await withStore(async (store) => {
    assertEquals(store.writerFence(), undefined);
    // No fence yet: an unfenced commit lands, as on a Phase 3 datastore.
    assertEquals(
      (await store.append(await save(1, { fence: undefined }))).kind,
      "appended",
    );
    await store.raiseWriterFence(2);
    assertEquals(store.writerFence(), 2);

    const unfenced = await assertRejects(
      async () => await store.append(await save(2, { fence: undefined })),
      WriterFencedError,
    );
    assertEquals(unfenced.code, "datastore_v3_writer_fenced");
    await assertRejects(
      async () => await store.append(await save(2, { fence: 1 })),
      WriterFencedError,
    );
    // A partition the current writer never wrote is fenced too.
    await assertRejects(
      () =>
        store.append(
          modelCommit(1, [leaseOp({ holder: "zombie", fence: 1 })], {
            partition: otherPartition(),
            fence: 1,
            txnId: "zombie-1",
          }),
        ),
      WriterFencedError,
    );

    // The refusals left the partition as it was: seq 2 is still free.
    assertEquals(
      (await store.append(await save(2, { fence: 2 }))).kind,
      "appended",
    );
    assertEquals((await store.head("", modelPartition())).seq, 2);
    assertEquals((await store.head("", otherPartition())).seq, 0);
  });
});

Deno.test("SqliteCommitStore: only a raise moves the writer fence, and a lower raise is refused", async () => {
  await withStore(async (store) => {
    await store.raiseWriterFence(1);
    await store.append(await save(1, { fence: 3 }));
    assertEquals(store.writerFence(), 1, "a commit never raises it");
    await store.raiseWriterFence(3);
    assertEquals(store.writerFence(), 3);
    await assertRejects(() => store.raiseWriterFence(2), WriterFencedError);
    // Raising to the same fence again is a no-op.
    await store.raiseWriterFence(3);
    assertEquals(store.writerFence(), 3);
  });
});

Deno.test("SqliteCommitStore: the writer fence survives a reopen", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    await store.raiseWriterFence(5);
    await store.close();
    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(reopened.writerFence(), 5);
      await assertRejects(
        async () => await reopened.append(await save(1, { fence: 4 })),
        WriterFencedError,
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore: a Phase 3 commits.db keeps its unfenced history, and its first fence starts fencing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    // A schema 3 store with unfenced commits, as Phase 3 wrote it.
    const phase3 = SqliteCommitStore.open(path);
    await phase3.append(await save(1, { fence: undefined }));
    await phase3.append(await save(2, { fence: undefined }));
    await phase3.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE writer_fence");
    db.exec("PRAGMA user_version=3");
    db.close();

    const store = SqliteCommitStore.open(path);
    try {
      assertEquals(store.writerFence(), undefined);
      assertEquals((await store.head("", modelPartition())).seq, 2);
      await store.raiseWriterFence(1);
      assertEquals(
        (await store.append(await save(3, { fence: 1 }))).kind,
        "appended",
      );
      // A partition that never saw a fence still refuses an unfenced commit:
      // the store has one.
      await assertRejects(
        () =>
          store.append(
            modelCommit(1, [leaseOp({ holder: "old", fence: 1 })], {
              partition: otherPartition(),
              fence: undefined,
              txnId: "unfenced-1",
            }),
          ),
        WriterFencedError,
      );
      const changes = await store.changesSince(0, 10);
      assertEquals(changes.map((change) => change.commit.fence), [
        undefined,
        undefined,
        1,
      ]);
    } finally {
      await store.close();
    }
  });
});

Deno.test("SqliteCommitStore: a compaction by a writer whose fence is below the store's is refused", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 3; seq++) {
      await store.append(await save(seq, { fence: 2 }));
    }
    await store.raiseWriterFence(3);
    await assertRejects(
      () => store.compactHistory(2, { fence: 2 }),
      WriterFencedError,
    );
    await assertRejects(() => store.compactHistory(2), WriterFencedError);
    const report = await store.compactHistory(2, { fence: 3 });
    assertEquals(report.compacted, 2);
  });
});
