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
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit, CommitWriter } from "../../domain/datastore_v3/commit.ts";
import {
  type HeadIdentity,
  outboxKeyOf,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import {
  blobPut,
  MemoryStorage,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  fixtureCommit,
  saveOps,
} from "../../domain/datastore_v3/offline_rebase_test_helpers.ts";
import type { OfflineRebaseCarry } from "../../domain/datastore_v3/offline_rebase.ts";
import type { OfflineFlushPort } from "./offline_flush.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import {
  CommitOutboxUnreadableError,
  recoverCommitOutbox,
  type RecoverCommitOutboxOptions,
} from "./commit_outbox_recovery.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { setLocalProcessForTesting } from "./process_identity.ts";
import {
  ServeCommitRefusedError,
  ServeCommitRejectedError,
} from "./serve_upstream_errors.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";

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
    writerAlive?: RecoverCommitOutboxOptions["writerAlive"] | "default",
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
        {
          fence,
          writer: RECOVERER,
          ...(writerAlive !== "default" ? { writerAlive } : {}),
          clock: () => NOW,
        },
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

Deno.test("recoverCommitOutbox: a quarantined entry whose commit an admin accepted at serve settles, counted as accepted (swamp-club#4195)", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    const commit = prepared(1, [await savePut("a", 1)], "t1");
    await prepare(commit);
    await outbox.markState([outboxKeyOf(commit)], "quarantined", "no grant");
    // The admin's accept lands it under its original txnId.
    await store.append(commit);
    const report = await recover(2);
    assertEquals([report.landed, report.settled, report.accepted], [0, 0, 1]);
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

Deno.test("recoverCommitOutbox: leaves a live writer's entry past the floor, and lands it once the writer is gone (swamp-club#3564)", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"));
    const alive = (writer: CommitWriter) => writer.instance === "dead";
    const report = await recover(2, alive);
    assertEquals([report.landed, report.skipped], [0, 1]);
    assertEquals(await outbox.hasEntries(), true);
    // The floor rose past it, but a recovery left it: still left alone.
    const next = await recover(3, alive);
    assertEquals([next.skipped, next.drops.length], [1, 0]);
    // Its writer is gone now: it lands.
    const last = await recover(4);
    assertEquals([last.landed, last.drops.length], [1, 0]);
    assertEquals((await commitsOf(store)).map((c) => c.txnId), ["t1"]);
  });
});

Deno.test("recoverCommitOutbox: a left entry whose writer resumes and is refused is gone once it discards, and a later recovery lands nothing", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    const entry = prepared(1, [await savePut("a", 1)], "t1");
    await prepare(entry);
    const alive = (writer: CommitWriter) => writer.instance === "dead";
    // Its writer was alive at the recovery: left, and the floor rose.
    assertEquals((await recover(2, alive)).skipped, 1);
    assertEquals(
      (await outbox.entries()).entries.map((e) => e.leftAtFence),
      [2],
    );
    // The writer resumes; the store refuses its fenced append, and it
    // discards the entry, as a refused unit does (swamp-club#3506). Left
    // entries rely on this discard: one that failed would leave a landable
    // entry, the V3-08 case.
    await assertRejects(() => store.append(entry), WriterFencedError);
    await outbox.discard([outboxKeyOf(entry)]);
    // The writer is gone now: nothing is left to land.
    const later = await recover(3);
    assertEquals(
      [later.landed, later.settled, later.skipped, later.drops.length],
      [0, 0, 0, 0],
    );
    assertEquals(await commitsOf(store), []);
  });
});

Deno.test("recoverCommitOutbox: an entry prepared again after a recovery left it is overtaken like any other", async () => {
  await withFixture(async ({ store, outbox, prepare, recover }) => {
    const entry = prepared(1, [await savePut("a", 1)], "t1");
    await prepare(entry);
    const alive = (writer: CommitWriter) => writer.instance === "dead";
    await recover(2, alive);
    // The writer, fenced, prepares it again after the recovery, then dies.
    await prepare(entry);
    assertEquals(
      (await outbox.entries()).entries.map((e) => e.leftAtFence),
      [undefined],
    );
    const next = await recover(3);
    assertEquals(next.drops.map((drop) => drop.reason), ["overtaken"]);
    assertEquals(await commitsOf(store), []);
  });
});

Deno.test("recoverCommitOutbox: judges a writer by the identity it prepared under, landing a reused pid's entry and leaving a live one's (swamp-club#3564)", async () => {
  const kernel = { host: "host-a#pid:[1]", bootId: "boot-id:a" };
  setLocalProcessForTesting({
    pid: 7,
    identity: { ...kernel, startTime: "t-recoverer" },
    // pid 4242 runs, started at t-live.
    probe: (pid) =>
      pid === 4242
        ? { present: true, zombie: false, startTime: "t-live" }
        : { present: false, zombie: false },
    bootIdRequired: true,
  });
  try {
    for (
      const [startTime, landed] of [["t-dead", 1], ["t-live", 0]] as const
    ) {
      await withFixture(async ({ store, outbox, recover }) => {
        const prepping = new SqliteCommitOutbox(outbox.path, {
          clock: () => NOW,
          writerProcess: () => Promise.resolve({ ...kernel, startTime }),
        });
        try {
          const commit = prepared(1, [await savePut("a", 1)], "t1");
          await prepping.prepare({
            commit,
            unitId: "unit",
            base: await store.headIdentity(commit.namespace, commit.partition),
          });
        } finally {
          await prepping.close();
        }
        const report = await recover(2, "default");
        assertEquals([report.landed, report.skipped], [landed, 1 - landed]);
      });
    }
  } finally {
    setLocalProcessForTesting(undefined);
  }
});

Deno.test("recoverCommitOutbox: an entry from a swamp before identities is recovered under the lease, not dropped", async () => {
  await withFixture(async ({ store, prepare, recover }) => {
    // Prepared with no identity, by a writer on this host that still runs.
    await prepare(
      modelCommit(1, [await savePut("a", 1)], {
        txnId: "t1",
        writer: { host: Deno.hostname(), pid: Deno.ppid, instance: "old" },
        fence: 1,
        at: NOW.toISOString(),
      }),
    );
    const report = await recover(2, "default");
    assertEquals([report.landed, report.drops.length], [1, 0]);
    assertEquals((await commitsOf(store)).map((c) => c.txnId), ["t1"]);
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

Deno.test("recoverCommitOutbox: drops an entry naming a chunk a crash left short, on a storage that reads sizes (swamp-club#3617)", async () => {
  await withFixture(async ({ store, outbox, dir, prepare }) => {
    const signal = new AbortController().signal;
    const datastore = join(dir, "datastore");
    const chunkStore = new ChunkStore(
      new FileSystemStorage(datastore, { syncedAncestors: new Map() }),
    );
    const blob = await chunkStore.write(
      SOLO_NAMESPACE,
      new Uint8Array(200).fill(7),
      signal,
    );
    await prepare(prepared(1, [await blobPut("a", 1, blob)], "t1"));
    // Torn: the name survived a power loss, the bytes did not.
    await Deno.truncate(
      join(
        datastore,
        "_blobs",
        "_default",
        "sha256",
        blob.sha256.slice(0, 2),
        blob.sha256,
      ),
      10,
    );
    await store.raiseWriterFence(2);
    await outbox.recordFence(2);
    const report = await recoverCommitOutbox(
      { outbox, commitStore: store, chunkStore },
      {
        fence: 2,
        writer: RECOVERER,
        writerAlive: () => false,
        clock: () => NOW,
      },
    );
    assertEquals(report.drops.map((drop) => drop.reason), ["missing-chunk"]);
    assertEquals(
      report.drops[0].detail,
      `chunk ${blob.sha256} is missing or damaged`,
    );
    assertEquals(await commitsOf(store), []);
  });
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

Deno.test("recoverCommitOutbox: an entry serve refuses on the caller's access is dropped, as a narrowed grant refuses it on every recovery (swamp-club#4089)", async () => {
  await withFixture(async ({ store, prepare, recover }) => {
    await prepare(prepared(1, [await savePut("a", 1)], "t1"));
    // Serve's 403 for a forwarded commit, as a grant narrowed since the
    // write was made answers it.
    store.append = () =>
      Promise.reject(
        new ServeCommitRefusedError(
          "forbidden",
          "access",
          0,
          "Not authorized to write data:web",
        ),
      );
    const report = await recover(2);
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t1", "refused"]],
    );
  });
});

// Forwarded resends (swamp-club#4121): a resend never lands on a newer head.

/**
 * Recovers `fixture`'s outbox as a serve-mode checkout does: its store's
 * appends stand in for serve's, and every send is recorded with the lease
 * it names.
 */
async function recoverForwarded(
  fixture: Fixture,
  fence: number,
  serve: (commit: Commit) => Promise<void> = async (commit) => {
    await fixture.store.append(commit);
  },
): Promise<{
  report: Awaited<ReturnType<typeof recoverCommitOutbox>>;
  sent: { txnId: string; lease: string | undefined }[];
}> {
  const { store, outbox, chunkStore } = fixture;
  await store.raiseWriterFence(fence);
  await outbox.recordFence(fence);
  const sent: { txnId: string; lease: string | undefined }[] = [];
  const upstream = {
    append: () =>
      Promise.reject(new Error("a forwarded resend names its lease")),
    headIdentity: store.headIdentity.bind(store),
    landedSeq: store.landedSeq.bind(store),
    appendUnderLease: async (commit: Commit, lease: string | undefined) => {
      sent.push({ txnId: commit.txnId, lease });
      await serve(commit);
    },
  };
  const report = await recoverCommitOutbox(
    { outbox, commitStore: upstream, chunkStore },
    {
      fence,
      writer: RECOVERER,
      writerAlive: () => false,
      clock: () => NOW,
      forwarded: true,
    },
  );
  return { report, sent };
}

Deno.test("recoverCommitOutbox: a forwarded entry whose head moved is dropped, never sent over the newer record (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    const { store, prepare } = fixture;
    // Built on an empty partition: a put with no expect.
    await prepare(prepared(1, [await savePut("a", 1, "stale")], "t1"), {
      base: { seq: 0, txnId: undefined },
    });
    // Another writer's newer record of the same key lands first.
    await store.append(prepared(1, [await savePut("a", 1, "newer")], "other"));
    const { report, sent } = await recoverForwarded(fixture, 2);
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t1", "head-moved"]],
    );
    assertEquals(sent, []);
    assertEquals((await commitsOf(store)).map((commit) => commit.txnId), [
      "other",
    ]);
  });
});

Deno.test("recoverCommitOutbox: a forwarded entry serve answers with a moved head is dropped, not built again (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    await fixture.prepare(prepared(1, [await savePut("a", 1)], "t1"));
    let sends = 0;
    const { report } = await recoverForwarded(fixture, 2, () => {
      sends++;
      return Promise.reject(
        new ServeCommitRejectedError(
          "seq-gap",
          "stale_seq",
          "Serve's partition is past this commit's head",
        ),
      );
    });
    assertEquals(sends, 1);
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t1", "head-moved"]],
    );
    assertEquals(await commitsOf(fixture.store), []);
  });
});

Deno.test("recoverCommitOutbox: a forwarded entry is resent naming the lease it was built under, and once that lease has ended, under none on its unmoved head (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    const { outbox, store } = fixture;
    const lease = { leaseId: crypto.randomUUID(), fence: 3 };
    await outbox.prepare({
      commit: prepared(1, [await savePut("a", 1)], "t1"),
      unitId: "unit",
      base: await store.headIdentity("", modelPartition()),
      lease,
    });
    let first = true;
    const { report, sent } = await recoverForwarded(
      fixture,
      2,
      async (commit) => {
        // Serve no longer holds the lease its writer died with.
        if (first) {
          first = false;
          throw new ServeCommitRejectedError(
            "lease-lost",
            "commit_lease-lost",
            "This commit's model lease is not held",
          );
        }
        await store.append(commit);
      },
    );
    assertEquals(sent, [
      { txnId: "t1", lease: lease.leaseId },
      { txnId: "t1", lease: undefined },
    ]);
    assertEquals(report.landed, 1);
    assertEquals(report.drops, []);
  });
});

Deno.test("recoverCommitOutbox: a forwarded entry whose lease was superseded is dropped (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    const { outbox, store } = fixture;
    await outbox.prepare({
      commit: prepared(1, [await savePut("a", 1)], "t1"),
      unitId: "unit",
      base: await store.headIdentity("", modelPartition()),
      lease: { leaseId: crypto.randomUUID(), fence: 3 },
    });
    const { report } = await recoverForwarded(
      fixture,
      2,
      () =>
        Promise.reject(
          new ServeCommitRejectedError(
            "stale-lease",
            "commit_stale-lease",
            "Lease fence 3 is below the partition's lease fence 4",
          ),
        ),
    );
    assertEquals(
      report.drops.map((drop) => [drop.entry.commit.txnId, drop.reason]),
      [["t1", "lease-superseded"]],
    );
    assertEquals(await commitsOf(store), []);
  });
});

Deno.test("recoverCommitOutbox: a deferred data entry holds back its unit's run entry, so a run record never lands without its data (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    await fixture.prepare(prepared(1, [await savePut("a", 1)], "t1"), {
      unitId: "u",
    });
    await fixture.prepare(
      modelCommit(1, [await runPut("r")], {
        partition: runPartition(),
        txnId: "run",
        writer: DEAD,
        fence: 1,
        at: NOW.toISOString(),
      }),
      { unitId: "u" },
    );
    const sent: string[] = [];
    const { report } = await recoverForwarded(fixture, 2, (commit) => {
      sent.push(commit.txnId);
      return Promise.reject(
        new ServeCommitRejectedError(
          "lease-lost",
          "commit_lease-lost",
          "This commit's model lease is not held",
        ),
      );
    });
    assertEquals(sent, ["t1"]);
    assertEquals(report.skipped, 2);
    assertEquals(await commitsOf(fixture.store, runPartition()), []);
    assertEquals(
      (await fixture.outbox.entries()).entries.map((e) => e.commit.txnId)
        .sort(),
      ["run", "t1"],
    );
  });
});

Deno.test("recoverCommitOutbox: a forwarded entry built outside any lease is resent naming none, and lands on an unmoved head", async () => {
  await withFixture(async (fixture) => {
    await fixture.prepare(prepared(1, [await savePut("a", 1)], "t1"));
    const { report, sent } = await recoverForwarded(fixture, 2);
    assertEquals(sent, [{ txnId: "t1", lease: undefined }]);
    assertEquals(report.landed, 1);
    assertEquals((await commitsOf(fixture.store)).map((c) => c.txnId), ["t1"]);
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

Deno.test("recoverCommitOutbox: makes the names of an entry's chunks durable before it lands it (swamp-club#3617)", async () => {
  await withFixture(async ({ store, outbox, prepare }) => {
    const signal = new AbortController().signal;
    const events: string[] = [];
    const storage = new (class extends MemoryStorage {
      async syncChunkDirectories(
        namespace: string,
        hashes: readonly string[],
        syncSignal: AbortSignal,
      ): Promise<void> {
        syncSignal.throwIfAborted();
        events.push(
          `sync ${namespace} ${[...hashes].sort().join(",")} landed ${
            (await commitsOf(store)).length
          }`,
        );
      }
    })({ maxChunkBytes: 64 });
    const chunkStore = new ChunkStore(storage);
    const blob = await chunkStore.write(
      SOLO_NAMESPACE,
      new Uint8Array(200).map((_, i) => i),
      signal,
    );
    // Inline content names no chunk: only the blob's are synced.
    await prepare(
      prepared(1, [await blobPut("a", 1, blob), await savePut("b", 1)], "t1"),
    );
    await store.raiseWriterFence(2);
    await outbox.recordFence(2);
    const report = await recoverCommitOutbox(
      { outbox, commitStore: store, chunkStore },
      {
        fence: 2,
        writer: RECOVERER,
        writerAlive: () => false,
        clock: () => NOW,
      },
    );
    assertEquals(report.landed, 1);
    assertEquals(events, [
      `sync _default ${
        [...new Set(blob.chunkHashes())].sort().join(",")
      } landed 0`,
    ]);
  });
});

Deno.test("recoverCommitOutbox: a failed chunk barrier lands nothing and keeps the entry for the next recovery (swamp-club#3617)", async () => {
  await withFixture(async ({ store, outbox, prepare }) => {
    const signal = new AbortController().signal;
    const storage = new (class extends MemoryStorage {
      syncChunkDirectories(): Promise<void> {
        return Promise.reject(new Error("fsync failed"));
      }
    })();
    const chunkStore = new ChunkStore(storage);
    const blob = await chunkStore.write(
      SOLO_NAMESPACE,
      new Uint8Array(200).fill(3),
      signal,
    );
    await prepare(prepared(1, [await blobPut("a", 1, blob)], "t1"));
    await store.raiseWriterFence(2);
    await outbox.recordFence(2);
    await assertRejects(
      () =>
        recoverCommitOutbox(
          { outbox, commitStore: store, chunkStore },
          {
            fence: 2,
            writer: RECOVERER,
            writerAlive: () => false,
            clock: () => NOW,
          },
        ),
      Error,
      "fsync failed",
    );
    assertEquals(await commitsOf(store), []);
    assertEquals(await outbox.hasEntries(), true);
  });
});

Deno.test("recoverCommitOutbox: a forwarded entry built outside any lease is left for a later recovery while another holder's lease covers its partition (swamp-club#4121)", async () => {
  await withFixture(async (fixture) => {
    await fixture.prepare(prepared(1, [await savePut("a", 1)], "t1"));
    await fixture.prepare(prepared(2, [await savePut("a", 2)], "t2"), {
      base: { seq: 1, txnId: "t1" },
    });
    let sends = 0;
    const { report } = await recoverForwarded(fixture, 2, () => {
      sends++;
      return Promise.reject(
        new ServeCommitRejectedError(
          "lease-lost",
          "commit_lease-lost",
          "This commit's model lease is not held",
        ),
      );
    });
    // The second waits with the first, unsent.
    assertEquals(sends, 1);
    assertEquals(report.drops, []);
    assertEquals(report.skipped, 2);
    assertEquals(
      (await fixture.outbox.entries()).entries.map((e) => e.commit.txnId),
      ["t1", "t2"],
    );
    // A later recovery, once the lease is gone, lands both.
    const later = await recoverForwarded(fixture, 3);
    assertEquals(later.report.landed, 2);
  });
});

Deno.test("recoverCommitOutbox: keeps an unreadable entry queued offline, rejected or quarantined, and drops an unreadable pending one (swamp-club#4195)", async () => {
  await withFixture(async ({ outbox, dir, prepare, recover }) => {
    const kept = prepared(1, [await savePut("a", 1)], "t-offline");
    const dropped = prepared(1, [await savePut("b", 1)], "t-pending");
    await prepare(kept);
    await prepare(dropped);
    await outbox.markState([outboxKeyOf(kept)], "offline");
    const db = new DatabaseSync(join(dir, "outbox.db"));
    db.exec("UPDATE outbox_entries SET body = '{\"v\":3}'");
    db.close();
    await recover(2);
    const listing = await outbox.entries();
    assertEquals(
      listing.unreadable.map((entry) => [entry.key.txnId, entry.state]),
      [["t-offline", "offline"]],
    );
  });
});

Deno.test("recoverCommitOutbox: an offline entry a cut-off flush landed is recorded as this checkout's own, with what its landing renumbered, before it settles (swamp-club#4195)", async () => {
  await withFixture(async ({ store, outbox, chunkStore, prepare }) => {
    const queued = fixtureCommit({
      seq: 1,
      txnId: "t-offline",
      fence: 1,
      ops: await saveOps({ name: "out", version: 3 }),
    });
    await prepare(queued, { base: { seq: 0, txnId: undefined } });
    await outbox.markState([outboxKeyOf(queued)], "offline");
    // The flush landed it as version 5, then the process ended.
    await store.append(fixtureCommit({
      seq: 1,
      txnId: "t-offline",
      fence: 1,
      ops: await saveOps({
        name: "out",
        version: 5,
        createdAt: "2026-10-15T09:00:00.000Z",
      }),
    }));
    const recorded: { txnId: string; carry?: OfflineRebaseCarry }[] = [];
    const port = {
      partitionCommits: async (namespace, partition) =>
        await commitsOf(store, partition).then((commits) =>
          commits.filter((commit) => commit.namespace === namespace)
        ),
      recordOwnLanded: (key, _at, carry) => {
        recorded.push({ txnId: key.txnId, carry });
        return Promise.resolve();
      },
    } as Pick<OfflineFlushPort, "partitionCommits" | "recordOwnLanded">;
    await store.raiseWriterFence(2);
    await outbox.recordFence(2);
    await recoverCommitOutbox(
      {
        outbox,
        commitStore: store,
        chunkStore,
        offline: port as OfflineFlushPort,
      },
      {
        fence: 2,
        writer: RECOVERER,
        writerAlive: () => false,
        clock: () => NOW,
      },
    );
    assertEquals(await outbox.hasEntries(), false);
    assertEquals(recorded.map((record) => record.txnId), ["t-offline"]);
    assertEquals(recorded[0].carry?.versions, [
      { name: "out", from: 3, to: 5 },
    ]);
    assertEquals(recorded[0].carry?.createdAt, [{
      name: "out",
      version: 5,
      createdAt: "2026-10-15T09:00:00.000Z",
    }]);
  });
});
