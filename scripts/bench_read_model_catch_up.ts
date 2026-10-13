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
 * How long a fresh checkout's read model takes to catch up (swamp-club#3337):
 * 1,000 data items saved in one commit, as a first clone of a populated
 * datastore sees them, and 500 single-item commits, as a checkout behind
 * other writers sees them. Each run starts from an empty checkout, so every
 * file is written and synced. Run with:
 *
 * ```
 * deno bench -A scripts/bench_read_model_catch_up.ts
 * ```
 */

import { join } from "@std/path";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import {
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";

const ITEMS = 1_000;
const SMALL_COMMITS = 500;

/** A save of item `i`: about 110 bytes inline and its data-version op. */
async function itemOps(i: number): Promise<Op[]> {
  return [
    await savePut(`item-${i}`, 1, `payload ${i} `.repeat(10)),
    versionOp(`item-${i}`, 1),
  ];
}

const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-bench-" });

/** A commit store holding `commits`, built once per case. */
async function storeOf(name: string, commits: Commit[]): Promise<string> {
  const path = join(dir, `${name}.db`);
  const store = SqliteCommitStore.open(path);
  for (const commit of commits) await store.append(commit);
  await store.close();
  return path;
}

const oneCommit = await storeOf("one-commit", [
  modelCommit(
    1,
    (await Promise.all(
      Array.from({ length: ITEMS }, (_, i) => itemOps(i)),
    )).flat(),
    { fence: 1 },
  ),
]);
const smallCommits = await storeOf(
  "small-commits",
  await Promise.all(
    Array.from(
      { length: SMALL_COMMITS },
      async (_, i) => modelCommit(i + 1, await itemOps(i), { fence: 1 }),
    ),
  ),
);

/** Catches a fresh checkout up with the store at `storePath`. */
async function catchUp(b: Deno.BenchContext, storePath: string): Promise<void> {
  const repoDir = join(dir, `repo-${crypto.randomUUID()}`);
  const store = SqliteCommitStore.open(storePath);
  const readModel = SqliteReadModel.open({
    commitStore: store,
    chunkStore: new ChunkStore(
      new FileSystemStorage(join(dir, "datastore")),
    ),
    cacheRoot: (namespace) =>
      namespace === "" ? swampPath(repoDir) : swampPath(repoDir, namespace),
    stateDir: readModelStateDir(repoDir),
  });
  try {
    b.start();
    await readModel.catchUp(AbortSignal.timeout(300_000));
    b.end();
  } finally {
    await readModel.close();
    await store.close();
    await Deno.remove(repoDir, { recursive: true });
  }
}

Deno.bench(
  `catch up a fresh checkout: ${ITEMS} items in one commit`,
  { n: 3, warmup: 0 },
  async (b) => await catchUp(b, oneCommit),
);

Deno.bench(
  `catch up a fresh checkout: ${SMALL_COMMITS} single-item commits`,
  { n: 3, warmup: 0 },
  async (b) => await catchUp(b, smallCommits),
);

globalThis.addEventListener("unload", () => {
  Deno.removeSync(dir, { recursive: true });
});
