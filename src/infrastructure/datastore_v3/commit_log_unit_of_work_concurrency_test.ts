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
import { waitFor } from "@swamp-club/swamp-testing";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { createIntent, modelRef } from "../../domain/datastore_v3/intent.ts";
import { putOp, tombstoneOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  base64,
  dataKey,
  MemoryStorage,
  MODEL_TYPE,
  modelIntent,
  modelPartition,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  newCommitOrigin,
  runInCommitOrigin,
} from "../../domain/datastore/commit_origin.ts";
import {
  checkpointFrom,
  CommitNotTriedError,
  createCommitLogUnitOfWork,
} from "./commit_log_unit_of_work.ts";
import {
  BatchMemorySink,
  contextHook,
  runPartition,
  runPut,
  unitOptions,
} from "./commit_log_test_helpers.ts";

function model(): { partition: PartitionKey; id: string } {
  const id = crypto.randomUUID();
  return {
    partition: partitionOf({ kind: "model", type: MODEL_TYPE, id }),
    id,
  };
}

function put(target: { id: string }, name: string) {
  return putOp({
    intent: createIntent({
      kind: "data.save",
      name,
      version: 1,
      model: modelRef(MODEL_TYPE, target.id),
    }),
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${target.id}/${name}/1/raw`,
    ),
    inline: base64(name),
  });
}

async function stage(
  unit: ReturnType<typeof createCommitLogUnitOfWork>,
  target: { partition: PartitionKey; id: string },
  name: string,
): Promise<void> {
  await unit.stageOp({
    partition: target.partition,
    op: await put(target, name),
  });
}

function concurrentSink(): BatchMemorySink {
  const sink = new BatchMemorySink();
  sink.roundsInFlight = () => 4;
  return sink;
}

function tree(sink: BatchMemorySink) {
  const hook = contextHook();
  const root = createCommitLogUnitOfWork(
    hook,
    unitOptions(sink, new MemoryStorage()),
  );
  const child = () =>
    createCommitLogUnitOfWork(
      hook,
      unitOptions(sink, new MemoryStorage(), { parent: root }),
    );
  return { root, child };
}

Deno.test("commit-log scheduler: two parallel steps' rounds are in flight together", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 2;
  const release = Promise.withResolvers<void>();
  sink.hold = () => release.promise;
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  const [a1, a2, b1, b2] = [model(), model(), model(), model()];
  await stage(a, a1, "a1");
  await stage(a, a2, "a2");
  await stage(b, b1, "b1");
  await stage(b, b2, "b2");
  const checkpoints = Promise.all([checkpointFrom(a), checkpointFrom(b)]);
  try {
    await waitFor(() => sink.batchesInFlight === 2, "two batches in flight");
  } finally {
    release.resolve();
  }
  assertEquals(await checkpoints, [true, true]);
  assertEquals(sink.mostBatchesInFlight, 2);
  assertEquals(sink.landed.length, 4);
  await root.commit();
});

Deno.test("commit-log scheduler: a step's later group on another partition is never sent after its earlier group failed", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 1;
  const [first, second] = [model(), model()];
  sink.refuse = (commit) =>
    commit.partition.equals(first.partition)
      ? new CommitRejectedError("seq-gap", "the head moved")
      : undefined;
  const { root, child } = tree(sink);
  const step = child();
  await stage(step, first, "first");
  await stage(step, second, "second");
  await assertRejects(() => checkpointFrom(step));
  assert(!sink.appendCalls.includes(second.partition.toString()));
  await root.abandon();
});

Deno.test("commit-log scheduler: a step opened after another handed its changes up waits for them, and is never sent after their failure", async () => {
  const sink = concurrentSink();
  // a round each, so nothing but the dependency keeps them apart
  sink.batchLimit = 1;
  const [earlier, later] = [model(), model()];
  sink.refuse = (commit) =>
    commit.partition.equals(earlier.partition)
      ? new CommitRejectedError("seq-gap", "the head moved")
      : undefined;
  const { root, child } = tree(sink);
  const a = child();
  await stage(a, earlier, "earlier");
  await assertRejects(() => checkpointFrom(a));
  await a.commit();
  const b = child();
  await stage(b, later, "later");
  await assertRejects(() => checkpointFrom(b));
  assert(!sink.appendCalls.includes(later.partition.toString()));
  await root.abandon();
});

Deno.test("commit-log scheduler: a step's data and its run record still go as one batch", async () => {
  const sink = concurrentSink();
  const { root, child } = tree(sink);
  const step = child();
  const target = model();
  await stage(step, target, "a");
  await step.stageOp({ partition: runPartition(), op: await runPut("r") });
  await checkpointFrom(step);
  assertEquals(sink.batches, [{
    partitions: [target.partition.toString(), runPartition().toString()],
  }]);
  await root.commit();
});

Deno.test("commit-log scheduler: a seq gap fails the checkpoint that formed it, while a concurrent checkpoint re-sends the group once and lands", async () => {
  const sink = concurrentSink();
  const [gapped, other] = [model(), model()];
  let gaps = 0;
  sink.refuse = (commit) =>
    commit.partition.equals(gapped.partition) && gaps++ < 2
      ? new CommitRejectedError("seq-gap", "the head moved")
      : undefined;
  const release = Promise.withResolvers<void>();
  let held = false;
  sink.hold = () => {
    if (held) return Promise.resolve();
    held = true;
    return release.promise;
  };
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  await stage(a, gapped, "gapped");
  await stage(b, other, "other");
  const first = checkpointFrom(a);
  const second = checkpointFrom(b);
  release.resolve();
  await assertRejects(() => first);
  assertEquals(await second, true);
  assert(
    sink.landed.some((commit) => commit.partition.equals(gapped.partition)),
    "the re-send landed the gapped group",
  );
  await root.commit();
});

Deno.test("commit-log scheduler: a refusal in one round holds the run record while another step's round lands", async () => {
  const sink = concurrentSink();
  const [refused, fine] = [model(), model()];
  sink.refuse = (commit) =>
    commit.partition.equals(refused.partition)
      ? new CommitRejectedError("lease-lost", "the lease is not held")
      : undefined;
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  await stage(a, refused, "refused");
  await a.stageOp({ partition: runPartition(), op: await runPut("r") });
  await stage(b, fine, "fine");
  const results = await Promise.allSettled([
    checkpointFrom(a),
    checkpointFrom(b),
  ]);
  assertEquals(results[0].status, "rejected");
  assert(
    results[0].status === "rejected" &&
      results[0].reason instanceof PartitionsRefusedError,
  );
  assert(!sink.appendCalls.includes(runPartition().toString()));
  assert(sink.landed.some((commit) => commit.partition.equals(fine.partition)));
  root.acknowledgeRefusals?.();
  await root.abandon();
});

Deno.test("commit-log scheduler: a checkpoint's release rides its last round only when none of its other rounds is still out", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 2;
  const release = Promise.withResolvers<void>();
  let first = true;
  sink.hold = () => {
    if (!first) return Promise.resolve();
    first = false;
    return release.promise;
  };
  const { root, child } = tree(sink);
  const step = child();
  const targets = [model(), model(), model(), model()];
  for (const [index, target] of targets.entries()) {
    await stage(step, target, `t${index}`);
  }
  const checkpoint = checkpointFrom(step, { release: "lease-1" });
  try {
    await waitFor(() => sink.batchesInFlight === 1, "the first round out");
  } finally {
    release.resolve();
  }
  await checkpoint;
  // same step: its second round waits for the first, which has landed by
  // then, so the release rides it
  assertEquals(sink.batches.map((batch) => batch.release), [
    undefined,
    "lease-1",
  ]);
  await root.commit();
});

Deno.test("commit-log scheduler: an end whose round failed waits for its other round still out before it says what landed", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 2;
  const [a1, a2, b1] = [model(), model(), model()];
  let failed = false;
  sink.refuse = (commit) => {
    if (!commit.partition.equals(b1.partition)) return undefined;
    failed = true;
    return new Error("connect ECONNREFUSED");
  };
  const release = Promise.withResolvers<void>();
  sink.hold = () => release.promise;
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  await stage(a, a1, "a1");
  await stage(a, a2, "a2");
  await stage(b, b1, "b1");
  await a.commit();
  await b.commit();
  let ended = false;
  const end = root.commit().finally(() => {
    ended = true;
  });
  try {
    await waitFor(() => failed && sink.batchesInFlight === 1, "b1 failed");
    // waitFor's polling yields to the event loop, so the failure has settled
    const state = await Promise.race([
      end.then(() => "settled", () => "settled"),
      Promise.resolve("unsettled"),
    ]);
    assertEquals(state, "unsettled", "the end decided while a round was out");
    assertEquals(ended, false);
  } finally {
    release.resolve();
  }
  await assertRejects(() => end);
  assertEquals(
    sink.landed.map((commit) => commit.partition.toString()).sort(),
    [a1.partition.toString(), a2.partition.toString()].sort(),
  );
});

Deno.test("commit-log scheduler: a group that keeps coming back not tried fails its flush after three sends, and stays pending for the next", async () => {
  const sink = concurrentSink();
  const stuck = model();
  sink.refuse = (commit) =>
    commit.partition.equals(stuck.partition)
      ? new CommitNotTriedError(commit.partition.toString())
      : undefined;
  const { root, child } = tree(sink);
  const step = child();
  await stage(step, stuck, "stuck");
  await assertRejects(() => checkpointFrom(step), CommitNotTriedError);
  const sends = () =>
    sink.appendCalls.filter((call) => call === stuck.partition.toString())
      .length;
  assertEquals(sends(), 3);
  await assertRejects(() => root.checkpoint(), CommitNotTriedError);
  assertEquals(sends(), 6, "the next flush asks for it again");
  await root.abandon();
});

Deno.test("commit-log scheduler: a checkpoint waiting on a group a sibling then supersedes still lands the group's rewrite before it resolves", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 2;
  const release = Promise.withResolvers<void>();
  let first = true;
  sink.hold = () => {
    if (!first) return Promise.resolve();
    first = false;
    return release.promise;
  };
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  const [x, y] = [model(), model()];
  await stage(a, x, "x");
  await stage(a, y, "y");
  const MODEL = modelPartition();
  await a.stageOp({
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
      key: dataKey("a", 1),
      content: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20_000).fill(3));
            controller.close();
          },
        }),
    },
  });
  await a.stageOp({ partition: MODEL, op: versionOp("a", 1) });
  let resolved = false;
  const checkpoint = checkpointFrom(a, { release: "lease-1" }).then(() => {
    resolved = true;
  });
  try {
    // x and y are out; the model's group waits on them, as the same step's
    await waitFor(() => sink.batchesInFlight === 1, "the first round out");
    await b.stageOp({
      partition: MODEL,
      op: tombstoneOp({
        intent: modelIntent({ kind: "data.gc", name: "a", version: 1 }),
        key: dataKey("a", 1),
      }),
    });
    await b.commit();
  } finally {
    release.resolve();
  }
  await checkpoint;
  assert(resolved);
  assert(
    sink.landed.some((commit) =>
      commit.partition.equals(MODEL) &&
      commit.ops.some((op) => op.kind === "data-version")
    ),
    "the rewritten group landed before the checkpoint resolved",
  );
  await root.commit();
});

Deno.test("commit-log scheduler: a checkpoint's run record never waits on, or fails with, data a later flush formed", async () => {
  // one at a time, as with a serve that takes no batches
  const sink = new BatchMemorySink();
  sink.roundsInFlight = () => 1;
  sink.batchLimit = 1;
  const [d1, e] = [model(), model()];
  const release = Promise.withResolvers<void>();
  let d1Out = false;
  sink.holdAppend = (commit) => {
    if (!commit.partition.equals(d1.partition)) return Promise.resolve();
    d1Out = true;
    return release.promise;
  };
  sink.refuse = (commit) =>
    commit.partition.equals(e.partition)
      ? new Error("connect ECONNREFUSED")
      : undefined;
  const { root, child } = tree(sink);
  const a = child();
  const b = child();
  await stage(a, d1, "d1");
  await a.stageOp({ partition: runPartition(), op: await runPut("r") });
  const first = checkpointFrom(a);
  try {
    await waitFor(() => d1Out, "d1 out");
    await stage(b, e, "e");
    const second = checkpointFrom(b);
    release.resolve();
    assertEquals(await first, true);
    await assertRejects(() => second);
  } finally {
    release.resolve();
  }
  assert(sink.landed.some((commit) => commit.partition.equals(runPartition())));
  await root.abandon();
});

Deno.test("commit-log scheduler: two steps writing into one run's unit, each in its own origin, have their rounds in flight together", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 2;
  const release = Promise.withResolvers<void>();
  sink.hold = () => release.promise;
  const { root, child } = tree(sink);
  // a workflow run: one unit, its steps writing into it
  const run = child();
  const [s1, s2] = [newCommitOrigin(), newCommitOrigin()];
  const [a1, a2, b1, b2] = [model(), model(), model(), model()];
  await runInCommitOrigin(s1, () => stage(run, a1, "a1"));
  await runInCommitOrigin(s1, () => stage(run, a2, "a2"));
  await runInCommitOrigin(s2, () => stage(run, b1, "b1"));
  await runInCommitOrigin(s2, () => stage(run, b2, "b2"));
  const checkpoint = checkpointFrom(run);
  try {
    await waitFor(() => sink.batchesInFlight === 2, "two batches in flight");
  } finally {
    release.resolve();
  }
  assertEquals(await checkpoint, true);
  assertEquals(sink.landed.length, 4);
  await root.commit();
});

Deno.test("commit-log scheduler: a step that began after another recorded its commits waits for them", async () => {
  const sink = concurrentSink();
  sink.batchLimit = 1;
  const [first, second] = [model(), model()];
  sink.refuse = (commit) =>
    commit.partition.equals(first.partition)
      ? new CommitRejectedError("seq-gap", "the head moved")
      : undefined;
  const { root, child } = tree(sink);
  const run = child();
  await runInCommitOrigin(newCommitOrigin(), () => stage(run, first, "f"));
  await runInCommitOrigin(newCommitOrigin(), () => stage(run, second, "s"));
  await assertRejects(() => checkpointFrom(run));
  assert(!sink.appendCalls.includes(second.partition.toString()));
  await root.abandon();
});
