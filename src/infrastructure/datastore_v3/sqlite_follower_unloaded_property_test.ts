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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { createIntent, modelRef } from "../../domain/datastore_v3/intent.ts";
import { leaseOp, type Op, putOp } from "../../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  MODEL_TYPE,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

const OTHER_ID = "7e2d3c4b-5a6f-4b70-9c8d-0e1f2a3b4c5d";

const PARTITIONS: readonly PartitionKey[] = [
  modelPartition(),
  partitionOf({ kind: "model", type: MODEL_TYPE, id: OTHER_ID }),
];

function putFor(partition: number, name: string, version: number): Promise<Op> {
  if (partition === 0) return savePut(name, version);
  return putOp({
    intent: createIntent({
      kind: "data.save",
      name,
      version,
      model: modelRef(MODEL_TYPE, OTHER_ID),
    }),
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${OTHER_ID}/${name}/${version}/raw`,
    ),
    inline: btoa(`${name}@${version}`),
  });
}

interface Step {
  readonly partition: number;
  readonly seqDelta: number;
  readonly fence: number | undefined;
  /** -1 for a new txnId, else (modulo the steps so far) the step whose txnId it reuses */
  readonly reuse: number;
  /** the reused step's commit is delivered again unchanged */
  readonly redeliver: boolean;
  readonly leases: readonly number[];
  /** applied through a second connection on each file, outside both stores */
  readonly other: boolean;
  /** the unloaded store is reopened first, as a new command would be */
  readonly reopen: boolean;
  /** appended concurrently with the steps before it in its batch */
  readonly batch: boolean;
}

const arbStep: fc.Arbitrary<Step> = fc.record({
  partition: fc.integer({ min: 0, max: 1 }),
  seqDelta: fc.integer({ min: -2, max: 3 }),
  fence: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  reuse: fc.oneof(
    { weight: 3, arbitrary: fc.constant(-1) },
    { weight: 2, arbitrary: fc.nat({ max: 30 }) },
  ),
  redeliver: fc.boolean(),
  leases: fc.oneof(
    { weight: 3, arbitrary: fc.constant([]) },
    {
      weight: 2,
      arbitrary: fc.array(fc.integer({ min: 0, max: 4 }), {
        minLength: 1,
        maxLength: 2,
      }),
    },
  ),
  other: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  reopen: fc.boolean(),
  batch: fc.boolean(),
});

type Outcome =
  | { readonly kind: string; readonly seq: number }
  | { readonly refused: string; readonly message: string };

async function outcomeOf(append: Promise<unknown>): Promise<Outcome> {
  try {
    const result = await append as { kind: string; seq: number };
    return { kind: result.kind, seq: result.seq };
  } catch (error) {
    if (!(error instanceof CommitRejectedError)) throw error;
    return { refused: error.reason, message: error.message };
  }
}

function rows(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all();
    return {
      commits: all(
        "SELECT namespace, partition, seq, txn_id, fence, at, body FROM commits ORDER BY cursor",
      ),
      heads: all(
        "SELECT namespace, partition, seq, highest_fence FROM partition_heads ORDER BY partition",
      ),
      snapshots: all(
        "SELECT namespace, partition, seq, body FROM partition_snapshots ORDER BY partition",
      ),
      chunkRefs: all("SELECT * FROM chunk_refs ORDER BY 1, 2"),
      chunkPartitions: all("SELECT * FROM chunk_partitions ORDER BY 1, 2, 3"),
    };
  } finally {
    db.close();
  }
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SqliteCommitStore follower: appends to an unloaded partition match the loaded path's results, rows and rebuilt state", async () => {
  const coverage: Record<string, number> = {};
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbStep, { minLength: 1, maxLength: 30 }),
      fc.integer({ min: 1, max: 5 }),
      async (steps, snapshotInterval) => {
        const dir = await Deno.makeTempDir({ prefix: "swamp-unloaded-prop-" });
        try {
          const options = { follower: true, snapshotInterval };
          const unloadedPath = join(dir, "unloaded.db");
          const loadedPath = join(dir, "loaded.db");
          let unloaded = SqliteCommitStore.open(unloadedPath, options);
          const loaded = SqliteCommitStore.open(loadedPath, options);
          const unloadedOther = SqliteCommitStore.open(unloadedPath, options);
          const loadedOther = SqliteCommitStore.open(loadedPath, options);
          try {
            const highest = [0, 0];
            const commits: Commit[] = [];
            const planned: { commit: Commit; step: Step }[] = [];
            for (const [index, step] of steps.entries()) {
              if (step.reuse >= 0 && step.redeliver && commits.length > 0) {
                const again = commits[step.reuse % commits.length];
                commits.push(again);
                planned.push({ commit: again, step });
                continue;
              }
              const key = PARTITIONS[step.partition];
              const seq = Math.max(1, highest[step.partition] + step.seqDelta);
              highest[step.partition] = Math.max(highest[step.partition], seq);
              const reused = step.reuse >= 0 && commits.length > 0
                ? commits[step.reuse % commits.length].txnId
                : undefined;
              const ops: Op[] = [
                await putFor(step.partition, `n${index}`, seq),
              ];
              for (const fence of step.leases) {
                ops.push(leaseOp({ holder: "serve", fence }));
              }
              const commit = modelCommit(seq, ops, {
                partition: key,
                txnId: reused ?? `txn-${index}`,
                ...(step.fence !== undefined ? { fence: step.fence } : {}),
              });
              commits.push(commit);
              planned.push({ commit, step });
            }
            let pending: Promise<Outcome>[] = [];
            let expected: Promise<Outcome>[] = [];
            const flush = async () => {
              const got = await Promise.all(pending);
              const want = await Promise.all(expected);
              assertEquals(got, want);
              for (const outcome of want) {
                const label = "kind" in outcome
                  ? outcome.kind
                  : outcome.refused;
                coverage[label] = (coverage[label] ?? 0) + 1;
              }
              pending = [];
              expected = [];
            };
            for (const { commit, step } of planned) {
              if (step.other) {
                await flush();
                assertEquals(
                  await outcomeOf(unloadedOther.append(commit)),
                  await outcomeOf(loadedOther.append(commit)),
                );
                coverage.other = (coverage.other ?? 0) + 1;
                continue;
              }
              if (!step.batch) await flush();
              if (step.reopen && pending.length === 0) {
                await unloaded.close();
                unloaded = SqliteCommitStore.open(unloadedPath, options);
              }
              pending.push(outcomeOf(unloaded.append(commit)));
              // Loaded first, so the oracle takes the loaded path.
              await loaded.partitionState("", commit.partition);
              expected.push(outcomeOf(loaded.append(commit)));
              await Promise.all(expected);
            }
            await flush();

            assertEquals(rows(unloadedPath), rows(loadedPath));
            const fresh = [
              SqliteCommitStore.open(unloadedPath, options),
              SqliteCommitStore.open(loadedPath, options),
            ];
            try {
              for (const key of PARTITIONS) {
                const [a, b] = await Promise.all(
                  fresh.map((store) => store.partitionState("", key)),
                );
                assertEquals(a.snapshot(), b.snapshot());
              }
            } finally {
              for (const store of fresh) await store.close();
            }
          } finally {
            await unloaded.close();
            await loaded.close();
            await unloadedOther.close();
            await loadedOther.close();
          }
        } finally {
          await removeDir(dir);
        }
      },
    ),
    { numRuns: 500 },
  );
  console.log(`unloaded follower coverage: ${JSON.stringify(coverage)}`);
});
