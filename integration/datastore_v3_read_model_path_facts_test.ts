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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { type Op, putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  blobPut,
  modelIntent,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type {
  ChunkDirectorySync,
  ChunkStat,
  ChunkStatReader,
} from "../src/domain/datastore/datastore_storage.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import type { SqliteReadModelOptions } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import type { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  commitOf,
  SmallChunkStorage,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();
const signal = () => AbortSignal.timeout(30_000);
const ATTR = "swamp.datastore.v3.";

function put(key: string, text: string): Promise<Op> {
  return putOp({
    intent: modelIntent({ kind: "data.save", name: "n", version: 1 }),
    key: RecordKey.create(key),
    inline: base64(text),
  });
}

function tombstone(key: string): Op {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "n", version: 1 }),
    key: RecordKey.create(key),
  });
}

async function append(env: V3Env, seq: number, ops: Op[]): Promise<void> {
  await env.store.append(
    commitOf({ seq, partition: PARTITION, namespace: "", ops }),
  );
}

function pathOf(env: V3Env, key: string): string {
  return join(swampPath(env.repoDir), ...key.split("/"));
}

async function readOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

interface Probes {
  stats: Map<string, number>;
  notFound: number;
  lstats: Map<string, number>;
}

/** counts Deno.stat and Deno.lstat of paths under root, and those finding nothing, while fn runs */
async function countingProbes(
  root: string,
  fn: () => Promise<unknown>,
): Promise<Probes> {
  const deno = Deno as { stat: typeof Deno.stat; lstat: typeof Deno.lstat };
  const stat = deno.stat;
  const lstat = deno.lstat;
  const probes: Probes = { stats: new Map(), notFound: 0, lstats: new Map() };
  const under = (path: string | URL) => String(path).startsWith(root);
  deno.stat = async (path) => {
    if (!under(path)) return await stat(path);
    probes.stats.set(String(path), (probes.stats.get(String(path)) ?? 0) + 1);
    try {
      return await stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) probes.notFound++;
      throw error;
    }
  };
  deno.lstat = async (path) => {
    if (!under(path)) return await lstat(path);
    probes.lstats.set(String(path), (probes.lstats.get(String(path)) ?? 0) + 1);
    try {
      return await lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) probes.notFound++;
      throw error;
    }
  };
  try {
    await fn();
  } finally {
    deno.stat = stat;
    deno.lstat = lstat;
  }
  return probes;
}

async function catchUp(
  env: V3Env,
  overrides: Partial<SqliteReadModelOptions> = {},
): Promise<Record<string, unknown>> {
  const readModel = env.openReadModel({
    bootIdentity: () => Promise.resolve("boot-1"),
    ...overrides,
  });
  try {
    let attributes: Record<string, unknown> = {};
    await withCapturedSpans(async (spans) => {
      await readModel.catchUp(signal());
      attributes = {
        ...findSpan(spans, "swamp.datastore.v3.readmodel.catchup").attributes,
      };
    });
    return attributes;
  } finally {
    await readModel.close();
  }
}

const DIRECTORIES = 4;
const FILES_EACH = 10;

for (const facts of [true, false]) {
  Deno.test(
    `read model path facts: a base load of new files across new directories ${
      facts
        ? "probes about one missing directory each, and lstats none of the files"
        : "with the facts off probes each file"
    } (swamp-club#5136)`,
    async () => {
      await withV3Env(async (env) => {
        const keys: string[] = [];
        for (let d = 0; d < DIRECTORIES; d++) {
          for (let f = 0; f < FILES_EACH; f++) keys.push(`data/d${d}/f${f}`);
        }
        await append(
          env,
          1,
          await Promise.all(keys.map((key) => put(key, `${key} body`))),
        );
        await env.store.compactHistory(1);
        let attributes: Record<string, unknown> = {};
        const probes = await countingProbes(
          join(swampPath(env.repoDir), "data"),
          async () => {
            attributes = await catchUp(env, { pathFacts: facts });
          },
        );
        for (const key of keys) {
          assertEquals(await readOrAbsent(pathOf(env, key)), `${key} body`);
        }
        assertEquals(attributes[`${ATTR}base_writes`], keys.length);
        // the net plan also looks for the data directory, outside the counter
        const notFound = Number(attributes[`${ATTR}path_notfound`]);
        assert(notFound > 0 && notFound <= probes.notFound, `${notFound}`);
        if (facts) {
          assert(
            probes.notFound <= DIRECTORIES,
            `${probes.notFound} stats found nothing, for ${DIRECTORIES} new directories`,
          );
        } else {
          assert(probes.notFound >= keys.length, `${probes.notFound}`);
        }
        if (facts) {
          for (const key of keys) {
            assertEquals(probes.lstats.get(pathOf(env, key)) ?? 0, 0, key);
          }
        }
        for (const name of ["base_target_ms", "base_sql_ms", "path_lstats"]) {
          assert(`${ATTR}${name}` in attributes, name);
        }
      });
    },
  );
}

/**
 * a put through a link into the state directory is probed and then skipped,
 * so it notes a missing directory and neither creates nor removes anything
 */
async function linkIntoStateDir(env: V3Env): Promise<string> {
  const link = pathOf(env, "data/s");
  await Deno.symlink("../_read_model_v3", link, { type: "dir" });
  return pathOf(env, "data/s/q");
}

Deno.test({
  name:
    "read model path facts: after a removal the next probe lstats again, and a file lands where the removal took a directory (swamp-club#5136)",
  // file symlinks need a privilege on Windows
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withV3Env(async (env) => {
      await append(env, 1, [
        await put("data/r/f", "r/f"),
        await put("data/keep", "keep"),
      ]);
      await catchUp(env);
      const missing = await linkIntoStateDir(env);
      await append(env, 2, [await put("data/s/q/x", "x")]);
      await append(env, 3, [tombstone("data/r/f")]);
      await append(env, 4, [await put("data/s/q/y", "y")]);
      await append(env, 5, [await put("data/r", "r now a file")]);
      const probes = await countingProbes(
        join(swampPath(env.repoDir), "data"),
        () => catchUp(env, { netReplay: false }),
      );
      assertEquals(probes.lstats.get(missing), 2);
      assertEquals(await readOrAbsent(pathOf(env, "data/r")), "r now a file");
    });
  },
});

class StatStorage extends SmallChunkStorage
  implements ChunkStatReader, ChunkDirectorySync {
  refusePuts = false;
  override put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (this.refusePuts) {
      return Promise.reject(new Error("AccessDenied: read-only member"));
    }
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

const V1 = new Uint8Array(10 * TEST_CHUNK_BYTES + 13).map((_, i) => i % 251);

Deno.test({
  name:
    "read model path facts: after a file is moved aside the next probe lstats again (swamp-club#5136)",
  // file symlinks need a privilege on Windows
  ignore: Deno.build.os === "windows",
  fn: () => movedAside(),
});

async function movedAside(): Promise<void> {
  await withV3Env(async (env) => {
    const k = "data/k";
    const v1 = await env.chunkStore.write(SOLO_NAMESPACE, V1, signal());
    await append(env, 1, [await blobPutAt(k, v1)]);
    await catchUp(env);
    // Another process changes the file to content whose chunk is torn, and
    // commits it at another key that is applied last.
    const same = V1.map((b) => b ^ 7);
    const v2 = await env.chunkStore.write(SOLO_NAMESPACE, same, signal());
    await Deno.truncate(chunkFileOf(env, v2.parts![3].sha256), 10);
    await Deno.writeFile(pathOf(env, k), same);
    const storage = new StatStorage(env.storage.inner);
    storage.refusePuts = true;
    const missing = await linkIntoStateDir(env);
    await append(env, 2, [await put("data/s/q/x", "x")]);
    await append(env, 3, [await blobPutAt(k, v1, "again")]);
    await append(env, 4, [await put("data/s/q/y", "y")]);
    await append(env, 5, [await blobPutAt("data/l", v2)]);
    let renamed = 0;
    const probes = await countingProbes(
      join(swampPath(env.repoDir), "data"),
      () =>
        catchUp(env, {
          netReplay: false,
          chunkStore: new ChunkStore(storage),
          rename: async (from, to) => {
            renamed++;
            await Deno.rename(from, to);
          },
        }).catch(() => undefined),
    );
    assertEquals(renamed, 1, "the file was moved aside");
    assertEquals(probes.lstats.get(missing), 2);
  });
}

function chunkFileOf(env: V3Env, sha256: string): string {
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

async function blobPutAt(
  key: string,
  blob: BlobRef,
  name = "n",
): Promise<Op> {
  if (key === "data/k" && name === "n") return await blobPut("k", 1, blob);
  return await putOp({
    intent: modelIntent({ kind: "data.save", name, version: 1 }),
    key: RecordKey.create(key),
    blob,
  });
}

/** holds the write to `held` until released, failing it when told to */
class HeldWriteBatch extends DurableWriteBatch {
  readonly started: string[] = [];
  readonly gate = Promise.withResolvers<void>();
  fail = false;

  constructor(readonly held: string) {
    super({ sync: false });
  }

  override async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options?: Parameters<DurableWriteBatch["write"]>[3],
  ): Promise<void> {
    this.started.push(path);
    if (path === this.held) {
      await this.gate.promise;
      if (this.fail) throw new Error("injected pooled write failure");
    }
    return await super.write(path, content, signal, options);
  }
}

Deno.test("read model path facts: a sibling resolved while its directory's creating write is held waits for it, and a key at that directory is refused as one (swamp-club#5136)", async () => {
  await withV3Env(async (env) => {
    await append(env, 1, [await put("data/a", "a")]);
    const creating = pathOf(env, "data/h/x/f");
    const batch = new HeldWriteBatch(creating);
    let drained = false;
    const readModel = env.openReadModel({
      bootIdentity: () => Promise.resolve("boot-1"),
      netReplay: false,
      writeBatch: () => batch,
      onPoolDrain: () => {
        drained = true;
      },
    });
    try {
      await readModel.catchUp(signal());
      batch.started.length = 0;
      await append(env, 2, [
        await put("data/h/x/f", "f"),
        await put("data/h/x/g", "g"),
        await put("data/h/x", "a file where a directory is being made"),
      ]);
      drained = false;
      const caughtUp = readModel.catchUp(signal());
      await waitFor(
        () => drained,
        "the sibling waiting for the creating write",
      );
      assertEquals(batch.started, [creating]);
      batch.gate.resolve();
      await caughtUp;
      assertEquals(batch.started, [creating, pathOf(env, "data/h/x/g")]);
      assertEquals(await readOrAbsent(creating), "f");
      assertEquals(await readOrAbsent(pathOf(env, "data/h/x/g")), "g");
      assert((await Deno.stat(pathOf(env, "data/h/x"))).isDirectory);
    } finally {
      batch.gate.resolve();
      await readModel.close();
    }
  });
});

Deno.test("read model path facts: a pooled write that fails leaves no fact the next section reads: the load throws, and the next one finds its files missing and lstats none (swamp-club#5136)", async () => {
  await withV3Env(async (env) => {
    const keys = ["data/p/q/r", "data/p/q/s", "data/p/t", "data/u"];
    await append(
      env,
      1,
      await Promise.all(keys.map((key) => put(key, `${key} body`))),
    );
    await env.store.compactHistory(1);
    const batch = new HeldWriteBatch(pathOf(env, keys[0]));
    batch.fail = true;
    batch.gate.resolve();
    const readModel = env.openReadModel({
      bootIdentity: () => Promise.resolve("boot-1"),
      writeBatch: () => batch,
    });
    try {
      await assertRejects(
        () => readModel.catchUp(signal()),
        Error,
        "injected pooled write failure",
      );
      batch.fail = false;
      const probes = await countingProbes(
        join(swampPath(env.repoDir), "data"),
        () => readModel.catchUp(signal()),
      );
      assertEquals(probes.lstats.get(pathOf(env, keys[0])) ?? 0, 0);
    } finally {
      await readModel.close();
    }
    for (const key of keys) {
      assertEquals(await readOrAbsent(pathOf(env, key)), `${key} body`);
    }
  });
});

for (const facts of [true, false]) {
  Deno.test({
    name: `read model path facts: ${
      facts ? "with" : "without"
    } the facts, a key reaching a file this section wrote through a link to its directory is another key's file (swamp-club#5136)`,
    // directory symlinks need a privilege on Windows
    ignore: Deno.build.os === "windows",
    fn: async () => {
      await withV3Env(async (env) => {
        await Deno.mkdir(pathOf(env, "data"), { recursive: true });
        await Deno.symlink("a", pathOf(env, "data/l"), { type: "dir" });
        await append(env, 1, [await put("data/a/x", "x")]);
        await append(env, 2, [await put("data/l/z", "z")]);
        await append(env, 3, [await put("data/l/x", "forged")]);
        const attributes = await catchUp(env, {
          pathFacts: facts,
          spellingFolding: "canonical",
          // one write at a time: a pooled one races a probe through the link
          pooledWrites: 1,
          netReplay: false,
        });
        assertEquals(attributes[`${ATTR}aliased_skipped`], 1);
        assertEquals(await readOrAbsent(pathOf(env, "data/a/x")), "x");
        assertEquals(await readOrAbsent(pathOf(env, "data/a/z")), "z");
      });
    },
  });
}

/**
 * a section knows data/a as a directory and data/a/a as its file; another
 * process then makes data/a a link to l, and the next section puts data/l/a
 * (its write held when pooled) and data/a/a
 */
async function linkWhereADirectoryWas(
  env: V3Env,
  pooled: boolean,
): Promise<{ startedWhileHeld?: string[]; outcome: unknown }> {
  await append(env, 1, [
    await put("data/a/a", "0"),
    await put("data/l/a", "0"),
  ]);
  const held = new HeldWriteBatch(pathOf(env, "data/l/a"));
  let batch = new DurableWriteBatch({ sync: false });
  let drained = false;
  const readModel = env.openReadModel({
    bootIdentity: () => Promise.resolve("boot-1"),
    netReplay: false,
    writeBatch: () => batch,
    ...(pooled ? {} : { pooledWrites: 1 }),
    onPoolDrain: () => {
      drained = true;
    },
  });
  try {
    await readModel.catchUp(signal());
    await Deno.remove(pathOf(env, "data/a"), { recursive: true });
    await Deno.symlink("l", pathOf(env, "data/a"), { type: "dir" });
    await append(env, 2, [
      await put("data/l/a", "p"),
      await put("data/a/a", "q"),
    ]);
    let startedWhileHeld: string[] | undefined;
    if (pooled) {
      batch = held;
      drained = false;
      const caughtUp = readModel.catchUp(signal());
      await waitFor(() => drained, "a put meeting the held write");
      startedWhileHeld = [...held.started];
      held.gate.resolve();
      await caughtUp;
    } else {
      await readModel.catchUp(signal());
    }
    const index = (await readModel.liveRecords("", PARTITION)).map((record) => [
      record.key.toString(),
      record.sha256,
    ]);
    return {
      startedWhileHeld,
      outcome: { index, file: await readOrAbsent(pathOf(env, "data/l/a")) },
    };
  } finally {
    held.gate.resolve();
    await readModel.close();
  }
}

Deno.test({
  name:
    "read model path facts: a link another process puts where the last section knew a directory is lstat'ed and noted, so a put through it waits for every pooled write, as writes one at a time do (swamp-club#5136)",
  // directory symlinks need a privilege on Windows
  ignore: Deno.build.os === "windows",
  fn: async () => {
    let oneAtATime: unknown;
    await withV3Env(async (env) => {
      oneAtATime = (await linkWhereADirectoryWas(env, false)).outcome;
    });
    await withV3Env(async (env) => {
      const pooled = await linkWhereADirectoryWas(env, true);
      assertEquals(pooled.startedWhileHeld, [pathOf(env, "data/l/a")]);
      assertEquals(pooled.outcome, oneAtATime);
    });
  },
});
