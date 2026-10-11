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
import { leaseOp } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import {
  MODEL_TYPE,
  modelCommit,
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
    assertEquals(all.map((commit) => commit.seq), [1, 2, 3, 4, 5]);
    assert(all[2].equals(await save(3)));
    const tail = await store.readPartition("", modelPartition(), 3, 2);
    assertEquals(tail.map((commit) => commit.seq), [3, 4]);
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
      "version-not-increasing",
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
    assertEquals(teamA.map((commit) => commit.namespace), [
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
    assert(error instanceof Error);
    assertStringIncludes(error.message, "newer than this swamp's");
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
      assertStringIncludes(error.message, "high-water mark");
    } finally {
      await reopened.close();
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
