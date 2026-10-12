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

/** An in-memory chunk storage with small chunks, so content spans several. */
function memory(): MemoryStorage {
  return new MemoryStorage({ maxChunkBytes: 32 * 1024 });
}

/** Three partitions: two models and one workflow run. */
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

/** A tombstone on `target`, its key unique to its position in the run. */
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

/** One step: stage a change on a target, or checkpoint. */
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
      /** The partitions each flush touches, in first-touched order. */
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

      // Every op lands once, in staging order within its partition.
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
      // Seqs have no gaps.
      for (const partition of expected.keys()) {
        const seqs = sink.landed
          .filter((commit) => commit.partition.toString() === partition)
          .map((commit) => commit.seq);
        assertEquals(seqs, seqs.map((_, i) => i + 1));
      }
      // Each flush appends its non-run partitions in first-touched order,
      // then the run partition.
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
