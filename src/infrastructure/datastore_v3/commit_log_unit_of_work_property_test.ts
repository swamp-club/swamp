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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { createIntent, modelRef } from "../../domain/datastore_v3/intent.ts";
import { type Op, tombstoneOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { RunChanges } from "../../domain/datastore_v3/repository_changes.ts";
import {
  MemoryStorage,
  MODEL_TYPE,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import {
  contextHook,
  MemorySink,
  MODEL_A_ID,
  MODEL_B_ID,
  RUN_ID,
  unitOptions,
  WORKFLOW_ID,
} from "./commit_log_test_helpers.ts";

function memory(): MemoryStorage {
  return new MemoryStorage({ maxChunkBytes: 32 * 1024 });
}

const TARGETS = ["model-a", "model-b", "run"] as const;
type Target = typeof TARGETS[number];

function partitionFor(target: Target): PartitionKey {
  if (target === "run") {
    return partitionOf({ kind: "run", workflowId: WORKFLOW_ID, runId: RUN_ID });
  }
  return partitionOf({
    kind: "model",
    type: MODEL_TYPE,
    id: target === "model-a" ? MODEL_A_ID : MODEL_B_ID,
  });
}

function opFor(target: Target, index: number): Op {
  const key = RecordKey.create(`probe/${target}/${index}`);
  if (target === "run") {
    return tombstoneOp({
      intent: createIntent({
        kind: "run.delete",
        run: { workflowId: WORKFLOW_ID, runId: RUN_ID },
      }),
      key,
    });
  }
  const id = target === "model-a" ? MODEL_A_ID : MODEL_B_ID;
  return tombstoneOp({
    intent: createIntent({
      kind: "data.delete",
      name: "n",
      model: modelRef(MODEL_TYPE, id),
    }),
    key,
  });
}

const arbStep = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...TARGETS) },
  { weight: 1, arbitrary: fc.constant("checkpoint" as const) },
);

Deno.test("commit-log unit property: every staged op lands once, in staging order per partition, run partitions after the others of each flush", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(arbStep, { maxLength: 40 }), async (steps) => {
      const sink = new MemorySink();
      const uow = createCommitLogUnitOfWork(
        contextHook(),
        unitOptions(sink, memory()),
      );
      const expected = new Map<string, string[]>();
      const flushes: Target[][] = [[]];
      for (const [index, step] of steps.entries()) {
        if (step === "checkpoint") {
          await uow.checkpoint();
          flushes.push([]);
          continue;
        }
        const partition = partitionFor(step);
        const op = opFor(step, index);
        await uow.stageOp({ partition, op });
        const keys = expected.get(partition.toString()) ?? [];
        keys.push(`probe/${step}/${index}`);
        expected.set(partition.toString(), keys);
        const touched = flushes[flushes.length - 1];
        if (!touched.includes(step)) touched.push(step);
      }
      await uow.commit();

      for (const [partition, keys] of expected) {
        const landed = sink.landed
          .filter((commit) => commit.partition.toString() === partition)
          .flatMap((commit) =>
            commit.ops.map((op) =>
              op.kind === "tombstone" ? op.key.toString() : ""
            )
          );
        assertEquals(landed, keys);
      }
      for (const partition of expected.keys()) {
        const seqs = sink.landed
          .filter((commit) => commit.partition.toString() === partition)
          .map((commit) => commit.seq);
        assertEquals(seqs, seqs.map((_, i) => i + 1));
      }
      const order = flushes
        .filter((touched) => touched.length > 0)
        .flatMap((touched) => [
          ...touched.filter((t) => t !== "run"),
          ...touched.filter((t) => t === "run"),
        ])
        .map((target) => partitionFor(target).toString());
      assertEquals(sink.appendCalls, order);
      assert(sink.landed.length === order.length);
    }),
    { numRuns: 200 },
  );
});

const arbRunStep = fc.constantFrom(
  "save",
  "checkpoint",
  "failed-checkpoint",
  "takeover",
  "takeover-across-a-checkpoint",
);

Deno.test("commit-log unit property: once another owner has taken the run over and committed, no commit of the executor's lands after it, and until then its latest save lands (swamp-club#4171)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbRunStep, { maxLength: 12 }),
      async (steps) => {
        const sink = new MemorySink();
        const storage = memory();
        const changes = new RunChanges(WORKFLOW_ID, RUN_ID);
        const key = RecordKey.create(
          `workflow-runs/${WORKFLOW_ID}/${RUN_ID}.yaml`,
        );
        const encode = (text: string) => new TextEncoder().encode(text);
        let record = "created";
        let takenOver = false;
        const executor = createCommitLogUnitOfWork(
          contextHook(),
          unitOptions(sink, storage),
        );
        const takeOver = async () => {
          takenOver = true;
          record = "interrupted";
          const owner = createCommitLogUnitOfWork(
            contextHook(),
            unitOptions(sink, storage),
          );
          await owner.stageOps([
            changes.write("run.update", key, encode(record)),
          ]);
          await owner.commit();
        };

        let saves = 0;
        for (const step of steps) {
          // As the fence does, an executor saves nothing once taken over.
          if (step === "save" && !takenOver) {
            record = `save-${++saves}`;
            const content = record;
            await executor.stageOps([
              changes.write(
                "run.update",
                key,
                () => ReadableStream.from([encode(content)]),
                () => takenOver,
              ),
            ]);
          } else if (step === "checkpoint") {
            await executor.checkpoint();
          } else if (step === "failed-checkpoint") {
            sink.beforeAppend = () => {
              throw new Error("connection lost");
            };
            await executor.checkpoint().catch(() => {});
            sink.beforeAppend = () => {};
          } else if (step === "takeover" && !takenOver) {
            await takeOver();
          } else if (step === "takeover-across-a-checkpoint" && !takenOver) {
            // The owner takes over while the executor's append is at the
            // sink, after its check passed: the owner's commit queues behind
            // that append's lock, so it lands after, and is awaited there.
            let owner: Promise<void> | undefined;
            sink.beforeAppend = () => {
              owner ??= takeOver();
            };
            await executor.checkpoint();
            sink.beforeAppend = () => {};
            await (owner ?? takeOver());
          }
        }
        await executor.commit();

        const texts = sink.commitsOf(changes.partition).flatMap((commit) =>
          commit.ops.flatMap((op) =>
            op.kind === "put" && "inline" in op.content
              ? [atob(op.content.inline)]
              : []
          )
        );
        const expected = takenOver
          ? "interrupted"
          : saves === 0
          ? undefined
          : `save-${saves}`;
        assertEquals(texts.at(-1), expected);
      },
    ),
    { numRuns: 200 },
  );
});
