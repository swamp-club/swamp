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

// The store's behaviour on a real commits.db is tested in
// integration/sqlite_commit_store_test.ts; these cover what it refuses before
// it touches the filesystem, and truncation to a published high-water mark
// (swamp-club#3482) on a temp commits.db.

import {
  assertEquals,
  assertGreater,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { leaseOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  blobPut,
  deleteVersion,
  MODEL_TYPE,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  CommitStoreTruncateRefusedError,
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "./sqlite_commit_store.ts";

/** A path that is never created: open refuses before opening it. */
const NEVER_OPENED = join("never", "created", "commits.db");

Deno.test("SqliteCommitStore.open: refuses a cache size that is not a positive integer", () => {
  for (const cachedPartitions of [0, -1, 1.5, Number.NaN]) {
    assertThrows(
      () => SqliteCommitStore.open(NEVER_OPENED, { cachedPartitions }),
      Error,
      "cachedPartitions must be a positive integer",
    );
  }
});

Deno.test("SqliteCommitStore.open: refuses a snapshot interval that is not a positive integer", () => {
  for (const snapshotInterval of [0, -3, 2.5, Infinity]) {
    assertThrows(
      () => SqliteCommitStore.open(NEVER_OPENED, { snapshotInterval }),
      Error,
      "snapshotInterval must be a positive integer",
    );
  }
});

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
async function save(seq: number, namespace = ""): Promise<Commit> {
  return modelCommit(
    seq,
    [await savePut("a", seq), versionOp("a", seq)],
    { fence: 1, namespace },
  );
}

/** Another model's partition, which only lease ops are written to here. */
function otherPartition(): PartitionKey {
  return partitionOf({
    kind: "model",
    type: MODEL_TYPE,
    id: "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b",
  });
}

/** A lease-only commit raising the other partition's fence to `fence`. */
function leaseCommit(seq: number, fence: number): Commit {
  return modelCommit(seq, [leaseOp({ holder: "serve", fence })], {
    partition: otherPartition(),
    fence,
    txnId: `lease-${seq}`,
  });
}

/** A 64-hex digest made of one repeated character. */
function hash(char: string): string {
  return char.repeat(64);
}

/** Content stored as one chunk, keyed by its own digest. */
const ONE_CHUNK = BlobRef.create({ sha256: hash("a"), size: 10 });
/** Content stored as two chunks, sharing chunk `d` with {@link OTHER_TWO}. */
const TWO_CHUNKS = BlobRef.create({
  sha256: hash("b"),
  size: 3,
  parts: [{ sha256: hash("c"), size: 1 }, { sha256: hash("d"), size: 2 }],
});
const OTHER_TWO = BlobRef.create({
  sha256: hash("f"),
  size: 3,
  parts: [{ sha256: hash("d"), size: 2 }, { sha256: hash("e"), size: 1 }],
});

/** Rows of `table`, read behind the store's back. */
function rawRows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function chunkRefs(path: string): Record<string, unknown>[] {
  return rawRows(
    path,
    "SELECT namespace, sha256, refs FROM chunk_refs ORDER BY namespace, sha256",
  );
}

Deno.test("SqliteCommitStore.highWaterMark: is cursor 0 on an empty store", async () => {
  await withStore((store) => {
    assertEquals(store.highWaterMark(), { cursor: 0 });
    return Promise.resolve();
  });
});

Deno.test("SqliteCommitStore.highWaterMark: names the last stored commit", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    await store.append(leaseCommit(1, 2));
    await store.append(await save(2));
    assertEquals(store.highWaterMark(), {
      cursor: 3,
      commit: {
        namespace: "",
        partition: modelPartition().toString(),
        seq: 2,
        txnId: "txn-2",
      },
    });
    // A refused append rolls back its insert; the mark does not move.
    await assertRejects(() => save(5).then((c) => store.append(c)));
    assertEquals(store.highWaterMark().cursor, 3);
  });
});

Deno.test("SqliteCommitStore.highWaterMark: is the compaction point once every commit is compacted", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    await store.compactHistory(2);
    assertEquals(store.highWaterMark().cursor, 3);
    assertEquals(store.highWaterMark().commit?.seq, 3);
    await store.compactHistory(3);
    assertEquals(store.highWaterMark(), { cursor: 3 });
  });
});

Deno.test("SqliteCommitStore.oldestStoredCommitAt: is the oldest commit above the compaction point", async () => {
  await withStore(async (store, path) => {
    assertEquals(await store.oldestStoredCommitAt(), null);
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    const atOf = (cursor: number) =>
      rawRows(path, `SELECT at FROM commits WHERE cursor = ${cursor}`)[0].at;
    assertEquals(await store.oldestStoredCommitAt(), atOf(1));
    await store.compactHistory(1);
    assertEquals(await store.oldestStoredCommitAt(), atOf(2));
    await store.compactHistory(3);
    assertEquals(await store.oldestStoredCommitAt(), null);
  });
});

Deno.test("SqliteCommitStore.checkMark: matches the store's own mark and any earlier commit", async () => {
  await withStore(async (store) => {
    assertEquals(store.checkMark({ cursor: 0 }), "match");
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    assertEquals(store.checkMark(store.highWaterMark()), "match");
    assertEquals(store.checkMark({ cursor: 0 }), "match");
    assertEquals(store.checkMark({ cursor: 2 }), "match");
    assertEquals(
      store.checkMark({
        cursor: 2,
        commit: {
          namespace: "",
          partition: modelPartition().toString(),
          seq: 2,
          txnId: "txn-2",
        },
      }),
      "match",
    );
  });
});

Deno.test("SqliteCommitStore.checkMark: a mismatch when the commit at the cursor differs or the store is behind", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    const commit = {
      namespace: "",
      partition: modelPartition().toString(),
      seq: 2,
      txnId: "txn-2",
    };
    assertEquals(
      store.checkMark({ cursor: 2, commit: { ...commit, txnId: "other" } }),
      "mismatch",
    );
    assertEquals(
      store.checkMark({ cursor: 2, commit: { ...commit, seq: 3 } }),
      "mismatch",
    );
    assertEquals(
      store.checkMark({ cursor: 2, commit: { ...commit, namespace: "acme" } }),
      "mismatch",
    );
    // The store misses an acknowledged commit.
    assertEquals(store.checkMark({ cursor: 4 }), "mismatch");
    assertEquals(store.checkMark({ cursor: 0, commit }), "mismatch");
  });
});

Deno.test("SqliteCommitStore.checkMark: compacted-past when compaction passed the mark, a match at the point by txnId", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 4; seq++) await store.append(await save(seq));
    await store.compactHistory(2);
    const commit = {
      namespace: "",
      partition: modelPartition().toString(),
      seq: 2,
      txnId: "txn-2",
    };
    assertEquals(store.checkMark({ cursor: 1 }), "compacted-past");
    assertEquals(store.checkMark({ cursor: 0 }), "compacted-past");
    assertEquals(store.checkMark({ cursor: 2, commit }), "match");
    assertEquals(
      store.checkMark({ cursor: 2, commit: { ...commit, seq: 1 } }),
      "mismatch",
    );
    await store.compactHistory(4);
    // Every commit compacted: the point is the store's position.
    assertEquals(store.checkMark({ cursor: 4 }), "match");
    assertEquals(store.checkMark({ cursor: 5 }), "mismatch");
  });
});

Deno.test("SqliteCommitStore.checkMark: refuses a mark that is not a cursor", async () => {
  await withStore((store) => {
    for (const cursor of [-1, 1.5, Number.NaN]) {
      assertThrows(() => store.checkMark({ cursor }), Error, "cursor");
    }
    return Promise.resolve();
  });
});

Deno.test("SqliteCommitStore.truncateAfter: removes the commits past the mark and keeps heads, snapshots and chunk refs consistent", async () => {
  await withTempDir(async (dir) => {
    const options = { snapshotInterval: 2 };
    const truncated = join(dir, "truncated.db");
    const reference = join(dir, "reference.db");
    const prefix = async () => [
      modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], { fence: 1 }),
      leaseCommit(1, 2),
      modelCommit(2, [await blobPut("y", 1, TWO_CHUNKS)], { fence: 1 }),
    ];
    const suffix = async () => [
      modelCommit(3, [await blobPut("z", 1, OTHER_TWO)], { fence: 1 }),
      leaseCommit(2, 5),
      modelCommit(4, [await blobPut("w", 1, ONE_CHUNK)], { fence: 1 }),
      modelCommit(1, [await blobPut("x", 1, TWO_CHUNKS)], {
        namespace: "acme",
        fence: 1,
      }),
    ];

    const store = SqliteCommitStore.open(truncated, options);
    try {
      for (const commit of await prefix()) await store.append(commit);
      const mark = store.highWaterMark();
      for (const commit of await suffix()) await store.append(commit);
      assertEquals(
        rawRows(truncated, "SELECT seq FROM partition_snapshots WHERE seq = 4")
          .length,
        1,
      );
      assertEquals(await store.truncateAfter(mark), { removed: 4 });
      assertEquals(store.highWaterMark(), mark);
      assertEquals(await store.head("", modelPartition()), {
        seq: 2,
        highestFence: 1,
      });
      assertEquals(await store.head("", otherPartition()), {
        seq: 1,
        highestFence: 2,
      });
      assertEquals(await store.head("acme", modelPartition()), {
        seq: 0,
        highestFence: undefined,
      });
      assertEquals(
        (await store.changesSince(0, 100)).map((c) => c.commit.txnId),
        ["txn-1", "lease-1", "txn-2"],
      );
      // Chunks only the removed commits named are released.
      assertEquals(
        rawRows(
          truncated,
          "SELECT namespace, sha256 FROM released_chunks ORDER BY namespace, sha256",
        ),
        [
          { namespace: "", sha256: hash("e") },
          { namespace: "acme", sha256: hash("c") },
          { namespace: "acme", sha256: hash("d") },
        ],
      );
    } finally {
      await store.close();
    }

    const expected = SqliteCommitStore.open(reference, options);
    try {
      for (const commit of await prefix()) await expected.append(commit);
    } finally {
      await expected.close();
    }
    const tables = [
      "SELECT namespace, partition, seq, highest_fence FROM partition_heads ORDER BY namespace, partition",
      "SELECT namespace, partition, seq, body FROM partition_snapshots ORDER BY namespace, partition",
      "SELECT namespace, sha256, refs FROM chunk_refs ORDER BY namespace, sha256",
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits ORDER BY cursor",
    ];
    for (const sql of tables) {
      assertEquals(rawRows(truncated, sql), rawRows(reference, sql), sql);
    }
  });
});

Deno.test("SqliteCommitStore.truncateAfter: later appends continue each partition's seq at cursors past the removed ones", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    await store.append(await save(2));
    const mark = store.highWaterMark();
    await store.append(await save(3));
    await store.append(await save(4));
    // The cached partition is at seq 4; truncation drops it.
    await store.truncateAfter(mark);
    // Seq 3 again, with a version the removed commits never used.
    assertEquals(
      await store.append(
        modelCommit(3, [await savePut("a", 5), versionOp("a", 5)], {
          fence: 1,
        }),
      ),
      { kind: "appended", seq: 3 },
    );
    const changes = await store.changesSince(0, 100);
    assertEquals(changes.map((c) => c.cursor), [1, 2, 5]);
    assertGreater(store.highWaterMark().cursor, 4);
    // A removed commit is gone: its txnId is new again.
    assertEquals(
      (await store.readPartition("", modelPartition(), 3, 10)).length,
      1,
    );
  });
});

Deno.test("SqliteCommitStore.truncateAfter: a cursor-0 mark empties the store", async () => {
  await withStore(async (store, path) => {
    await store.append(
      modelCommit(1, [await blobPut("x", 1, TWO_CHUNKS)], { fence: 1 }),
    );
    await store.append(leaseCommit(1, 3));
    assertEquals(await store.truncateAfter({ cursor: 0 }), { removed: 2 });
    assertEquals(store.highWaterMark(), { cursor: 0 });
    assertEquals(await store.changesSince(0, 10), []);
    assertEquals(rawRows(path, "SELECT * FROM partition_heads"), []);
    assertEquals(rawRows(path, "SELECT * FROM partition_snapshots"), []);
    assertEquals(chunkRefs(path), []);
    assertEquals(await store.append(await save(1)), {
      kind: "appended",
      seq: 1,
    });
    assertEquals((await store.changesSince(0, 10))[0].cursor, 3);
  });
});

Deno.test("SqliteCommitStore.truncateAfter: refuses a mark compaction passed, or a mismatched one, and changes nothing", async () => {
  await withStore(async (store, path) => {
    for (let seq = 1; seq <= 4; seq++) await store.append(await save(seq));
    await store.compactHistory(2);
    const before = rawRows(path, "SELECT cursor, body FROM commits");
    const refusals: [
      Parameters<SqliteCommitStore["truncateAfter"]>[0],
      string,
    ][] = [
      [{ cursor: 1 }, "compacted-past"],
      [{ cursor: 7 }, "mismatch"],
      [{
        cursor: 3,
        commit: {
          namespace: "",
          partition: modelPartition().toString(),
          seq: 3,
          txnId: "zombie",
        },
      }, "mismatch"],
    ];
    for (const [mark, reason] of refusals) {
      const error = await assertRejects(
        () => store.truncateAfter(mark),
        CommitStoreTruncateRefusedError,
      );
      assertEquals(error.reason, reason);
    }
    assertEquals(rawRows(path, "SELECT cursor, body FROM commits"), before);
    // The queue is not wedged by a refusal.
    assertEquals(await store.truncateAfter({ cursor: 3 }), { removed: 1 });
  });
});

Deno.test("SqliteCommitStore.truncateAfter: compacted-past when a compacted partition's snapshot is past the mark", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
    await store.compactHistory(1);
    const mark = store.highWaterMark();
    // Seq 4 writes the partition's only snapshot past the mark; its state at
    // seq 3 cannot be rebuilt without the compacted seq 1.
    await store.append(await save(4));
    assertEquals(store.checkMark(mark), "compacted-past");
    const error = await assertRejects(
      () => store.truncateAfter(mark),
      CommitStoreTruncateRefusedError,
    );
    assertEquals(error.reason, "compacted-past");
  }, { snapshotInterval: 4 });
});

Deno.test("SqliteCommitStore.truncateAfter: puts back the snapshot an append would have left when the last one is past the mark", async () => {
  await withTempDir(async (dir) => {
    const options = { snapshotInterval: 2 };
    const reference = join(dir, "reference.db");
    const expected = SqliteCommitStore.open(reference, options);
    try {
      for (let seq = 1; seq <= 3; seq++) await expected.append(await save(seq));
    } finally {
      await expected.close();
    }
    const snapshots =
      "SELECT namespace, partition, seq, body FROM partition_snapshots";

    const truncated = join(dir, "truncated.db");
    const store = SqliteCommitStore.open(truncated, options);
    try {
      for (let seq = 1; seq <= 3; seq++) await store.append(await save(seq));
      const mark = store.highWaterMark();
      // No data version, so nothing outlives the truncation.
      await store.append(await unversioned(4));
      assertEquals(rawRows(truncated, "SELECT seq FROM partition_snapshots"), [
        { seq: 4 },
      ]);
      await store.truncateAfter(mark);
      assertEquals(
        rawRows(truncated, snapshots),
        rawRows(reference, snapshots),
      );
      assertEquals(rawRows(truncated, "SELECT seq FROM partition_snapshots"), [
        { seq: 2 },
      ]);
      assertEquals(await store.append(await save(4)), {
        kind: "appended",
        seq: 4,
      });
    } finally {
      await store.close();
    }
  });
});

Deno.test("SqliteCommitStore.truncateAfter: leaves no snapshot when the new head is below the first interval", async () => {
  await withStore(async (store, path) => {
    await store.append(await save(1));
    const mark = store.highWaterMark();
    await store.append(await unversioned(2));
    assertEquals(rawRows(path, "SELECT seq FROM partition_snapshots"), [
      { seq: 2 },
    ]);
    await store.truncateAfter(mark);
    assertEquals(rawRows(path, "SELECT seq FROM partition_snapshots"), []);
    assertEquals(await store.append(await save(2)), {
      kind: "appended",
      seq: 2,
    });
  }, { snapshotInterval: 2 });
});

Deno.test("SqliteCommitStore.truncateAfter: keeps the versions it removes from being recorded again (swamp-club#3532)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(await save(1));
      await store.append(await save(2));
      const mark = store.highWaterMark();
      await store.append(await save(3));
      await store.append(await save(4));
      await store.truncateAfter(mark);

      // A writer that lost its lease may have shared versions 3 and 4.
      assertEquals(
        await store.dataHighWater("", modelPartition(), "a"),
        4,
      );
      assertEquals(rawRows(path, "SELECT seq FROM partition_snapshots"), [
        { seq: 2 },
      ]);
      const error = await assertRejects(
        async () => store.append(await save(3)),
        CommitRejectedError,
      );
      assertEquals(error.reason, "version-reused");
    } finally {
      await store.close();
    }

    // A rebuild from the file keeps them too.
    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(
        await reopened.dataHighWater("", modelPartition(), "a"),
        4,
      );
      const error = await assertRejects(
        async () => reopened.append(await save(3)),
        CommitRejectedError,
      );
      assertEquals(error.reason, "version-reused");
      assertEquals(
        await reopened.append(
          modelCommit(3, [await savePut("a", 5), versionOp("a", 5)], {
            fence: 1,
          }),
        ),
        { kind: "appended", seq: 3 },
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore.truncateAfter: a second truncation below the first's head keeps the versions the first retained", async () => {
  await withStore(async (store) => {
    const versioned = async (seq: number, version: number) =>
      modelCommit(seq, [await savePut("a", version), versionOp("a", version)], {
        fence: 1,
      });
    await store.append(await save(1));
    await store.append(await save(2));
    const first = store.highWaterMark();
    await store.append(await save(3));
    await store.append(await save(4));
    // Versions 3 and 4 survive only in the snapshot at seq 2.
    await store.truncateAfter(first);

    await store.append(await versioned(3, 5));
    const second = store.highWaterMark();
    // Seq 4 replaces the snapshot at seq 2 with one past the next mark.
    await store.append(await versioned(4, 6));
    await store.truncateAfter(second);

    assertEquals(await store.dataHighWater("", modelPartition(), "a"), 6);
    for (const version of [3, 4, 6]) {
      const error = await assertRejects(
        async () => store.append(await versioned(4, version)),
        CommitRejectedError,
      );
      assertEquals(error.reason, "version-reused", `version ${version}`);
    }
    assertEquals(await store.append(await versioned(4, 7)), {
      kind: "appended",
      seq: 4,
    });
  }, { snapshotInterval: 2 });
});

Deno.test("SqliteCommitStore.truncateAfter: keeps the versions of a partition it removes whole", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    await store.append(await save(2));
    assertEquals(await store.truncateAfter({ cursor: 0 }), { removed: 2 });
    assertEquals((await store.head("", modelPartition())).seq, 0);
    assertEquals(await store.dataHighWater("", modelPartition(), "a"), 2);
    const error = await assertRejects(
      async () => store.append(await save(1)),
      CommitRejectedError,
    );
    assertEquals(error.reason, "version-reused");
  });
});

Deno.test("SqliteCommitStore.dataHighWater: reads a partition another connection wrote", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const reader = SqliteCommitStore.open(path);
    const writer = SqliteCommitStore.open(path);
    try {
      await reader.append(await save(1));
      assertEquals(await reader.dataHighWater("", modelPartition(), "a"), 1);
      await writer.append(await save(2));
      await writer.append(await save(3));
      // The reader's cached partition is at seq 1; the file is at seq 3.
      assertEquals(await reader.dataHighWater("", modelPartition(), "a"), 3);
      assertEquals(await reader.dataHighWater("", modelPartition(), "b"), 0);
    } finally {
      await writer.close();
      await reader.close();
    }
  });
});

Deno.test("SqliteCommitStore: a stored reuse from before version-reused still rebuilds (swamp-club#3532)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(await save(1));
      await store.append(modelCommit(2, [deleteVersion("a", 1)], { fence: 1 }));
      await store.append(await save(3));
    } finally {
      await store.close();
    }
    // Write the reuse a store accepted before swamp-club#3532: seq 3
    // re-records the removed version 1.
    const reuse = modelCommit(3, [await savePut("a", 1), versionOp("a", 1)], {
      fence: 1,
    });
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE commits SET body = ? WHERE seq = 3").run(
        JSON.stringify(reuse.toJSON()),
      );
    } finally {
      db.close();
    }

    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(
        await reopened.dataHighWater("", modelPartition(), "a"),
        1,
      );
      assertEquals(
        await reopened.append(
          modelCommit(4, [await savePut("a", 2), versionOp("a", 2)], {
            fence: 1,
          }),
        ),
        { kind: "appended", seq: 4 },
      );
    } finally {
      await reopened.close();
    }
  });
});

/** A commit at `seq` that writes a record but records no data version. */
async function unversioned(seq: number): Promise<Commit> {
  return modelCommit(seq, [await savePut("a", seq)], { fence: 1 });
}

/** Every table's rows, for comparing two stores' files. */
function allTables(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      rows[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all();
    }
    return rows;
  } finally {
    db.close();
  }
}

/** The source of a replacement: commits, chunks, compaction, a snapshot and a fence. */
async function writeSource(path: string): Promise<void> {
  const source = SqliteCommitStore.open(path, { snapshotInterval: 2 });
  try {
    await source.raiseWriterFence(1);
    for (let seq = 1; seq <= 3; seq++) {
      await source.append(
        modelCommit(seq, [await blobPut(`n${seq}`, 1, TWO_CHUNKS)], {
          fence: 1,
          txnId: `source-${seq}`,
        }),
      );
    }
    await source.append(leaseCommit(1, 4));
    await source.compactHistory(1, { fence: 4 });
    await source.raiseWriterFence(4);
    // Truncated past cursor 4: sqlite_sequence is ahead of the commits.
    await source.append(
      modelCommit(1, [await savePut("a", 1)], { namespace: "acme", fence: 4 }),
    );
    await source.truncateAfter({ cursor: 4 });
  } finally {
    await source.close();
  }
}

Deno.test("SqliteCommitStore.replaceContentFrom: the store holds exactly the restored file's content", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "restored.db");
    await writeSource(sourcePath);
    const targetPath = join(dir, "commits.db");
    const target = SqliteCommitStore.open(targetPath);
    try {
      for (let seq = 1; seq <= 6; seq++) await target.append(await save(seq));
      await target.append(
        modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], {
          namespace: "acme",
          fence: 1,
        }),
      );
      await target.replaceContentFrom(sourcePath);

      assertEquals(allTables(targetPath), allTables(sourcePath));
      const expected = SqliteCommitStore.open(sourcePath);
      try {
        assertEquals(target.highWaterMark(), expected.highWaterMark());
        assertEquals(await target.history(), await expected.history());
        assertEquals(target.writerFence(), 4);
        for (
          const [namespace, partition] of [
            ["", modelPartition()],
            ["", otherPartition()],
            ["acme", modelPartition()],
          ] as const
        ) {
          assertEquals(
            await target.head(namespace, partition),
            await expected.head(namespace, partition),
          );
        }
        const feed = (store: SqliteCommitStore) =>
          store.changesSince(1, 100).then((changes) =>
            changes.map((c) => [c.cursor, c.commit.toJSON()])
          );
        assertEquals(await feed(target), await feed(expected));
        assertEquals(
          (await target.readPartition("", modelPartition(), 2, 100)).map((
            c,
          ) => c.commit.txnId),
          ["source-2", "source-3"],
        );
      } finally {
        await expected.close();
      }

      // The cache of the old content is gone: the next append continues the
      // source's partition, at a cursor past every one the source assigned.
      assertEquals(
        await target.append(
          modelCommit(4, [await blobPut("n4", 1, ONE_CHUNK)], {
            fence: 4,
            txnId: "after",
          }),
        ),
        { kind: "appended", seq: 4 },
      );
      assertEquals(target.highWaterMark().cursor, 6);
    } finally {
      await target.close();
    }
  });
});

Deno.test("SqliteCommitStore.replaceContentFrom: another connection to the file sees the new content and appends after it", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "restored.db");
    await writeSource(sourcePath);
    const targetPath = join(dir, "commits.db");
    const target = SqliteCommitStore.open(targetPath);
    const other = SqliteCommitStore.open(targetPath);
    try {
      for (let seq = 1; seq <= 5; seq++) await other.append(await save(seq));
      // `other` has the partition cached at seq 5.
      await target.replaceContentFrom(sourcePath);
      assertEquals(await other.head("", modelPartition()), {
        seq: 3,
        highestFence: 1,
      });
      assertEquals(other.highWaterMark(), target.highWaterMark());
      assertEquals(
        await other.append(
          modelCommit(4, [await blobPut("n4", 1, ONE_CHUNK)], {
            fence: 4,
            txnId: "other-4",
          }),
        ),
        { kind: "appended", seq: 4 },
      );
      assertEquals(
        (await target.readPartition("", modelPartition(), 2, 100)).map((c) =>
          c.commit.txnId
        ),
        ["source-2", "source-3", "other-4"],
      );
      assertEquals(other.highWaterMark().cursor, 6);
    } finally {
      await other.close();
      await target.close();
    }
  });
});

Deno.test("SqliteCommitStore.replaceContentFrom: refuses a newer-schema file and changes nothing", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "restored.db");
    await writeSource(sourcePath);
    const db = new DatabaseSync(sourcePath);
    try {
      db.exec("PRAGMA user_version=999");
    } finally {
      db.close();
    }
    const targetPath = join(dir, "commits.db");
    const target = SqliteCommitStore.open(targetPath);
    try {
      for (let seq = 1; seq <= 3; seq++) await target.append(await save(seq));
      const before = allTables(targetPath);
      await assertRejects(
        () => target.replaceContentFrom(sourcePath),
        Error,
        "newer",
      );
      assertEquals(allTables(targetPath), before);
      // Not wedged, and nothing left attached.
      assertEquals(await target.append(await save(4)), {
        kind: "appended",
        seq: 4,
      });
    } finally {
      await target.close();
    }
  });
});

Deno.test("SqliteCommitStore.replaceContentFrom: an empty restored file empties the store", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "restored.db");
    SqliteCommitStore.open(sourcePath).close();
    const targetPath = join(dir, "commits.db");
    const target = SqliteCommitStore.open(targetPath);
    try {
      await target.append(
        modelCommit(1, [await blobPut("x", 1, TWO_CHUNKS)], { fence: 1 }),
      );
      await target.raiseWriterFence(2);
      await target.replaceContentFrom(sourcePath);
      assertEquals(target.highWaterMark(), { cursor: 0 });
      assertEquals(await target.changesSince(0, 10), []);
      assertEquals(await target.head("", modelPartition()), {
        seq: 0,
        highestFence: undefined,
      });
      assertEquals(target.writerFence(), undefined);
      assertEquals(chunkRefs(targetPath), []);
      assertEquals(await target.append(await save(1)), {
        kind: "appended",
        seq: 1,
      });
    } finally {
      await target.close();
    }
  });
});
