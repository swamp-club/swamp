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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { createIntent } from "../../domain/datastore_v3/intent.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { MAX_COMMIT_OPS } from "../../domain/datastore_v3/commit.ts";
import {
  leaseOp,
  MAX_INLINE_BYTES,
  type PutOp,
  tombstoneOp,
} from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import {
  dataKey,
  MemoryStorage,
  modelCommit,
  modelIntent,
  modelPartition,
  readAll,
  savePut,
  streamOf,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import { unitOfWorkBinding } from "../persistence/unit_of_work_binding.ts";
import {
  commitLogParentFor,
  createCommitLogUnitOfWork,
  partitionLockCountForTesting,
  PathOnlyChangeRefusedError,
} from "./commit_log_unit_of_work.ts";
import {
  AT,
  contextHook,
  MemorySink,
  runPartition,
  runPut,
  unitOptions,
  WRITER,
} from "./commit_log_test_helpers.ts";

/** An in-memory chunk storage with small chunks, so content spans several. */
function memory(): MemoryStorage {
  return new MemoryStorage({ maxChunkBytes: 32 * 1024 });
}

const MODEL = modelPartition();

function bytesOf(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
}

/** The bytes a put's content holds, inline or from the chunk storage. */
async function contentOf(
  op: PutOp,
  storage: MemoryStorage,
): Promise<Uint8Array> {
  if ("inline" in op.content) {
    return Uint8Array.from(atob(op.content.inline), (c) => c.charCodeAt(0));
  }
  return await readAll(
    new ChunkStore(storage).read(
      SOLO_NAMESPACE,
      op.content.blob,
      new AbortController().signal,
    ),
  );
}

function pendingPut(
  name: string,
  content: Uint8Array | (() => ReadableStream<Uint8Array>),
) {
  return {
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name, version: 1 }),
      key: dataKey(name, 1),
      content,
    },
  };
}

Deno.test("createCommitLogUnitOfWork: commit lands one commit with the staged ops in order", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { fence: 3 }),
  );
  const a = await savePut("a", 1);
  const b = await savePut("b", 1);
  await uow.stageOp({ partition: MODEL, op: a });
  await uow.stageOp({ partition: MODEL, op: versionOp("a", 1) });
  await uow.stageOp({ partition: MODEL, op: b });
  await uow.commit();
  assertEquals(sink.landed.length, 1);
  const [commit] = sink.landed;
  assertEquals(commit.seq, 1);
  assertEquals(commit.namespace, "");
  assertEquals(commit.writer, WRITER);
  assertEquals(commit.fence, 3);
  assertEquals(commit.at, AT.toISOString());
  assertEquals(commit.ops.map((op) => op.kind), ["put", "data-version", "put"]);
  assertStrictEquals(commit.ops[0], a);
  assertEquals(uow.stagedOps().length, 3);
  assertEquals(uow.staged(), []);
});

Deno.test("createCommitLogUnitOfWork: the run partition commits last, the others in first-touched order", async () => {
  const sink = new MemorySink();
  const other = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "deploy",
  });
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: runPartition(), op: await runPut("r1") });
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({
    partition: other,
    op: tombstoneOp({
      intent: createIntent({
        kind: "definition.delete",
        definition: { kind: "workflow", name: "deploy" },
      }),
      key: dataKey("x", 1),
    }),
  });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r2") });
  await uow.commit();
  assertEquals(sink.appendCalls, [
    MODEL.toString(),
    other.toString(),
    runPartition().toString(),
  ]);
  assertEquals(sink.commitsOf(runPartition())[0].ops.length, 2);
});

Deno.test("createCommitLogUnitOfWork: each partition's commit gets its own txnId", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.commit();
  const [first, second] = sink.landed;
  assert(first.txnId !== second.txnId);
});

Deno.test("createCommitLogUnitOfWork: small content is inlined, larger content is stored as chunks first", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  const small = bytesOf(MAX_INLINE_BYTES);
  const large = bytesOf(MAX_INLINE_BYTES + 1);
  sink.beforeAppend = async (commit) => {
    // Every chunk a commit names is in storage before the commit lands.
    for (const op of commit.ops) {
      if (op.kind === "put" && "blob" in op.content) {
        const parts = op.content.blob.parts ??
          [{ sha256: op.content.blob.sha256 }];
        const present = await options.storage.has(
          "_default",
          parts.map((part) => part.sha256),
          new AbortController().signal,
        );
        assertEquals(present.size, parts.length);
      }
    }
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("small", small));
  await uow.stageOp(pendingPut("large", large));
  await uow.commit();
  const [inline, chunked] = sink.landed[0].ops as PutOp[];
  assert("inline" in inline.content);
  assert("blob" in chunked.content);
  assertEquals(await contentOf(inline, options.storage), small);
  assertEquals(await contentOf(chunked, options.storage), large);
});

Deno.test("createCommitLogUnitOfWork: streamed content above the chunk size lands as the same blob as the equal bytes", async () => {
  const content = bytesOf(100 * 1024);
  const fromBytes = new MemorySink();
  const fromStream = new MemorySink();
  const a = unitOptions(fromBytes, memory());
  const b = unitOptions(fromStream, memory());
  const bytesUnit = createCommitLogUnitOfWork(contextHook(), a);
  await bytesUnit.stageOp(pendingPut("x", content));
  await bytesUnit.commit();
  const streamUnit = createCommitLogUnitOfWork(contextHook(), b);
  await streamUnit.stageOp(
    pendingPut("x", () => streamOf(content, [5, 7000, 3])),
  );
  await streamUnit.commit();
  const left = fromBytes.landed[0].ops[0] as PutOp;
  const right = fromStream.landed[0].ops[0] as PutOp;
  assert("blob" in left.content && "blob" in right.content);
  assert(left.content.blob.equals(right.content.blob));
  assert((right.content.blob.parts?.length ?? 0) > 1);
  assertEquals(await contentOf(right, b.storage), content);
});

Deno.test("createCommitLogUnitOfWork: streamed content within the inline limit is inlined", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  const content = bytesOf(MAX_INLINE_BYTES);
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("x", () => streamOf(content, [100, 100])));
  await uow.commit();
  const op = sink.landed[0].ops[0] as PutOp;
  assert("inline" in op.content);
  assertEquals(await contentOf(op, options.storage), content);
  assertEquals(options.storage.puts(), 0);
});

/** Storage whose next put fails. */
class FlakyStorage extends MemoryStorage {
  failNextPut = false;
  override put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error("bucket unreachable"));
    }
    return super.put(namespace, sha256, bytes, signal);
  }
}

Deno.test("createCommitLogUnitOfWork: an upload that fails partway is retried from a fresh stream and lands once", async () => {
  const sink = new MemorySink();
  const storage = new FlakyStorage({ maxChunkBytes: 32 * 1024 });
  const options = unitOptions(sink, storage);
  const content = bytesOf(100 * 1024);
  let opened = 0;
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("x", () => {
    opened++;
    return streamOf(content, [4096]);
  }));
  storage.failNextPut = true;
  await assertRejects(() => uow.checkpoint(), Error, "bucket unreachable");
  assertEquals(sink.landed, []);
  await uow.commit();
  assertEquals(opened, 2);
  assertEquals(sink.landed.length, 1);
  assertEquals(
    await contentOf(sink.landed[0].ops[0] as PutOp, storage),
    content,
  );
});

Deno.test("createCommitLogUnitOfWork: a source that throws surfaces unchanged and stays pending", async () => {
  const sink = new MemorySink();
  const failure = new Error("file gone");
  let fail = true;
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp(pendingPut("x", () => {
    if (fail) throw failure;
    return streamOf(bytesOf(10));
  }));
  const error = await assertRejects(() => uow.checkpoint());
  assertStrictEquals(error, failure);
  fail = false;
  await uow.commit();
  assertEquals(sink.landed.length, 1);
});

Deno.test("createCommitLogUnitOfWork: a retry after an append that landed but failed reports duplicate and lands once", async () => {
  const sink = new MemorySink();
  let fail = true;
  sink.afterAppend = () => {
    if (fail) {
      fail = false;
      throw new Error("connection lost after commit");
    }
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint(), Error, "connection lost");
  assertEquals(sink.landed.length, 1);
  await uow.commit();
  assertEquals(sink.landed.length, 1);
  assertEquals(sink.appendCalls.length, 2);
});

Deno.test("createCommitLogUnitOfWork: a failed head read releases the partition lock and keeps the group pending", async () => {
  const sink = new MemorySink();
  let fail = true;
  sink.beforeHead = () => {
    if (fail) {
      fail = false;
      throw new Error("store closed");
    }
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint(), Error, "store closed");
  assertEquals(partitionLockCountForTesting(sink), 0);
  await uow.commit();
  assertEquals(sink.landed.length, 1);
  assertEquals(partitionLockCountForTesting(sink), 0);
});

Deno.test("createCommitLogUnitOfWork: a refusal surfaces unchanged and later partitions are not appended", async () => {
  const sink = new MemorySink();
  await sink.append(
    modelCommit(1, [await savePut("seed", 1)], { fence: 5 }),
  );
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { fence: 3 }),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  const error = await assertRejects(() => uow.commit(), CommitRejectedError);
  assertEquals(error.reason, "stale-fence");
  assertEquals(sink.appendCalls, [MODEL.toString(), MODEL.toString()]);
  assertEquals(sink.commitsOf(runPartition()), []);
});

Deno.test("createCommitLogUnitOfWork: partitions committed before a failure stay committed", async () => {
  const sink = new MemorySink();
  sink.beforeAppend = (commit) => {
    if (commit.partition.equals(runPartition())) throw new Error("disk full");
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.commit(), Error, "disk full");
  assertEquals(sink.commitsOf(MODEL).length, 1);
  assertEquals(sink.commitsOf(runPartition()), []);
});

Deno.test("createCommitLogUnitOfWork: abandon discards, and stores no content", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("large", bytesOf(MAX_INLINE_BYTES * 4)));
  await uow.abandon();
  assertEquals(sink.appendCalls, []);
  assertEquals(options.storage.puts(), 0);
  await assertRejects(() => uow.commit(), Error, "already abandoned");
});

Deno.test("createCommitLogUnitOfWork: abandon after a failed checkpoint appends nothing", async () => {
  const sink = new MemorySink();
  let fail = true;
  sink.beforeAppend = () => {
    if (fail) throw new Error("disk full");
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.checkpoint(), Error, "disk full");
  fail = false;
  await uow.abandon();
  assertEquals(sink.landed, []);
  assertEquals(sink.appendCalls.length, 1);
});

Deno.test("createCommitLogUnitOfWork: checkpoint commits what is staged and keeps the unit open", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.checkpoint();
  assertEquals(sink.landed.map((commit) => commit.seq), [1]);
  await uow.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await uow.commit();
  assertEquals(sink.landed.map((commit) => commit.seq), [1, 2]);
  await assertRejects(() => uow.checkpoint(), Error, "after the unit");
});

Deno.test("createCommitLogUnitOfWork: a child's commit rolls its changes up into the root, which commits them", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await child.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await child.commit();
  assertEquals(sink.appendCalls, []);
  await root.commit();
  assertEquals(sink.landed.length, 1);
  assertEquals(sink.landed[0].ops.length, 2);
});

Deno.test("createCommitLogUnitOfWork: a child's abandon discards its changes, and the root's survive", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await child.stageOp({ partition: runPartition(), op: await runPut("r") });
  await child.abandon();
  await root.commit();
  assertEquals(sink.appendCalls, [MODEL.toString()]);
});

Deno.test("createCommitLogUnitOfWork: checkpoint on a child throws; its root commits", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await assertRejects(() => child.checkpoint(), Error, "its root commits");
});

Deno.test("createCommitLogUnitOfWork: a unit over another hook is a root, not a child", () => {
  const sink = new MemorySink();
  const root = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  assertStrictEquals(commitLogParentFor(contextHook(), root), undefined);
});

Deno.test("createCommitLogUnitOfWork: a child whose changes would take the root over MAX_COMMIT_OPS hands it none of them", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  const op = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "a" }),
    key: dataKey("a", 1),
  });
  for (let i = 0; i < MAX_COMMIT_OPS - 2; i++) {
    await root.stageOp({ partition: MODEL, op });
  }
  for (let i = 0; i < 5; i++) await child.stageOp({ partition: MODEL, op });
  await assertRejects(
    () => child.commit(),
    Error,
    "checkpoint before staging more",
  );
  assertEquals(root.stagedOps().length, MAX_COMMIT_OPS - 2);
});

Deno.test("createCommitLogUnitOfWork: a refused partition is dropped, so the next checkpoint commits the partitions after it", async () => {
  const sink = new MemorySink();
  await sink.append(
    modelCommit(1, [await savePut("seed", 1)], { fence: 5 }),
  );
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { fence: 3 }),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await assertRejects(() => uow.checkpoint(), CommitRejectedError);
  await uow.commit();
  assertEquals(sink.commitsOf(runPartition()).length, 1);
  assertEquals(sink.commitsOf(MODEL).length, 1);
});

Deno.test("createCommitLogUnitOfWork: a seq gap keeps the partition pending, and the next checkpoint lands it at the new head", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  let raced = false;
  sink.beforeAppend = async () => {
    if (raced) return;
    raced = true;
    // Another writer appends between this unit's head read and its append.
    await sink.append(modelCommit(1, [await savePut("other", 1)], {
      txnId: "other-writer",
    }));
  };
  const error = await assertRejects(
    () => uow.checkpoint(),
    CommitRejectedError,
  );
  assertEquals(error.reason, "seq-gap");
  await uow.commit();
  assertEquals(sink.commitsOf(MODEL).map((commit) => commit.seq), [1, 2]);
});

Deno.test("createCommitLogUnitOfWork: a failed commit ends the unit, so retrying means checkpointing first", async () => {
  const sink = new MemorySink();
  let fail = true;
  sink.beforeAppend = () => {
    if (fail) throw new Error("disk full");
  };
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await assertRejects(() => uow.commit(), Error, "disk full");
  fail = false;
  await assertRejects(() => uow.commit(), Error, "already committed");
  await assertRejects(() => uow.checkpoint(), Error, "after the unit");
  assertEquals(sink.landed, []);
});

Deno.test("createCommitLogUnitOfWork: a change staged on an ended child goes to its open root", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await child.commit();
  await child.stageOp({ partition: MODEL, op: await savePut("late", 1) });
  await root.commit();
  assertEquals(sink.landed[0].ops.length, 1);
});

Deno.test("createCommitLogUnitOfWork: a change staged on an abandoned child is refused, not rolled up", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await child.abandon();
  await assertRejects(
    async () =>
      child.stageOp({ partition: MODEL, op: await savePut("late", 1) }),
    Error,
    "already abandoned",
  );
  await root.commit();
  assertEquals(sink.appendCalls, []);
});

Deno.test("createCommitLogUnitOfWork: a pending put with a bad expect is refused where it is staged", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  const change = pendingPut("a", bytesOf(4));
  await assertRejects(() =>
    uow.stageOp({
      ...change,
      put: { ...change.put, expect: { sha256: "not-a-digest" } },
    })
  );
  assertEquals(uow.stagedOps(), []);
});

Deno.test("createCommitLogUnitOfWork: bytes are copied when staged, so reusing the buffer changes nothing", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  const buffer = bytesOf(16);
  const original = buffer.slice();
  await uow.stageOp(pendingPut("a", buffer));
  buffer.fill(0);
  await uow.commit();
  assertEquals(
    await contentOf(sink.landed[0].ops[0] as PutOp, options.storage),
    original,
  );
});

Deno.test("createCommitLogUnitOfWork: a change staged on an ended root is refused", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  await uow.commit();
  await assertRejects(
    async () => uow.stageOp({ partition: MODEL, op: await savePut("late", 1) }),
    Error,
    "already committed",
  );
});

Deno.test("createCommitLogUnitOfWork: a path-only change is refused, naming it", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  const error = await assertRejects(
    () => uow.stage({ kind: "write", path: "/cache/data/a/raw" }),
    PathOnlyChangeRefusedError,
  );
  assertEquals(
    error.message,
    "A datastore write of /cache/data/a/raw was staged without its intent " +
      "and content; a v3 datastore commits only typed changes, so it was " +
      "refused",
  );
  assertEquals(uow.staged(), []);
});

Deno.test("createCommitLogUnitOfWork: a change for another partition is refused where it is staged", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  await assertRejects(
    async () =>
      uow.stageOp({ partition: runPartition(), op: await savePut("a", 1) }),
    Error,
    "was staged for partition",
  );
  await assertRejects(
    () =>
      uow.stageOp({
        partition: runPartition(),
        put: pendingPut("a", bytesOf(4)).put,
      }),
    Error,
    "was staged for partition",
  );
  assertEquals(uow.stagedOps(), []);
});

Deno.test("createCommitLogUnitOfWork: a lease op is refused", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  await assertRejects(
    () =>
      uow.stageOp({
        partition: MODEL,
        op: leaseOp({ holder: "a", fence: 1 }),
      }),
    Error,
    "lease machinery",
  );
});

Deno.test("createCommitLogUnitOfWork: more than MAX_COMMIT_OPS changes to one partition are refused at stage", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  const op = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "a" }),
    key: dataKey("a", 1),
  });
  for (let i = 0; i < MAX_COMMIT_OPS; i++) {
    await uow.stageOp({ partition: MODEL, op });
  }
  await assertRejects(
    () => uow.stageOp({ partition: MODEL, op }),
    Error,
    "checkpoint before staging more",
  );
});

Deno.test("createCommitLogUnitOfWork: two units committing one partition at once take consecutive seqs", async () => {
  const sink = new MemorySink();
  const first = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const second = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await first.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await second.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await Promise.all([first.commit(), second.commit()]);
  assertEquals(sink.landed.map((commit) => commit.seq), [1, 2]);
  assertEquals(partitionLockCountForTesting(sink), 0);
});

Deno.test("createCommitLogUnitOfWork: binds the unit to its hook", () => {
  const hook = contextHook();
  const uow = createCommitLogUnitOfWork(
    hook,
    unitOptions(new MemorySink(), memory()),
  );
  assertStrictEquals(unitOfWorkBinding.boundHook(uow), hook);
});

Deno.test("createCommitLogUnitOfWork: an aborted signal rejects a commit that stores content", async () => {
  const controller = new AbortController();
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { signal: controller.signal }),
  );
  await uow.stageOp(pendingPut("x", bytesOf(MAX_INLINE_BYTES * 2)));
  controller.abort(new Error("timed out"));
  await assertRejects(() => uow.commit(), Error, "timed out");
  assertEquals(sink.appendCalls, []);
});
