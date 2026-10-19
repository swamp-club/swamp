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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { OUTBOX_RETRY_BOUND_MS } from "../../domain/datastore_v3/commit_outbox.ts";
import { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  dataKey,
  MemoryStorage,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
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
