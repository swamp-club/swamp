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

/** The commit-log unit's use of the commit outbox (swamp-club#3490). */

import { waitFor } from "@swamp-club/swamp-testing";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { OUTBOX_RETRY_BOUND_MS } from "../../domain/datastore_v3/commit_outbox.ts";
import {
  MayLandLaterError,
  PartitionsRefusedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import {
  dataKey,
  MemoryStorage,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { MemorySink } from "./commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import {
  AT,
  contextHook,
  OutboxMemorySink,
  runPartition,
  runPut,
  unitOptions,
} from "./commit_log_test_helpers.ts";

const MODEL = modelPartition();

function memory(): MemoryStorage {
  return new MemoryStorage({ maxChunkBytes: 32 * 1024 });
}

function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

/** The outbox removals the sink saw, in order: `settle:` or `discard:`. */
function removals(sink: OutboxMemorySink): string[] {
  return sink.events.filter((event) =>
    event.startsWith("settle:") || event.startsWith("discard:")
  );
}

function blobChange(name: string) {
  return {
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name, version: 1 }),
      key: dataKey(name, 1),
      content: bytesOf(100 * 1024),
    },
  };
}

Deno.test("commit-log unit with an outbox: prepares each commit with its base before appending, and settles it once landed", async () => {
  const sink = new OutboxMemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { fence: 3 }),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.checkpoint();
  await uow.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await uow.commit();
  const [first, second] = sink.landed;
  assertEquals(sink.events, [
    `prepare:${first.txnId}`,
    `append:${first.txnId}`,
    `settle:${first.txnId}`,
    `prepare:${second.txnId}`,
    `append:${second.txnId}`,
    `settle:${second.txnId}`,
  ]);
  assertEquals(sink.entries.size, 0);
});

Deno.test("commit-log unit with an outbox: the base is the head read under the partition lock, and a seq-gap rebuild prepares again", async () => {
  const sink = new OutboxMemorySink();
  const bases: { seq: number; txnId: string | undefined }[] = [];
  const prepare = sink.outbox.prepare;
  Object.assign(sink.outbox, {
    prepare: (preparation: Parameters<typeof prepare>[0]) => {
      bases.push(preparation.base);
      return prepare(preparation);
    },
  });
  // Another writer lands seq 1 between this unit's head read and append.
  let raced = false;
  sink.beforeAppend = async () => {
    if (raced) return;
    raced = true;
    await sink.append(
      modelCommit(1, [await savePut("z", 1)], { txnId: "other" }),
    );
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.commit();
  assertEquals(bases, [
    { seq: 0, txnId: undefined },
    { seq: 1, txnId: "other" },
  ]);
  assertEquals(sink.entries.size, 0);
});

Deno.test("commit-log unit with an outbox: a failed append keeps the entry while the unit is open; a failed commit discards it", async () => {
  const sink = new OutboxMemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  sink.beforeAppend = () => {
    throw new Error("disk full");
  };
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint(), Error, "disk full");
  assertEquals(sink.entries.size, 1, "durable while the unit may retry");
  const [txnId] = [...sink.entries.keys()];
  await assertRejects(() => uow.commit(), Error, "disk full");
  assertEquals(sink.entries.size, 0, "the failure was reported");
  // Durable: a discard a power cut undid could be landed by a recovery.
  assertEquals(removals(sink), [`discard:${txnId}`]);
});

Deno.test("commit-log unit with an outbox: a failed discard leaves the commit's own error to the caller", async () => {
  const sink = new OutboxMemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  sink.beforeAppend = () => {
    throw new Error("disk full");
  };
  sink.beforeRemove = () => {
    throw new Error("outbox locked");
  };
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.commit(), Error, "disk full");
});

Deno.test("commit-log unit with an outbox: abandon discards what it prepared", async () => {
  const sink = new OutboxMemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  let fail = true;
  sink.beforeAppend = () => {
    if (fail) throw new Error("transient");
  };
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint());
  const [txnId] = [...sink.entries.keys()];
  fail = false;
  await uow.abandon();
  assertEquals(sink.entries.size, 0);
  assertEquals(sink.landed, []);
  assertEquals(removals(sink), [`discard:${txnId}`]);
});

Deno.test("commit-log unit with an outbox: a refusal discards the refused entry and the unit's run entries, and held runs are never prepared", async () => {
  const sink = new OutboxMemorySink();
  const options = unitOptions(sink, memory());
  // The run's first append fails, so its entry stays prepared.
  let runFails = true;
  sink.beforeAppend = (commit) => {
    if (runFails && commit.partition.equals(runPartition())) {
      runFails = false;
      throw new Error("transient");
    }
  };
  const first = createCommitLogUnitOfWork(contextHook(), options);
  await first.stageOp({
    partition: MODEL,
    op: await savePut("a", 1, "a", "absent"),
  });
  await first.commit();
  const settled = removals(sink);
  assertEquals(settled.length, 1);
  assert(settled[0].startsWith("settle:"), "the landed commit settles");
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp({ partition: runPartition(), op: await runPut("r1") });
  await assertRejects(() => uow.checkpoint(), Error, "transient");
  const runTxn = [...sink.entries.keys()];
  assertEquals(runTxn.length, 1);
  // Refused: its expect no longer holds.
  await uow.stageOp({
    partition: MODEL,
    op: await savePut("a", 1, "again", "absent"),
  });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r2") });
  const error = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assert(error.heldRuns.length > 0);
  assertEquals(sink.entries.size, 0, "no run entry outlives the refusal");
  const discarded = removals(sink).slice(1);
  assertEquals(discarded.length, 2, "the refused entry and the run entry");
  assert(
    discarded.every((event) => event.startsWith("discard:")),
    `a refusal discards durably, never settles: ${discarded}`,
  );
  assertEquals(
    sink.events.filter((event) => event.startsWith("prepare:")).length,
    3,
    "the first unit, the failed run and the refused model commit; the held run never",
  );
  uow.acknowledgeRefusals();
  await uow.abandon();
});

Deno.test("commit-log unit with an outbox: chunks are checked before the append only when a sweep may have overlapped", async () => {
  for (const overlap of [false, true]) {
    const sink = new OutboxMemorySink();
    const options = unitOptions(sink, memory());
    // Read before storing, then after preparing.
    sink.sweepStates = [
      { epoch: 4, active: false },
      { epoch: overlap ? 5 : 4, active: false },
    ];
    let presentAtAppend: boolean | undefined;
    // A sweep deletes every chunk between the content store and the prepare.
    sink.beforeHead = () => options.storage.chunks.clear();
    sink.beforeAppend = () => {
      presentAtAppend = options.storage.chunks.size > 0;
    };
    const uow = createCommitLogUnitOfWork(contextHook(), options);
    await uow.stageOp(blobChange("x"));
    await uow.commit();
    assertEquals(presentAtAppend, overlap);
    // The post-commit check restores them either way.
    assert(options.storage.chunks.size > 0);
  }
});

Deno.test("commit-log unit with an outbox: a retry older than the bound is refused before it is appended", async () => {
  const sink = new OutboxMemorySink();
  let now = AT.getTime();
  const options = unitOptions(sink, memory(), {
    clock: () => new Date(now),
  });
  let fail = true;
  sink.beforeAppend = () => {
    if (fail) throw new Error("transient");
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint(), Error, "transient");
  fail = false;
  now += OUTBOX_RETRY_BOUND_MS + 1;
  const error = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assert(error instanceof CommitRejectedError);
  assertEquals(error.refusals[0].reason, "retry-expired");
  assertEquals(sink.landed, []);
  assertEquals(sink.entries.size, 0);
  uow.acknowledgeRefusals();
  await uow.commit();
});

Deno.test("commit-log unit with an outbox: a writer that may overlap a sweep batch waits for it before its chunk check and its append (swamp-club#3586)", async () => {
  const sink = new OutboxMemorySink();
  const options = unitOptions(sink, memory());
  // A sweep is in progress at both reads.
  sink.sweepStates = [{ epoch: 4, active: true }, { epoch: 4, active: true }];
  // The batch in flight judged the chunks unreferenced before the prepare.
  // Run to its end, it deletes them and its re-check, finding the entry,
  // puts them back.
  let batchEnded = false;
  Object.assign(sink.outbox, {
    sweepBatch: () => {
      sink.events.push("batch");
      batchEnded = true;
      return Promise.resolve();
    },
  });
  let presentAtAppend: boolean | undefined;
  sink.beforeAppend = () => {
    // Not waited for, it deletes them after the writer's check, and the
    // process dies before either re-check runs.
    if (!batchEnded) options.storage.chunks.clear();
    presentAtAppend = options.storage.chunks.size > 0;
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(blobChange("x"));
  await uow.commit();
  assertEquals(presentAtAppend, true);
  const [commit] = sink.landed;
  assertEquals(sink.events.slice(0, 3), [
    `prepare:${commit.txnId}`,
    "batch",
    `append:${commit.txnId}`,
  ]);
});

Deno.test("commit-log unit with an outbox: the unit counts as open until its final flush and discards are done (swamp-club#3586)", async () => {
  for (const ending of ["commit", "abandon"] as const) {
    const sink = new OutboxMemorySink();
    const options = unitOptions(sink, memory(), {
      tracker: {
        opened: () => {},
        ended: () => sink.events.push("ended"),
        dropped: () => {},
      },
    });
    const uow = createCommitLogUnitOfWork(contextHook(), options);
    await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
    if (ending === "abandon") {
      sink.beforeAppend = () => {
        throw new Error("transient");
      };
      await assertRejects(() => uow.checkpoint(), Error, "transient");
      await uow.abandon();
    } else {
      await uow.commit();
    }
    assertEquals(sink.events.at(-1), "ended", ending);
    assertEquals(sink.events.filter((event) => event === "ended").length, 1);
  }
});

Deno.test("commit-log unit with an outbox: a retry refreshes the chunks it stored, and stores again what a sweep deleted, before it appends (swamp-club#3586)", async () => {
  const sink = new OutboxMemorySink();
  const options = unitOptions(sink, memory());
  let fail = true;
  let presentAtAppend: boolean | undefined;
  sink.beforeAppend = () => {
    if (fail) throw new Error("transient");
    presentAtAppend = options.storage.chunks.size > 0;
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(blobChange("x"));
  await assertRejects(() => uow.checkpoint(), Error, "transient");
  // Past the grace period while the retry waited, a sweep deletes them.
  options.storage.chunks.clear();
  fail = false;
  await uow.commit();
  assertEquals(presentAtAppend, true);
  assertEquals(sink.landed.length, 1);
});

Deno.test("commit-log unit with an outbox: a refusal in the unit's own commit whose give-up cannot be recorded says the change may land (swamp-club#3586)", async () => {
  for (const ending of ["commit", "checkpoint then commit"] as const) {
    const sink = new OutboxMemorySink();
    const options = unitOptions(sink, memory());
    const first = createCommitLogUnitOfWork(contextHook(), options);
    await first.stageOp({
      partition: MODEL,
      op: await savePut("a", 1, "a", "absent"),
    });
    await first.commit();
    // Neither the abandoned mark nor the discard can be written.
    Object.assign(sink.outbox, {
      abandon: () => Promise.reject(new Error("database or disk is full")),
    });
    sink.beforeRemove = () => {
      throw new Error("database or disk is full");
    };
    const uow = createCommitLogUnitOfWork(contextHook(), options);
    // Refused: its expect no longer holds.
    await uow.stageOp({
      partition: MODEL,
      op: await savePut("a", 1, "again", "absent"),
    });
    await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
    if (ending === "checkpoint then commit") {
      await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
      uow.acknowledgeRefusals();
    }
    const error = await assertRejects(() => uow.commit(), MayLandLaterError);
    assert(error.message.includes("disk is full"), ending);
  }
});

/**
 * A memory storage that syncs chunk directories as the filesystem storage
 * does, recording each barrier in `events` as `sync:<hashes>` (sorted).
 */
class SyncingStorage extends MemoryStorage {
  failSync = false;

  constructor(readonly events: string[]) {
    super({ maxChunkBytes: 32 * 1024 });
  }

  syncChunkDirectories(
    _namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.failSync) return Promise.reject(new Error("fsync failed"));
    this.events.push(`sync:${[...hashes].sort().join(",")}`);
    return Promise.resolve();
  }
}

/** The barrier event naming every chunk of `content`. */
async function syncEventOf(content: Uint8Array): Promise<string> {
  const { parts } = await new ChunkStore(memory()).refOf(
    content,
    new AbortController().signal,
  );
  return `sync:${[...new Set(parts.map((p) => p.sha256))].sort().join(",")}`;
}

Deno.test("commit-log unit with an outbox: one chunk directory barrier covers the group's chunks, a dedupe hit's included, before the prepare (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  const storage = new SyncingStorage(sink.events);
  const options = unitOptions(sink, storage);
  const sync = await syncEventOf(bytesOf(100 * 1024));

  const first = createCommitLogUnitOfWork(contextHook(), options);
  await first.stageOp(blobChange("x"));
  await first.commit();
  const [landed] = sink.landed;
  assertEquals(sink.events, [
    sync,
    `prepare:${landed.txnId}`,
    `append:${landed.txnId}`,
    `settle:${landed.txnId}`,
  ]);

  // The same content again: every chunk is a dedupe hit, put by no one
  // now, and its shard is still synced before the prepare.
  sink.events.length = 0;
  const puts = storage.puts();
  const second = createCommitLogUnitOfWork(contextHook(), options);
  await second.stageOp(blobChange("y"));
  await second.commit();
  assertEquals(storage.puts(), puts);
  assertEquals(sink.events.slice(0, 2), [
    sync,
    `prepare:${sink.landed[1].txnId}`,
  ]);
});

Deno.test("commit-log unit without an outbox: the chunk directory barrier runs before the append (swamp-club#3617)", async () => {
  const sink = new MemorySink();
  const events: string[] = [];
  sink.beforeAppend = (commit) => {
    events.push(`append:${commit.txnId}`);
  };
  const options = unitOptions(sink, new SyncingStorage(events));
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(blobChange("x"));
  await uow.commit();
  assertEquals(events, [
    await syncEventOf(bytesOf(100 * 1024)),
    `append:${sink.landed[0].txnId}`,
  ]);
});

Deno.test("commit-log unit with an outbox: a group whose content is all inline has no chunk directory barrier (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  const options = unitOptions(sink, new SyncingStorage(sink.events));
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.commit();
  assertEquals(sink.events.filter((e) => e.startsWith("sync:")), []);
  assertEquals(sink.landed.length, 1);
});

Deno.test("commit-log unit with an outbox: a failed chunk directory barrier prepares and appends nothing, and the next unit syncs the chunks again (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  const storage = new SyncingStorage(sink.events);
  const options = unitOptions(sink, storage);
  storage.failSync = true;
  const failed = createCommitLogUnitOfWork(contextHook(), options);
  await failed.stageOp(blobChange("x"));
  await assertRejects(() => failed.commit(), Error, "fsync failed");
  assertEquals(sink.events, []);
  assertEquals(sink.landed, []);
  assertEquals(sink.entries.size, 0);

  // The chunks are stored but their names may not be durable: a later unit
  // that finds them present syncs them before it prepares.
  storage.failSync = false;
  const next = createCommitLogUnitOfWork(contextHook(), options);
  await next.stageOp(blobChange("x"));
  await next.commit();
  assertEquals(sink.events[0], await syncEventOf(bytesOf(100 * 1024)));
  assertEquals(sink.events[1], `prepare:${sink.landed[0].txnId}`);
});

Deno.test("commit-log unit with an outbox: chunks stored again before or after the append get their own barrier (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  const storage = new SyncingStorage(sink.events);
  const options = unitOptions(sink, storage);
  const sync = await syncEventOf(bytesOf(100 * 1024));
  // A sweep overlaps: the chunks vanish after the first barrier, are stored
  // again under the lock, and vanish again before the post-commit check.
  sink.sweepStates = [
    { epoch: 4, active: false },
    { epoch: 5, active: false },
  ];
  sink.beforeHead = () => storage.chunks.clear();
  sink.afterAppend = () => storage.chunks.clear();
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(blobChange("x"));
  await uow.commit();
  const [landed] = sink.landed;
  assertEquals(sink.events, [
    sync,
    `prepare:${landed.txnId}`,
    sync,
    `append:${landed.txnId}`,
    sync,
    `settle:${landed.txnId}`,
  ]);
  assert(storage.chunks.size > 0);
});

/** 100 KiB of content that differs by `seed`: one chunk each. */
function seededBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(100 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
}

function seededChange(name: string, seed: number) {
  return {
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name, version: 1 }),
      key: dataKey(name, 1),
      content: seededBytes(seed),
    },
  };
}

/**
 * A filesystem storage in a temp directory whose file and directory syncs
 * are recorded in `events` (`file:<chunks renamed so far>`, `dir:<path>`),
 * with memos of its own. `syncFile` runs inside each file sync.
 */
async function withRecordingFs(
  events: string[],
  fn: (
    storage: FileSystemStorage,
    chunkPath: (sha256: string) => string,
    hooks: { syncFile?: () => Promise<void> },
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-uow-barrier-" });
  const chunkPath = (sha256: string) =>
    join(dir, "_blobs", "_default", "sha256", sha256.slice(0, 2), sha256);
  const hooks: { syncFile?: () => Promise<void> } = {};
  const storage = new FileSystemStorage(dir, {
    syncFile: async (file) => {
      await hooks.syncFile?.();
      await file.sync();
    },
    syncDirectory: (path) => {
      events.push(`dir:${path}`);
      return Promise.resolve();
    },
    syncedAncestors: new Map(),
    durableChunks: new Map(),
  });
  try {
    await fn(storage, chunkPath, hooks);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  return (await new ChunkStore(memory()).refOf(
    bytes,
    new AbortController().signal,
  )).sha256;
}

async function present(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("commit-log unit with an outbox: a group's new chunks are synced together before any is renamed, then one directory barrier, then the prepare (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  await withRecordingFs(sink.events, async (storage, chunkPath, hooks) => {
    const seeds = [1, 2, 3];
    const paths = await Promise.all(
      seeds.map(async (seed) => chunkPath(await hashOf(seededBytes(seed)))),
    );
    let entered = 0;
    hooks.syncFile = async () => {
      entered++;
      // Each file sync waits for the others: the group's syncs run at once.
      await waitFor(() => entered === seeds.length, "every file sync", {
        timeoutMs: 2_000,
        intervalMs: 1,
      });
      let renamed = 0;
      for (const path of paths) if (await present(path)) renamed++;
      sink.events.push(`file:${renamed}`);
    };
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, storage),
    );
    for (const seed of seeds) {
      await uow.stageOp(seededChange(`x${seed}`, seed));
    }
    await uow.commit();
    const [landed] = sink.landed;
    const prepareAt = sink.events.indexOf(`prepare:${landed.txnId}`);
    const before = sink.events.slice(0, prepareAt);
    // Every file synced before any chunk was renamed into place.
    assertEquals(before.filter((e) => e.startsWith("file:")), [
      "file:0",
      "file:0",
      "file:0",
    ]);
    // Then the directories, each shard once, after every file sync.
    const dirs = before.filter((e) => e.startsWith("dir:"));
    const shards = [...new Set(paths.map((path) => `dir:${dirname(path)}`))];
    for (const shard of shards) {
      assertEquals(dirs.filter((e) => e === shard).length, 1, shard);
    }
    assertEquals(
      before.findIndex((e) => e.startsWith("dir:")),
      seeds.length,
    );
    for (const path of paths) assert(await present(path));
  });
});

Deno.test("commit-log unit with an outbox: a dedupe hit on chunks this process made durable syncs no directory (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  await withRecordingFs(sink.events, async (storage) => {
    const options = unitOptions(sink, storage);
    const first = createCommitLogUnitOfWork(contextHook(), options);
    await first.stageOp(seededChange("x", 1));
    await first.commit();
    assert(sink.events.some((e) => e.startsWith("dir:")));

    sink.events.length = 0;
    const second = createCommitLogUnitOfWork(contextHook(), options);
    await second.stageOp(seededChange("y", 1));
    await second.commit();
    assertEquals(sink.events, [
      `prepare:${sink.landed[1].txnId}`,
      `append:${sink.landed[1].txnId}`,
      `settle:${sink.landed[1].txnId}`,
    ]);
  });
});

Deno.test("commit-log unit with an outbox: a failed file sync prepares nothing and leaves none of the group's chunks in place (swamp-club#3617)", async () => {
  const sink = new OutboxMemorySink();
  await withRecordingFs(sink.events, async (storage, chunkPath, hooks) => {
    let syncs = 0;
    hooks.syncFile = () =>
      ++syncs === 2
        ? Promise.reject(new Error("disk gone"))
        : Promise.resolve();
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, storage),
    );
    await uow.stageOp(seededChange("x1", 1));
    await uow.stageOp(seededChange("x2", 2));
    await assertRejects(() => uow.commit(), Error, "disk gone");
    assertEquals(sink.landed, []);
    assertEquals(sink.events.filter((e) => e.startsWith("prepare:")), []);
    for (const seed of [1, 2]) {
      const path = chunkPath(await hashOf(seededBytes(seed)));
      assertEquals(await present(path), false, path);
      // No temp file is left beside it either.
      const left = await present(dirname(path))
        ? [...Deno.readDirSync(dirname(path))]
        : [];
      assertEquals(left, []);
    }
  });
});
