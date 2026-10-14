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

/**
 * Truncation to a high-water mark (swamp-club#3482) undoes appends exactly:
 * a store that appended a prefix, took its mark, appended a suffix and was
 * truncated to the mark is observably the store that appended the prefix
 * only, and stays so when both append the suffix again. Commits span three
 * partitions in two namespaces, share chunks, raise fences through lease
 * ops, and may be partly compacted before the mark.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { leaseOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import {
  blobPut,
  MODEL_TYPE,
  modelCommit,
  modelPartition,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  CommitStoreTruncateRefusedError,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";

function hash(char: string): string {
  return char.repeat(64);
}

/** Blobs whose chunks overlap, so a chunk is named by several commits. */
const BLOBS = [
  BlobRef.create({ sha256: hash("a"), size: 10 }),
  BlobRef.create({
    sha256: hash("b"),
    size: 3,
    parts: [{ sha256: hash("c"), size: 1 }, { sha256: hash("d"), size: 2 }],
  }),
  BlobRef.create({
    sha256: hash("f"),
    size: 3,
    parts: [{ sha256: hash("d"), size: 2 }, { sha256: hash("a"), size: 1 }],
  }),
];

function otherPartition(): PartitionKey {
  return partitionOf({
    kind: "model",
    type: MODEL_TYPE,
    id: "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b",
  });
}

/** The partitions commits go to: data in two namespaces, leases in one. */
const SPACES = [
  { namespace: "", partition: modelPartition, lease: false },
  { namespace: "", partition: otherPartition, lease: true },
  { namespace: "acme", partition: modelPartition, lease: false },
] as const;

const arbStep = fc.record({
  space: fc.integer({ min: 0, max: SPACES.length - 1 }),
  name: fc.constantFrom("x", "y", "z"),
  blob: fc.integer({ min: 0, max: BLOBS.length - 1 }),
  fenceBump: fc.integer({ min: 0, max: 2 }),
});
type Step = typeof arbStep extends fc.Arbitrary<infer T> ? T : never;

/** Builds each step's commit, numbering seqs per partition. */
class Builder {
  readonly #seqs = new Map<number, number>();
  readonly #fences = new Map<number, number>();
  #txn = 0;

  async build(step: Step): Promise<Commit> {
    const space = SPACES[step.space];
    const seq = (this.#seqs.get(step.space) ?? 0) + 1;
    this.#seqs.set(step.space, seq);
    const txnId = `t-${this.#txn++}`;
    if (space.lease) {
      const fence = (this.#fences.get(step.space) ?? 1) + step.fenceBump;
      this.#fences.set(step.space, fence);
      return modelCommit(seq, [leaseOp({ holder: "serve", fence })], {
        namespace: space.namespace,
        partition: space.partition(),
        fence,
        txnId,
      });
    }
    return modelCommit(
      seq,
      [await blobPut(step.name, 1, BLOBS[step.blob])],
      {
        namespace: space.namespace,
        partition: space.partition(),
        fence: 1,
        txnId,
      },
    );
  }
}

async function appendAll(
  store: SqliteCommitStore,
  commits: readonly Commit[],
): Promise<void> {
  for (const commit of commits) {
    const result = await store.append(commit);
    assertEquals(result, { kind: "appended", seq: commit.seq });
  }
}

/** What a store shows: heads, feed, partitions, snapshots and chunk references. */
async function observe(store: SqliteCommitStore, path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  let chunkRefs: unknown[];
  let snapshots: unknown[];
  let compacted: Map<string, number>;
  try {
    chunkRefs = db.prepare(
      "SELECT namespace, sha256, refs FROM chunk_refs ORDER BY namespace, sha256",
    ).all();
    snapshots = db.prepare(
      "SELECT namespace, partition, seq, body FROM partition_snapshots ORDER BY namespace, partition",
    ).all();
    compacted = new Map(
      (db.prepare(
        "SELECT namespace, partition, seq FROM compacted_partitions",
      ).all() as { namespace: string; partition: string; seq: number }[])
        .map((row) => [`${row.namespace}/${row.partition}`, row.seq]),
    );
  } finally {
    db.close();
  }
  const { compactedThrough } = await store.history();
  const feed = (await store.changesSince(compactedThrough, 1_000_000)).map((
    change,
  ) => [change.commit.namespace, change.commit.txnId]);
  const partitions = [];
  for (const space of SPACES) {
    const key = space.partition();
    const from = (compacted.get(`${space.namespace}/${key}`) ?? 0) + 1;
    partitions.push({
      head: await store.head(space.namespace, key),
      commits: (await store.readPartition(space.namespace, key, from, 1000))
        .map((change) => change.commit.toJSON()),
    });
  }
  return { chunkRefs, snapshots, feed, partitions };
}

Deno.test("SqliteCommitStore.truncateAfter: undoes the appends past the mark exactly", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-truncate-property-" });
  let truncatedRuns = 0;
  let refusedRuns = 0;
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbStep, { minLength: 0, maxLength: 12 }),
        fc.array(arbStep, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.option(fc.nat(), { nil: undefined }),
        async (prefixSteps, suffixSteps, snapshotInterval, compactAt) => {
          const builder = new Builder();
          const prefix: Commit[] = [];
          for (const step of prefixSteps) {
            prefix.push(await builder.build(step));
          }
          const suffix: Commit[] = [];
          for (const step of suffixSteps) {
            suffix.push(await builder.build(step));
          }
          const through = compactAt === undefined || prefix.length === 0
            ? undefined
            : compactAt % (prefix.length + 1);
          const options = { snapshotInterval, cachedPartitions: 2 };
          const run = crypto.randomUUID();
          const truncatedPath = join(dir, `${run}-truncated.db`);
          const prefixPath = join(dir, `${run}-prefix.db`);

          const truncated = SqliteCommitStore.open(truncatedPath, options);
          const prefixOnly = SqliteCommitStore.open(prefixPath, options);
          try {
            await appendAll(truncated, prefix);
            await appendAll(prefixOnly, prefix);
            if (through !== undefined) {
              await truncated.compactHistory(through);
              await prefixOnly.compactHistory(through);
            }
            const mark = truncated.highWaterMark();
            assertEquals(mark, prefixOnly.highWaterMark());
            await appendAll(truncated, suffix);

            if (truncated.checkMark(mark) === "compacted-past") {
              // A compacted partition's only snapshot went past the mark.
              assert(through !== undefined);
              const before = await observe(truncated, truncatedPath);
              try {
                await truncated.truncateAfter(mark);
                throw new Error("truncateAfter did not refuse");
              } catch (error) {
                assert(error instanceof CommitStoreTruncateRefusedError);
                assertEquals(error.reason, "compacted-past");
              }
              assertEquals(await observe(truncated, truncatedPath), before);
              refusedRuns++;
              return;
            }
            truncatedRuns++;
            assertEquals(await truncated.truncateAfter(mark), {
              removed: suffix.length,
            });
            assertEquals(truncated.highWaterMark(), mark);
            assertEquals(
              await observe(truncated, truncatedPath),
              await observe(prefixOnly, prefixPath),
            );

            // Both take the suffix again, from rebuilt or cached partitions.
            await appendAll(truncated, suffix);
            await appendAll(prefixOnly, suffix);
            assertEquals(
              await observe(truncated, truncatedPath),
              await observe(prefixOnly, prefixPath),
            );
            assert(
              truncated.highWaterMark().cursor >
                prefixOnly.highWaterMark().cursor,
            );
          } finally {
            await truncated.close();
            await prefixOnly.close();
          }
        },
      ),
      { numRuns: 150 },
    );
    // A refusal only arises with compaction, which about half the runs do.
    assert(truncatedRuns > 60, `only ${truncatedRuns} runs truncated`);
    assert(refusedRuns > 0, "no run was refused");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
