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
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { leaseOp } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import {
  MODEL_TYPE,
  modelCommit,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  FeedDivergedError,
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "./sqlite_commit_store.ts";

async function withStores(
  fn: (leader: SqliteCommitStore, follower: SqliteCommitStore) => Promise<
    void
  >,
  followerOptions: SqliteCommitStoreOptions = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-commit-feed-" });
  const leader = SqliteCommitStore.open(join(dir, "leader.db"));
  const follower = SqliteCommitStore.open(
    join(dir, "follower.db"),
    followerOptions,
  );
  try {
    await fn(leader, follower);
  } finally {
    await leader.close();
    await follower.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** A lease-only commit to another model's partition. */
function otherLease(seq: number): Commit {
  return modelCommit(seq, [leaseOp({ holder: "serve", fence: 1 })], {
    partition: partitionOf({
      kind: "model",
      type: MODEL_TYPE,
      id: "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b",
    }),
    fence: 1,
    txnId: `lease-${seq}`,
  });
}

async function save(seq: number, name = "a"): Promise<Commit> {
  return modelCommit(
    seq,
    [await savePut(name, seq), versionOp(name, seq)],
    { fence: 1, txnId: `txn-${name}-${seq}` },
  );
}

Deno.test("SqliteCommitStore.appendFromLeader: keeps the leader's cursors, and refuses a partition's seq gap", async () => {
  await withStores(async (leader, follower) => {
    for (let seq = 1; seq <= 3; seq++) await leader.append(await save(seq));
    const changes = await leader.changesSince(0, 10);
    await follower.appendFromLeader(changes[0]);
    // The partition is at seq 1: seq 3 cannot land before seq 2.
    await assertRejects(
      () => follower.appendFromLeader(changes[2]),
      FeedDivergedError,
    );
    await follower.appendFromLeader(changes[1]);
    await follower.appendFromLeader(changes[2]);
    const copied = await follower.changesSince(0, 10);
    assertEquals(
      copied.map((c) => [c.cursor, c.commit.txnId]),
      changes.map((c) => [c.cursor, c.commit.txnId]),
    );
  });
});

Deno.test("SqliteCommitStore.appendFromLeader: a cursor skipped by the feed still keeps later cursors", async () => {
  await withStores(async (leader, follower) => {
    await leader.append(await save(1, "a"));
    await leader.append(otherLease(1));
    await leader.append(await save(2, "a"));
    const changes = await leader.changesSince(0, 10);
    // The other partition's commit is not sent: the feed skips its cursor.
    await follower.appendFromLeader(changes[0]);
    await follower.appendFromLeader(changes[2]);
    assertEquals(
      (await follower.changesSince(0, 10)).map((c) => c.cursor),
      [changes[0].cursor, changes[2].cursor],
    );
    assertEquals(follower.highWaterMark().cursor, changes[2].cursor);
  });
});

Deno.test("SqliteCommitStore.appendFromLeader: the same commit again is a duplicate, another at a held cursor diverges", async () => {
  await withStores(async (leader, follower) => {
    await leader.append(await save(1));
    await leader.append(await save(2));
    const [first, second] = await leader.changesSince(0, 10);
    await follower.appendFromLeader(first);
    await follower.appendFromLeader(second);
    assertEquals((await follower.appendFromLeader(first)).kind, "duplicate");
    await assertRejects(
      () =>
        follower.appendFromLeader({
          cursor: first.cursor,
          commit: second.commit,
        }),
      FeedDivergedError,
      "another commit",
    );
    assertEquals(follower.highWaterMark().cursor, second.cursor);
  });
});

Deno.test("SqliteCommitStore.appendFromLeader: refuses a cursor behind the copy's", async () => {
  await withStores(async (leader, follower) => {
    await follower.append(await save(1, "local"));
    await follower.append(await save(2, "local"));
    await leader.append(await save(1));
    const [first] = await leader.changesSince(0, 10);
    await assertRejects(
      () => follower.appendFromLeader(first),
      FeedDivergedError,
    );
  });
});

Deno.test("SqliteCommitStore.appendFromLeader: refused on a serve-mode checkout's copy", async () => {
  await withStores(async (leader, follower) => {
    await leader.append(await save(1));
    const [first] = await leader.changesSince(0, 10);
    await assertRejects(
      () => follower.appendFromLeader(first),
      Error,
      "serve-mode checkout",
    );
  }, { follower: true });
});

Deno.test("SqliteCommitStore.onHeadMoved: called after an append and a leader's commit land, not after a duplicate", async () => {
  await withStores(async (leader, follower) => {
    const moved: number[] = [];
    const offLeader = leader.onHeadMoved(() =>
      moved.push(leader.highWaterMark().cursor)
    );
    const commit = await save(1);
    await leader.append(commit);
    await leader.append(commit);
    assertEquals(moved, [1]);
    offLeader();
    await leader.append(await save(2));
    assertEquals(moved, [1]);

    const seen: number[] = [];
    follower.onHeadMoved(() => seen.push(follower.highWaterMark().cursor));
    const [first] = await leader.changesSince(0, 10);
    await follower.appendFromLeader(first);
    assertEquals(seen, [first.cursor]);
  });
});

Deno.test("SqliteCommitStore.append: a serve-mode copy takes a commit another process keeps landing commits around, however often its partition goes stale (swamp-club#4207)", async () => {
  // Every CLI process reading through serve catches the same copy up from
  // serve's feed, none holding the writer lock: between this process's
  // rebuild of a stale partition and its transaction, another may land
  // more commits, more than once.
  const dir = await Deno.makeTempDir({ prefix: "swamp-commit-feed-" });
  const path = join(dir, "commits.db");
  const here = SqliteCommitStore.open(path, { follower: true });
  const other = SqliteCommitStore.open(path, { follower: true });
  try {
    const commits = await Promise.all([1, 2, 3, 4, 5, 6].map((s) => save(s)));
    await here.append(commits[0]);
    await other.append(commits[1]);
    const landing = (async () => {
      for (const commit of commits.slice(2)) await other.append(commit);
    })();
    const result = await here.append(commits[2]);
    await landing;
    assertEquals(["appended", "duplicate"].includes(result.kind), true);
    assertEquals(
      (await here.head(commits[0].namespace, commits[0].partition)).seq,
      6,
    );
  } finally {
    await here.close();
    await other.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
