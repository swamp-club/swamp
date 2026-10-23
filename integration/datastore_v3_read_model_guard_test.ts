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
 * The v3 read model's checkout-copy guard and unreadable records
 * (swamp-club#3617) on real temp directories: a torn or missing chunk whose
 * only good copy is a checkout file is stored again from the file, or the
 * file is moved aside, before the file is overwritten or removed; a record
 * whose chunks cannot be read is recorded instead of wedging every later
 * commit; and the check after a reboot rewrites mismatched files instead of
 * replaying every commit.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import {
  ChunkMissingError,
  ChunkStore,
} from "../src/domain/datastore_v3/chunk_store.ts";
import type {
  ChunkDirectorySync,
  ChunkStat,
  ChunkStatReader,
  DatastoreStorage,
} from "../src/domain/datastore/datastore_storage.ts";
import type { CommitStore } from "../src/domain/datastore_v3/commit_store.ts";
import { type Op, putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  CheckoutCopyAtRiskError,
  ReadModelApplyError,
} from "../src/domain/datastore_v3/read_model.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  blobPut,
  dataKey,
  deleteVersion,
  modelIntent,
  modelPartition,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import type { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import {
  atRiskCopyPath,
  READ_MODEL_STATE_FILE,
  type SqliteReadModel,
  type SqliteReadModelOptions,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  base64Of,
  commitOf,
  sha256Hex,
  SmallChunkStorage,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();
const signal = () => AbortSignal.timeout(30_000);

/** Content over the inline limit, in several chunks. */
const V1 = new Uint8Array(10 * TEST_CHUNK_BYTES + 13).map((_, i) => i % 251);
const V2 = new Uint8Array(10 * TEST_CHUNK_BYTES + 29).map((_, i) =>
  (i * 7 + 3) % 253
);
const K = dataKey("k", 1);

/**
 * The test storage over the env's filesystem storage, counting requests and
 * refusing puts on demand; without the size reader, as a bucket's.
 */
class SpyStorage extends SmallChunkStorage {
  has_ = 0;
  gets = 0;
  readonly puts: string[] = [];
  refusePuts: Error | undefined;
  refused = 0;

  override has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ) {
    this.has_++;
    return super.has(namespace, hashes, signal);
  }
  override get(namespace: string, sha256: string, signal: AbortSignal) {
    this.gets++;
    return super.get(namespace, sha256, signal);
  }
  override put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (this.refusePuts !== undefined) {
      this.refused++;
      return Promise.reject(this.refusePuts);
    }
    this.puts.push(sha256);
    return super.put(namespace, sha256, bytes, signal);
  }
}

/** {@link SpyStorage} with the filesystem's size reader and directory sync. */
class StatSpyStorage extends SpyStorage
  implements ChunkStatReader, ChunkDirectorySync {
  stats = 0;
  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>> {
    this.stats++;
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

function fileOf(env: V3Env, key: RecordKey): string {
  return join(swampPath(env.repoDir), ...key.toString().split("/"));
}

function chunkFile(env: V3Env, sha256: string): string {
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

/** Tears a stored chunk, as a power cut before its sync would. */
async function tear(env: V3Env, sha256: string): Promise<void> {
  await Deno.truncate(chunkFile(env, sha256), 10);
}

async function chunkSize(env: V3Env, sha256: string): Promise<number> {
  return (await Deno.stat(chunkFile(env, sha256))).size;
}

/** Appends one commit putting K with `blob`, at `seq`. */
async function putK(env: V3Env, seq: number, blob: BlobRef): Promise<void> {
  await env.store.append(commitOf({
    seq,
    partition: PARTITION,
    namespace: "",
    ops: [await blobPut("k", 1, blob)],
  }));
}

function open(
  env: V3Env,
  storage: DatastoreStorage,
  overrides: Partial<SqliteReadModelOptions> = {},
): SqliteReadModel {
  return env.openReadModel({
    chunkStore: new ChunkStore(storage),
    ...overrides,
  });
}

async function using<T>(
  model: SqliteReadModel,
  fn: (model: SqliteReadModel) => Promise<T>,
): Promise<T> {
  try {
    return await fn(model);
  } finally {
    await model.close();
  }
}

const recoverOptions = () => ({
  // Nothing is swept: every file is the commits'.
  since: Number.MAX_SAFE_INTEGER,
  admits: () => true,
  signal: signal(),
});

function stateRows(env: V3Env, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** The writer's checkout: K v1 then v2 applied, the v2 file in place. */
async function writerAtV2(
  env: V3Env,
): Promise<{ v1: BlobRef; v2: BlobRef }> {
  const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
  const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
  await putK(env, 1, v1);
  await putK(env, 2, v2);
  await using(env.openReadModel(), (model) => model.catchUp(signal()));
  assertEquals(await Deno.readFile(fileOf(env, K)), V2);
  return { v1, v2 };
}

Deno.test("read model guard: recover stores a torn chunk again from the checkout file before an earlier put overwrites it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v2 } = await writerAtV2(env);
    const torn = v2.parts![3].sha256;
    await tear(env, torn);
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), async (model) => {
      assertEquals(await model.recover("", recoverOptions()), []);
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
    assertEquals(storage.puts, [torn]);
  });
});

Deno.test("read model guard: after a reboot a writer-overwritten listed file is rewritten through the guard, without a replay (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await putK(env, 1, v1);
    let boot = "boot-id:1";
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve(boot) });
    await using(reader(), (model) => model.catchUp(signal()));
    // A writer in this checkout wrote v2 over the listed file and landed
    // its commit; then the power went, tearing a v2 chunk.
    await Deno.writeFile(fileOf(env, K), V2);
    await putK(env, 2, v2);
    const torn = v2.parts![0].sha256;
    await tear(env, torn);
    boot = "boot-id:2";
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 1, cursor: 2 });
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
  });
});

Deno.test("read model guard: a chunk torn after its file was applied is repaired by the check after a reboot (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    let boot = "boot-id:1";
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve(boot) });
    await using(reader(), (model) => model.catchUp(signal()));
    const torn = v1.parts![5].sha256;
    await tear(env, torn);
    boot = "boot-id:2";
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 0, cursor: 1 });
    });
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model guard: a file that already holds the content is not rewritten, and is listed unsynced (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, {
        bootIdentity: () => Promise.resolve("boot-id:1"),
      });
    await using(reader(), (model) => model.catchUp(signal()));
    const old = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(fileOf(env, K), old, old);
    // A deleted state replays every commit over the files.
    await Deno.remove(join(env.stateDir, READ_MODEL_STATE_FILE));
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 1, cursor: 1 });
    });
    assertEquals(
      (await Deno.stat(fileOf(env, K))).mtime?.getTime(),
      old.getTime(),
    );
    assertEquals(
      stateRows(env, "SELECT record_key FROM unsynced_keys").map((r) =>
        r.record_key
      ),
      [K.toString()],
    );
  });
});

Deno.test("read model guard: a catch-up hashes no file it wrote itself and no inline-sized file (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await putK(env, 1, v1);
    await putK(env, 2, v2);
    await env.store.append(commitOf({
      seq: 3,
      partition: PARTITION,
      namespace: "",
      ops: [await savePut("s", 1, "small one")],
    }));
    let cuts = 0;
    class CountingChunkStore extends ChunkStore {
      override refOf(
        content: Uint8Array | ReadableStream<Uint8Array>,
        signal: AbortSignal,
      ) {
        cuts++;
        return super.refOf(content, signal);
      }
    }
    const storage = new StatSpyStorage(env.storage.inner);
    await using(
      env.openReadModel({ chunkStore: new CountingChunkStore(storage) }),
      (model) => model.catchUp(signal()),
    );
    // An inline-sized file another commit overwrites is not hashed either.
    await env.store.append(commitOf({
      seq: 4,
      partition: PARTITION,
      namespace: "",
      ops: [await savePut("s", 1, "small two")],
    }));
    await using(
      env.openReadModel({ chunkStore: new CountingChunkStore(storage) }),
      (model) => model.catchUp(signal()),
    );
    assertEquals(cuts, 0);
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
  });
});

/** Removes K, at `seq`. */
async function removeK(env: V3Env, seq: number): Promise<void> {
  await env.store.append(commitOf({
    seq,
    partition: PARTITION,
    namespace: "",
    ops: [tombstoneOp({
      intent: modelIntent({ kind: "data.delete", name: "k", version: 1 }),
      key: K,
    })],
  }));
}

/** Changes K's file as another process would: new bytes, a new mtime. */
async function rewriteByHand(env: V3Env, content: Uint8Array): Promise<void> {
  await Deno.writeFile(fileOf(env, K), content);
  const old = new Date("2001-01-01T00:00:00Z");
  await Deno.utime(fileOf(env, K), old, old);
}

Deno.test({
  name:
    "read model guard: an ordinary catch-up reads no file it wrote that is still as written, and reads one changed since (swamp-club#3617)",
  // On Windows nothing is recorded, and every file is read.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withV3Env(async (env) => {
      const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
      const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
      let cuts = 0;
      class CountingChunkStore extends ChunkStore {
        override refOf(
          content: Uint8Array | ReadableStream<Uint8Array>,
          signal: AbortSignal,
        ) {
          cuts++;
          return super.refOf(content, signal);
        }
      }
      const storage = new StatSpyStorage(env.storage.inner);
      const catchUp = () =>
        using(
          env.openReadModel({ chunkStore: new CountingChunkStore(storage) }),
          (model) => model.catchUp(signal()),
        );
      await putK(env, 1, v1);
      await catchUp();
      // An overwrite, then a removal, of files it wrote.
      await putK(env, 2, v2);
      await catchUp();
      assertEquals(await Deno.readFile(fileOf(env, K)), V2);
      await removeK(env, 3);
      await catchUp();
      assertEquals(cuts, 0);
      // A file changed since it was written is read before it is replaced.
      await putK(env, 4, v1);
      await catchUp();
      await rewriteByHand(env, V2);
      await putK(env, 5, v2);
      await catchUp();
      assertEquals(cuts, 1);
      assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    });
  },
});

Deno.test("read model guard: a file it wrote that another process has since changed is read before its removal, and stores the torn chunk only it holds (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), (model) => model.catchUp(signal()));
    // Another process writes new content of the same size over the file,
    // and commits it at another key; its chunk is torn.
    const same = V1.map((b) => b ^ 7);
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, same, signal());
    const torn = v2.parts![3].sha256;
    await tear(env, torn);
    await rewriteByHand(env, same);
    const L = dataKey("l", 1);
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [await blobPut("l", 1, v2)],
    }));
    await removeK(env, 3);
    await using(open(env, storage), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", L.toString()), undefined);
    });
    assertEquals(
      await sha256Hex(await Deno.readFile(chunkFile(env, torn))),
      torn,
    );
    assertEquals(await Deno.readFile(fileOf(env, L)), same);
    await assertRejects(() => Deno.stat(fileOf(env, K)), Deno.errors.NotFound);
  });
});

Deno.test("read model guard: a file torn after a reboot though its stat still shows it as written is read, and rewritten (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    const storage = new StatSpyStorage(env.storage.inner);
    let boot = "boot-id:1";
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve(boot) });
    await using(reader(), (model) => model.catchUp(signal()));
    // A power cut tore the unsynced file and left its stat as written.
    await Deno.writeFile(fileOf(env, K), new Uint8Array(V1.length));
    const info = await Deno.lstat(fileOf(env, K));
    const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE));
    try {
      assertEquals(
        db.prepare(
          "UPDATE written_files SET mtime = ?, ctime = ? WHERE record_key = ?",
        ).run(
          info.mtime!.getTime(),
          info.ctime?.getTime() ?? null,
          K.toString(),
        ).changes,
        Deno.build.os === "windows" ? 0 : 1,
      );
    } finally {
      db.close();
    }
    boot = "boot-id:2";
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model guard: on Windows no written file is recorded or looked up, so a row holding an NTFS file id past 2^53 never fails a catch-up (swamp-club#3788)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    const storage = new StatSpyStorage(env.storage.inner);
    const catchUp = () =>
      using(
        open(env, storage, { os: "windows" }),
        (model) => model.catchUp(signal()),
      );
    await catchUp();
    assertEquals(stateRows(env, "SELECT * FROM written_files"), []);
    // A release before swamp-club#3788 recorded the file with its NTFS id,
    // which SQLite cannot read back as a number.
    const info = await Deno.lstat(fileOf(env, K));
    const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE));
    try {
      db.prepare(
        "INSERT INTO written_files (namespace, record_key, blob, size, ino, dev, mtime, ctime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "",
        K.toString(),
        JSON.stringify(v1.toJSON()),
        info.size,
        9570149209554324,
        info.dev,
        info.mtime!.getTime(),
        info.ctime?.getTime() ?? null,
      );
    } finally {
      db.close();
    }
    // An overwrite, then a removal, each guard the file the row names.
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await putK(env, 2, v2);
    await catchUp();
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    assertEquals(
      stateRows(env, "SELECT record_key FROM written_files"),
      [{ record_key: K.toString() }],
    );
    await removeK(env, 3);
    await catchUp();
    await assertRejects(() => Deno.stat(fileOf(env, K)), Deno.errors.NotFound);
  });
});

Deno.test("read model guard: a replay finds a right-size damaged chunk and stores it again; an ordinary catch-up reads no stored part (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v1, v2 } = await writerAtV2(env);
    // Same size, wrong bytes: only reading the chunk tells.
    const damaged = v2.parts![2].sha256;
    await Deno.writeFile(
      chunkFile(env, damaged),
      new Uint8Array(TEST_CHUNK_BYTES),
    );
    // An ordinary catch-up overwriting K with a third put reads no part.
    const storage = new StatSpyStorage(env.storage.inner);
    const v3 = await env.chunkStore.write(
      SOLO_NAMESPACE,
      V1.map((b) => b ^ 1),
      signal(),
    );
    await putK(env, 3, v3);
    await using(open(env, storage), (model) => model.catchUp(signal()));
    assertEquals(storage.gets, v3.parts!.length, "only v3's own chunks read");
    // Put v2 back as the file, as a writer would, and replay.
    await Deno.writeFile(fileOf(env, K), V2);
    await putK(env, 4, v2);
    storage.gets = 0;
    await using(open(env, storage), async (model) => {
      await model.recover("", recoverOptions());
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    assertEquals(
      await sha256Hex(await Deno.readFile(chunkFile(env, damaged))),
      damaged,
    );
    assert(storage.puts.includes(damaged));
    assert(!storage.puts.includes(v1.parts![0].sha256));
  });
});

Deno.test("read model guard: a lagging checkout loading the compacted base stores no released chunk again (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    // The lagging checkout applied v1.
    await using(env.openReadModel(), (model) => model.catchUp(signal()));
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await putK(env, 2, v2);
    // Compaction folds v1 away and releases its chunks; a sweep deletes them.
    const report = await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    assert(report.released > 0);
    for (const part of v1.parts!) {
      if (!v2.parts!.some((p) => p.sha256 === part.sha256)) {
        await Deno.remove(chunkFile(env, part.sha256));
      }
    }
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), (model) => model.catchUp(signal()));
    assertEquals(storage.puts, []);
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
  });
});

Deno.test("read model guard: a put the storage refuses moves the file aside, and a later section with write access stores it and repairs the record (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v2 } = await writerAtV2(env);
    const torn = v2.parts![3].sha256;
    await tear(env, torn);
    let now = new Date("2026-10-19T00:00:00Z");
    const synced: string[] = [];
    const storage = new StatSpyStorage(env.storage.inner);
    storage.refusePuts = new Error("AccessDenied: read-only member");
    const reader = () =>
      open(env, storage, {
        clock: () => now,
        syncDirectory: (dir) => {
          synced.push(dir);
          return Promise.resolve();
        },
      });
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
    await using(reader(), async (model) => {
      await model.recover("", recoverOptions());
      const record = await model.unreadableRecord("", K.toString());
      assertExists(record);
      assertEquals(record.chunk, torn);
      assertEquals(record.reason, "missing");
    });
    assertEquals(await Deno.readFile(copy), V2);
    assert(synced.includes(dirname(copy)), "the at-risk directory synced");
    assert(synced.includes(dirname(fileOf(env, K))), "the source synced");
    assertEquals(
      stateRows(env, "SELECT namespace, record_key, size FROM at_risk_copies"),
      [{ namespace: "", record_key: K.toString(), size: V2.length }],
    );
    // Commands keep working while the copy waits.
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(await Deno.readFile(copy), V2);

    // Write access is back, and the retry interval has passed.
    storage.refusePuts = undefined;
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    await assertRejects(() => Deno.stat(copy), Deno.errors.NotFound);
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
    assertEquals(stateRows(env, "SELECT * FROM unreadable_records"), []);
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
  });
});

Deno.test("read model guard: a copy moved aside for a right-size damaged chunk is kept until a retry stores the good bytes (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v2 } = await writerAtV2(env);
    // Same size, wrong bytes: the storage's sizes say it is present.
    const damaged = v2.parts![2].sha256;
    await Deno.writeFile(
      chunkFile(env, damaged),
      new Uint8Array(TEST_CHUNK_BYTES),
    );
    let now = new Date("2026-10-19T00:00:00Z");
    const storage = new StatSpyStorage(env.storage.inner);
    storage.refusePuts = new Error("AccessDenied: read-only member");
    const reader = () => open(env, storage, { clock: () => now });
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
    // The replay finds the damage, cannot store it, and moves the file aside.
    await using(reader(), (model) => model.recover("", recoverOptions()));
    assertEquals(await Deno.readFile(copy), V2);

    // Write access is back, and the retry interval has passed.
    storage.refusePuts = undefined;
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await using(reader(), (model) => model.catchUp(signal()));
    assert(storage.puts.includes(damaged), "the good bytes were stored");
    assertEquals(
      await sha256Hex(await Deno.readFile(chunkFile(env, damaged))),
      damaged,
    );
    await assertRejects(() => Deno.stat(copy), Deno.errors.NotFound);
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
  });
});

Deno.test("read model guard: an at-risk copy deleted by hand is forgotten (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v2 } = await writerAtV2(env);
    await tear(env, v2.parts![0].sha256);
    let now = new Date("2026-10-19T00:00:00Z");
    const storage = new StatSpyStorage(env.storage.inner);
    storage.refusePuts = new Error("AccessDenied");
    const reader = () => open(env, storage, { clock: () => now });
    await using(reader(), (model) => model.recover("", recoverOptions()));
    await Deno.remove(join(env.stateDir, "at-risk"), { recursive: true });
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
  });
});

Deno.test("read model guard: across devices the file is copied aside within the cap, and past it the section fails without touching the file (swamp-club#3617)", async () => {
  for (const cap of [undefined, 0]) {
    await withV3Env(async (env) => {
      const { v2 } = await writerAtV2(env);
      await tear(env, v2.parts![1].sha256);
      const storage = new StatSpyStorage(env.storage.inner);
      storage.refusePuts = new Error("AccessDenied");
      const crossDevice = () => {
        const error = new Error("Cross-device link (os error 18)");
        return Promise.reject(error);
      };
      const model = open(env, storage, {
        rename: crossDevice,
        ...(cap === undefined ? {} : { atRiskCopyBytes: cap }),
      });
      const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
      await using(model, async (model) => {
        if (cap === undefined) {
          await model.recover("", recoverOptions());
          assertEquals(await Deno.readFile(copy), V2);
        } else {
          const error = await assertRejects(
            () => model.recover("", recoverOptions()),
            CheckoutCopyAtRiskError,
          );
          assertInstanceOf(error, ReadModelApplyError);
          assertEquals(await Deno.readFile(fileOf(env, K)), V2);
          await assertRejects(() => Deno.stat(copy), Deno.errors.NotFound);
        }
      });
    });
  }
});

Deno.test("read model guard: on a storage that cannot read sizes, an ordinary catch-up asks nothing per file, and a replay asks once per file and moves aside what it cannot store (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    let boot = "boot-id:1";
    const storage = new SpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve(boot) });
    await using(reader(), (model) => model.catchUp(signal()));
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await putK(env, 2, v2);
    storage.has_ = 0;
    // After a reboot the matching listed file is not guarded either.
    boot = "boot-id:2";
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(storage.has_, 0);
    // A chunk lost from the bucket, whose only copy is this file.
    await Deno.remove(chunkFile(env, v2.parts![4].sha256));
    storage.refusePuts = new Error("AccessDenied");
    await using(reader(), async (model) => {
      await model.recover("", recoverOptions());
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    assertEquals(storage.has_, 1);
    assertEquals(
      await Deno.readFile(
        atRiskCopyPath(env.stateDir, "", await sha256Hex(V2)),
      ),
      V2,
    );
  });
});

Deno.test("read model: a missing chunk makes its record unreadable instead of failing the commit, and a retry once the chunk is stored writes it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const firstPart = blob.parts![0].sha256;
    await env.storage.delete("_default", firstPart, signal());
    await putK(env, 1, blob);
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [await savePut("b", 1)],
    }));
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve("boot-id:1") });
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 2, cursor: 2 });
      const record = await model.unreadableRecord("", K.toString());
      assertExists(record);
      assertEquals(record.chunk, firstPart);
      assertEquals(record.reason, "missing");
      assertEquals([record.partition, record.seq, record.position], [
        PARTITION.toString(),
        1,
        1,
      ]);
      // Later commits applied and the index is complete.
      assertEquals((await model.chunksInUse("")).size, blob.parts!.length);
      assertEquals(
        await Deno.readTextFile(fileOf(env, dataKey("b", 1))),
        "b@1",
      );
      await assertRejects(
        () => Deno.stat(fileOf(env, K)),
        Deno.errors.NotFound,
      );
    });
    // Nothing changed: the next catch-up does not try again.
    const gets = storage.gets;
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(storage.gets, gets);

    await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
    assert(
      stateRows(env, "SELECT record_key FROM unsynced_keys").some((r) =>
        r.record_key === K.toString()
      ),
    );
  });
});

Deno.test("read model: a retry of an unreadable record the checkout's directories now keep local forgets it and leaves the local file (swamp-club#3736)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![0].sha256, signal());
    await putK(env, 1, blob);
    await using(open(env, env.storage), async (model) => {
      await model.catchUp(signal());
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const local = fileOf(env, K);
    await Deno.mkdir(dirname(local), { recursive: true });
    await Deno.writeTextFile(local, "local");
    await using(
      open(env, env.storage, {
        checkout: { namespace: "", admits: (key) => key.startsWith("config/") },
      }),
      async (model) => {
        await model.catchUp(signal());
        assertEquals(await model.unreadableRecord("", K.toString()), undefined);
      },
    );
    assertEquals(await Deno.readTextFile(local), "local");
  });
});

Deno.test("read model: without a size reader an unreadable record is tried again at most hourly (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![2].sha256, signal());
    await putK(env, 1, blob);
    let now = new Date("2026-10-19T00:00:00Z");
    const storage = new SpyStorage(env.storage.inner);
    const reader = () => open(env, storage, { clock: () => now });
    await using(reader(), (model) => model.catchUp(signal()));
    await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    now = new Date(now.getTime() + 61 * 60 * 1000);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model: a tombstone of another partition keeps a key's unreadable record, and a later put of its own forgets it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const key = RecordKey.create(
      "config/models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
    );
    const definition = (name: string) => ({ kind: "model" as const, name });
    const partition = (name: string) =>
      partitionOf({ kind: "config", definitionKind: "model", name });
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![0].sha256, signal());
    const append = async (seq: number, name: string, op: Op) =>
      await env.store.append(commitOf({
        seq,
        partition: partition(name),
        namespace: "",
        ops: [op],
      }));
    await append(
      1,
      "alpha",
      await putOp({
        intent: { kind: "definition.edit", definition: definition("alpha") },
        key,
        blob,
      }),
    );
    await append(
      1,
      "beta",
      tombstoneOp({
        intent: { kind: "definition.delete", definition: definition("beta") },
        key,
      }),
    );
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), async (model) => {
      await model.catchUp(signal());
      assertExists(await model.unreadableRecord("", key.toString()));
    });
    await append(
      2,
      "alpha",
      await putOp({
        intent: { kind: "definition.edit", definition: definition("alpha") },
        key,
        inline: base64Of(new TextEncoder().encode("now inline")),
      }),
    );
    await using(open(env, storage), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", key.toString()), undefined);
    });
    assertEquals(await Deno.readTextFile(fileOf(env, key)), "now inline");
  });
});

Deno.test("read model: a commit at or below the compaction point whose chunk is missing still fails the commit (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![0].sha256, signal());
    await putK(env, 1, blob);
    // The store compacted past the commit while the page was read.
    const store: CommitStore = new Proxy(env.store, {
      get(target, property) {
        if (property === "compactionPoint") return () => Promise.resolve(1);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await using(
      open(env, new StatSpyStorage(env.storage.inner), { commitStore: store }),
      async (model) => {
        const error = await assertRejects(
          () => model.catchUp(signal()),
          ReadModelApplyError,
        );
        assertInstanceOf(error.cause, ChunkMissingError);
      },
    );
  });
});

Deno.test("read model: a compacted-base record whose chunk is missing is unreadable at the base's mark, and the load completes (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, blob);
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [await savePut("b", 1)],
    }));
    await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    await env.storage.delete("_default", blob.parts![1].sha256, signal());
    await using(
      open(env, new StatSpyStorage(env.storage.inner)),
      async (model) => {
        assertEquals((await model.catchUp(signal())).cursor, 2);
        const record = await model.unreadableRecord("", K.toString());
        assertExists(record);
        assertEquals([record.seq, record.position], [0, 1]);
        assertEquals(record.chunk, blob.parts![1].sha256);
      },
    );
    assertEquals(await Deno.readTextFile(fileOf(env, dataKey("b", 1))), "b@1");
  });
});

Deno.test("read model: an undone removal in a compacted store is removed again after a reset (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    await env.store.append(commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [await savePut("a", 1)],
    }));
    let boot: string | undefined = "boot-id:1";
    const reader = () =>
      env.openReadModel({ bootIdentity: () => Promise.resolve(boot) });
    await using(reader(), (model) => model.catchUp(signal()));
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [tombstoneOp({
        intent: modelIntent({ kind: "data.delete", name: "a", version: 1 }),
        key: dataKey("a", 1),
      })],
    }));
    await using(reader(), (model) => model.catchUp(signal()));
    await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    // A power cut undid the removal, and the next boot cannot be named.
    await Deno.mkdir(dirname(fileOf(env, dataKey("a", 1))), {
      recursive: true,
    });
    await Deno.writeTextFile(fileOf(env, dataKey("a", 1)), "a@1");
    boot = undefined;
    await using(reader(), (model) => model.catchUp(signal()));
    await assertRejects(
      () => Deno.stat(fileOf(env, dataKey("a", 1))),
      Deno.errors.NotFound,
    );
    assertEquals(stateRows(env, "SELECT * FROM load_touched_keys"), []);
  });
});

Deno.test("read model: the unreadable-record lookup answers undefined once closed (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const model = env.openReadModel();
    await model.close();
    assertEquals(await model.unreadableRecord("", K.toString()), undefined);
  });
});

Deno.test("read model: a listed key the check after a reboot cannot target, or whose content it cannot read, falls back to applying every commit again (swamp-club#3617)", async () => {
  for (
    const fault of ["path-conflict", "chunk-lost", "state-symlink"] as const
  ) {
    // Windows symlinks need privileges the test may not have.
    if (fault === "state-symlink" && Deno.build.os === "windows") continue;
    await withV3Env(async (env) => {
      const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
      await putK(env, 1, v1);
      let boot = "boot-id:1";
      const storage = new StatSpyStorage(env.storage.inner);
      const reader = () =>
        open(env, storage, { bootIdentity: () => Promise.resolve(boot) });
      await using(reader(), (model) => model.catchUp(signal()));
      const versionDir = dirname(fileOf(env, K));
      if (fault === "path-conflict") {
        // A file now claims the directory the listed key's file is in.
        await Deno.remove(versionDir, { recursive: true });
        await Deno.writeTextFile(versionDir, "in the way");
      } else if (fault === "chunk-lost") {
        // The file is gone and so is a chunk it would be rewritten from.
        await Deno.remove(fileOf(env, K));
        await Deno.remove(chunkFile(env, v1.parts![2].sha256));
      } else {
        // The directory is now a symlink into the state directory.
        await Deno.mkdir(join(env.stateDir, "elsewhere"));
        await Deno.remove(versionDir, { recursive: true });
        await Deno.symlink(join(env.stateDir, "elsewhere"), versionDir, {
          type: "dir",
        });
      }
      boot = "boot-id:2";
      await using(reader(), async (model) => {
        assertEquals(await model.catchUp(signal()), { applied: 1, cursor: 1 });
        if (fault === "chunk-lost") {
          assertExists(await model.unreadableRecord("", K.toString()));
        }
      });
      if (fault === "state-symlink") {
        // Nothing was written through the symlink.
        assertEquals(
          await Array.fromAsync(Deno.readDir(join(env.stateDir, "elsewhere"))),
          [],
        );
      }
    });
  }
});

Deno.test("read model guard: a tombstone over a file whose committed chunk is torn stores the chunk from the file before removing it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), (model) => model.catchUp(signal()));
    const torn = v1.parts![4].sha256;
    await tear(env, torn);
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [deleteVersion("k", 1)],
    }));
    await using(open(env, storage), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 1, cursor: 2 });
    });
    await assertRejects(() => Deno.stat(fileOf(env, K)), Deno.errors.NotFound);
    assertEquals(storage.puts, [torn]);
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
  });
});

Deno.test("read model guard: recover's sweep of unowned files stores a torn committed chunk from the file it removes (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    await using(env.openReadModel(), (model) => model.catchUp(signal()));
    const torn = v1.parts![4].sha256;
    await tear(env, torn);
    // K's own file is gone; a dead writer left the same bytes at a key no
    // commit owns.
    await Deno.remove(fileOf(env, K));
    const stray = dataKey("stray", 1);
    await Deno.mkdir(dirname(fileOf(env, stray)), { recursive: true });
    await Deno.writeFile(fileOf(env, stray), V1);
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), async (model) => {
      assertEquals(
        await model.recover("", { ...recoverOptions(), since: 0 }),
        [stray.toString()],
      );
    });
    await assertRejects(
      () => Deno.stat(fileOf(env, stray)),
      Deno.errors.NotFound,
    );
    assert(storage.puts.includes(torn), storage.puts.join(", "));
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
  });
});

/** K and K2 both hold V2, applied; a V2 chunk then torn. */
async function twoKeysAtV2(env: V3Env): Promise<RecordKey> {
  const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
  await env.store.append(commitOf({
    seq: 1,
    partition: PARTITION,
    namespace: "",
    ops: [await blobPut("k", 1, v2), await blobPut("k2", 1, v2)],
  }));
  await using(env.openReadModel(), (model) => model.catchUp(signal()));
  await tear(env, v2.parts![3].sha256);
  return dataKey("k2", 1);
}

Deno.test("read model guard: a file whose bytes are already aside is only removed (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const k2 = await twoKeysAtV2(env);
    // Both keys are overwritten: a file that holds what is about to be
    // written stays in place instead.
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [await blobPut("k", 1, v1), await blobPut("k2", 1, v1)],
    }));
    const storage = new StatSpyStorage(env.storage.inner);
    storage.refusePuts = new Error("AccessDenied");
    const renamed: string[] = [];
    const model = open(env, storage, {
      rename: (from, to) => {
        renamed.push(from);
        return Deno.rename(from, to);
      },
    });
    await using(model, (model) => model.catchUp(signal()));
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
    assertEquals(renamed.length, 1);
    assertEquals(await Deno.readFile(copy), V2);
    for (const key of [K, k2]) {
      assertEquals(await Deno.readFile(fileOf(env, key)), V1);
    }
    assertEquals(
      stateRows(env, "SELECT sha256 FROM at_risk_copies").length,
      1,
    );
  });
});

Deno.test("read model guard: across devices a copy that fails for another reason than the cap fails the section, keeping the file (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v2 } = await writerAtV2(env);
    await tear(env, v2.parts![1].sha256);
    const storage = new StatSpyStorage(env.storage.inner);
    storage.refusePuts = new Error("AccessDenied");
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
    // A directory where the copy would land: its rename into place fails.
    await Deno.mkdir(join(copy, "in-the-way"), { recursive: true });
    const model = open(env, storage, {
      rename: () =>
        Promise.reject(new Error("Cross-device link (os error 18)")),
    });
    await using(model, async (model) => {
      await assertRejects(
        () => model.recover("", recoverOptions()),
        CheckoutCopyAtRiskError,
      );
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V2);
    // No temp copy is left behind.
    assertEquals(
      (await Array.fromAsync(Deno.readDir(dirname(copy)))).map((e) => e.name),
      [await sha256Hex(V2)],
    );
  });
});

Deno.test("read model guard: a move aside makes the copy's directories durable, up to the state directory, before the checkout's (swamp-club#3617)", async () => {
  for (const crossDevice of [false, true]) {
    await withV3Env(async (env) => {
      const { v2 } = await writerAtV2(env);
      await tear(env, v2.parts![2].sha256);
      const storage = new StatSpyStorage(env.storage.inner);
      storage.refusePuts = new Error("AccessDenied");
      const source = fileOf(env, K);
      // Each directory synced, and whether the checkout file was still
      // there at the time.
      const synced: [string, boolean][] = [];
      const exists = async (path: string) => {
        try {
          await Deno.lstat(path);
          return true;
        } catch {
          return false;
        }
      };
      const model = open(env, storage, {
        ...(crossDevice
          ? {
            rename: () =>
              Promise.reject(new Error("Cross-device link (os error 18)")),
          }
          : {}),
        syncDirectory: async (dir) => {
          synced.push([dir, await exists(source)]);
        },
      });
      await using(model, (model) => model.recover("", recoverOptions()));
      const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V2));
      assertEquals(await Deno.readFile(copy), V2);
      const name = crossDevice ? "copy" : "rename";
      const targets = [dirname(copy), dirname(dirname(copy)), env.stateDir];
      const sourceAt = synced.findIndex(([dir]) => dir === dirname(source));
      assert(sourceAt >= 0, `${name}: the checkout's directory synced`);
      assertEquals(synced[sourceAt][1], false, name);
      for (const target of targets) {
        const at = synced.findIndex(([dir]) => dir === target);
        assert(at >= 0 && at < sourceAt, `${name}: ${target} synced first`);
        // Across devices the source stays until its copy is durable.
        if (crossDevice) assertEquals(synced[at][1], true, name);
      }
    });
  }
});

Deno.test("read model: unreadable records that no longer own their key never keep a later one from its retry (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![0].sha256, signal());
    await putK(env, 1, blob);
    const storage = new StatSpyStorage(env.storage.inner);
    await using(open(env, storage), async (model) => {
      await model.catchUp(signal());
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    // A full retry batch of rows whose keys no file shows, least recently
    // tried of all.
    const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE));
    try {
      const insert = db.prepare(
        "INSERT INTO unreadable_records (namespace, record_key, partition, seq, position, blob, chunk, chunk_size, chunk_mtime, reason, last_attempt) VALUES ('', ?, ?, 1, 1, NULL, NULL, NULL, NULL, 'missing', 0)",
      );
      for (let i = 0; i < 32; i++) {
        insert.run(`data/ghost/${i}/1/raw`, PARTITION.toString());
      }
    } finally {
      db.close();
    }
    await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    let tries = 0;
    for (; tries < 3; tries++) {
      const readable = await using(open(env, storage), async (model) => {
        await model.catchUp(signal());
        return await model.unreadableRecord("", K.toString()) === undefined;
      });
      if (readable) break;
    }
    assert(tries < 3, "K was never retried");
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
    assertEquals(stateRows(env, "SELECT * FROM unreadable_records"), []);
  });
});

/** Stores one chunk of `content` again, as it was. */
async function restoreChunk(
  env: V3Env,
  blob: BlobRef,
  index: number,
  content: Uint8Array,
): Promise<void> {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += blob.parts![i].size;
  const part = blob.parts![index];
  await env.storage.put(
    "_default",
    part.sha256,
    content.slice(offset, offset + part.size),
    signal(),
  );
}

/** A small put, so a state exists and the next catch-up is no replay. */
async function smallPut(env: V3Env, seq: number): Promise<void> {
  await env.store.append(commitOf({
    seq,
    partition: PARTITION,
    namespace: "",
    ops: [await savePut("s", seq, `small ${seq}`)],
  }));
}

Deno.test("read model guard: on a storage that cannot read sizes, an ordinary catch-up whose chunk is lost keeps the checkout file holding the content and stores the chunk from it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    await smallPut(env, 1);
    const storage = new SpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, { bootIdentity: () => Promise.resolve("boot-id:1") });
    await using(reader(), (model) => model.catchUp(signal()));
    // A writer in this checkout wrote K and landed its commit; the bucket
    // then lost one of its chunks.
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await Deno.mkdir(dirname(fileOf(env, K)), { recursive: true });
    await Deno.writeFile(fileOf(env, K), V1);
    await putK(env, 2, v1);
    const lost = v1.parts![6].sha256;
    await Deno.remove(chunkFile(env, lost));
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 1, cursor: 2 });
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
    assertEquals(storage.puts, [lost]);
    assertEquals(await chunkSize(env, lost), TEST_CHUNK_BYTES);
  });
});

Deno.test("read model guard: after a reboot a listed file holding its content stays when the storage refuses its torn chunk, and a copy aside stores it later (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    let boot = "boot-id:1";
    let now = new Date("2026-10-19T00:00:00Z");
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, {
        bootIdentity: () => Promise.resolve(boot),
        clock: () => now,
      });
    await using(reader(), (model) => model.catchUp(signal()));
    // The power went before the chunk reached the disk, and the datastore
    // refuses puts (it is full, or this member reads only).
    const torn = v1.parts![2].sha256;
    await tear(env, torn);
    storage.refusePuts = new Error("No space left on device (os error 28)");
    boot = "boot-id:2";
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V1));
    await using(reader(), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 0, cursor: 1 });
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
    assertEquals(await Deno.readFile(copy), V1);
    assertEquals(
      stateRows(env, "SELECT record_key, size FROM at_risk_copies"),
      [{ record_key: K.toString(), size: V1.length }],
    );

    // The datastore takes puts again, and the retry interval has passed.
    storage.refusePuts = undefined;
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(await chunkSize(env, torn), TEST_CHUNK_BYTES);
    await assertRejects(() => Deno.stat(copy), Deno.errors.NotFound);
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model: a record with two missing chunks is retried for the second once the first returns, and heals once both are back (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const first = blob.parts![1].sha256;
    const second = blob.parts![7].sha256;
    await env.storage.delete("_default", first, signal());
    await env.storage.delete("_default", second, signal());
    await putK(env, 1, blob);
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () => open(env, storage);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(
        (await model.unreadableRecord("", K.toString()))?.chunk,
        first,
      );
    });
    await restoreChunk(env, blob, 1, V1);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(
        (await model.unreadableRecord("", K.toString()))?.chunk,
        second,
      );
    });
    await restoreChunk(env, blob, 7, V1);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model: a retry whose chunk cannot be looked at leaves the catch-up to finish, and a later one heals the record (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![1].sha256, signal());
    await putK(env, 1, blob);
    class FailingStatStorage extends StatSpyStorage {
      failStats = false;
      override statChunks(
        namespace: string,
        hashes: readonly string[],
        signal: AbortSignal,
      ): Promise<Map<string, ChunkStat>> {
        if (this.failStats) {
          return Promise.reject(new Error("EIO: input/output error"));
        }
        return super.statChunks(namespace, hashes, signal);
      }
    }
    const storage = new FailingStatStorage(env.storage.inner);
    await using(open(env, storage), (model) => model.catchUp(signal()));
    await restoreChunk(env, blob, 1, V1);
    storage.failStats = true;
    await using(open(env, storage), async (model) => {
      assertEquals(await model.catchUp(signal()), { applied: 0, cursor: 1 });
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    storage.failStats = false;
    await using(open(env, storage), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test({
  name:
    "read model: a retry whose key now leads out of the cache leaves the catch-up to finish and writes nothing there (swamp-club#3617)",
  // Creating a symlink needs privileges on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withV3Env(async (env) => {
      const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
      await env.storage.delete("_default", blob.parts![1].sha256, signal());
      await putK(env, 1, blob);
      const storage = new StatSpyStorage(env.storage.inner);
      await using(open(env, storage), (model) => model.catchUp(signal()));
      // The key's directory is now a symlink out of the cache.
      const outside = join(env.dir, "outside");
      await Deno.mkdir(outside);
      const dir = dirname(fileOf(env, K));
      await Deno.mkdir(dirname(dir), { recursive: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.symlink(outside, dir, { type: "dir" });
      await restoreChunk(env, blob, 1, V1);
      await using(open(env, storage), async (model) => {
        assertEquals(await model.catchUp(signal()), { applied: 0, cursor: 1 });
        assertExists(await model.unreadableRecord("", K.toString()));
      });
      assertEquals([...Deno.readDirSync(outside)], []);
    });
  },
});

Deno.test("read model: on a storage that reads sizes, a record with no chunk to watch is retried an hour after its last try, however often catch-ups look at it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await env.storage.delete("_default", blob.parts![1].sha256, signal());
    await putK(env, 1, blob);
    const start = new Date("2026-10-19T00:00:00Z").getTime();
    let now = new Date(start);
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () => open(env, storage, { clock: () => now });
    await using(reader(), (model) => model.catchUp(signal()));
    // A failure that named no chunk: nothing to watch.
    const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE));
    try {
      db.prepare(
        "UPDATE unreadable_records SET chunk = NULL, chunk_size = NULL, chunk_mtime = NULL, last_attempt = ?",
      ).run(start);
    } finally {
      db.close();
    }
    await restoreChunk(env, blob, 1, V1);
    // Looked at by a catch-up within the hour: not tried.
    now = new Date(start + 40 * 60 * 1000);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertExists(await model.unreadableRecord("", K.toString()));
    });
    // An hour after the last try: tried, and healed.
    now = new Date(start + 61 * 60 * 1000);
    await using(reader(), async (model) => {
      await model.catchUp(signal());
      assertEquals(await model.unreadableRecord("", K.toString()), undefined);
    });
    assertEquals(await Deno.readFile(fileOf(env, K)), V1);
  });
});

Deno.test("read model guard: where the boot cannot be named, a file the guard keeps is synced with its directory (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    await smallPut(env, 1);
    const syncedFiles: string[] = [];
    const syncedDirs: string[] = [];
    const reader = () =>
      open(env, new StatSpyStorage(env.storage.inner), {
        bootIdentity: () => Promise.resolve(undefined),
        syncFile: (path) => {
          syncedFiles.push(path);
          return Promise.resolve();
        },
        writeBatch: () =>
          new DurableWriteBatch({
            syncDirectory: (dir) => {
              syncedDirs.push(dir);
              return Promise.resolve();
            },
          }),
      });
    await using(reader(), (model) => model.catchUp(signal()));
    // A writer wrote K unsynced and landed its commit.
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await Deno.mkdir(dirname(fileOf(env, K)), { recursive: true });
    await Deno.writeFile(fileOf(env, K), V1);
    const old = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(fileOf(env, K), old, old);
    await putK(env, 2, v1);
    syncedDirs.length = 0;
    await using(reader(), (model) => model.catchUp(signal()));
    // Not rewritten, but synced.
    assertEquals(
      (await Deno.stat(fileOf(env, K))).mtime?.getTime(),
      old.getTime(),
    );
    assertEquals(syncedFiles, [fileOf(env, K)]);
    assert(syncedDirs.includes(dirname(fileOf(env, K))), syncedDirs.join());
  });
});

Deno.test("read model guard: only a structured 401 or 403, or a message naming the refusal too, stops at-risk retries for the process (swamp-club#3617)", async () => {
  const cases: [Error, number][] = [
    [new Error("Uploading part 403 timed out"), 2],
    [
      Object.assign(new Error("denied"), {
        $metadata: { httpStatusCode: 403 },
      }),
      1,
    ],
    [new Error("put failed", { cause: { status: 401 } }), 1],
    [new Error("HTTP 403 Forbidden"), 1],
  ];
  for (const [refusal, tries] of cases) {
    await withV3Env(async (env) => {
      const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
      const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
      await env.store.append(commitOf({
        seq: 1,
        partition: PARTITION,
        namespace: "",
        ops: [await blobPut("k", 1, v1), await blobPut("k2", 1, v2)],
      }));
      const storage = new StatSpyStorage(env.storage.inner);
      await using(open(env, storage), (model) => model.catchUp(signal()));
      // Two copies aside, each holding a chunk the datastore lost.
      for (const [blob, content] of [[v1, V1], [v2, V2]] as const) {
        await Deno.remove(chunkFile(env, blob.parts![0].sha256));
        const copy = atRiskCopyPath(env.stateDir, "", blob.sha256);
        await Deno.mkdir(dirname(copy), { recursive: true });
        await Deno.writeFile(copy, content);
      }
      storage.refusePuts = refusal;
      await using(open(env, storage), (model) => model.catchUp(signal()));
      assertEquals(storage.refused, tries, refusal.message);
    });
  }
});

Deno.test("read model guard: a file whose cut fails before it is read is closed (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const { v1 } = await writerAtV2(env);
    // Written again by another process, so the guard reads it.
    await rewriteByHand(env, V2);
    await putK(env, 3, v1);
    const cut: ReadableStream<Uint8Array>[] = [];
    class FailingCut extends ChunkStore {
      override refOf(
        content: Uint8Array | ReadableStream<Uint8Array>,
      ): Promise<never> {
        if (content instanceof ReadableStream) cut.push(content);
        return Promise.reject(new Error("cannot cut"));
      }
    }
    await using(
      env.openReadModel({
        chunkStore: new FailingCut(new StatSpyStorage(env.storage.inner)),
      }),
      async (model) => {
        await assertRejects(() => model.catchUp(signal()), ReadModelApplyError);
      },
    );
    assertEquals(cut.length, 1);
    // Closed: its stream can no longer be read.
    await assertRejects(
      () => cut[0].getReader().read(),
      Deno.errors.BadResource,
    );
  });
});

Deno.test("read model guard: a hard-linked at-risk copy whose checkout file was edited in place is not trusted; the next file of that content is moved aside over it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    const k2 = dataKey("k2", 1);
    await env.store.append(commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [await blobPut("k", 1, v1), await blobPut("k2", 1, v1)],
    }));
    let boot = "boot-id:1";
    const now = new Date("2026-10-19T00:00:00Z");
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, {
        bootIdentity: () => Promise.resolve(boot),
        clock: () => now,
      });
    await using(reader(), (model) => model.catchUp(signal()));
    // After a power cut a chunk is torn and the datastore refuses puts:
    // both files hold their content, so a copy is linked aside.
    await tear(env, v1.parts![2].sha256);
    storage.refusePuts = new Error("No space left on device (os error 28)");
    boot = "boot-id:2";
    await using(reader(), (model) => model.catchUp(signal()));
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V1));
    assertEquals(await Deno.readFile(copy), V1);

    // K is edited in place: the hard-linked copy changes with it, at the
    // same size, still named for V1.
    const edited = V1.slice();
    edited[0] ^= 0xff;
    await Deno.writeFile(fileOf(env, K), edited);
    assertEquals(await Deno.readFile(copy), edited);

    // K2 is overwritten: its V1 is the only good copy left, so it is moved
    // aside over the stale copy rather than removed.
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, V2, signal());
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [await blobPut("k2", 1, v2)],
    }));
    await using(reader(), (model) => model.catchUp(signal()));
    assertEquals(await Deno.readFile(fileOf(env, k2)), V2);
    assertEquals(await Deno.readFile(copy), V1);
    assertEquals(await Deno.readFile(fileOf(env, K)), edited);
  });
});

Deno.test("read model guard: a retry drops an at-risk copy whose bytes no longer match its name, with its row, storing nothing from it (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await putK(env, 1, v1);
    let boot = "boot-id:1";
    let now = new Date("2026-10-19T00:00:00Z");
    const storage = new StatSpyStorage(env.storage.inner);
    const reader = () =>
      open(env, storage, {
        bootIdentity: () => Promise.resolve(boot),
        clock: () => now,
      });
    await using(reader(), (model) => model.catchUp(signal()));
    const torn = v1.parts![2].sha256;
    await tear(env, torn);
    storage.refusePuts = new Error("No space left on device (os error 28)");
    boot = "boot-id:2";
    await using(reader(), (model) => model.catchUp(signal()));
    const copy = atRiskCopyPath(env.stateDir, "", await sha256Hex(V1));
    assertEquals(await Deno.readFile(copy), V1);

    // The checkout file, and with it the hard-linked copy, is edited in
    // place, chunk 2 included.
    const edited = V1.slice();
    edited[2 * TEST_CHUNK_BYTES] ^= 0xff;
    await Deno.writeFile(fileOf(env, K), edited);

    storage.refusePuts = undefined;
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await using(reader(), (model) => model.catchUp(signal()));
    await assertRejects(() => Deno.stat(copy), Deno.errors.NotFound);
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
    assertEquals(storage.puts, []);
    assertEquals(await Deno.readFile(fileOf(env, K)), edited);
  });
});

Deno.test("read model guard: adoption removes a stale temp file a crash mid-copy left aside, and keeps a recent one (swamp-club#3617)", async () => {
  await withV3Env(async (env) => {
    const now = new Date("2026-10-19T00:00:00Z");
    const dir = dirname(atRiskCopyPath(env.stateDir, "", "0".repeat(64)));
    await Deno.mkdir(dir, { recursive: true });
    const stale = join(dir, `.${crypto.randomUUID()}.tmp`);
    const recent = join(dir, `.${crypto.randomUUID()}.tmp`);
    const other = join(dir, "notes.tmp");
    for (const path of [stale, recent, other]) {
      await Deno.writeFile(path, V1);
    }
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000 - 1000);
    await Deno.utime(stale, hourAgo, hourAgo);
    await Deno.utime(other, hourAgo, hourAgo);
    await Deno.utime(recent, now, now);
    await using(
      open(env, env.storage, { clock: () => now }),
      (model) => model.catchUp(signal()),
    );
    await assertRejects(() => Deno.stat(stale), Deno.errors.NotFound);
    assertEquals(await Deno.readFile(recent), V1);
    assertEquals(await Deno.readFile(other), V1);
    assertEquals(stateRows(env, "SELECT * FROM at_risk_copies"), []);
  });
});
