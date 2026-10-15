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
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit, CommitWriter } from "../../domain/datastore_v3/commit.ts";
import type { HeadIdentity } from "../../domain/datastore_v3/commit_outbox.ts";
import {
  blobPut,
  MemoryStorage,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import {
  CommitOutboxUnreadableError,
  recoverCommitOutbox,
} from "./commit_outbox_recovery.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

const DEAD: CommitWriter = { host: "host-a", pid: 4242, instance: "dead" };
const RECOVERER: CommitWriter = { host: "host-a", pid: 7, instance: "next" };
const NOW = new Date("2026-10-15T12:00:00.000Z");

interface Fixture {
  readonly store: SqliteCommitStore;
  readonly outbox: SqliteCommitOutbox;
  readonly storage: MemoryStorage;
  readonly chunkStore: ChunkStore;
  readonly dir: string;
  /** Prepares `commit` as a dead writer at `fence` would have. */
  prepare(
    commit: Commit,
    options?: { unitId?: string; base?: HeadIdentity },
  ): Promise<void>;
  /** Takes the lease at `fence`, as a writer start does, and recovers. */
  recover(
    fence: number,
    writerAlive?: (writer: CommitWriter) => boolean,
  ): ReturnType<typeof recoverCommitOutbox>;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-outbox-recovery-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"), {
    clock: () => NOW,
  });
  const storage = new MemoryStorage();
  const chunkStore = new ChunkStore(storage);
  const fixture: Fixture = {
    store,
    outbox,
    storage,
    chunkStore,
    dir,
    async prepare(commit, options = {}) {
      await outbox.prepare({
        commit,
        unitId: options.unitId ?? "unit",
        base: options.base ??
          await store.headIdentity(commit.namespace, commit.partition),
      });
    },
    async recover(fence, writerAlive = () => false) {
      await store.raiseWriterFence(fence);
      await outbox.recordFence(fence);
      return await recoverCommitOutbox(
        { outbox, commitStore: store, chunkStore },
        { fence, writer: RECOVERER, writerAlive, clock: () => NOW },
      );
    },
  };
  try {
    await outbox.recordFence(1);
    await store.raiseWriterFence(1);
    await fn(fixture);
  } finally {
    await store.close();
    await outbox.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function commitsOf(
  store: SqliteCommitStore,
  partition = modelPartition(),
) {
  return (await store.readPartition("", partition, 1, 100)).map((change) =>
    change.commit
  );
}

function prepared(seq: number, ops: Commit["ops"], txnId: string, fence = 1) {
  return modelCommit(seq, ops, {
    txnId,
    writer: DEAD,
    fence,
    at: NOW.toISOString(),
  });
}

Deno.test("recoverCommitOutbox: lands an entry whose head is unchanged once, under the recovering writer's fence", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"));
    const report = await recover(2);
    assertEquals(report.landed, 1);
    assertEquals(report.drops, []);
    const [landed] = await commitsOf(store);
    assertEquals(landed.txnId, "t1");
    assertEquals(landed.fence, 2);
    assertEquals(landed.writer, RECOVERER);
    assertEquals(await outbox.hasEntries(), false);
    assertEquals((await outbox.chain())?.floor, 2);
    // Nothing left: a second recovery lands nothing more.
    assertEquals((await recover(3)).landed, 0);
    assertEquals((await commitsOf(store)).length, 1);
  });
});

Deno.test("recoverCommitOutbox: settles an entry whose commit landed before its writer died", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    const commit = prepared(1, [await savePut("a", 1)], "t1");
    await prepare(commit);
    await store.append(commit);
    const report = await recover(2);
    assertEquals([report.landed, report.settled], [0, 1]);
    assertEquals((await commitsOf(store)).length, 1);
    assertEquals(await outbox.hasEntries(), false);
  });
});

Deno.test("recoverCommitOutbox: drops an entry whose partition moved on, with its unit's run entry", async () => {
  await withFixture(async ({ store, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"), { unitId: "u" });
    await prepare(
      modelCommit(1, [await runPut("r")], {
        partition: runPartition(),
        txnId: "run",
        writer: DEAD,
        fence: 1,
        at: NOW.toISOString(),
      }),
      { unitId: "u" },
    );
    // Another writer committed the partition since.
    await store.append(
      modelCommit(1, [await savePut("b", 1)], { txnId: "newer", fence: 1 }),
    );
    const report = await recover(2);
    assertEquals(report.landed, 0);
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t1", "head-moved"], ["run", "unit-dropped"]],
    );
    assertEquals((await commitsOf(store)).map((c) => c.txnId), ["newer"]);
    assertEquals(await commitsOf(store, runPartition()), []);
  });
});

/** Records each settle and discard on `outbox`, as `settle:<txnId>`. */
function recordRemovals(outbox: SqliteCommitOutbox): string[] {
  const calls: string[] = [];
  const settle = outbox.settle.bind(outbox);
  const discard = outbox.discard.bind(outbox);
  outbox.settle = (keys) => {
    for (const key of keys) calls.push(`settle:${key.txnId}`);
    return settle(keys);
  };
  outbox.discard = (keys) => {
    for (const key of keys) calls.push(`discard:${key.txnId}`);
    return discard(keys);
  };
  return calls;
}

Deno.test("recoverCommitOutbox: a landed or already-landed entry settles; a dropped one is discarded durably", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    const calls = recordRemovals(outbox);
    const before = prepared(1, [await savePut("a", 1)], "landed-before");
    await prepare(before);
    await store.append(before);
    await prepare(prepared(2, [await savePut("a", 2)], "lands"));
    assertEquals(
      [(await recover(2)).landed, calls],
      [1, ["settle:landed-before", "settle:lands"]],
    );
    calls.length = 0;
    // A drop was reported: back after a power cut, a run entry dropped with
    // its unit could land alone.
    await prepare(prepared(3, [await savePut("b", 1)], "t1"), { unitId: "u" });
    await prepare(
      modelCommit(1, [await runPut("r")], {
        partition: runPartition(),
        txnId: "run",
        writer: DEAD,
        fence: 2,
        at: NOW.toISOString(),
      }),
      { unitId: "u" },
    );
    await store.append(
      modelCommit(3, [await savePut("c", 1)], { txnId: "newer", fence: 2 }),
    );
    const report = await recover(3);
    assertEquals(report.drops.length, 2);
    assertEquals(calls, ["discard:t1", "discard:run"]);
  });
});

Deno.test("recoverCommitOutbox: drops an entry another copy's lease came after, and lands nothing", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"));
    // Fence 2 was another copy's: this copy's chain restarts at 3.
    const report = await recover(3);
    assertEquals(report.drops.map((drop) => drop.reason), ["stale-fence"]);
    assertEquals(await commitsOf(store), []);
    assertEquals(await outbox.hasEntries(), false);
  });
});

Deno.test("recoverCommitOutbox: leaves a live writer's entry, and the floor drops it at the next recovery", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"));
    const report = await recover(2, (writer) => writer.instance === "dead");
    assertEquals([report.landed, report.skipped], [0, 1]);
    assertEquals(await outbox.hasEntries(), true);
    // The writer lost its lease at fence 2; the next recovery is past it.
    const next = await recover(3, (writer) => writer.instance === "dead");
    assertEquals(next.drops.map((drop) => drop.reason), ["overtaken"]);
    assertEquals(await commitsOf(store), []);
  });
});

Deno.test("recoverCommitOutbox: drops an entry whose chunks are missing rather than land it", async () => {
  await withFixture(
    async ({ store, storage, chunkStore, prepare, recover }) => {
      const signal = new AbortController().signal;
      const blob = await chunkStore.write(
        SOLO_NAMESPACE,
        new Uint8Array(200).fill(7),
        signal,
      );
      await prepare(prepared(1, [await blobPut("a", 1, blob)], "t1"));
      storage.chunks.clear();
      const report = await recover(2);
      assertEquals(report.drops.map((drop) => drop.reason), ["missing-chunk"]);
      assertEquals(await commitsOf(store), []);
    },
  );
});

Deno.test("recoverCommitOutbox: a refused entry is dropped with its unit's run entries", async () => {
  await withFixture(async ({ store, prepare, recover }) => {
    await store.append(
      modelCommit(1, [await savePut("a", 1)], { txnId: "first", fence: 1 }),
    );
    // Prepared on the current head, but its expect no longer holds.
    await prepare(
      prepared(2, [await savePut("a", 1, "again", "absent")], "t2"),
      { unitId: "u" },
    );
    await prepare(
      modelCommit(1, [await runPut("r")], {
        partition: runPartition(),
        txnId: "run",
        writer: DEAD,
        fence: 1,
        at: NOW.toISOString(),
      }),
      { unitId: "u" },
    );
    const report = await recover(2);
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t2", "refused"], ["run", "unit-dropped"]],
    );
    assertEquals(await commitsOf(store, runPartition()), []);
  });
});

Deno.test("recoverCommitOutbox: an outbox that cannot be read names its path", async () => {
  await withFixture(async ({ store, chunkStore, dir }) => {
    const path = join(dir, "broken.db");
    await Deno.writeTextFile(path, "not a database");
    const broken = new SqliteCommitOutbox(path);
    const error = await assertRejects(
      () =>
        recoverCommitOutbox(
          { outbox: broken, commitStore: store, chunkStore },
          { fence: 2, writer: RECOVERER },
        ),
      CommitOutboxUnreadableError,
    );
    assert(error.message.includes(path));
    await broken.close();
  });
});

Deno.test("recoverCommitOutbox: an empty recovery raises the floor, so an entry a lease-lost writer prepares after it is overtaken", async () => {
  await withFixture(async ({ store, prepare, recover }) => {
    // The successor at fence 2 finds nothing to recover.
    assertEquals((await recover(2)).drops, []);
    // The writer at fence 1, whose lease lapsed, prepares and dies.
    await prepare(prepared(1, [await savePut("a", 1)], "late"));
    const report = await recover(3);
    assertEquals(report.drops.map((drop) => drop.reason), ["overtaken"]);
    assertEquals(await commitsOf(store), []);
  });
});
