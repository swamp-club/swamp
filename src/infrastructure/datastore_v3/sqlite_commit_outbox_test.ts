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
    await outbox.settle([{ namespace: "", partition: "p", txnId: "t" }]);
    await outbox.discard([{ namespace: "", partition: "p", txnId: "t" }]);
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
    await reopened.settle([outboxKeyOf(first)]);
    assertEquals(
      (await reopened.entries()).entries.map((e) => e.commit.txnId),
      ["txn-other"],
    );
    await reopened.close();
  });
});

Deno.test("SqliteCommitOutbox: a discard is fsynced and a settle is not, and later writes are fsynced again", async () => {
  await withTempDir(async (dir) => {
    const modes: number[] = [];
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"), {
      onWrite: (synchronous) => modes.push(synchronous),
    });
    const landed = modelCommit(1, [await savePut("a", 1)]);
    const failed = modelCommit(2, [await savePut("b", 1)]);
    for (const commit of [landed, failed]) {
      await outbox.prepare({
        commit,
        unitId: "u",
        base: { seq: commit.seq - 1, txnId: undefined },
      });
    }
    const FULL = 2;
    const NORMAL = 1;
    assertEquals(modes, [FULL, FULL], "a prepare is fsynced");
    modes.length = 0;
    await outbox.settle([outboxKeyOf(landed)]);
    assertEquals(modes, [NORMAL], "a lost settle is settled again");
    modes.length = 0;
    await outbox.discard([outboxKeyOf(failed)]);
    assertEquals(modes, [FULL], "a discarded failure must stay discarded");
    modes.length = 0;
    await outbox.settle([outboxKeyOf(landed)]);
    await outbox.raiseFloor(1);
    assertEquals(
      modes,
      [NORMAL, FULL],
      "a settle leaves the connection at FULL",
    );
    assertEquals(await outbox.hasEntries(), false);
    await outbox.close();
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
    await outbox.discard([outboxKeyOf(commit)]);
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
    // An upgrade, never corruption: what a swamp at schema 1 also says of a
    // schema 2 outbox (swamp-club#3564).
    assertEquals(
      (error as Error).message,
      `The v3 commit outbox at ${path} is at schema version ` +
        `${COMMIT_OUTBOX_SCHEMA_VERSION + 1}, newer than this swamp's ` +
        `${COMMIT_OUTBOX_SCHEMA_VERSION}: upgrade swamp.`,
    );
    await outbox.close();
  });
});

/**
 * An outbox file as a swamp at schema 1 left it, holding one entry with no
 * identity (swamp-club#3564).
 */
async function schemaOneOutbox(path: string): Promise<void> {
  const outbox = new SqliteCommitOutbox(path);
  await outbox.prepare({
    commit: modelCommit(1, [await savePut("a", 1)]),
    unitId: "u",
    base: { seq: 0, txnId: undefined },
  });
  await outbox.close();
  const db = new DatabaseSync(path);
  db.exec(
    "ALTER TABLE outbox_entries DROP COLUMN abandoned_at; " +
      "ALTER TABLE outbox_chain DROP COLUMN pending_fence; " +
      "ALTER TABLE outbox_entries DROP COLUMN writer_process; " +
      "ALTER TABLE outbox_entries DROP COLUMN left_at_fence; " +
      "PRAGMA user_version=1",
  );
  db.close();
}

/**
 * An outbox file as a swamp at schema 2 left it (swamp-club#3586): a chain,
 * and an entry a recovery left for its live writer.
 */
async function schemaTwoOutbox(path: string): Promise<void> {
  const outbox = new SqliteCommitOutbox(path);
  const commit = modelCommit(1, [await savePut("a", 1)]);
  await outbox.prepare({
    commit,
    unitId: "u",
    base: { seq: 0, txnId: undefined },
  });
  await outbox.recordFence(4);
  await outbox.markLeft([outboxKeyOf(commit)], 4);
  await outbox.close();
  const db = new DatabaseSync(path);
  db.exec(
    "ALTER TABLE outbox_entries DROP COLUMN abandoned_at; " +
      "ALTER TABLE outbox_chain DROP COLUMN pending_fence; " +
      "PRAGMA user_version=2",
  );
  db.close();
}

function schemaOf(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
  } finally {
    db.close();
  }
}

Deno.test("SqliteCommitOutbox: a schema 1 outbox migrates to 2, its entries read as prepared by no identity (swamp-club#3564)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    await schemaOneOutbox(path);
    const outbox = new SqliteCommitOutbox(path);
    try {
      const { entries } = await outbox.entries();
      assertEquals(entries.length, 1);
      assertEquals(entries[0].writerProcess, undefined);
      assertEquals(entries[0].leftAtFence, undefined);
      assertEquals(schemaOf(path), COMMIT_OUTBOX_SCHEMA_VERSION);
      assertEquals(entries[0].abandonedAt, undefined);
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: a read alone migrates a schema 1 outbox", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    await schemaOneOutbox(path);
    const outbox = new SqliteCommitOutbox(path);
    try {
      assertEquals(await outbox.hasEntries(), true);
      assertEquals(schemaOf(path), COMMIT_OUTBOX_SCHEMA_VERSION);
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: a schema 2 outbox migrates to the current schema, keeping its left marks and chain, nothing abandoned (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    await schemaTwoOutbox(path);
    const outbox = new SqliteCommitOutbox(path);
    try {
      const { entries } = await outbox.entries();
      assertEquals(entries.length, 1);
      assertEquals(entries[0].leftAtFence, 4);
      assertEquals(entries[0].abandonedAt, undefined);
      assertEquals(await outbox.chain(), {
        lastFence: 4,
        chainStart: 4,
        floor: 0,
      });
      assertEquals(schemaOf(path), COMMIT_OUTBOX_SCHEMA_VERSION);
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: abandon marks entries durably, and a prepare again clears the mark (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    const modes: number[] = [];
    const outbox = new SqliteCommitOutbox(path, {
      clock: () => new Date(5_000),
      onWrite: (synchronous) => modes.push(synchronous),
    });
    try {
      const commit = modelCommit(1, [await savePut("a", 1)]);
      const preparation = {
        commit,
        unitId: "u",
        base: { seq: 0, txnId: undefined },
      };
      await outbox.prepare(preparation);
      modes.length = 0;
      await outbox.abandon([outboxKeyOf(commit)]);
      assertEquals(modes, [2]);
      assertEquals((await outbox.entries()).entries[0].abandonedAt, 5_000);
      await outbox.prepare(preparation);
      assertEquals(
        (await outbox.entries()).entries[0].abandonedAt,
        undefined,
      );
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: a noted fence whose record was lost continues the chain (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    try {
      await outbox.notePendingFence(1);
      await outbox.recordFence(1, { replicated: true });
      // Fence 2 noted, then its writer died before the record.
      await outbox.notePendingFence(2);
      await outbox.notePendingFence(3);
      assertEquals(
        await outbox.recordFence(3, { replicated: true }),
        { lastFence: 3, chainStart: 1, floor: 0 },
      );
      // A stale lower note never lowers it.
      await outbox.notePendingFence(2);
      // Fence 4 was never noted here: another copy's, while replicating.
      assertEquals(
        await outbox.recordFence(5, { replicated: true }),
        { lastFence: 5, chainStart: 5, floor: 0 },
      );
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: another copy's fence, then this copy's noted fence whose record was lost, still restarts the chain while replicating (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    try {
      await outbox.notePendingFence(1);
      await outbox.recordFence(1, { replicated: true });
      // Another copy takes fence 2 and replicates; this copy's writer at 3
      // notes it, raises it and dies before the record.
      await outbox.notePendingFence(3);
      await outbox.notePendingFence(4);
      assertEquals(
        await outbox.recordFence(4, { replicated: true }),
        { lastFence: 4, chainStart: 4, floor: 0 },
      );
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: a recorded fence clears its note, so a stale note never outlives recreated lease records (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    try {
      assertEquals(await outbox.chain(), undefined);
      await outbox.notePendingFence(10);
      assertEquals(await outbox.chain(), undefined, "a note is no chain");
      await outbox.recordFence(10, { replicated: true });
      // The lease records are recreated: the chain restarts at 1 and climbs
      // back to 9.
      for (let fence = 1; fence <= 9; fence++) {
        await outbox.notePendingFence(fence);
        await outbox.recordFence(fence, { replicated: true });
      }
      // Another copy takes 10; this copy's next fence is 11.
      await outbox.notePendingFence(11);
      assertEquals(
        await outbox.recordFence(11, { replicated: true }),
        { lastFence: 11, chainStart: 11, floor: 0 },
      );
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: the first fence of a copy, noted and its record lost, is still the chain's (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    try {
      await outbox.notePendingFence(1);
      await outbox.notePendingFence(2);
      assertEquals(
        await outbox.recordFence(2, { replicated: true }),
        { lastFence: 2, chainStart: 1, floor: 0 },
      );
    } finally {
      await outbox.close();
    }
  });
  // A copy whose first fence is not 1: other copies took the ones before.
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    try {
      await outbox.notePendingFence(5);
      await outbox.notePendingFence(6);
      assertEquals(
        await outbox.recordFence(6, { replicated: true }),
        { lastFence: 6, chainStart: 5, floor: 0 },
      );
    } finally {
      await outbox.close();
    }
  });
});

Deno.test("SqliteCommitOutbox: records the preparing process's identity, and a left mark until the entry is prepared again", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "outbox.db");
    const process = { host: "h#pid:[1]", bootId: "b", startTime: "t" };
    const outbox = new SqliteCommitOutbox(path, {
      writerProcess: () => Promise.resolve(process),
    });
    try {
      const commit = modelCommit(1, [await savePut("a", 1)]);
      const preparation = {
        commit,
        unitId: "u",
        base: { seq: 0, txnId: undefined },
      };
      await outbox.prepare(preparation);
      await outbox.markLeft([outboxKeyOf(commit)], 4);
      // A second mark keeps the first recovery's fence.
      await outbox.markLeft([outboxKeyOf(commit)], 5);
      let [entry] = (await outbox.entries()).entries;
      assertEquals([entry.writerProcess, entry.leftAtFence], [process, 4]);
      await outbox.prepare(preparation);
      [entry] = (await outbox.entries()).entries;
      assertEquals(entry.leftAtFence, undefined);
    } finally {
      await outbox.close();
    }
  });
});

// Grouped prepares (swamp-club#3915).

Deno.test("SqliteCommitOutbox.prepare: prepares made together share one fsynced transaction", async () => {
  await withTempDir(async (dir) => {
    const modes: number[] = [];
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"), {
      onWrite: (synchronous) => modes.push(synchronous),
    });
    const commits = await Promise.all(
      [1, 2, 3, 4].map(async (seq) =>
        modelCommit(seq, [await savePut("a", seq)])
      ),
    );
    await Promise.all(commits.map((commit) =>
      outbox.prepare({
        commit,
        unitId: "u",
        base: { seq: commit.seq - 1, txnId: undefined },
      })
    ));
    assertEquals(modes, [2], "one FULL transaction for the burst");
    assertEquals(
      (await outbox.entries()).entries.map((entry) => entry.commit.seq),
      [1, 2, 3, 4],
    );
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox.prepare: a failing prepare in a group fails alone", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    const good = modelCommit(1, [await savePut("a", 1)]);
    const other = modelCommit(2, [await savePut("a", 2)]);
    // A commit whose body cannot be written: its prepare throws mid-group.
    const broken = Object.create(other, {
      txnId: { value: "txn-broken" },
      toJSON: {
        value: () => {
          throw new Error("cannot serialise");
        },
      },
    }) as typeof other;
    const settled = await Promise.allSettled(
      [good, broken, other].map((commit) =>
        outbox.prepare({
          commit,
          unitId: "u",
          base: { seq: 0, txnId: undefined },
        })
      ),
    );
    assertEquals(settled.map((s) => s.status), [
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    assertEquals(
      (await outbox.entries()).entries.map((entry) => entry.commit.txnId),
      ["txn-1", "txn-2"],
    );
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox.prepare: a write made while prepares wait sees them first", async () => {
  await withTempDir(async (dir) => {
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
    const commit = modelCommit(1, [await savePut("a", 1)]);
    const prepared = outbox.prepare({
      commit,
      unitId: "u",
      base: { seq: 0, txnId: undefined },
    });
    // Let the prepare reach the group before the discard is made.
    await Promise.resolve();
    const discarded = outbox.discard([outboxKeyOf(commit)]);
    await prepared;
    await discarded;
    assertEquals(await outbox.hasEntries(), false);
    await outbox.close();
  });
});

Deno.test("SqliteCommitOutbox.prepare: ungrouped prepares each write their own transaction", async () => {
  await withTempDir(async (dir) => {
    const modes: number[] = [];
    const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"), {
      onWrite: (synchronous) => modes.push(synchronous),
      groupPrepares: false,
    });
    const commits = await Promise.all(
      [1, 2, 3].map(async (seq) => modelCommit(seq, [await savePut("a", seq)])),
    );
    await Promise.all(commits.map((commit) =>
      outbox.prepare({
        commit,
        unitId: "u",
        base: { seq: commit.seq - 1, txnId: undefined },
      })
    ));
    assertEquals(modes, [2, 2, 2]);
    await outbox.close();
  });
});
