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
  assert,
  assertEquals,
  assertGreater,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { createIntent, modelRef } from "../../domain/datastore_v3/intent.ts";
import { leaseOp, putOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { DatastoreOwner } from "../../domain/datastore_v3/datastore_owner.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import {
  blobPut,
  dataKey,
  deleteVersion,
  MODEL_TYPE,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  CommitsCompactedError,
  InvalidBasePageTokenError,
} from "../../domain/datastore_v3/commit_store.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import { metadata as fixtureMetadata } from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  CommitStoreTruncateRefusedError,
  ObservedBaseStaging,
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

Deno.test("SqliteCommitStore.recordSha256: reads a record's digest as the file holds it, after another connection wrote (swamp-club#4097)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const reader = SqliteCommitStore.open(path);
    const writer = SqliteCommitStore.open(path);
    try {
      await reader.append(await save(1));
      assertEquals(
        await reader.recordSha256("", modelPartition(), dataKey("a", 1)),
        (await savePut("a", 1)).sha256,
      );
      assertEquals(
        await reader.recordSha256("", modelPartition(), dataKey("a", 2)),
        undefined,
      );
      await writer.append(await save(2));
      // The reader's cached partition is at seq 1; the file is at seq 2.
      assertEquals(
        await reader.recordSha256("", modelPartition(), dataKey("a", 2)),
        (await savePut("a", 2)).sha256,
      );
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

// Which partitions name each chunk (swamp-club#3915).

/** A put on the other partition's model of content stored as `blob`. */
function otherBlobPut(name: string, blob: BlobRef) {
  const id = "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b";
  return putOp({
    intent: createIntent({
      kind: "data.save",
      model: modelRef(MODEL_TYPE, id),
      name,
      version: 1,
    }),
    key: RecordKey.create(`data/${MODEL_TYPE.normalized}/${id}/${name}/1/raw`),
    blob,
  });
}

async function referencing(
  store: SqliteCommitStore,
  sha256: string,
  namespace = "",
): Promise<string[]> {
  return (await store.partitionsReferencing(namespace, sha256, 10)).map((
    key,
  ) => key.toString());
}

function chunkPartitions(path: string): Record<string, unknown>[] {
  return rawRows(
    path,
    "SELECT namespace, sha256, partition, refs FROM chunk_partitions ORDER BY namespace, sha256, partition",
  );
}

Deno.test("SqliteCommitStore.partitionsReferencing: an append indexes the partitions naming each chunk, per namespace", async () => {
  await withStore(async (store) => {
    const model = modelPartition().toString();
    const other = otherPartition().toString();
    await store.append(
      modelCommit(1, [await blobPut("x", 1, TWO_CHUNKS)], { fence: 1 }),
    );
    await store.append(
      modelCommit(1, [await otherBlobPut("y", OTHER_TWO)], {
        partition: otherPartition(),
        fence: 1,
      }),
    );
    await store.append(
      modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], {
        namespace: "acme",
        fence: 1,
      }),
    );
    // A chunk's own digest is not a chunk once the content has parts.
    assertEquals(await referencing(store, hash("b")), []);
    assertEquals(await referencing(store, hash("c")), [model]);
    // Shared by both partitions, listed in key order.
    assertEquals(
      await referencing(store, hash("d")),
      [model, other].sort(),
    );
    assertEquals(await referencing(store, hash("e")), [other]);
    // Namespaces are isolated.
    assertEquals(await referencing(store, hash("a")), []);
    assertEquals(await referencing(store, hash("a"), "acme"), [model]);
    assertEquals(await referencing(store, hash("d"), "acme"), []);
    // The limit bounds the answer.
    assertEquals(
      (await store.partitionsReferencing("", hash("d"), 1)).length,
      1,
    );
    await assertRejects(
      () => store.partitionsReferencing("", hash("d"), 0),
      Error,
      "limit must be a positive integer",
    );
  });
});

Deno.test("SqliteCommitStore.partitionsReferencing: compaction keeps a partition while a stored commit or base record names the chunk, and drops it after", async () => {
  await withStore(async (store, path) => {
    const model = modelPartition().toString();
    // Two commits of one partition name chunk a; the base record x then
    // holds TWO_CHUNKS.
    await store.append(
      modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], { fence: 1 }),
    );
    await store.append(
      modelCommit(2, [await blobPut("w", 1, ONE_CHUNK)], { fence: 1 }),
    );
    await store.append(
      modelCommit(3, [await blobPut("x", 1, TWO_CHUNKS)], { fence: 1 }),
    );
    assertEquals(
      chunkPartitions(path).filter((row) => row.sha256 === hash("a")),
      [{ namespace: "", sha256: hash("a"), partition: model, refs: 2 }],
    );

    // Folding commit 1: its base record x names a, and commit 2 still does.
    await store.compactHistory(1);
    assertEquals(await referencing(store, hash("a")), [model]);
    // Folding everything: x now holds TWO_CHUNKS, but w still names a.
    await store.compactHistory(3);
    assertEquals(await referencing(store, hash("a")), [model]);
    assertEquals(await referencing(store, hash("c")), [model]);
    // Deleting w's content drops the last reference to a.
    await store.append(
      modelCommit(4, [deleteVersion("w", 1)], { fence: 1 }),
    );
    await store.compactHistory(4);
    assertEquals(await referencing(store, hash("a")), []);
    assertEquals(
      chunkPartitions(path),
      [
        { namespace: "", sha256: hash("c"), partition: model, refs: 1 },
        { namespace: "", sha256: hash("d"), partition: model, refs: 1 },
      ],
    );
    // The namespace-wide count agrees.
    assertEquals(
      chunkRefs(path).map((row) => row.sha256),
      [hash("c"), hash("d")],
    );
  });
});

Deno.test("SqliteCommitStore.partitionsReferencing: a truncation drops the removed commits' references", async () => {
  await withStore(async (store) => {
    await store.append(
      modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], { fence: 1 }),
    );
    const mark = store.highWaterMark();
    await store.append(
      modelCommit(2, [await blobPut("y", 1, TWO_CHUNKS)], { fence: 1 }),
    );
    assertEquals(await referencing(store, hash("c")), [
      modelPartition().toString(),
    ]);
    await store.truncateAfter(mark);
    assertEquals(await referencing(store, hash("c")), []);
    assertEquals(await referencing(store, hash("a")), [
      modelPartition().toString(),
    ]);
  });
});

Deno.test("SqliteCommitStore: migrating a schema-7 store backfills the chunk partitions a fresh store builds (swamp-club#3915)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(
        modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], { fence: 1 }),
      );
      await store.append(
        modelCommit(2, [await blobPut("x", 1, TWO_CHUNKS)], { fence: 1 }),
      );
      await store.append(
        modelCommit(3, [await blobPut("y", 1, TWO_CHUNKS)], { fence: 1 }),
      );
      await store.append(
        modelCommit(1, [await otherBlobPut("z", OTHER_TWO)], {
          partition: otherPartition(),
          fence: 1,
        }),
      );
      await store.append(
        modelCommit(1, [await blobPut("x", 1, ONE_CHUNK)], {
          namespace: "acme",
          fence: 1,
        }),
      );
      // Fold the first two commits, so the base holds records too.
      await store.compactHistory(2);
    } finally {
      await store.close();
    }
    const built = chunkPartitions(path);
    assertGreater(built.length, 0);

    // Take the file back to schema 7, as a swamp before the index left it.
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TABLE chunk_partitions; PRAGMA user_version=7");
    } finally {
      db.close();
    }
    const migrated = SqliteCommitStore.open(path);
    await migrated.close();
    assertEquals(chunkPartitions(path), built);
    assertEquals(
      rawRows(path, "PRAGMA user_version")[0].user_version,
      COMMIT_STORE_SCHEMA_VERSION,
    );
  });
});

Deno.test("SqliteCommitStore: a store with the chunk partition index is at a schema a schema-7 swamp refuses as newer (swamp-club#3915)", () => {
  // A swamp at schema 7 appends without indexing chunk partitions, so it
  // must see the store as newer and ask to be upgraded, not write it.
  const LAST_SCHEMA_WITHOUT_CHUNK_PARTITIONS = 7;
  assertGreater(
    COMMIT_STORE_SCHEMA_VERSION,
    LAST_SCHEMA_WITHOUT_CHUNK_PARTITIONS,
  );
});

Deno.test("SqliteCommitStore.logId: minted once per log, kept across a reopen and by a copy of the file (swamp-club#4049)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    const id = store.logId();
    await store.close();
    assert(/^[0-9a-f]{32}$/.test(id), id);

    const reopened = SqliteCommitStore.open(path);
    assertEquals(reopened.logId(), id);
    await reopened.close();

    // A restored or replicated copy of the file is the same log.
    const copy = join(dir, "restored.db");
    await Deno.copyFile(path, copy);
    const restored = SqliteCommitStore.open(copy);
    assertEquals(restored.logId(), id);
    await restored.close();

    // A fresh log is another.
    const fresh = SqliteCommitStore.open(join(dir, "fresh.db"));
    assert(fresh.logId() !== id);
    await fresh.close();
  });
});

Deno.test("SqliteCommitStore.logId: a store from before log ids gets one when it migrates, at a schema a schema-8 swamp refuses as newer (swamp-club#4049)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await (SqliteCommitStore.open(path)).close();
    // Take the file back to schema 8, as a swamp before log ids left it.
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TABLE log_identity; PRAGMA user_version=8");
    } finally {
      db.close();
    }
    const migrated = SqliteCommitStore.open(path);
    const id = migrated.logId();
    await migrated.close();
    assert(/^[0-9a-f]{32}$/.test(id), id);
    assertEquals(
      rawRows(path, "PRAGMA user_version")[0].user_version,
      COMMIT_STORE_SCHEMA_VERSION,
    );
    // A swamp at schema 8 would serve this log without its id.
    assertGreater(COMMIT_STORE_SCHEMA_VERSION, 8);
  });
});

// The datastore's owner (swamp-club#4063).

function owner(address = "https://swamp.example.com"): DatastoreOwner {
  return DatastoreOwner.create({
    address,
    claimedAt: "2026-10-28T00:00:00.000Z",
    claimedAtCursor: 3,
  });
}

Deno.test("SqliteCommitStore.claimOwner: a claim is read back from the file by another connection, and a release removes it (swamp-club#4063)", async () => {
  await withStore(async (store, path) => {
    assertEquals(store.owner(), undefined);
    await store.raiseWriterFence(2);
    await store.claimOwner(2, owner("HTTPS://Swamp.Example.com:443/"));

    const other = SqliteCommitStore.open(path);
    try {
      const read = other.owner();
      assertEquals(read?.address, "https://swamp.example.com");
      assertEquals(read?.claimedAt, "2026-10-28T00:00:00.000Z");
      assertEquals(read?.claimedAtCursor, 3);
    } finally {
      await other.close();
    }

    // A second claim replaces the first.
    await store.claimOwner(2, owner("https://other.example.com"));
    assertEquals(store.owner()?.address, "https://other.example.com");

    await store.releaseOwner(2);
    assertEquals(store.owner(), undefined);
    // Releasing an unclaimed store is not an error.
    await store.releaseOwner(2);
  });
});

Deno.test("SqliteCommitStore.claimOwner: a writer below the store's fence can neither claim nor release (swamp-club#4063)", async () => {
  await withStore(async (store) => {
    await store.raiseWriterFence(5);
    await assertRejects(
      () => store.claimOwner(4, owner()),
      WriterFencedError,
    );
    assertEquals(store.owner(), undefined);

    await store.claimOwner(5, owner());
    await assertRejects(() => store.releaseOwner(4), WriterFencedError);
    assertEquals(store.owner()?.address, "https://swamp.example.com");
  });
});

Deno.test("SqliteCommitStore.claimOwner: a serve-mode copy is never claimed or released (swamp-club#4063)", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () => store.claimOwner(1, owner()),
      Error,
      "serve-mode copy",
    );
    await assertRejects(() => store.releaseOwner(1), Error, "serve-mode copy");
    assertEquals(store.owner(), undefined);
  }, { follower: true });
});

Deno.test("SqliteCommitStore.owner: a store from before owners migrates with none, at a schema a schema-9 swamp refuses as newer (swamp-club#4063)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await (SqliteCommitStore.open(path)).close();
    // Take the file back to schema 9, as a swamp before owners left it.
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TABLE datastore_owner; PRAGMA user_version=9");
    } finally {
      db.close();
    }
    const migrated = SqliteCommitStore.open(path);
    try {
      assertEquals(migrated.owner(), undefined);
    } finally {
      await migrated.close();
    }
    assertEquals(
      rawRows(path, "PRAGMA user_version")[0].user_version,
      COMMIT_STORE_SCHEMA_VERSION,
    );
    // A swamp at schema 9 would write past a claim it cannot see.
    assertGreater(COMMIT_STORE_SCHEMA_VERSION, 9);
  });
});

Deno.test("SqliteCommitStore: a store from schema 10 migrates to a schema a schema-10 swamp refuses as newer, since tombstones may expect a digest (swamp-club#4097)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await (SqliteCommitStore.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA user_version=10");
    } finally {
      db.close();
    }
    await (SqliteCommitStore.open(path)).close();
    assertEquals(
      rawRows(path, "PRAGMA user_version")[0].user_version,
      COMMIT_STORE_SCHEMA_VERSION,
    );
    // A swamp at schema 10 would call a digest-expecting tombstone corrupt.
    assertGreater(COMMIT_STORE_SCHEMA_VERSION, 10);
  });
});

Deno.test("SqliteCommitStore: a store from schema 11 migrates to a schema a schema-11 swamp refuses as newer, since snapshots may carry a lease fence (swamp-club#4121)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await (SqliteCommitStore.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA user_version=11");
    } finally {
      db.close();
    }
    await (SqliteCommitStore.open(path)).close();
    assertEquals(
      rawRows(path, "PRAGMA user_version")[0].user_version,
      COMMIT_STORE_SCHEMA_VERSION,
    );
    // A swamp at schema 11 would call a snapshot with a lease fence corrupt.
    assertGreater(COMMIT_STORE_SCHEMA_VERSION, 11);
  });
});

// Bounded txnIds in a cached partition (swamp-club#3915).

Deno.test("SqliteCommitStore: a long-cached partition holds at most a snapshot interval of txnIds and still detects older duplicates", async () => {
  await withStore(async (store) => {
    const key = modelPartition();
    for (let seq = 1; seq <= 23; seq++) {
      assertEquals(await store.append(await save(seq)), {
        kind: "appended",
        seq,
      });
      const count = store.cachedTxnIdCount("", key);
      assert(count !== undefined && count <= 5, `seq ${seq}: ${count}`);
    }
    // Restored at seq 20: three txnIds since.
    assertEquals(store.cachedTxnIdCount("", key), 3);
    // Retries of commits from below the snapshot, and from before the one
    // before it, are still duplicates.
    assertEquals(await store.append(await save(2)), {
      kind: "duplicate",
      seq: 2,
    });
    assertEquals(await store.append(await save(17)), {
      kind: "duplicate",
      seq: 17,
    });
    assertEquals(await store.append(await save(22)), {
      kind: "duplicate",
      seq: 22,
    });
    assertEquals(await store.append(await save(24)), {
      kind: "appended",
      seq: 24,
    });
  }, { snapshotInterval: 5 });
});

Deno.test("SqliteCommitStore: without the bound a cached partition keeps every txnId", async () => {
  await withStore(async (store) => {
    for (let seq = 1; seq <= 23; seq++) await store.append(await save(seq));
    assertEquals(store.cachedTxnIdCount("", modelPartition()), 23);
  }, { snapshotInterval: 5, boundTxnIds: false });
});

// Group commit (swamp-club#3915); the equivalence property is in
// sqlite_commit_store_group_commit_property_test.ts.

Deno.test("SqliteCommitStore.append: a solo append is one transaction, and a burst shares them", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    assertEquals(store.appendTransactions, 1);
    // Built before any is appended: a commit whose build finished first
    // would otherwise be appended out of order and refused as a seq gap.
    const commits = await Promise.all([2, 3, 4, 5, 6].map((seq) => save(seq)));
    const burst = await Promise.all(
      commits.map((commit) => store.append(commit)),
    );
    assertEquals(burst.map((result) => result.seq), [2, 3, 4, 5, 6]);
    // The first of the burst starts alone; the rest queue behind it.
    assert(store.appendTransactions < 6, `${store.appendTransactions}`);
  });
});

Deno.test("SqliteCommitStore.append: a refused commit in a burst fails alone", async () => {
  await withStore(async (store) => {
    await store.append(await save(1));
    const commits = [await save(2), await save(9), await save(3)];
    const settled = await Promise.allSettled(
      commits.map((commit) => store.append(commit)),
    );
    assertEquals(settled[0], {
      status: "fulfilled",
      value: { kind: "appended", seq: 2 },
    });
    assertEquals(settled[1].status, "rejected");
    assertEquals(
      ((settled[1] as PromiseRejectedResult).reason as CommitRejectedError)
        .reason,
      "seq-gap",
    );
    assertEquals(settled[2], {
      status: "fulfilled",
      value: { kind: "appended", seq: 3 },
    });
  });
});

Deno.test("SqliteCommitStore.append: a burst whose partition another connection wrote rebuilds and retries that commit alone", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const grouped = SqliteCommitStore.open(path);
    const other = SqliteCommitStore.open(path);
    try {
      await grouped.append(await save(1));
      await other.append(await save(2));
      // The grouped store's partition is at seq 1; the file is at seq 2.
      const commits = [
        leaseCommit(1, 1),
        await save(3),
        await save(4),
        leaseCommit(2, 1),
      ];
      const results = await Promise.all(
        commits.map((commit) => grouped.append(commit)),
      );
      assertEquals(results, [
        { kind: "appended", seq: 1 },
        { kind: "appended", seq: 3 },
        { kind: "appended", seq: 4 },
        { kind: "appended", seq: 2 },
      ]);
      assertEquals(await grouped.head("", modelPartition()), {
        seq: 4,
        highestFence: 1,
      });
    } finally {
      await other.close();
      await grouped.close();
    }
  });
});

// Follower mode (swamp-club#3985): a checkout's copy of serve's log, where
// serve left out commits the caller may not read.

/** The fixture model's seqs a follower saw, with holes. */
const GAPPED = [2, 5, 9, 10, 14];

Deno.test("SqliteCommitStore follower: appends gapped seqs and keeps the head at the highest one (swamp-club#3985)", async () => {
  await withStore(async (store, path) => {
    for (const seq of GAPPED) {
      assertEquals(await store.append(await save(seq)), {
        kind: "appended",
        seq,
      });
      assertEquals((await store.head("", modelPartition())).seq, seq);
    }
    assertEquals(
      rawRows(path, "SELECT seq FROM partition_heads"),
      [{ seq: 14 }],
    );
    assertEquals(
      rawRows(path, "SELECT MAX(seq) AS seq FROM commits"),
      [{ seq: 14 }],
    );
    assertEquals(
      (await store.readPartition("", modelPartition(), 1, 100)).map((c) =>
        c.commit.seq
      ),
      GAPPED,
    );
    assertEquals(
      (await store.readPartition("", modelPartition(), 6, 100)).map((c) =>
        c.commit.seq
      ),
      [9, 10, 14],
    );
    assertEquals(await store.headIdentity("", modelPartition()), {
      seq: 14,
      txnId: "txn-14",
    });
  }, { follower: true });
});

Deno.test("SqliteCommitStore follower: a retry is still a duplicate, and a seq at or below the head is refused", async () => {
  await withStore(async (store) => {
    for (const seq of GAPPED) await store.append(await save(seq));
    assertEquals(await store.append(await save(5)), {
      kind: "duplicate",
      seq: 5,
    });
    const stale = modelCommit(12, [await savePut("b", 1)], {
      fence: 1,
      txnId: "fresh",
    });
    const error = await assertRejects(
      () => store.append(stale),
      CommitRejectedError,
    );
    assertEquals(error.reason, "seq-gap");
    assertEquals((await store.head("", modelPartition())).seq, 14);
  }, { follower: true });
});

Deno.test("SqliteCommitStore: a solo store still refuses the gap a follower takes", async () => {
  await withStore(async (store) => {
    for (const seq of [2, 1, 5]) {
      if (seq === 1) {
        await store.append(await save(1));
        continue;
      }
      const commit = await save(seq);
      const error = await assertRejects(
        () => store.append(commit),
        CommitRejectedError,
      );
      assertEquals(error.reason, "seq-gap");
    }
    assertEquals((await store.head("", modelPartition())).seq, 1);
  });
});

Deno.test("SqliteCommitStore follower: snapshots on crossing each interval, and a reopened store rebuilds and appends past the gaps", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const options = { follower: true, snapshotInterval: 3 };
    const store = SqliteCommitStore.open(path, options);
    try {
      for (const seq of GAPPED) await store.append(await save(seq));
      // 2 crosses nothing; 5 crosses 3; 9 lands on 9; 10 crosses nothing;
      // 14 crosses 12. The one row is the latest.
      assertEquals(
        rawRows(path, "SELECT seq FROM partition_snapshots"),
        [{ seq: 14 }],
      );
    } finally {
      await store.close();
    }

    // The bounded txnIds came from the snapshot: earlier retries are still
    // duplicates after a reopen, and a later gapped seq appends.
    const reopened = SqliteCommitStore.open(path, options);
    try {
      assertEquals(await reopened.append(await save(9)), {
        kind: "duplicate",
        seq: 9,
      });
      assertEquals(await reopened.dataHighWater("", modelPartition(), "a"), 14);
      assertEquals(await reopened.append(await save(20)), {
        kind: "appended",
        seq: 20,
      });
      assertEquals(
        rawRows(path, "SELECT seq FROM partition_snapshots"),
        [{ seq: 20 }],
      );
    } finally {
      await reopened.close();
    }

    // A rebuild from a snapshot below gapped commits replays them.
    const fresh = SqliteCommitStore.open(path, {
      follower: true,
      snapshotInterval: 1000,
    });
    try {
      assertEquals(await fresh.append(await save(23)), {
        kind: "appended",
        seq: 23,
      });
    } finally {
      await fresh.close();
    }
    // A solo store refuses to rebuild the follower's file.
    const solo = SqliteCommitStore.open(path, { snapshotInterval: 1000 });
    try {
      await assertRejects(
        async () => await solo.append(await save(24)),
        Error,
        "seq",
      );
    } finally {
      await solo.close();
    }
  });
});

Deno.test("SqliteCommitStore follower: truncateAfter takes a partition back to the highest seq it keeps", async () => {
  await withStore(async (store, path) => {
    await store.append(await save(2));
    await store.append(await save(5));
    const mark = store.highWaterMark();
    await store.append(await save(9));
    await store.append(await save(10));
    assertEquals(
      rawRows(path, "SELECT seq FROM partition_snapshots"),
      [{ seq: 9 }],
    );
    assertEquals(await store.truncateAfter(mark), { removed: 2 });
    assertEquals((await store.head("", modelPartition())).seq, 5);
    // The snapshot past the new head went; the one put back is at a seq
    // the follower holds.
    assertEquals(
      rawRows(path, "SELECT seq FROM partition_snapshots"),
      [{ seq: 5 }],
    );
    assertEquals(await store.append(await save(7)), {
      kind: "appended",
      seq: 7,
    });
    assertEquals(
      (await store.readPartition("", modelPartition(), 1, 100)).map((c) =>
        c.commit.seq
      ),
      [2, 5, 7],
    );
  }, { follower: true, snapshotInterval: 4 });
});

Deno.test("SqliteCommitStore follower: compaction over gapped seqs keeps rebuilding and reading", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const options = { follower: true, snapshotInterval: 1000 };
    const store = SqliteCommitStore.open(path, options);
    try {
      for (const seq of GAPPED) await store.append(await save(seq));
      await store.compactHistory(2);
      assertEquals(
        (await store.readPartition("", modelPartition(), 6, 100)).map((c) =>
          c.commit.seq
        ),
        [9, 10, 14],
      );
      await assertRejects(() =>
        store.readPartition("", modelPartition(), 5, 100)
      );
    } finally {
      await store.close();
    }
    const reopened = SqliteCommitStore.open(path, options);
    try {
      assertEquals(await reopened.append(await save(5)), {
        kind: "duplicate",
        seq: 5,
      });
      assertEquals(await reopened.append(await save(17)), {
        kind: "appended",
        seq: 17,
      });
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore follower: a snapshot truncateAfter puts back is at a seq the follower holds", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const options = { follower: true, snapshotInterval: 4 };
    // Puts alone record no data versions, so the truncation retains none
    // and puts back the snapshot below the new head.
    const put = async (seq: number) =>
      modelCommit(seq, [await savePut("b", seq)], { fence: 1 });
    const store = SqliteCommitStore.open(path, options);
    try {
      await store.append(await put(2));
      await store.append(await put(5));
      await store.append(await put(6));
      const mark = store.highWaterMark();
      await store.append(await put(9));
      assertEquals(
        rawRows(path, "SELECT seq FROM partition_snapshots"),
        [{ seq: 9 }],
      );
      assertEquals(await store.truncateAfter(mark), { removed: 1 });
      assertEquals((await store.head("", modelPartition())).seq, 6);
      // The last multiple at or below 6 is 4, which the follower never
      // held: the snapshot is at 2, the seq it holds there.
      const rows = rawRows(path, "SELECT seq, body FROM partition_snapshots");
      assertEquals(rows.map((row) => row.seq), [2]);
      assertEquals(JSON.parse(String(rows[0].body)).seq, 2);
    } finally {
      await store.close();
    }
    const reopened = SqliteCommitStore.open(path, options);
    try {
      assertEquals(await reopened.append(await put(5)), {
        kind: "duplicate",
        seq: 5,
      });
      assertEquals(await reopened.append(await put(7)), {
        kind: "appended",
        seq: 7,
      });
    } finally {
      await reopened.close();
    }
  });
});

/** A staged base of the fixture model at compacted seq `seq`. */
async function stageBase(
  dir: string,
  seq: number,
  names: { name: string; highWater: number; removed?: [number, number][] }[],
  live: number[] = [],
): Promise<ObservedBaseStaging> {
  const staging = ObservedBaseStaging.create(join(dir, "staging.db"), "");
  const partition = modelPartition().toString();
  const put = await savePut("a", 1);
  staging.add([
    { kind: "partition", namespace: "", partition, seq, names },
    {
      kind: "record",
      namespace: "",
      partition,
      key: put.key.toString(),
      record: { sha256: put.sha256, content: { inline: btoa("a@1") } },
    },
    ...live.map((version) => ({
      kind: "version" as const,
      namespace: "",
      partition,
      version: {
        version,
        metadata: DataMetadataSchema.parse(fixtureMetadata("a", version)),
      },
    })),
  ]);
  return staging;
}

Deno.test("SqliteCommitStore.installObservedBase: a follower takes serve's base in place of its commits (swamp-club#4006)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path, { follower: true });
    try {
      for (const seq of [1, 2]) await store.append(await save(seq));
      const logId = store.logId();
      const staging = await stageBase(
        dir,
        7,
        [{ name: "a", highWater: 9, removed: [[2, 3], [5, 5]] }],
        [3, 4],
      );
      try {
        // Serve's point is below the copy's own cursors: the local point is
        // past every cursor the copy handed out.
        await store.installObservedBase(staging, 1);
      } finally {
        staging.close();
      }
      assertEquals(await store.compactionPoint(), 3);
      assertEquals(store.highWaterMark().cursor, 3);
      assertEquals(store.logId(), logId);
      assertEquals((await store.head("", modelPartition())).seq, 7);
      await assertRejects(
        () => store.readPartition("", modelPartition(), 7, 10),
        CommitsCompactedError,
      );
      // Serve's marks hold, and a version live in the base is not removed.
      assertEquals(await store.dataHighWater("", modelPartition(), "a"), 9);
      const base = await store.readCompactedBase(undefined, 100);
      assertEquals(base.point, 3);
      assertEquals(
        base.entries.map((entry) => entry.kind),
        ["partition", "record", "version", "version"],
      );

      // The next commit serve sends appends past the compacted seq, at a
      // cursor past the point.
      assertEquals(await store.append(await save(9)), {
        kind: "appended",
        seq: 9,
      });
      assertEquals(
        (await store.changesSince(3, 10)).map((change) => change.cursor),
        [4],
      );
    } finally {
      await store.close();
    }
    // A reopened store rebuilds the partition from the snapshot the base
    // left at its compacted seq.
    const reopened = SqliteCommitStore.open(path, { follower: true });
    try {
      assertEquals(
        await reopened.dataHighWater("", modelPartition(), "a"),
        9,
      );
      assertEquals((await reopened.head("", modelPartition())).seq, 9);
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("SqliteCommitStore.installObservedBase: only a follower loads serve's base, and a bad point is refused", async () => {
  await withTempDir(async (dir) => {
    const solo = SqliteCommitStore.open(join(dir, "solo.db"));
    const follower = SqliteCommitStore.open(join(dir, "copy.db"), {
      follower: true,
    });
    const staging = await stageBase(dir, 2, []);
    try {
      await assertRejects(
        () => solo.installObservedBase(staging, 5),
        Error,
        "only a serve-mode copy",
      );
      await assertRejects(
        () => follower.installObservedBase(staging, 0),
        Error,
        "point must be a positive integer",
      );
      assertEquals(await follower.compactionPoint(), 0);
    } finally {
      staging.close();
      await solo.close();
      await follower.close();
    }
  });
});

Deno.test("ObservedBaseStaging: one partition at two seqs is refused, and create removes a cut-off load's file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "staging.db");
    const partition = modelPartition().toString();
    const staging = ObservedBaseStaging.create(path, "");
    try {
      staging.add([{
        kind: "partition",
        namespace: "",
        partition,
        seq: 2,
        names: [],
      }]);
      assertThrows(
        () =>
          staging.add([
            { kind: "partition", namespace: "", partition, seq: 3, names: [] },
          ]),
        Error,
        "at seqs 2 and 3",
      );
      assertThrows(
        () =>
          staging.add([
            {
              kind: "partition",
              namespace: "other",
              partition,
              seq: 2,
              names: [],
            },
          ]),
        Error,
        "namespace",
      );
    } finally {
      staging.close();
    }
    const again = ObservedBaseStaging.create(path, "");
    try {
      assertEquals(
        rawRows(path, "SELECT COUNT(*) AS n FROM compacted_partitions"),
        [{ n: 0 }],
      );
    } finally {
      again.close();
    }
    ObservedBaseStaging.remove(path);
    await assertRejects(() => Deno.stat(path));
  });
});

Deno.test("SqliteCommitStore.compactedPartition: a compacted partition's seq and its names' marks now", async () => {
  await withStore(async (store) => {
    for (const seq of [1, 2, 3]) await store.append(await save(seq));
    assertEquals(
      await store.compactedPartition("", modelPartition()),
      undefined,
    );
    await store.compactHistory(2);
    assertEquals(await store.compactedPartition("", modelPartition()), {
      seq: 2,
      names: [{ name: "a", highWater: 3 }],
    });
  });
});

Deno.test("SqliteCommitStore.readCompactedBase: a token it never handed out is refused as such", async () => {
  await withStore(async (store) => {
    for (const token of ["not json", "null", '{"section":99,"key":[]}']) {
      await assertRejects(
        () => store.readCompactedBase(token, 10),
        InvalidBasePageTokenError,
      );
    }
  });
});
