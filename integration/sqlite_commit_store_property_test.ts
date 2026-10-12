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
 * Model-based property test of the SQLite commit store (swamp-club#3236):
 * random command sequences applied through the store must give the same
 * results and the same partition state as the partition reference model,
 * also after the store is closed and reopened, which rebuilds the partition
 * from its snapshot and the commits after it.
 *
 * Also (swamp-club#3249): the referenced-chunk index is exactly the chunks
 * the stored commits name, whether built append by append or backfilled by
 * the schema migration.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import {
  CommitRejectedError,
  Partition,
} from "../src/domain/datastore_v3/partition.ts";
import {
  arbCommand,
  buildOp,
  type Command,
  emptyModel,
  expected,
  type Model,
  modelAppend,
  observe,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  blobPut,
  modelCommit,
  modelPartition,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** A store result in the reference model's shape. */
type Outcome =
  | { kind: "appended"; seq: number }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: string };

/** Drives a store and the reference model with the same commands. */
class Harness {
  model: Model = emptyModel();
  /** The seq each landed txnId landed at. */
  readonly landed = new Map<string, number>();
  #fresh = 0;

  async apply(store: SqliteCommitStore, command: Command): Promise<void> {
    const used = [...this.landed.keys()];
    const txnId = command.reuseTxn !== undefined && used.length > 0
      ? used[command.reuseTxn % used.length]
      : `txn-${this.#fresh++}`;
    const ops: Op[] = [];
    for (const spec of command.ops) ops.push(await buildOp(spec));
    const commit = modelCommit(
      Math.max(1, this.model.seq + 1 + command.seqOffset),
      ops,
      { txnId, fence: command.fence },
    );

    let actual: Outcome;
    try {
      const result = await store.append(commit);
      if (result.kind === "duplicate") {
        assertEquals(result.seq, this.landed.get(txnId));
        actual = { kind: "duplicate" };
      } else {
        actual = result;
      }
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      actual = { kind: "rejected", reason: error.reason };
    }
    const reference = await modelAppend(this.model, commit, command.ops);
    assertEquals(actual, reference.result);
    this.model = reference.model;
    if (actual.kind === "appended") this.landed.set(txnId, actual.seq);
  }

  /**
   * The store's stored commits and head agree with the model, and its
   * snapshot, if it wrote one, is the state those commits give at its seq.
   */
  async check(store: SqliteCommitStore, path: string): Promise<void> {
    const replayed = Partition.empty(modelPartition());
    const commits = (await store.readPartition("", modelPartition(), 1, 1000))
      .map((change) => change.commit);
    for (const commit of commits) replayed.append(commit);
    assertEquals(observe(replayed), expected(this.model));
    assertEquals(await store.head("", modelPartition()), {
      seq: this.model.seq,
      highestFence: this.model.fence,
    });

    const db = new DatabaseSync(path);
    let row: { body: string } | undefined;
    try {
      row = db.prepare("SELECT body FROM partition_snapshots").get() as
        | { body: string }
        | undefined;
    } finally {
      db.close();
    }
    if (row === undefined) return;
    const body = JSON.parse(row.body);
    const covered = commits.slice(0, body.seq);
    const restored = Partition.restore(
      modelPartition(),
      body,
      (txnId) => covered.some((commit) => commit.txnId === txnId),
    );
    const upToSnapshot = Partition.empty(modelPartition());
    for (const commit of covered) upToSnapshot.append(commit);
    // Compared through the partitions' getters, not snapshot(), which would
    // share any fault of the snapshot it checks.
    assertEquals(observe(restored), observe(upToSnapshot));
    assertEquals(restored.leaseHolder, upToSnapshot.leaseHolder);
  }
}

Deno.test("SqliteCommitStore: agrees with the partition reference model, before and after a reopen", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-commit-property-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCommand, { minLength: 1, maxLength: 20 }),
        fc.array(fc.tuple(arbCommand, fc.boolean()), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 5 }),
        async (before, after, snapshotInterval) => {
          const path = join(dir, `${crypto.randomUUID()}.db`);
          const options = { snapshotInterval, cachedPartitions: 1 };
          const harness = new Harness();

          // The first phase lands as much as it can (the next seq, one
          // fence), so the snapshot the reopen rebuilds from holds real
          // state: deleted top versions, tombstoned records, a raised fence.
          // In the second phase about half the commands do the same, so they
          // test the rebuilt state; the rest are unbiased and mostly refused
          // for their seq or fence.
          const store = SqliteCommitStore.open(path, options);
          try {
            for (const command of before) {
              await harness.apply(store, {
                ...command,
                seqOffset: 0,
                fence: 1,
              });
            }
            await harness.check(store, path);
          } finally {
            await store.close();
          }

          // Reopened, the store rebuilds the partition from the file.
          const reopened = SqliteCommitStore.open(path, options);
          try {
            for (const [command, lands] of after) {
              await harness.apply(
                reopened,
                lands ? { ...command, seqOffset: 0, fence: 1 } : command,
              );
            }
            await harness.check(reopened, path);
          } finally {
            await reopened.close();
          }
        },
      ),
      { numRuns: 150 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** A small pool of chunk hashes, so content shares chunks across puts. */
const POOL = [..."0123456789ab"].map((c) => c.repeat(64));

const arbContent = fc.oneof(
  fc.constant({ kind: "inline" as const }),
  fc.record({
    kind: fc.constant("one" as const),
    chunk: fc.nat({ max: POOL.length - 1 }),
  }),
  fc.record({
    kind: fc.constant("parts" as const),
    chunks: fc.array(fc.nat({ max: POOL.length - 1 }), {
      minLength: 2,
      maxLength: 4,
    }),
    whole: fc.nat({ max: POOL.length - 1 }),
  }),
);

/** One append: a put of each content, maybe at a refused (gapped) seq. */
const arbChunkAppend = fc.record({
  namespace: fc.constantFrom("", "acme", "beta"),
  gap: fc.boolean(),
  puts: fc.array(
    fc.record({ name: fc.constantFrom("a", "b", "c"), content: arbContent }),
    { minLength: 1, maxLength: 3 },
  ),
});

Deno.test("SqliteCommitStore: the chunk index equals the chunks every stored commit names, appended or backfilled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-chunk-refs-property-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbChunkAppend, { minLength: 1, maxLength: 25 }),
        async (appends) => {
          const path = join(dir, `${crypto.randomUUID()}.db`);
          const store = SqliteCommitStore.open(path);
          const seqs = new Map<string, number>();
          try {
            for (const append of appends) {
              const ops: Op[] = [];
              for (const [i, put] of append.puts.entries()) {
                const content = put.content;
                ops.push(
                  content.kind === "inline"
                    ? await savePut(put.name, i + 1)
                    : await blobPut(
                      put.name,
                      i + 1,
                      content.kind === "one"
                        ? BlobRef.create({
                          sha256: POOL[content.chunk],
                          size: 1,
                        })
                        : BlobRef.create({
                          sha256: POOL[content.whole],
                          size: content.chunks.length,
                          parts: content.chunks.map((c) => ({
                            sha256: POOL[c],
                            size: 1,
                          })),
                        }),
                    ),
                );
              }
              const next = (seqs.get(append.namespace) ?? 0) + 1;
              try {
                await store.append(
                  modelCommit(append.gap ? next + 1 : next, ops, {
                    namespace: append.namespace,
                    txnId: crypto.randomUUID(),
                  }),
                );
                seqs.set(append.namespace, next);
              } catch (error) {
                if (!(error instanceof CommitRejectedError)) throw error;
              }
            }

            // The oracle: every stored commit's chunks, by namespace.
            const named = new Map<string, Set<string>>();
            for (const change of await store.changesSince(0, 10_000)) {
              const set = named.get(change.commit.namespace) ?? new Set();
              for (const sha256 of change.commit.chunkRefs()) set.add(sha256);
              named.set(change.commit.namespace, set);
            }
            for (const namespace of ["", "acme", "beta"]) {
              assertEquals(
                await store.referencedChunks(namespace, POOL),
                named.get(namespace) ?? new Set(),
              );
            }
          } finally {
            await store.close();
          }

          const fresh = chunkRefRows(path);
          const db = new DatabaseSync(path);
          db.exec("DROP TABLE chunk_refs; PRAGMA user_version=1");
          db.close();
          await SqliteCommitStore.open(path).close();
          assertEquals(chunkRefRows(path), fresh);
        },
      ),
      { numRuns: 150 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** The `chunk_refs` rows, read behind the store's back. */
function chunkRefRows(path: string): unknown[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(
      "SELECT namespace, sha256 FROM chunk_refs ORDER BY namespace, sha256",
    ).all();
  } finally {
    db.close();
  }
}

/** The ops of one generated append, as the index test builds them. */
async function chunkAppendOps(
  append: typeof arbChunkAppend extends fc.Arbitrary<infer T> ? T : never,
): Promise<Op[]> {
  const ops: Op[] = [];
  for (const [i, put] of append.puts.entries()) {
    const content = put.content;
    ops.push(
      content.kind === "inline"
        ? await savePut(put.name, i + 1)
        : await blobPut(
          put.name,
          i + 1,
          content.kind === "one"
            ? BlobRef.create({ sha256: POOL[content.chunk], size: 1 })
            : BlobRef.create({
              sha256: POOL[content.whole],
              size: content.chunks.length,
              parts: content.chunks.map((c) => ({
                sha256: POOL[c],
                size: 1,
              })),
            }),
        ),
    );
  }
  return ops;
}

Deno.test("SqliteCommitStore: after compactions the chunk counts equal the stored commits and base records naming each chunk (swamp-club#3258)", async () => {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-chunk-counts-property-",
  });
  const arbStep = fc.oneof(
    { weight: 3, arbitrary: arbChunkAppend.map((a) => ({ append: a })) },
    {
      weight: 1,
      arbitrary: fc.record({
        compact: fc.double({ min: 0, max: 1, noNaN: true }),
        batchSize: fc.integer({ min: 1, max: 3 }),
      }),
    },
  );
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbStep, { minLength: 1, maxLength: 30 }),
        async (steps) => {
          const path = join(dir, `${crypto.randomUUID()}.db`);
          const store = SqliteCommitStore.open(path);
          const seqs = new Map<string, number>();
          try {
            for (const step of steps) {
              if ("compact" in step) {
                const last = (await store.compactionStatus({
                  commits: 0,
                  since: "9999-12-31T00:00:00.000Z",
                })).through ?? 0;
                await store.compactHistory(
                  Math.ceil(step.compact * last),
                  { batchSize: step.batchSize },
                );
                continue;
              }
              const { append } = step;
              const next = (seqs.get(append.namespace) ?? 0) + 1;
              try {
                await store.append(
                  modelCommit(next, await chunkAppendOps(append), {
                    namespace: append.namespace,
                    txnId: crypto.randomUUID(),
                  }),
                );
                seqs.set(append.namespace, next);
              } catch (error) {
                if (!(error instanceof CommitRejectedError)) throw error;
              }
            }

            // The oracle: each surviving commit, and each base record, that
            // names a chunk counts once.
            const counts = new Map<string, number>();
            const add = (namespace: string, hashes: Iterable<string>) => {
              for (const sha256 of new Set(hashes)) {
                const key = JSON.stringify([namespace, sha256]);
                counts.set(key, (counts.get(key) ?? 0) + 1);
              }
            };
            const point = (await store.readCompactedBase(undefined, 1)).point;
            for (const change of await store.changesSince(point, 10_000)) {
              add(change.commit.namespace, change.commit.chunkRefs());
            }
            let after: string | undefined;
            do {
              const page = await store.readCompactedBase(after, 50);
              for (const entry of page.entries) {
                if (entry.kind === "record" && "blob" in entry.record.content) {
                  add(entry.namespace, entry.record.content.blob.chunkHashes());
                }
              }
              after = page.next;
            } while (after !== undefined);

            const db = new DatabaseSync(path);
            try {
              const rows = db.prepare(
                "SELECT namespace, sha256, refs FROM chunk_refs",
              ).all() as { namespace: string; sha256: string; refs: number }[];
              assertEquals(
                new Map(
                  rows.map((
                    r,
                  ) => [JSON.stringify([r.namespace, r.sha256]), r.refs]),
                ),
                counts,
              );
            } finally {
              db.close();
            }
            // Referenced now: exactly the counted chunks, once releases are
            // past; every released chunk still counts without a bound.
            for (const namespace of ["", "acme", "beta"]) {
              const named = new Set(
                [...counts.keys()].map((k) => JSON.parse(k) as string[])
                  .filter(([ns]) => ns === namespace).map(([, sha]) => sha),
              );
              assertEquals(
                await store.referencedChunks(
                  namespace,
                  POOL,
                  new Date(Date.now() + 60_000),
                ),
                named,
              );
              const all = await store.referencedChunks(namespace, POOL);
              for (const sha256 of named) assertEquals(all.has(sha256), true);
            }
          } finally {
            await store.close();
          }
        },
      ),
      { numRuns: 150 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
