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
 * Chunk garbage collection (swamp-club#3249) on a real `commits.db` and the
 * filesystem `storage/1`: it reclaims the chunks no commit names, and a
 * fresh checkout can still replay the whole history afterwards, including
 * content later overwritten, deleted or garbage-collected.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ChunkCollector } from "../src/domain/datastore_v3/chunk_collector.ts";
import { putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import {
  dataKey,
  modelIntent,
  modelPartition,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import {
  commitOf,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();
const signal = () => AbortSignal.timeout(30_000);

/** Content of several chunks, distinct per seed. */
function content(seed: number): Uint8Array {
  return new Uint8Array(3 * TEST_CHUNK_BYTES + seed).map((_, i) =>
    (i * seed + seed) % 251
  );
}

function save(name: string, version: number, blob: BlobRef) {
  return putOp({
    intent: modelIntent({ kind: "data.save", name, version }),
    key: dataKey(name, version),
    blob,
  });
}

function gc(name: string, version: number) {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.gc", name, version }),
    key: dataKey(name, version),
  });
}

function remove(name: string, version: number) {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name, version }),
    key: dataKey(name, version),
  });
}

/** Every chunk stored in a storage namespace. */
async function storedChunks(env: V3Env, namespace: string): Promise<string[]> {
  const hashes: string[] = [];
  for await (const chunk of env.storage.list(namespace, signal())) {
    hashes.push(chunk.sha256);
  }
  return hashes.sort();
}

/**
 * A history of overwrites, a delete and a `data gc` in one namespace, plus
 * chunks a unit stored and then abandoned. Returns the chunks the commits
 * name and the abandoned ones.
 */
async function writeHistory(env: V3Env, namespace: Namespace) {
  const store = (seed: number) =>
    env.chunkStore.write(namespace, content(seed), signal());
  const v1 = await store(1);
  const overwritten = await store(2);
  const deleted = await store(3);
  const collected = await store(4);
  const kept = await store(5);
  const abandoned = [await store(6), await store(7)];
  const commits = [
    [await save("a", 1, v1), versionOp("a", 1)],
    // The same key, overwritten: v1's chunks are only in history now.
    [await save("a", 1, overwritten)],
    [await save("b", 1, deleted), versionOp("b", 1)],
    [remove("b", 1)],
    [await save("c", 1, collected), versionOp("c", 1)],
    [await save("c", 2, kept), versionOp("c", 2)],
    [gc("c", 1)],
  ];
  let seq = 0;
  for (const ops of commits) {
    await env.store.append(
      commitOf({ seq: ++seq, partition: PARTITION, namespace, ops }),
    );
  }
  const named = [v1, overwritten, deleted, collected, kept]
    .flatMap((ref) => ref.chunkHashes());
  return {
    named: [...new Set(named)].sort(),
    abandoned: abandoned.flatMap((ref) => ref.chunkHashes()),
    commits: commits.length,
  };
}

Deno.test("chunk gc: reclaims abandoned chunks, and a fresh checkout still replays the whole history", async () => {
  await withV3Env(async (env) => {
    const solo = await writeHistory(env, SOLO_NAMESPACE);
    const acme = await writeHistory(env, restoreNamespace("acme"));
    const fs = new FileSystemStorage(join(env.dir, "datastore"));
    // A put that died before renaming its temp file into place.
    const temp = join(
      env.dir,
      "datastore",
      "_blobs",
      "_default",
      "sha256",
      solo.named[0].slice(0, 2),
      `.${crypto.randomUUID()}.tmp`,
    );
    await Deno.writeFile(temp, new Uint8Array([1]));
    await Deno.utime(temp, new Date(0), new Date(0));

    // Every chunk is older than the grace period an hour from now.
    const collector = new ChunkCollector({
      commitStore: env.store,
      storage: fs,
      tempFiles: fs,
      graceMs: 0,
      clock: () => new Date(Date.now() + 60 * 60 * 1000),
    });
    const report = await collector.collect(SOLO_NAMESPACE, {
      verifyBytes: Number.MAX_SAFE_INTEGER,
      signal: signal(),
    });

    assertEquals(report.deleted, solo.abandoned.length);
    assertEquals(report.referenced, solo.named.length);
    assertEquals(report.damaged, []);
    assertEquals(report.tempFilesRemoved, 1);
    assertEquals(await storedChunks(env, "_default"), solo.named);
    // Another namespace is untouched until it is swept itself.
    assertEquals(
      await storedChunks(env, "acme"),
      [...acme.named, ...acme.abandoned].sort(),
    );
    await collector.collect(restoreNamespace("acme"), { signal: signal() });
    assertEquals(await storedChunks(env, "acme"), acme.named);

    // A checkout catching up from cursor 0 reads every put's chunks.
    const readModel = env.openReadModel();
    try {
      const result = await readModel.catchUp(signal());
      assertEquals(result.applied, solo.commits + acme.commits);
      const root = swampPath(env.repoDir);
      assertEquals(
        await Deno.readFile(
          join(root, ...dataKey("c", 2).toString().split("/")),
        ),
        content(5),
      );
      assert(
        (await Deno.readFile(
          join(root, ...dataKey("a", 1).toString().split("/")),
        )).length === content(2).length,
      );
    } finally {
      await readModel.close();
    }
  });
});
