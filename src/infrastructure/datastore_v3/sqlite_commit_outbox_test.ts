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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import {
  OUTBOX_SWEEP_STALE_MS,
  outboxKeyOf,
} from "../../domain/datastore_v3/commit_outbox.ts";
import {
  blobPut,
  modelCommit,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  COMMIT_OUTBOX_SCHEMA_NEWER_CODE,
  COMMIT_OUTBOX_SCHEMA_VERSION,
  SqliteCommitOutbox,
} from "./sqlite_commit_outbox.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-commit-outbox-" });
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

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function blobOf(hash: string): BlobRef {
  return BlobRef.create({ sha256: hash, size: 10 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("SqliteCommitOutbox: reads see an outbox nothing wrote as empty, and create no file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    const outbox = new SqliteCommitOutbox(path);
    assertEquals(await outbox.entries(), { entries: [], unreadable: [] });
    assertEquals(await outbox.hasEntries(), false);
    assertEquals(await outbox.chain(), undefined);
    assertEquals(await outbox.referencedChunks("", [HASH_A]), new Set());
    assertEquals(await outbox.sweepState(0), { epoch: 0, active: false });
    await outbox.remove([{ namespace: "", partition: "p", txnId: "t" }]);
    await outbox.raiseFloor(3);
    assertEquals(await exists(path), false);
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox: a prepared entry survives a reopen, and a re-prepare keeps its sequence and creation time", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    let now = 1_000;
    const outbox = new SqliteCommitOutbox(path, { clock: () => new Date(now) });
    const first = modelCommit(1, [await savePut("a", 1)], { fence: 2 });
    await outbox.prepare({
      commit: first,
      unitId: "u1",
      base: { seq: 0, txnId: undefined },
    });
    const other = modelCommit(1, [await savePut("b", 1)], {
      txnId: "txn-other",
      fence: 2,
    });
    await outbox.prepare({
      commit: other,
      unitId: "u2",
      base: { seq: 0, txnId: undefined },
    });
    now = 5_000;
    // A seq-gap rebuild prepares again with its new base.
    const rebuilt = modelCommit(2, first.ops, { txnId: "txn-1", fence: 2 });
    await outbox.prepare({
      commit: rebuilt,
      unitId: "u1",
      base: { seq: 1, txnId: "txn-other" },
    });
    await outbox.close();

    const reopened = new SqliteCommitOutbox(path);
    const { entries, unreadable } = await reopened.entries();
    assertEquals(unreadable, []);
    assertEquals(entries.map((entry) => entry.commit.txnId), [
      "txn-1",
      "txn-other",
    ]);
    const [entry] = entries;
    assertEquals(entry.sequence, 1);
    assertEquals(entry.createdAt, 1_000);
    assertEquals(entry.base, { seq: 1, txnId: "txn-other" });
    assertEquals(entry.commit.seq, 2);
    assert(entry.commit.equals(rebuilt));
    await reopened.remove([outboxKeyOf(first)]);
    assertEquals(
      (await reopened.entries()).entries.map((e) => e.commit.txnId),
      ["txn-other"],
    );
    await reopened.close();
  });
});

Deno.test("SqliteCommitOutbox: names the chunks of its entries until they are removed", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    const commit = modelCommit(1, [await blobPut("a", 1, blobOf(HASH_A))]);
    await outbox.prepare({
      commit,
      unitId: "u",
      base: { seq: 0, txnId: undefined },
    });
    assertEquals(
      await outbox.referencedChunks("", [HASH_A, HASH_B]),
      new Set([HASH_A]),
    );
    assertEquals(await outbox.referencedChunks("other", [HASH_A]), new Set());
    // A re-prepare with other content names only that content.
    await outbox.prepare({
      commit: modelCommit(1, [await blobPut("a", 1, blobOf(HASH_B))]),
      unitId: "u",
      base: { seq: 0, txnId: undefined },
    });
    assertEquals(
      await outbox.referencedChunks("", [HASH_A, HASH_B]),
      new Set([HASH_B]),
    );
    await outbox.remove([outboxKeyOf(commit)]);
    assertEquals(await outbox.referencedChunks("", [HASH_B]), new Set());
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox: records fences as a chain and raises the floor no higher than the last fence", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    assertEquals(await outbox.recordFence(3), {
      lastFence: 3,
      chainStart: 3,
      floor: 0,
    });
    await outbox.recordFence(4);
    await outbox.raiseFloor(4);
    await outbox.raiseFloor(9);
    await outbox.raiseFloor(2);
    assertEquals(await outbox.chain(), {
      lastFence: 4,
      chainStart: 3,
      floor: 4,
    });
    assertEquals(await outbox.recordFence(7), {
      lastFence: 7,
      chainStart: 7,
      floor: 4,
    });
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox: a sweep is active until it ends or its heartbeat goes stale, and moves the epoch both ways", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    await outbox.beginSweep("s1", 100);
    assertEquals(await outbox.sweepState(100), { epoch: 1, active: true });
    assertEquals(
      await outbox.sweepState(100 + OUTBOX_SWEEP_STALE_MS),
      { epoch: 1, active: false },
      "a sweeper killed mid-sweep stops counting",
    );
    await outbox.heartbeatSweep("s1", 100 + OUTBOX_SWEEP_STALE_MS);
    assertEquals(
      await outbox.sweepState(100 + OUTBOX_SWEEP_STALE_MS),
      { epoch: 1, active: true },
    );
    // Another sweeper's end leaves this one in progress.
    await outbox.endSweep("s2");
    assertEquals((await outbox.sweepState(100)).epoch, 1);
    await outbox.endSweep("s1");
    assertEquals(await outbox.sweepState(100), { epoch: 2, active: false });
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox: lists an entry whose body no longer parses as unreadable", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    const outbox = new SqliteCommitOutbox(path);
    const commit = modelCommit(1, [await savePut("a", 1)]);
    await outbox.prepare({
      commit,
      unitId: "u",
      base: { seq: 0, txnId: undefined },
    });
    const db = new DatabaseSync(path);
    db.exec("UPDATE outbox_entries SET body = '{\"v\":3}'");
    db.close();
    const listing = await outbox.entries();
    assertEquals(listing.entries, []);
    assertEquals(listing.unreadable.map((entry) => entry.key), [
      outboxKeyOf(commit),
    ]);
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox: refuses a file written by a newer schema", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${COMMIT_OUTBOX_SCHEMA_VERSION + 1}`);
    db.close();
    const outbox = new SqliteCommitOutbox(path);
    const error = await assertRejects(() => outbox.hasEntries());
    assertEquals(
      (error as { code?: string }).code,
      COMMIT_OUTBOX_SCHEMA_NEWER_CODE,
    );
    await outbox.close();
  });
});
