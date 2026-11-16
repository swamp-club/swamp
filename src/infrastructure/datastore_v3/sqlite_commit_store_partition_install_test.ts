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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type { PartitionBaseRows } from "../../domain/datastore_v3/commit_store.ts";
import type { ObservedBaseEntry } from "../../domain/datastore_v3/observed_base.ts";
import { leaseOp } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import {
  deleteVersion,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { COMMIT_OUTBOX_FILE } from "./v3_datastore.ts";
import {
  CommitStoreTruncateRefusedError,
  type PartitionBaseInstall,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";

const PARTITION = modelPartition().toString();

async function withStores(
  fn: (
    serve: SqliteCommitStore,
    copy: SqliteCommitStore,
    paths: { serve: string; copy: string },
  ) => Promise<void>,
  copyOptions: { snapshotInterval?: number } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-partition-install-" });
  const paths = { serve: join(dir, "serve.db"), copy: join(dir, "copy.db") };
  const serve = SqliteCommitStore.open(paths.serve);
  const copy = SqliteCommitStore.open(paths.copy, {
    follower: true,
    ...copyOptions,
  });
  try {
    await fn(serve, copy, paths);
  } finally {
    await serve.close();
    await copy.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function rows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** what a reader of the base sees of the partition: everything but marks */
function baseOf(path: string): unknown {
  const where = `WHERE partition = '${PARTITION}'`;
  return {
    records: rows(
      path,
      `SELECT record_key, sha256, inline, blob FROM base_records ${where} ORDER BY record_key`,
    ),
    versions: rows(
      path,
      `SELECT name, version, metadata FROM base_versions ${where} ORDER BY name, version`,
    ),
    catalog: rows(
      path,
      `SELECT name, version FROM base_catalog ${where} ORDER BY name, version`,
    ),
    forwards: rows(path, `SELECT name, renamed_to FROM base_forwards ${where}`),
    files: rows(
      path,
      `SELECT record_key, owner, present FROM base_files WHERE owner = '${PARTITION}' ORDER BY record_key`,
    ),
    seq: rows(path, `SELECT seq FROM compacted_partitions ${where}`),
  };
}

async function both(
  serve: SqliteCommitStore,
  copy: SqliteCommitStore,
  commit: Commit,
): Promise<void> {
  await serve.append(commit);
  await copy.append(commit);
}

function installOf(
  read: PartitionBaseRows,
  mode: "whole" | "difference",
  readModelCursor = Number.MAX_SAFE_INTEGER,
): PartitionBaseInstall {
  return {
    namespace: "",
    partition: PARTITION,
    seq: read.seq,
    entries: read.entries as ObservedBaseEntry[],
    removed: read.removed,
    mode,
    readModelCursor,
  };
}

async function readOf(
  serve: SqliteCommitStore,
  since?: number,
  limit = 100_000,
): Promise<PartitionBaseRows> {
  const read = await serve.readBaseOfPartition("", PARTITION, since, limit);
  if (typeof read === "string") throw new Error(`base read ${read}`);
  return read;
}

async function save(name: string, version: number, seq: number) {
  return modelCommit(seq, [
    await savePut(name, version),
    versionOp(name, version),
  ], {
    fence: 1,
    txnId: `txn-${seq}`,
  });
}

function chunkSums(path: string): Record<string, unknown>[] {
  return rows(
    path,
    "SELECT r.sha256, r.refs, COALESCE((SELECT SUM(p.refs) FROM chunk_partitions AS p WHERE p.namespace = r.namespace AND p.sha256 = r.sha256), 0) AS indexed FROM chunk_refs AS r",
  ).filter((row) => Number(row.indexed) > Number(row.refs));
}

Deno.test("SqliteCommitStore.installPartitionBase: a whole install leaves the copy's base as serve's, its commits through the seq gone, and the rest still served", async () => {
  await withStores(async (serve, copy, paths) => {
    for (let seq = 1; seq <= 4; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(3);
    const outcome = await copy.installPartitionBase(
      installOf(await readOf(serve), "whole"),
    );
    assertEquals(outcome.kind, "installed");
    assertEquals(baseOf(paths.copy), baseOf(paths.serve));
    assertEquals(
      rows(paths.copy, "SELECT seq FROM commits").map((r) => r.seq),
      [4],
    );
    // every commit below the first unfolded one is in the base now
    assertEquals(await copy.compactionPoint(), 3);
    const changes = await copy.changesSince(3, 10);
    assertEquals(changes.map((c) => c.commit.seq), [4]);
    assertEquals(chunkSums(paths.copy), []);
    assertEquals(
      rows(paths.copy, "SELECT COUNT(*) AS n FROM compacted_txns")[0].n,
      3,
    );
  });
});

Deno.test("SqliteCommitStore.installPartitionBase: a difference applies only what changed, keeps commits above the latest snapshot as history-only, and the feed never serves them", async () => {
  await withStores(async (serve, copy, paths) => {
    for (let seq = 1; seq <= 3; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(3);
    await copy.installPartitionBase(installOf(await readOf(serve), "whole"));
    // another partition's commit, never installed: it holds the copy's point
    // below the history-only commits, so only the filter keeps them out
    const other = partitionOf({
      kind: "config",
      definitionKind: "model",
      name: "z",
    });
    await both(
      serve,
      copy,
      modelCommit(1, [leaseOp({ holder: "serve", fence: 1 })], {
        partition: other,
        fence: 1,
        txnId: "lease-1",
      }),
    );
    await both(
      serve,
      copy,
      modelCommit(4, [deleteVersion("a", 1)], { fence: 1, txnId: "txn-4" }),
    );
    for (let seq = 5; seq <= 7; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(7);
    const difference = await readOf(serve, 3);
    const outcome = await copy.installPartitionBase(
      installOf(difference, "difference"),
    );
    assertEquals(outcome.kind, "installed");
    assertEquals(baseOf(paths.copy), baseOf(paths.serve));
    // snapshot interval 4: the latest snapshot is at 4, so 5 and 6 stay
    assertEquals(
      rows(
        paths.copy,
        `SELECT seq FROM commits WHERE partition = '${PARTITION}' ORDER BY seq`,
      )
        .map((r) => r.seq),
      [5, 6, 7],
    );
    assertEquals(await copy.compactionPoint(), 3);
    assertEquals(
      (await copy.changesSince(3, 10)).map((c) =>
        `${
          c.commit.partition.toString() === PARTITION ? "a" : "z"
        }${c.commit.seq}`
      ),
      ["z1", "a7"],
    );
    assertEquals(chunkSums(paths.copy), []);
  }, { snapshotInterval: 4 });
});

Deno.test("SqliteCommitStore.installPartitionBase: never folds a commit the read model has not applied", async () => {
  await withStores(async (serve, copy) => {
    for (let seq = 1; seq <= 3; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(3);
    const read = await readOf(serve);
    const outcome = await copy.installPartitionBase(
      installOf(read, "whole", 2),
    );
    assertEquals(outcome, { kind: "skipped", reason: "read-model-behind" });
    assertEquals((await copy.changesSince(0, 10)).length, 3);
  });
});

Deno.test("SqliteCommitStore.installPartitionBase: skips a partition the copy has not caught up to, and a difference without a serve-sourced base", async () => {
  await withStores(async (serve, copy) => {
    for (let seq = 1; seq <= 3; seq++) {
      await serve.append(await save("a", seq, seq));
    }
    await copy.append(await save("a", 1, 1));
    await serve.compactHistory(3);
    const read = await readOf(serve);
    assertEquals(
      await copy.installPartitionBase(installOf(read, "whole")),
      { kind: "skipped", reason: "behind" },
    );
    await copy.append(await save("a", 2, 2));
    await copy.append(await save("a", 3, 3));
    assertEquals(
      await copy.installPartitionBase(installOf(read, "difference")),
      { kind: "skipped", reason: "no-source" },
    );
  });
});

Deno.test("SqliteCommitStore.compactHistory: a copy that installs serve's base by partition refuses to fold locally", async () => {
  await withStores(async (serve, copy) => {
    for (let seq = 1; seq <= 2; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(2);
    await copy.installPartitionBase(installOf(await readOf(serve), "whole"));
    await assertRejects(
      () => copy.compactHistory(2),
      Error,
      "never compacts locally",
    );
  });
});

Deno.test("SqliteCommitStore.installPartitionBase: a hot partition of 40k records (about 160k base rows) folded again and again writes only the rows that changed", async () => {
  await withStores(async (serve, copy, paths) => {
    let seq = 0;
    const commitMany = async (from: number, count: number) => {
      const ops = [];
      for (let i = from; i < from + count; i++) {
        ops.push(await savePut(`r${i}`, 1), versionOp(`r${i}`, 1));
      }
      seq++;
      await both(
        serve,
        copy,
        modelCommit(seq, ops, { fence: 1, txnId: `bulk-${seq}` }),
      );
    };
    for (let from = 0; from < 40_000; from += 2_000) {
      await commitMany(from, 2_000);
    }
    await serve.compactHistory(seq);
    // as a full base load would give it: serve's base, row for row
    const first = await copy.installPartitionBase(
      installOf(await readOf(serve, undefined, 1_000_000), "whole"),
    );
    assertEquals(first.kind, "installed");
    const records = Number(
      rows(paths.copy, "SELECT COUNT(*) AS n FROM base_records")[0].n,
    );
    assertEquals(records >= 40_000, true);
    for (let round = 0; round < 5; round++) {
      const source = seq;
      await commitMany(100_000 + round * 10, 10);
      await serve.compactHistory(seq);
      const difference = await readOf(serve, source);
      const outcome = await copy.installPartitionBase(
        installOf(difference, "difference"),
      );
      if (outcome.kind !== "installed") throw new Error(outcome.reason);
      // ten saves: a record and a version each, a catalog row, a file
      assertEquals(outcome.rows <= 10 * 5, true, `${outcome.rows} rows`);
      assertEquals(baseOf(paths.copy), baseOf(paths.serve));
    }
  });
});

Deno.test("SqliteCommitStore.truncateAfter: a follower refuses to remove a history-only commit, which the base already holds", async () => {
  await withStores(async (serve, copy) => {
    for (let seq = 1; seq <= 3; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(3);
    await copy.installPartitionBase(installOf(await readOf(serve), "whole"));
    const other = partitionOf({
      kind: "config",
      definitionKind: "model",
      name: "z",
    });
    await both(
      serve,
      copy,
      modelCommit(1, [leaseOp({ holder: "serve", fence: 1 })], {
        partition: other,
        fence: 1,
        txnId: "lease-1",
      }),
    );
    for (let seq = 4; seq <= 7; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(8);
    await copy.installPartitionBase(
      installOf(await readOf(serve, 3), "difference"),
    );
    // the lease commit holds the point at 3; commits 5 and 6 are history-only
    const error = await assertRejects(
      () => copy.truncateAfter({ cursor: 4 }),
      CommitStoreTruncateRefusedError,
    );
    assertEquals(error.reason, "compacted-past");
  }, { snapshotInterval: 4 });
});

Deno.test("SqliteCommitStore: a downgrade recipe that removes only commits.db keeps the copy's outbox entries, which a fresh store beside them does not touch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-copy-downgrade-" });
  try {
    const commitsDb = join(dir, "commits.db");
    const outboxDb = join(dir, COMMIT_OUTBOX_FILE);
    const store = SqliteCommitStore.open(commitsDb, { follower: true });
    await store.append(await save("a", 1, 1));
    await store.close();
    const outbox = new SqliteCommitOutbox(outboxDb);
    await outbox.prepare({
      commit: await save("a", 2, 2),
      unitId: "u1",
      base: { seq: 1, txnId: "txn-1" },
    });
    await outbox.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Deno.remove(`${commitsDb}${suffix}`).catch(() => {});
    }
    const fresh = SqliteCommitStore.open(commitsDb, { follower: true });
    assertEquals(fresh.highWaterMark().cursor, 0);
    await fresh.close();
    const kept = new SqliteCommitOutbox(outboxDb);
    assertEquals(
      (await kept.entries()).entries.map((e) => e.commit.txnId),
      ["txn-2"],
    );
    await kept.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("SqliteCommitStore.installStagedPartition: a hot partition staged a page at a time swaps in as serve's base in one transaction, and a difference follows it", async () => {
  await withStores(async (serve, copy, paths) => {
    let seq = 0;
    const commitMany = async (from: number, count: number) => {
      const ops = [];
      for (let i = from; i < from + count; i++) {
        ops.push(await savePut(`r${i}`, 1), versionOp(`r${i}`, 1));
      }
      seq++;
      await both(
        serve,
        copy,
        modelCommit(seq, ops, { fence: 1, txnId: `bulk-${seq}` }),
      );
    };
    for (let from = 0; from < 40_000; from += 2_000) {
      await commitMany(from, 2_000);
    }
    await serve.compactHistory(seq);
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await serve.readBaseOfPartitionPage(
        "",
        PARTITION,
        after,
        20_000,
      );
      await copy.stagePartitionPage({
        namespace: "",
        partition: PARTITION,
        seq: page.seq,
        entries: page.entries as ObservedBaseEntry[],
        next: page.next,
      });
      after = page.next;
      pages++;
    } while (after !== undefined);
    assertEquals(pages > 1, true);
    const staged = await copy.stagedPartition();
    assertEquals(staged?.complete, true);
    const outcome = await copy.installStagedPartition(Number.MAX_SAFE_INTEGER);
    assertEquals(outcome.kind, "installed");
    assertEquals(baseOf(paths.copy), baseOf(paths.serve));
    assertEquals(chunkSums(paths.copy), []);
    assertEquals(await copy.stagedPartition(), undefined);
    const source = seq;
    await commitMany(100_000, 10);
    await serve.compactHistory(seq);
    const outcome2 = await copy.installPartitionBase(
      installOf(await readOf(serve, source), "difference"),
    );
    assertEquals(outcome2.kind, "installed");
    assertEquals(baseOf(paths.copy), baseOf(paths.serve));
  });
});

Deno.test("SqliteCommitStore.stagePartitionPage: a page at another seq starts the staging over", async () => {
  await withStores(async (serve, copy) => {
    for (let s = 1; s <= 2; s++) await both(serve, copy, await save("a", s, s));
    await serve.compactHistory(1);
    const first = await serve.readBaseOfPartitionPage(
      "",
      PARTITION,
      undefined,
      1,
    );
    await copy.stagePartitionPage({
      namespace: "",
      partition: PARTITION,
      seq: first.seq,
      entries: first.entries as ObservedBaseEntry[],
      next: first.next,
    });
    assertEquals((await copy.stagedPartition())?.rows, 1);
    await serve.compactHistory(2);
    const fresh = await serve.readBaseOfPartitionPage(
      "",
      PARTITION,
      undefined,
      1,
    );
    await copy.stagePartitionPage({
      namespace: "",
      partition: PARTITION,
      seq: fresh.seq,
      entries: fresh.entries as ObservedBaseEntry[],
      next: fresh.next,
    });
    const staged = await copy.stagedPartition();
    assertEquals([staged?.seq, staged?.rows], [2, 1]);
  });
});

Deno.test("SqliteCommitStore.readBaseOfPartitionPage: a token naming the partitions section starts at the first base table rather than failing", async () => {
  await withStores(async (serve) => {
    await serve.append(await save("a", 1, 1));
    await serve.compactHistory(1);
    const token = JSON.stringify({ section: 0, key: ["", PARTITION] });
    const page = await serve.readBaseOfPartitionPage("", PARTITION, token, 10);
    assertEquals(page.entries.length > 0, true);
  });
});

Deno.test("SqliteCommitStore.readBaseIndex: answers from one read per compaction point", async () => {
  await withStores(async (serve, _copy, paths) => {
    for (let s = 1; s <= 2; s++) await serve.append(await save("a", s, s));
    await serve.compactHistory(1);
    const first = await serve.readBaseIndex("");
    // a row written behind the store's back is not seen until the point moves
    const db = new DatabaseSync(paths.serve);
    try {
      db.exec("DELETE FROM base_records");
    } finally {
      db.close();
    }
    assertEquals(await serve.readBaseIndex(""), first);
    await serve.compactHistory(2);
    assertEquals((await serve.readBaseIndex(""))[0].seq, 2);
  });
});

Deno.test("SqliteCommitStore.installPartitionBase: a whole install below the copy's newest snapshot keeps that snapshot, never rebuilding from commits a base already took", async () => {
  await withStores(async (serve, copy, paths) => {
    for (let seq = 1; seq <= 3; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    await serve.compactHistory(3);
    await copy.installPartitionBase(installOf(await readOf(serve), "whole"));
    for (let seq = 4; seq <= 9; seq++) {
      await both(serve, copy, await save("a", seq, seq));
    }
    const snapshot = () =>
      rows(
        paths.copy,
        `SELECT seq, body FROM partition_snapshots WHERE partition = '${PARTITION}'`,
      )[0] as { seq: number; body: string };
    assertEquals(snapshot().seq, 8);
    await serve.compactHistory(6);
    const outcome = await copy.installPartitionBase(
      installOf(await readOf(serve), "whole"),
    );
    assertEquals(outcome.kind, "installed");
    // the snapshot at 8 holds versions 1-3, which no stored commit holds any more
    assertEquals(snapshot().seq, 8);
    const live = (JSON.parse(snapshot().body).names as {
      name: string;
      live: number[];
    }[]).find((n) => n.name === "a")?.live;
    assertEquals(live?.includes(1), true);
    assertEquals(
      rows(
        paths.copy,
        `SELECT seq FROM commits WHERE partition = '${PARTITION}' ORDER BY seq`,
      )
        .map((r) => r.seq),
      [7, 8, 9],
    );
  }, { snapshotInterval: 4 });
});
