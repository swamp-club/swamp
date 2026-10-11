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
 * How long the commit store takes to rebuild a large partition, the cost a
 * short-lived CLI process pays on its first append to it (swamp-club#3236):
 * from its latest snapshot plus the commits after it, against a replay of
 * every commit, and what writing a snapshot costs. Run with:
 *
 * ```
 * deno bench -A scripts/bench_commit_store.ts
 * ```
 */

import { join } from "@std/path";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import { Partition } from "../src/domain/datastore_v3/partition.ts";
import {
  deleteVersion,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** The worst case for snapshots: 999 commits after the one at 10,000. */
const COMMITS = 10_999;
const NAMES = 50;

/**
 * Commit `seq` of a model partition: each saves a new version of one of 50
 * data names (an inline put of about 200 bytes and its data-version op), and
 * every tenth also deletes that name's previous version.
 */
async function benchCommit(seq: number): Promise<Commit> {
  const name = `name-${seq % NAMES}`;
  const version = Math.floor(seq / NAMES) + 1;
  const ops: Op[] = [
    await savePut(name, version, `${name}@${version} `.repeat(16)),
    versionOp(name, version),
  ];
  if (seq % 10 === 0 && version > 1) ops.push(deleteVersion(name, version - 1));
  return modelCommit(seq, ops, { fence: 1 });
}

const dir = await Deno.makeTempDir({ prefix: "swamp-commit-store-bench-" });
const snapshotted = join(dir, "snapshotted.db");
const replayOnly = join(dir, "replay-only.db");
const first = await benchCommit(1);
const inMemory = Partition.empty(modelPartition());
{
  const stores = [
    SqliteCommitStore.open(snapshotted),
    SqliteCommitStore.open(replayOnly, { snapshotInterval: 1_000_000 }),
  ];
  for (let seq = 1; seq <= COMMITS; seq++) {
    const commit = await benchCommit(seq);
    for (const store of stores) await store.append(commit);
    inMemory.append(commit);
  }
  for (const store of stores) await store.close();
}

/** A retry of commit 1 rebuilds the partition and writes nothing. */
async function rebuild(b: Deno.BenchContext, path: string): Promise<void> {
  const store = SqliteCommitStore.open(path);
  b.start();
  await store.append(first);
  b.end();
  await store.close();
}

Deno.bench(
  `rebuild ${COMMITS} commits from a snapshot`,
  async (b) => await rebuild(b, snapshotted),
);

Deno.bench(
  `rebuild ${COMMITS} commits by replay alone`,
  async (b) => await rebuild(b, replayOnly),
);

Deno.bench(`serialize the snapshot of ${COMMITS} commits`, () => {
  JSON.stringify(inMemory.snapshot());
});

Deno.bench("append to a cached partition", async (b) => {
  const store = SqliteCommitStore.open(
    join(dir, `warm-${crypto.randomUUID()}.db`),
  );
  await store.append(await benchCommit(1));
  const next = await benchCommit(2);
  b.start();
  await store.append(next);
  b.end();
  await store.close();
});

globalThis.addEventListener("unload", () => {
  Deno.removeSync(dir, { recursive: true });
});
