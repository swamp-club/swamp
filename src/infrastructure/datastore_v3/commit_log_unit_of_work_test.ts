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
  putOp,
  tombstoneOp,
} from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import {
  DATA_ID,
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
import {
  type ContentSource,
  PartitionsRefusedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  unitOfWorkBinding,
  unitWrites,
} from "../persistence/unit_of_work_binding.ts";
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
  RUN_ID,
  runIntent,
  runPartition,
  runPut,
  unitOptions,
  WORKFLOW_ID,
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
  content: ContentSource,
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

Deno.test("createCommitLogUnitOfWork: a child that takes the root past MAX_COMMIT_OPS commits as several commits (swamp-club#3250)", async () => {
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
  // Five batches of one, handed up batch by batch.
  for (let i = 0; i < 5; i++) await child.stageOp({ partition: MODEL, op });
  await child.commit();
  assertEquals(root.stagedOps().length, MAX_COMMIT_OPS + 3);
  await root.commit();
  assertEquals(
    sink.commitsOf(MODEL).map((commit) => commit.ops.length),
    [MAX_COMMIT_OPS, 3],
  );
  assertEquals(new Set(sink.commitsOf(MODEL).map((c) => c.txnId)).size, 2);
});

Deno.test("createCommitLogUnitOfWork: a child's batch is never split when it is handed up", async () => {
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
  await child.stageOps([
    { partition: MODEL, op },
    { partition: MODEL, op },
    { partition: MODEL, op },
  ]);
  await child.commit();
  await root.commit();
  assertEquals(
    sink.commitsOf(MODEL).map((commit) => commit.ops.length),
    [MAX_COMMIT_OPS - 2, 3],
  );
});

/** A unit whose model partition is refused (stale fence) at its next flush. */
async function refusingModel() {
  const sink = new MemorySink();
  await sink.append(
    modelCommit(1, [await savePut("seed", 1)], { fence: 5 }),
  );
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory(), { fence: 3 }),
  );
  await uow.stageOps([
    { partition: MODEL, op: await savePut("a", 1) },
    { partition: MODEL, op: versionOp("a", 1) },
  ]);
  return { sink, uow };
}

const AUTO_ID = "55555555-5555-4555-8555-555555555555";
const AUTO = partitionOf({ kind: "definition", id: AUTO_ID });

/** A put in an auto-definition partition, which no fence refuses here. */
function autoPut(): Promise<PutOp> {
  return putOp({
    intent: createIntent({
      kind: "auto-definition.save",
      autoDefinition: { id: AUTO_ID },
    }),
    key: RecordKey.create(`auto-definitions/${AUTO_ID}.yaml`),
    inline: btoa("auto"),
  });
}

Deno.test("createCommitLogUnitOfWork: a refused partition holds the run records back for the unit's life, until acknowledged (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  const error = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  // Still a CommitRejectedError with the refusal's reason.
  assert(error instanceof CommitRejectedError);
  assertEquals(error.reason, "stale-fence");
  assertEquals(
    error.refusals.map((r) => [r.partition.toString(), r.reason, r.versions]),
    [[MODEL.toString(), "stale-fence", [{ dataId: DATA_ID, version: 1 }]]],
  );
  assertEquals(error.heldRuns.map(String), [runPartition().toString()]);
  // A later save of the run still names what the refusal dropped: held too.
  await uow.stageOp({ partition: runPartition(), op: await runPut("r2") });
  const again = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assertEquals(again.refusals.map((r) => r.partition.toString()), [
    MODEL.toString(),
  ]);
  assertEquals(sink.commitsOf(runPartition()), []);
  uow.acknowledgeRefusals();
  await uow.commit();
  assertEquals(sink.commitsOf(runPartition()).length, 2);
  assertEquals(sink.commitsOf(MODEL).length, 1);
});

Deno.test("createCommitLogUnitOfWork: after a refusal the flush still commits the other partitions (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  await uow.stageOp({ partition: AUTO, op: await autoPut() });
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  assertEquals(sink.commitsOf(AUTO).length, 1);
});

Deno.test("createCommitLogUnitOfWork: a root that commits without acknowledging throws the refusal and commits no run record (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  const error = await assertRejects(
    () => uow.commit(),
    PartitionsRefusedError,
  );
  assertEquals(error.heldRuns.map(String), [runPartition().toString()]);
  assertEquals(sink.commitsOf(runPartition()), []);
});

Deno.test("createCommitLogUnitOfWork: a re-save of a held run supersedes the held record, and the run's other changes commit with it (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  const key = RecordKey.create(
    `workflow-runs/${WORKFLOW_ID}/workflow-run-${RUN_ID}.yaml`,
  );
  const runRecord = (source: ContentSource) => ({
    partition: runPartition(),
    put: { intent: runIntent(), key, content: source },
  });
  const held = countedStream(new TextEncoder().encode("names refused data"));
  await uow.stageOp(runRecord(held));
  // Another key of the run's partition, as its snapshot is.
  await uow.stageOp({
    partition: runPartition(),
    op: await runPut("snapshot"),
  });
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  await uow.stageOp(runRecord(new TextEncoder().encode("step failed")));
  uow.acknowledgeRefusals();
  await uow.commit();
  assertEquals(held.opened, 0);
  // The held group (now just the snapshot) commits, then the re-save.
  assertEquals(
    sink.commitsOf(runPartition()).flatMap((commit) =>
      commit.ops.map((op) => op.kind === "put" ? op.key.toString() : op.kind)
    ),
    [
      `workflow-runs/${WORKFLOW_ID}/${RUN_ID}.yaml`,
      key.toString(),
    ],
  );
});

Deno.test("createCommitLogUnitOfWork: an unacknowledged refusal is reported with every later one, and every flush throws until acknowledged (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  // The caller carried on; nothing new is refused, but the flush still says
  // so, since the refusal was never acknowledged.
  await uow.stageOp({ partition: AUTO, op: await autoPut() });
  const again = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assertEquals(sink.commitsOf(AUTO).length, 1);
  assertEquals(again.refusals.map((r) => r.partition.toString()), [
    MODEL.toString(),
  ]);
  // A second refusal of the same partition is listed with the first.
  await uow.stageOps([
    { partition: MODEL, op: await savePut("b", 1) },
    { partition: MODEL, op: versionOp("b", 1) },
  ]);
  const both = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assertEquals(both.refusals.length, 2);
  uow.acknowledgeRefusals();
  await uow.commit();
});

Deno.test("createCommitLogUnitOfWork: a transient failure after a refusal in the same flush surfaces the refusal, with the failure as its cause (swamp-club#3257)", async () => {
  const { sink, uow } = await refusingModel();
  await uow.stageOp({ partition: AUTO, op: await autoPut() });
  let fail = true;
  sink.beforeAppend = (commit) => {
    if (fail && commit.partition.equals(AUTO)) throw new Error("disk full");
  };
  const error = await assertRejects(
    () => uow.checkpoint(),
    PartitionsRefusedError,
  );
  assertEquals(error.refusals.map((r) => r.partition.toString()), [
    MODEL.toString(),
  ]);
  assert(error.cause instanceof Error);
  assertEquals(error.cause.message, "disk full");
  // The failed group stays pending and lands once the refusal is settled.
  fail = false;
  uow.acknowledgeRefusals();
  await uow.commit();
  assertEquals(sink.commitsOf(AUTO).length, 1);
});

Deno.test("createCommitLogUnitOfWork: only a root acknowledges refusals, and abandon forgets them (swamp-club#3257)", async () => {
  const hook = contextHook();
  const sink = new MemorySink();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const child = createCommitLogUnitOfWork(hook, {
    ...unitOptions(sink, memory()),
    parent: root,
  });
  try {
    await assertRejects(
      () => Promise.resolve().then(() => child.acknowledgeRefusals()),
      Error,
      "child unit of work",
    );
  } finally {
    await child.abandon();
    await root.abandon();
  }
  const { uow } = await refusingModel();
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  await uow.abandon();
});

/** Makes another writer append to MODEL before each of the next `n` appends. */
function raceNext(sink: MemorySink, n: number): void {
  let left = n;
  let inside = false;
  sink.beforeAppend = async () => {
    if (left === 0 || inside) return;
    left--;
    inside = true;
    try {
      const head = await sink.head("", MODEL);
      await sink.append(modelCommit(head.seq + 1, [await savePut("other", 1)], {
        txnId: crypto.randomUUID(),
      }));
    } finally {
      inside = false;
    }
  };
}

Deno.test("createCommitLogUnitOfWork: a seq gap is retried at the new head within the same flush", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  raceNext(sink, 1);
  await uow.commit();
  assertEquals(sink.commitsOf(MODEL).map((commit) => commit.seq), [1, 2]);
});

Deno.test("createCommitLogUnitOfWork: a seq gap on every attempt keeps the partition pending for the next checkpoint", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  raceNext(sink, 2);
  const error = await assertRejects(
    () => uow.checkpoint(),
    CommitRejectedError,
  );
  assertEquals(error.reason, "seq-gap");
  await uow.commit();
  assertEquals(sink.commitsOf(MODEL).map((commit) => commit.seq), [1, 2, 3]);
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

Deno.test("createCommitLogUnitOfWork: a partition past MAX_COMMIT_OPS commits as several commits, split between batches (swamp-club#3250)", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const op = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "a" }),
    key: dataKey("a", 1),
  });
  for (let i = 0; i < MAX_COMMIT_OPS; i++) {
    await uow.stageOp({ partition: MODEL, op });
  }
  await uow.stageOps([{ partition: MODEL, op }, { partition: MODEL, op }]);
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.commit();
  assertEquals(
    sink.commitsOf(MODEL).map((commit) => commit.ops.length),
    [MAX_COMMIT_OPS, 2],
  );
  // The run partition still commits last.
  assertEquals(sink.landed.at(-1)?.partition.kind, "run");
});

Deno.test("createCommitLogUnitOfWork: one batch over MAX_COMMIT_OPS for a partition is refused at stage", async () => {
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), memory()),
  );
  const op = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "a" }),
    key: dataKey("a", 1),
  });
  await assertRejects(
    () =>
      uow.stageOps(
        Array.from({ length: MAX_COMMIT_OPS + 1 }, () => ({
          partition: MODEL,
          op,
        })),
      ),
    Error,
    "stage it as smaller batches",
  );
  assertEquals(uow.stagedOps(), []);
});

Deno.test("createCommitLogUnitOfWork: a refused split drops the splits formed with it, not later groups", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const op = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "a" }),
    key: dataKey("a", 1),
  });
  // The first split carries a put that must create a key the second
  // batch of fillers never touches; a seeded record makes it refuse.
  await sink.append(modelCommit(1, [await savePut("seed", 1)]));
  await uow.stageOp({
    partition: MODEL,
    op: await savePut("seed", 1, "again", "absent"),
  });
  for (let i = 0; i < MAX_COMMIT_OPS; i++) {
    await uow.stageOp({ partition: MODEL, op });
  }
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await assertRejects(() => uow.checkpoint(), CommitRejectedError);
  // The second split was formed with the refused one: dropped. The run
  // partition, formed in the same flush, is held until the refusal is
  // acknowledged (swamp-club#3257).
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  assertEquals(sink.commitsOf(MODEL).length, 1);
  assertEquals(sink.commitsOf(runPartition()), []);
  // A batch staged after the refusal forms a group of its own and lands.
  await uow.stageOp({ partition: MODEL, op: await savePut("later", 1) });
  uow.acknowledgeRefusals();
  await uow.commit();
  assertEquals(sink.commitsOf(MODEL).length, 2);
  assertEquals(sink.commitsOf(runPartition()).length, 1);
});

/** A stream source that counts how often it was opened. */
function countedStream(bytes: Uint8Array) {
  const source = Object.assign(
    () => {
      source.opened++;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    { opened: 0 },
  );
  return source;
}

Deno.test("createCommitLogUnitOfWork: a stream put superseded by a later tombstone of its key is never read", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const source = countedStream(bytesOf(20_000));
  await uow.stageOp(pendingPut("a", source));
  await uow.stageOp({ partition: MODEL, op: versionOp("a", 1) });
  await uow.stageOp({
    partition: MODEL,
    op: tombstoneOp({
      intent: modelIntent({ kind: "data.gc", name: "a", version: 1 }),
      key: dataKey("a", 1),
    }),
  });
  await uow.commit();
  assertEquals(source.opened, 0);
  assertEquals(
    sink.landed[0].ops.map((op) => op.kind),
    ["data-version", "tombstone"],
  );
  // stagedOps still reports every change staged.
  assertEquals(uow.stagedOps().length, 3);
});

Deno.test("createCommitLogUnitOfWork: a stream put superseded by a later put of its key, or one in a later child, is never read", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(hook, unitOptions(sink, memory()));
  const first = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  const source = countedStream(bytesOf(20_000));
  await first.stageOp(pendingPut("a", source));
  await first.commit();
  const second = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root }),
  );
  await second.stageOp(pendingPut("a", new TextEncoder().encode("small")));
  await second.commit();
  await root.commit();
  assertEquals(source.opened, 0);
  assertEquals(sink.landed[0].ops.length, 1);
});

Deno.test("createCommitLogUnitOfWork: a put with an expect is never elided, nor one a later expect relies on", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const source = countedStream(new TextEncoder().encode("a"));
  await uow.stageOp(pendingPut("a", source));
  await uow.stageOp({
    partition: MODEL,
    op: tombstoneOp({
      intent: modelIntent({ kind: "data.delete", name: "a", version: 1 }),
      key: dataKey("a", 1),
      expect: "present",
    }),
  });
  await uow.commit();
  assertEquals(source.opened, 1);
  assertEquals(sink.landed[0].ops.map((op) => op.kind), ["put", "tombstone"]);
});

Deno.test("createCommitLogUnitOfWork: a retry reuses the content stored the first time", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  const source = countedStream(bytesOf(20_000, 1));
  await uow.stageOp(pendingPut("a", source));
  let failures = 1;
  sink.beforeAppend = () => {
    if (failures-- > 0) throw new Error("append failed");
  };
  await assertRejects(() => uow.checkpoint(), Error, "append failed");
  assertEquals(source.opened, 1);
  await uow.commit();
  // The file behind the stream may be gone by now; the retry never reads it.
  assertEquals(source.opened, 1);
  assertEquals(sink.commitsOf(MODEL).length, 1);
});

Deno.test("createCommitLogUnitOfWork: a pending put superseded before it is stored is elided, and its emptied group dropped", async () => {
  const sink = new MemorySink();
  const storage = new FlakyStorage({ maxChunkBytes: 32 * 1024 });
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, storage),
  );
  const source = countedStream(bytesOf(20_000, 4));
  await uow.stageOp(pendingPut("a", source));
  storage.failNextPut = true;
  await assertRejects(() => uow.checkpoint(), Error, "bucket unreachable");
  assertEquals(source.opened, 1);
  // A prune removes the file and stages its tombstone while the put waits.
  await uow.stageOp({
    partition: MODEL,
    op: tombstoneOp({
      intent: modelIntent({ kind: "data.gc", name: "a", version: 1 }),
      key: dataKey("a", 1),
    }),
  });
  await uow.commit();
  assertEquals(source.opened, 1);
  assertEquals(
    sink.commitsOf(MODEL).map((commit) => commit.ops.map((op) => op.kind)),
    [["tombstone"]],
  );
});

Deno.test("createCommitLogUnitOfWork: a put superseded while its group is being appended is skipped, not a wedged checkpoint", async () => {
  const sink = new MemorySink();
  const uow = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, memory()),
  );
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  // The stream opens once the test lets it, then finds its file removed.
  await uow.stageOp(pendingPut("a", async () => {
    reading();
    await opened;
    throw new Deno.errors.NotFound("raw was pruned");
  }));
  const checkpoint = uow.checkpoint();
  await started;
  await uow.stageOp({
    partition: MODEL,
    op: tombstoneOp({
      intent: modelIntent({ kind: "data.gc", name: "a", version: 1 }),
      key: dataKey("a", 1),
    }),
  });
  release();
  await checkpoint;
  await uow.commit();
  assertEquals(
    sink.commitsOf(MODEL).map((commit) => commit.ops.map((op) => op.kind)),
    [["tombstone"]],
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

/** Deletes every chunk a commit names, as a chunk sweep could. */
async function deleteChunksOf(
  commit: { ops: readonly unknown[] },
  storage: MemoryStorage,
): Promise<string[]> {
  const gone: string[] = [];
  for (const op of commit.ops as PutOp[]) {
    if (op.kind !== "put" || !("blob" in op.content)) continue;
    for (const sha256 of op.content.blob.chunkHashes()) {
      await storage.delete("_default", sha256, new AbortController().signal);
      gone.push(sha256);
    }
  }
  return gone;
}

Deno.test("createCommitLogUnitOfWork: chunks a sweep deleted after they were stored but before the commit landed are stored again once it lands", async () => {
  for (
    const source of [
      bytesOf(100 * 1024),
      () => streamOf(bytesOf(100 * 1024), [5, 7000]),
    ]
  ) {
    const sink = new MemorySink();
    const options = unitOptions(sink, memory());
    let deleted: string[] = [];
    // Between the unit's has()/touch() and its append, a sweep deletes the
    // chunks after its re-check, so only the writer can restore them.
    sink.beforeAppend = async (commit) => {
      deleted = await deleteChunksOf(commit, options.storage);
    };
    const uow = createCommitLogUnitOfWork(contextHook(), options);
    await uow.stageOp(pendingPut("x", source));
    await uow.commit();

    assert(deleted.length > 1);
    const present = await options.storage.has(
      "_default",
      deleted,
      new AbortController().signal,
    );
    assertEquals(present.size, deleted.length);
    assertEquals(
      await contentOf(sink.landed[0].ops[0] as PutOp, options.storage),
      bytesOf(100 * 1024),
    );
  }
});

Deno.test("createCommitLogUnitOfWork: a retried commit that lands as a duplicate also has its missing chunks stored again", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  let fail = true;
  sink.afterAppend = async (commit) => {
    // The append lands but the call fails, and a sweep deletes the chunks.
    if (!fail) return;
    fail = false;
    await deleteChunksOf(commit, options.storage);
    throw new Error("lost reply");
  };
  // The retry re-stores content before its append; delete it again there.
  let retried = false;
  sink.beforeAppend = async (commit) => {
    if (fail) return;
    retried = true;
    await deleteChunksOf(commit, options.storage);
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("x", bytesOf(100 * 1024)));
  await assertRejects(() => uow.checkpoint(), Error, "lost reply");
  await uow.commit();

  assert(retried);
  assertEquals(sink.landed.length, 1);
  assertEquals(
    await contentOf(sink.landed[0].ops[0] as PutOp, options.storage),
    bytesOf(100 * 1024),
  );
});

Deno.test("createCommitLogUnitOfWork: a source that changed cannot restore a deleted chunk; the landed commit stands, with a warning (swamp-club#3586)", async () => {
  const sink = new MemorySink();
  const options = unitOptions(sink, memory());
  let calls = 0;
  sink.beforeAppend = async (commit) => {
    await deleteChunksOf(commit, options.storage);
  };
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(
    pendingPut("x", () => streamOf(bytesOf(100 * 1024, ++calls))),
  );
  // It landed: failing the unit would drop work that is committed.
  await uow.commit();
  assertEquals(sink.landed.length, 1);
});

Deno.test("createCommitLogUnitOfWork: a commit whose chunks are all present checks them once and stores nothing again", async () => {
  const sink = new MemorySink();
  const storage = memory();
  const options = unitOptions(sink, storage);
  const uow = createCommitLogUnitOfWork(contextHook(), options);
  await uow.stageOp(pendingPut("x", bytesOf(100 * 1024)));
  await uow.stageOp(pendingPut("small", bytesOf(10)));
  const putsBefore = storage.puts();
  await uow.commit();
  const hasCalls = storage.calls.filter((c) => c.startsWith("has "));
  // One has() per chunk while storing, then one for the landed blob; the
  // inline put adds none.
  const parts = (sink.landed[0].ops[0] as PutOp).content;
  assert("blob" in parts);
  assertEquals(hasCalls.length, parts.blob.chunkHashes().length + 1);
  assertEquals(storage.puts() - putsBefore, parts.blob.chunkHashes().length);
});

/** A unit tracker that records what it is told (swamp-club#3553). */
function recordingTracker() {
  const seen = { open: 0, dropped: [] as number[] };
  return {
    seen,
    tracker: {
      opened: () => {
        seen.open++;
      },
      ended: () => {
        seen.open--;
      },
      dropped: (openedAt: number) => {
        seen.dropped.push(openedAt);
      },
    },
  };
}

for (const reason of ["version-live", "version-reused"] as const) {
  Deno.test(`createCommitLogUnitOfWork: a ${reason} refusal reports dropped work at the root's open time (swamp-club#3553)`, async () => {
    const sink = new MemorySink();
    sink.beforeAppend = () => {
      throw new CommitRejectedError(reason, `refused (${reason})`);
    };
    const { seen, tracker } = recordingTracker();
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, memory(), { tracker }),
    );
    assertEquals(seen.open, 1);
    await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
    await assertRejects(() => uow.commit(), PartitionsRefusedError);
    // Told at the refusal and again as the root's end fails: the handle
    // keeps the earliest time, so a repeat costs nothing.
    assert(seen.dropped.length > 0);
    assertEquals(new Set(seen.dropped), new Set([AT.getTime()]));
    assertEquals(seen.open, 0);
  });
}

Deno.test("createCommitLogUnitOfWork: a root refused after a child's commit rolled up into it reports dropped work (swamp-club#3553)", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const { seen, tracker } = recordingTracker();
  const root = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root, tracker }),
  );
  await child.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await child.commit();
  assertEquals(seen.dropped, []);
  sink.beforeAppend = () => {
    throw new Error("the writer lease was lost");
  };
  await assertRejects(() => root.commit(), Error, "lease was lost");
  assertEquals(seen.dropped, [AT.getTime()]);
  assertEquals(seen.open, 0);
});

Deno.test("createCommitLogUnitOfWork: an abandon reports dropped work only when a repository wrote into the unit (swamp-club#3553)", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const { seen, tracker } = recordingTracker();
  const untouched = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  await untouched.abandon();
  assertEquals(seen.dropped, []);

  // A write signal with nothing staged yet: the files were written.
  const written = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  unitWrites.signal(written);
  await written.abandon();
  assertEquals(seen.dropped.length, 1);

  const staged = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  await staged.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await staged.abandon();
  assertEquals(seen.dropped.length, 2);
  assertEquals(seen.open, 0);
});

Deno.test("createCommitLogUnitOfWork: a change refused on an abandoned child reports dropped work; a clean commit reports none (swamp-club#3553)", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const { seen, tracker } = recordingTracker();
  const root = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  const child = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { parent: root, tracker }),
  );
  await child.abandon();
  assertEquals(seen.dropped, []);
  await assertRejects(
    async () =>
      child.stageOp({ partition: MODEL, op: await savePut("late", 1) }),
    Error,
    "already abandoned",
  );
  assertEquals(seen.dropped, [AT.getTime()]);

  const clean = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, memory(), { tracker }),
  );
  await clean.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await clean.commit();
  await root.commit();
  assertEquals(seen.dropped.length, 1);
  assertEquals(seen.open, 0);
});
