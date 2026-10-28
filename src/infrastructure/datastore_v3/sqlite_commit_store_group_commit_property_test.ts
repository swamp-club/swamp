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
 * Group commit (swamp-club#3915) is invisible: a store that appends bursts
 * of commits concurrently, sharing transactions, gives every commit the
 * result a store appending them one at a time, ungrouped, gives it, and
 * ends with the same file content, row for row. The commits span four
 * partitions in two namespaces and mix valid appends, seq gaps, retries of
 * landed commits, stale and missing fences (a missing one on a fresh
 * partition is refused by the writer fence after the partition took it),
 * failed expects, and appends that fail after writing their rows. A small
 * cache and snapshot interval make bursts rebuild partitions mid-group and
 * restore them from snapshots.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { createIntent, modelRef } from "../../domain/datastore_v3/intent.ts";
import { putOp } from "../../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  MODEL_TYPE,
  modelCommit,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import {
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "./sqlite_commit_store.ts";

const PARTITION_IDS = [
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "1e2d3c4b-5a69-4878-9a6b-5c4d3e2f1a0b",
  "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  "3b4c5d6e-7f80-4a9b-8c1d-2e3f4a5b6c7d",
] as const;

const PARTITIONS: readonly PartitionKey[] = PARTITION_IDS.map((id) =>
  partitionOf({ kind: "model", type: MODEL_TYPE, id })
);

const NAMESPACES = ["", "acme"] as const;

/** The writer fence the stores hold; valid commits carry a higher one. */
const WRITER_FENCE = 3;
const VALID_FENCE = 5;
/** At or above the writer fence, below the valid commits'. */
const STALE_FENCE = 4;

function hash(char: string): string {
  return char.repeat(64);
}

const CHUNKS = [
  BlobRef.create({ sha256: hash("a"), size: 1 }),
  BlobRef.create({
    sha256: hash("b"),
    size: 3,
    parts: [{ sha256: hash("c"), size: 1 }, { sha256: hash("d"), size: 2 }],
  }),
  BlobRef.create({ sha256: hash("e"), size: 2 }),
];

const KINDS = [
  "valid",
  "seq-gap",
  "duplicate",
  "stale-fence",
  "unfenced",
  "expect-failed",
  "fault",
] as const;
type Kind = typeof KINDS[number];

const arbCommand = fc.record({
  kind: fc.oneof(
    { weight: 6, arbitrary: fc.constant<Kind>("valid") },
    { weight: 1, arbitrary: fc.constantFrom<Kind>(...KINDS) },
  ),
  partition: fc.nat({ max: PARTITIONS.length - 1 }),
  namespace: fc.nat({ max: NAMESPACES.length - 1 }),
  chunk: fc.nat({ max: CHUNKS.length - 1 }),
});
type Command = typeof arbCommand extends fc.Arbitrary<infer T> ? T : never;

/** Bursts of commands; each burst is appended concurrently. */
const arbBursts = fc.array(
  fc.array(arbCommand, { minLength: 1, maxLength: 12 }),
  { minLength: 1, maxLength: 5 },
);

/**
 * A put of data `name` version 1 of the model whose partition is `index`:
 * stored as `blob`, or inline with an `expect` that never holds.
 */
function put(index: number, name: string, blob: BlobRef | "expect-failed") {
  const id = PARTITION_IDS[index];
  return putOp({
    intent: createIntent({
      kind: "data.save",
      model: modelRef(MODEL_TYPE, id),
      name,
      version: 1,
    }),
    key: RecordKey.create(`data/${MODEL_TYPE.normalized}/${id}/${name}/1/raw`),
    ...(blob === "expect-failed"
      ? { inline: "eA==", expect: { sha256: hash("0") } }
      : { blob }),
  });
}

/** Commits whose txnId starts with this fail after writing their rows. */
const FAULT = "fault-";

/**
 * Builds every burst's commits up front, from the seqs valid commits would
 * reach: the stores decide what actually lands.
 */
async function buildBursts(bursts: Command[][]): Promise<Commit[][]> {
  const next = new Map<string, number>();
  const landed = new Map<string, Commit[]>();
  let txn = 0;
  const built: Commit[][] = [];
  for (const burst of bursts) {
    const commits: Commit[] = [];
    for (const command of burst) {
      const partition = PARTITIONS[command.partition];
      const namespace = NAMESPACES[command.namespace];
      const key = JSON.stringify([namespace, partition.toString()]);
      const seq = next.get(key) ?? 1;
      const id = `txn-${txn++}`;
      const base = { partition, namespace };
      const blobPut = () =>
        put(command.partition, `n${txn}`, CHUNKS[command.chunk]);
      switch (command.kind) {
        case "valid": {
          const commit = modelCommit(seq, [await blobPut()], {
            ...base,
            fence: VALID_FENCE,
            txnId: id,
          });
          next.set(key, seq + 1);
          landed.set(key, [...landed.get(key) ?? [], commit]);
          commits.push(commit);
          break;
        }
        case "seq-gap":
          commits.push(
            modelCommit(seq + 2, [await blobPut()], {
              ...base,
              fence: VALID_FENCE,
              txnId: id,
            }),
          );
          break;
        case "duplicate": {
          const earlier = landed.get(key) ?? [];
          commits.push(
            earlier.length > 0
              ? earlier[command.chunk % earlier.length]
              : modelCommit(seq, [await blobPut()], {
                ...base,
                fence: VALID_FENCE,
                txnId: id,
              }),
          );
          if (earlier.length === 0) {
            next.set(key, seq + 1);
            landed.set(key, [commits[commits.length - 1]]);
          }
          break;
        }
        case "stale-fence":
          commits.push(
            modelCommit(seq, [await blobPut()], {
              ...base,
              fence: STALE_FENCE,
              txnId: id,
            }),
          );
          break;
        case "unfenced":
          commits.push(
            modelCommit(seq, [await blobPut()], {
              ...base,
              fence: undefined,
              txnId: id,
            }),
          );
          break;
        case "expect-failed":
          commits.push(
            modelCommit(
              seq,
              [await put(command.partition, `n${txn}`, "expect-failed")],
              { ...base, fence: VALID_FENCE, txnId: id },
            ),
          );
          break;
        case "fault":
          commits.push(
            modelCommit(seq, [await blobPut()], {
              ...base,
              fence: VALID_FENCE,
              txnId: `${FAULT}${id}`,
            }),
          );
          break;
      }
    }
    built.push(commits);
  }
  return built;
}

type Outcome =
  | { readonly kind: "appended" | "duplicate"; readonly seq: number }
  | {
    readonly kind: "rejected";
    readonly reason: string;
    readonly key?: string;
  }
  | { readonly kind: "fenced" }
  | { readonly kind: "failed"; readonly message: string };

function outcomeOf(settled: PromiseSettledResult<unknown>): Outcome {
  if (settled.status === "fulfilled") {
    const result = settled.value as {
      kind: "appended" | "duplicate";
      seq: number;
    };
    return { kind: result.kind, seq: result.seq };
  }
  const error = settled.reason;
  if (error instanceof CommitRejectedError) {
    return {
      kind: "rejected",
      reason: error.reason,
      ...(error.key === undefined ? {} : { key: error.key.toString() }),
    };
  }
  if (error instanceof WriterFencedError) return { kind: "fenced" };
  return {
    kind: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Every table's rows, in a fixed order, but the log's id: random per
 * store, so two stores never share one (swamp-club#4049).
 */
function allTables(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'log_identity' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    const out: Record<string, unknown> = {};
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[]).map((column) => `"${column.name}"`).join(", ");
      out[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY ${columns}`)
        .all();
    }
    return out;
  } finally {
    db.close();
  }
}

function storeOptions(groupCommit: boolean): SqliteCommitStoreOptions {
  return {
    groupCommit,
    cachedPartitions: 2,
    snapshotInterval: 3,
    afterAppendWrites: (commit) => {
      if (commit.txnId.startsWith(FAULT)) {
        throw new Error(`injected failure after ${commit.txnId} wrote`);
      }
    },
  };
}

/** Per-run coverage of each outcome, so the property is not vacuous. */
const coverage = new Map<string, number>();
let groupedRuns = 0;

Deno.test("SqliteCommitStore group commit: concurrent bursts give every commit the result and the file the content of ungrouped one-at-a-time appends (swamp-club#3915)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-group-commit-" });
  try {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(arbBursts, async (bursts) => {
        const commits = await buildBursts(bursts);
        const groupedPath = join(dir, `grouped-${run}.db`);
        const soloPath = join(dir, `solo-${run}.db`);
        run++;
        const grouped = SqliteCommitStore.open(
          groupedPath,
          storeOptions(true),
        );
        const solo = SqliteCommitStore.open(soloPath, storeOptions(false));
        try {
          await grouped.raiseWriterFence(WRITER_FENCE);
          await solo.raiseWriterFence(WRITER_FENCE);
          const groupedOutcomes: Outcome[] = [];
          const soloOutcomes: Outcome[] = [];
          let appended = 0;
          for (const burst of commits) {
            const settled = await Promise.allSettled(
              burst.map((commit) => grouped.append(commit)),
            );
            groupedOutcomes.push(...settled.map(outcomeOf));
            for (const commit of burst) {
              const [one] = await Promise.allSettled([solo.append(commit)]);
              const outcome = outcomeOf(one);
              soloOutcomes.push(outcome);
              const label = outcome.kind === "rejected"
                ? outcome.reason
                : outcome.kind;
              coverage.set(label, (coverage.get(label) ?? 0) + 1);
              if (outcome.kind === "appended") appended++;
            }
          }
          assertEquals(groupedOutcomes, soloOutcomes);
          // Grouping happened: fewer transactions than the solo store.
          if (grouped.appendTransactions < solo.appendTransactions) {
            groupedRuns++;
          }
          assert(solo.appendTransactions === appended);
        } finally {
          await grouped.close();
          await solo.close();
        }
        assertEquals(allTables(groupedPath), allTables(soloPath));
      }),
      { numRuns: 100 },
    );
  } finally {
    console.log(
      `group commit coverage: ${
        JSON.stringify(Object.fromEntries([...coverage].sort()))
      }; runs that grouped: ${groupedRuns}`,
    );
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
  // Every case kind is exercised, and grouping actually saved transactions.
  for (
    const label of [
      "appended",
      "duplicate",
      "seq-gap",
      "stale-fence",
      "unfenced",
      "expect-failed",
      "fenced",
      "failed",
    ]
  ) {
    assert((coverage.get(label) ?? 0) > 0, `no ${label} outcome was generated`);
  }
  assert(groupedRuns > 0, "no run shared a transaction");
});
