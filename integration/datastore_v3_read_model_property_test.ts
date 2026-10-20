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
 * Model-based property test of the v3 read model (swamp-club#3239): random
 * command sequences from the partition reference model are appended to a
 * real `commits.db`, and after each catch-up (store-wide or of the
 * partition) the read model's files, live-record index and catalog must
 * match the reference model's present records and live versions. A second
 * read model replaying from cursor 0 must reach the same state.
 *
 * Pages hold one to three commits, and a catch-up can crash at its first
 * page's barrier (swamp-club#3337), losing a file that page wrote, as a power
 * loss would; the catch-up after it must repair the checkout. A step can
 * also reboot: one file written since the last reboot is lost or torn, and
 * the first catch-up in the new boot must repair it.
 *
 * The checkout-copy guard (swamp-club#3617) has a property of its own: over
 * random writes, torn and lost chunks, catch-ups, recoveries and reboots,
 * with the storage refusing puts at times, a chunk a commit names that had
 * a good copy anywhere (stored, in a checkout file or moved aside) before a
 * read model operation still has one after it.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ReadModelIncompleteError } from "../src/domain/datastore_v3/read_model.ts";
import { dirname, join } from "@std/path";
import fc from "fast-check";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  arbCommand,
  buildOp,
  emptyModel,
  type Model,
  modelAppend,
  modelCommit,
  modelPartition,
  NAMES,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import {
  catalogV3Path,
  commitOf,
  readCatalog,
  readTree,
  sha256Hex,
  SmallChunkStorage,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";
import { walk } from "@std/fs";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type {
  ChunkDirectorySync,
  ChunkStat,
  ChunkStatReader,
} from "../src/domain/datastore/datastore_storage.ts";
import { putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import {
  dataKey,
  modelIntent,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import type { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";

const PARTITION = modelPartition();

/** How a step catches the read model up after its append. */
const arbCatchUp = fc.constantFrom(
  "none" as const,
  "store" as const,
  "partition" as const,
  "crash-truncate" as const,
  "crash-delete" as const,
  "reboot-truncate" as const,
  "reboot-delete" as const,
);

/**
 * A batch that records what it writes and, while `control.armed`, fails its
 * barrier once before syncing anything.
 */
class CrashingBatch extends DurableWriteBatch {
  constructor(
    readonly control: {
      armed: boolean;
      written: string[];
      sinceReboot: string[];
    },
  ) {
    // Unsynced, as the read model's own page batches are.
    super({ sync: false });
    control.written = [];
  }
  override async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options?: { readonly absentDirectories?: readonly string[] },
  ): Promise<void> {
    await super.write(path, content, signal, options);
    this.control.written.push(path);
    this.control.sinceReboot.push(path);
  }
  override async barrier(): Promise<void> {
    if (this.control.armed) {
      this.control.armed = false;
      throw new Error("injected crash before the barrier");
    }
    await super.barrier();
  }
}

/** Loses one file the crashed page wrote: emptied or gone. */
async function loseWrite(
  written: readonly string[],
  how: "truncate" | "delete",
): Promise<void> {
  for (const path of written) {
    try {
      if (!(await Deno.stat(path)).isFile) continue;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (how === "truncate") await Deno.truncate(path, 0);
    else await Deno.remove(path);
    return;
  }
}

async function assertMatchesModel(
  env: V3Env,
  readModel: SqliteReadModel,
  model: Model,
  complete: boolean,
): Promise<void> {
  const records = Object.fromEntries(
    Object.entries(model.records).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  // Every present record is a file holding its bytes, and nothing else is.
  assertEquals(Object.fromEntries(await readTree(env.cacheRoot(""))), records);
  // Until a catch-up has drained the feed, the index refuses to be read.
  if (!complete) {
    await assertRejects(
      () => readModel.liveRecords("", PARTITION),
      ReadModelIncompleteError,
    );
  } else {
    const index = await readModel.liveRecords("", PARTITION);
    assertEquals(
      Object.fromEntries(index.map((r) => [r.key.toString(), r.sha256])),
      records,
    );
  }
  // One row per live version, the greatest of each name latest.
  const expectedRows = NAMES.flatMap((name) => {
    const live = [...(model.live[name] ?? [])].sort((a, b) => a - b);
    return live.map((version) => [
      name,
      version,
      version === live.at(-1) ? 1 : 0,
    ]);
  });
  assertEquals(
    readCatalog(catalogV3Path(env)).rows.map((
      r,
    ) => [r.data_name, r.version, r.is_latest]),
    expectedRows,
  );
}

Deno.test("read model: matches the partition reference model after every catch-up and after a replay", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(arbCommand, arbCatchUp), {
        minLength: 1,
        maxLength: 15,
      }),
      fc.integer({ min: 1, max: 3 }),
      async (steps, pageSize) => {
        await withV3Env(async (env) => {
          let model = emptyModel();
          let txn = 0;
          let complete = false;
          const control = {
            armed: false,
            written: [] as string[],
            sinceReboot: [] as string[],
          };
          let boot = 0;
          const readModel = env.openReadModel({
            pageSize,
            writeBatch: () => new CrashingBatch(control),
            bootIdentity: () => Promise.resolve(`boot-id:${boot}`),
          });
          try {
            for (const [command, catchUp] of steps) {
              const ops: Op[] = [];
              for (const spec of command.ops) ops.push(await buildOp(spec));
              // Mostly the next seq and one fence, so most commits land;
              // refused ones are skipped, as the store skips them.
              const commit = modelCommit(model.seq + 1, ops, {
                txnId: `txn-${txn++}`,
                fence: 1,
              });
              try {
                await env.store.append(commit);
              } catch (error) {
                if (!(error instanceof CommitRejectedError)) throw error;
                continue;
              }
              const next = await modelAppend(model, commit, command.ops);
              assertEquals(next.result.kind, "appended");
              model = next.model;

              if (catchUp === "none") continue;
              const signal = AbortSignal.timeout(30_000);
              if (catchUp === "store") {
                await readModel.catchUp(signal);
                complete = true;
              } else if (catchUp.startsWith("reboot")) {
                await readModel.catchUp(signal);
                await loseWrite(
                  control.sinceReboot,
                  catchUp === "reboot-truncate" ? "truncate" : "delete",
                );
                boot++;
                control.sinceReboot = [];
                await readModel.catchUp(signal);
                complete = true;
              } else if (catchUp !== "partition") {
                // A catch-up with nothing to apply has no page, so no barrier.
                control.armed = true;
                const crashed = await readModel.catchUp(signal).then(
                  () => false,
                  (error) => {
                    assertStringIncludes(String(error), "injected crash");
                    return true;
                  },
                );
                control.armed = false;
                if (crashed) {
                  await loseWrite(
                    control.written,
                    catchUp === "crash-truncate" ? "truncate" : "delete",
                  );
                }
                await readModel.catchUp(signal);
                complete = true;
              } else {
                await readModel.catchUpPartition("", PARTITION, signal);
              }
              await assertMatchesModel(env, readModel, model, complete);
            }
            await readModel.catchUp(AbortSignal.timeout(30_000));
            await assertMatchesModel(env, readModel, model, true);
          } finally {
            await readModel.close();
          }

          // A second read model with no state replays from cursor 0.
          await Deno.remove(join(env.stateDir, READ_MODEL_STATE_FILE));
          const replay = env.openReadModel();
          try {
            await replay.catchUp(AbortSignal.timeout(30_000));
            await assertMatchesModel(env, replay, model, true);
          } finally {
            await replay.close();
          }
        });
      },
    ),
    { numRuns: 60 },
  );
});

/** Contents over the inline limit, in several chunks each, none shared. */
const CONTENTS = [0, 1, 2, 3].map((n) =>
  new Uint8Array(9 * TEST_CHUNK_BYTES + 100 * n + 1).map((_, i) =>
    (i * (n + 3) + n * 17 + (i >> 10) * 31) % 256
  )
);
const GUARD_KEYS = [dataKey("k", 1), dataKey("l", 1)];

/** The filesystem storage, reading sizes, refusing puts on demand. */
class RefusingStatStorage extends SmallChunkStorage
  implements ChunkStatReader, ChunkDirectorySync {
  refuse = false;
  override put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (this.refuse) return Promise.reject(new Error("AccessDenied"));
    return super.put(namespace, sha256, bytes, signal);
  }
  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>> {
    return (this.inner as FileSystemStorage).statChunks(
      namespace,
      hashes,
      signal,
    );
  }
  syncChunkDirectories(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    return (this.inner as FileSystemStorage).syncChunkDirectories(
      namespace,
      hashes,
      signal,
    );
  }
}

const arbGuardStep = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      key: fc.integer({ min: 0, max: 1 }),
      content: fc.integer({ min: 0, max: 3 }),
      // The writer's own checkout writes the file before it commits.
      local: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("tombstone" as const),
      key: fc.integer({ min: 0, max: 1 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("damage" as const),
      content: fc.integer({ min: 0, max: 3 }),
      part: fc.integer({ min: 0, max: 8 }),
      how: fc.constantFrom("tear" as const, "lose" as const),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("sync" as const),
      op: fc.constantFrom(
        "catch-up" as const,
        "recover" as const,
        "reboot" as const,
      ),
      refuse: fc.boolean(),
    }),
  },
);

function guardChunkFile(env: V3Env, sha256: string): string {
  return join(
    env.dir,
    "datastore",
    "_blobs",
    "_default",
    "sha256",
    sha256.slice(0, 2),
    sha256,
  );
}

/**
 * The chunks of `chunks` that have a good copy: stored whole, or a part of
 * any file in the checkout's `.swamp`, the at-risk copies included.
 */
async function goodCopies(
  env: V3Env,
  chunks: ReadonlyMap<string, number>,
): Promise<{ stored: Set<string>; anywhere: Set<string> }> {
  const stored = new Set<string>();
  for (const [sha256, size] of chunks) {
    try {
      const bytes = await Deno.readFile(guardChunkFile(env, sha256));
      if (bytes.length === size && await sha256Hex(bytes) === sha256) {
        stored.add(sha256);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const anywhere = new Set(stored);
  try {
    for await (
      const entry of walk(swampPath(env.repoDir), { includeDirs: false })
    ) {
      if (entry.name.endsWith(".db") || entry.name.includes(".db-")) continue;
      const bytes = await Deno.readFile(entry.path);
      for (let at = 0; at < bytes.length; at += TEST_CHUNK_BYTES) {
        const hash = await sha256Hex(bytes.subarray(at, at + TEST_CHUNK_BYTES));
        if (chunks.has(hash)) anywhere.add(hash);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return { stored, anywhere };
}

Deno.test("read model guard: a referenced chunk with a good copy keeps one through every read model operation (swamp-club#3617)", async () => {
  const coverage = { atRisk: 0, restored: 0, movedAside: 0, operations: 0 };
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbGuardStep, { minLength: 4, maxLength: 14 }),
      async (steps) => {
        await withV3Env(async (env) => {
          const refs: BlobRef[] = [];
          for (const content of CONTENTS) {
            refs.push(
              await env.chunkStore.refOf(content, AbortSignal.timeout(30_000))
                .then((parts) => parts.ref),
            );
          }
          /** Every chunk a landed commit names, with its size. */
          const named = new Map<string, number>();
          const storage = new RefusingStatStorage(env.storage.inner);
          let boot = 1;
          let now = Date.parse("2026-10-19T00:00:00Z");
          let seq = 0;
          for (const step of steps) {
            const signal = AbortSignal.timeout(30_000);
            if (step.kind === "commit") {
              const key = GUARD_KEYS[step.key];
              const content = CONTENTS[step.content];
              // An older writer trusts a chunk it finds, torn or not.
              const blob = await env.chunkStore.write(
                SOLO_NAMESPACE,
                content,
                signal,
              );
              if (step.local) {
                const path = join(
                  swampPath(env.repoDir),
                  ...key.toString().split("/"),
                );
                await Deno.mkdir(dirname(path), { recursive: true });
                await Deno.writeFile(path, content);
              }
              await env.store.append(commitOf({
                seq: ++seq,
                partition: PARTITION,
                namespace: "",
                ops: [
                  await putOp({
                    intent: modelIntent({
                      kind: "data.save",
                      name: step.key === 0 ? "k" : "l",
                      version: 1,
                    }),
                    key,
                    blob,
                  }),
                ],
              }));
              for (const part of blob.parts ?? []) {
                named.set(part.sha256, part.size);
              }
              continue;
            }
            if (step.kind === "tombstone") {
              await env.store.append(commitOf({
                seq: ++seq,
                partition: PARTITION,
                namespace: "",
                ops: [tombstoneOp({
                  intent: modelIntent({
                    kind: "data.delete",
                    name: step.key === 0 ? "k" : "l",
                    version: 1,
                  }),
                  key: GUARD_KEYS[step.key],
                })],
              }));
              continue;
            }
            if (step.kind === "damage") {
              const part = refs[step.content].parts![step.part];
              const path = guardChunkFile(env, part.sha256);
              try {
                if (step.how === "tear") await Deno.truncate(path, 7);
                else await Deno.remove(path);
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
              continue;
            }
            const before = await goodCopies(env, named);
            storage.refuse = step.refuse;
            if (step.op === "reboot") boot++;
            now += 2 * 60 * 60 * 1000;
            const model = env.openReadModel({
              chunkStore: new ChunkStore(storage),
              bootIdentity: () => Promise.resolve(`boot-id:${boot}`),
              clock: () => new Date(now),
            });
            try {
              if (step.op === "recover") {
                await model.recover("", {
                  since: Number.MAX_SAFE_INTEGER,
                  admits: () => true,
                  signal,
                });
              } else {
                await model.catchUp(signal);
              }
            } finally {
              await model.close();
            }
            coverage.operations++;
            const after = await goodCopies(env, named);
            for (const sha256 of before.anywhere) {
              assert(
                after.anywhere.has(sha256),
                `chunk ${sha256} lost its last good copy in a ${step.op}`,
              );
              if (!before.stored.has(sha256)) {
                coverage.atRisk++;
                if (after.stored.has(sha256)) coverage.restored++;
              }
            }
            const atRisk = join(env.stateDir, "at-risk");
            try {
              for await (const _ of walk(atRisk, { includeDirs: false })) {
                coverage.movedAside++;
              }
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
          }
        });
      },
    ),
    { numRuns: 60 },
  );
  // Not vacuous: chunks whose only copy was a file were met, and stored
  // again from it or moved aside.
  console.log(`guard property coverage: ${JSON.stringify(coverage)}`);
  assert(
    coverage.atRisk > 0 && coverage.restored + coverage.movedAside > 0,
    JSON.stringify(coverage),
  );
});
