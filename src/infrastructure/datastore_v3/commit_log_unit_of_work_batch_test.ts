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
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { createIntent } from "../../domain/datastore_v3/intent.ts";
import { MAX_COMMIT_OPS } from "../../domain/datastore_v3/commit.ts";
import { tombstoneOp } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import {
  dataKey,
  MemoryStorage,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import {
  commandLanded,
  resetCommandLandedForTesting,
} from "./command_landed.ts";
import {
  BatchMemorySink,
  contextHook,
  runPartition,
  runPut,
  unitOptions,
} from "./commit_log_test_helpers.ts";

const MODEL = modelPartition();
const CONFIG = partitionOf({
  kind: "config",
  definitionKind: "workflow",
  name: "deploy",
});

function configDelete() {
  return tombstoneOp({
    intent: createIntent({
      kind: "definition.delete",
      definition: { kind: "workflow", name: "deploy" },
    }),
    key: dataKey("x", 1),
  });
}

async function stageThree(
  uow: ReturnType<typeof createCommitLogUnitOfWork>,
): Promise<void> {
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({ partition: CONFIG, op: configDelete() });
}

function unit(sink: BatchMemorySink) {
  return createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(sink, new MemoryStorage()),
  );
}

Deno.test("commit-log batches: a flush sends its partitions' commits in one batch, in their order, the run partition last", async () => {
  const sink = new BatchMemorySink();
  const uow = unit(sink);
  await stageThree(uow);
  await uow.commit();
  assertEquals(sink.batches, [{
    partitions: [
      MODEL.toString(),
      CONFIG.toString(),
      runPartition().toString(),
    ],
  }]);
  assertEquals(sink.landed.length, 3);
});

Deno.test("commit-log batches: a partition's later split never travels with a run commit ahead of it", async () => {
  const sink = new BatchMemorySink();
  const uow = unit(sink);
  // two batches over the limit together split the partition in two
  const half = Math.ceil(MAX_COMMIT_OPS / 2) + 1;
  await uow.stageOps(
    await Promise.all(
      Array.from({ length: half }, async (_, i) => ({
        partition: MODEL,
        op: await savePut(`a${i}`, 1),
      })),
    ),
  );
  await uow.stageOps(
    await Promise.all(
      Array.from({ length: half }, async (_, i) => ({
        partition: MODEL,
        op: await savePut(`b${i}`, 1),
      })),
    ),
  );
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.commit();
  // the second split and the run record go together only once the first landed
  assertEquals(sink.appendCalls, [
    MODEL.toString(),
    MODEL.toString(),
    runPartition().toString(),
  ]);
  assertEquals(sink.batches, [{
    partitions: [MODEL.toString(), runPartition().toString()],
  }]);
});

Deno.test("commit-log batches: a commit refused in a batch drops its partition, holds the run commit, and only what landed counts as landed", async () => {
  resetCommandLandedForTesting();
  const sink = new BatchMemorySink();
  sink.refuse = (commit) =>
    commit.partition.equals(CONFIG)
      ? new CommitRejectedError("lease-lost", "the lease is not held")
      : undefined;
  const uow = unit(sink);
  await stageThree(uow);
  await assertRejects(() => uow.commit(), PartitionsRefusedError);
  assertEquals(sink.landed.map((c) => c.partition.toString()), [
    MODEL.toString(),
  ]);
  assertEquals(commandLanded(), true, "the model's data landed");
  resetCommandLandedForTesting();
});

Deno.test("commit-log batches: when nothing of a batch lands, nothing counts as landed and the run commit is never sent", async () => {
  resetCommandLandedForTesting();
  const sink = new BatchMemorySink();
  sink.refuse = (commit) =>
    commit.partition.equals(runPartition())
      ? undefined
      : new CommitRejectedError("lease-lost", "the lease is not held");
  const uow = unit(sink);
  await stageThree(uow);
  await assertRejects(() => uow.commit(), PartitionsRefusedError);
  assertEquals(sink.landed, []);
  // the config commit, not tried in the batch, is sent on its own after it
  assertEquals(sink.appendCalls, [MODEL.toString(), CONFIG.toString()]);
  assertEquals(commandLanded(), false);
});

Deno.test("commit-log batches: only the final batch of a checkpoint asked to release names the lease", async () => {
  const sink = new BatchMemorySink();
  const uow = unit(sink);
  await uow.stageOp({ partition: MODEL, op: await savePut("a", 1) });
  await uow.stageOp({ partition: MODEL, op: versionOp("a", 1) });
  await uow.checkpoint();
  await uow.stageOp({ partition: MODEL, op: await savePut("b", 1) });
  await uow.stageOp({ partition: runPartition(), op: await runPut("r") });
  await uow.checkpoint({ release: "lease-1" });
  await uow.commit();
  // a single commit with nothing to end goes alone; the released one batches
  assertEquals(sink.batches, [{
    partitions: [MODEL.toString(), runPartition().toString()],
    release: "lease-1",
  }]);
  assertEquals(sink.landed.length, 3);
});

Deno.test("commit-log batches: a round never holds more commits than the sink takes in one batch", async () => {
  const sink = new BatchMemorySink();
  sink.batchLimit = 2;
  const uow = unit(sink);
  await stageThree(uow);
  await uow.commit();
  assertEquals(sink.batches, [{
    partitions: [MODEL.toString(), CONFIG.toString()],
  }]);
  // the run commit, left over, goes alone
  assertEquals(sink.appendCalls.at(-1), runPartition().toString());
  assertEquals(sink.landed.length, 3);
});

Deno.test("commit-log batches: behind a refusal still unacknowledged, an append with the staged changes goes alone and lands", async () => {
  const sink = new BatchMemorySink();
  sink.refuse = (commit) =>
    commit.partition.equals(CONFIG)
      ? new CommitRejectedError("lease-lost", "the lease is not held")
      : undefined;
  const uow = unit(sink);
  await uow.stageOp({ partition: CONFIG, op: configDelete() });
  await assertRejects(() => uow.checkpoint(), PartitionsRefusedError);
  const record = { partition: runPartition(), op: await runPut("nested") };
  assertEquals(
    await uow.appendNow([record], { withStaged: true }),
    "committed",
  );
  assertEquals(sink.landed.map((c) => c.partition.toString()), [
    runPartition().toString(),
  ]);
});
