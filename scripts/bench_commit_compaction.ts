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



import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import {
  deleteVersion,
  MemoryStorage,
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";

const COMMITS = 11_000;
const NAMES = 50;

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

async function churnCommit(seq: number): Promise<Commit> {
  const name = `name-${seq % NAMES}`;
  const version = Math.floor(seq / NAMES) + 1;
  const ops: Op[] = [
    await savePut(name, version, `${name}@${version} `.repeat(16)),
    versionOp(name, version),
  ];
  if (version > 1) ops.push(deleteVersion(name, version - 1));
  return modelCommit(seq, ops, { fence: 1 });
}

type Shape = (seq: number) => Promise<Commit>;

const dir = await Deno.makeTempDir({ prefix: "swamp-compaction-bench-" });

async function history(
  path: string,
  from: number,
  to: number,
  shape: Shape = benchCommit,
) {
  const store = SqliteCommitStore.open(path);
  for (let seq = from; seq <= to; seq++) {
    await store.append(await shape(seq));
  }
  await store.close();
}

function resetWal(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function walBytes(path: string): number {
  try {
    return Deno.statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

function pages(path: string): { pages: number; free: number; bytes: number } {
  const db = new DatabaseSync(path);
  const count = (pragma: string) =>
    Object.values(db.prepare(`PRAGMA ${pragma}`).get() as object)[0] as number;
  const result = {
    pages: count("page_count"),
    free: count("freelist_count"),
    bytes: Deno.statSync(path).size,
  };
  db.close();
  return result;
}

const sources = {
  growing: join(dir, "growing.db"),
  churning: join(dir, "churning.db"),
};
await history(sources.growing, 1, COMMITS, benchCommit);
await history(sources.churning, 1, COMMITS, churnCommit);

console.log(`## One compaction batch, ${COMMITS} commits of one partition\n`);
console.log("| History | Batch size | Batches | Mean ms per batch | Max ms | WAL bytes, first batch | WAL bytes, appending as many |");
console.log("|---|---|---|---|---|---|---|");
for (
  const [shape, batchSize] of [
    ["growing", 250],
    ["growing", 1000],
    ["churning", 250],
    ["churning", 1000],
    ["churning", 4000],
  ] as const
) {
  const source = sources[shape];
  const path = join(dir, `batch-${shape}-${batchSize}.db`);
  await Deno.copyFile(source, path);
  const appendPath = join(dir, `append-${shape}-${batchSize}.db`);
  await history(appendPath, 1, 1);
  resetWal(appendPath);
  {
    const store = SqliteCommitStore.open(appendPath);
    for (let seq = 2; seq <= batchSize + 1; seq++) {
      await store.append(await benchCommit(seq));
    }
    const bytes = walBytes(appendPath);
    await store.close();
    resetWal(path);
    const compacting = SqliteCommitStore.open(path);
    const first = performance.now();
    await compacting.compactHistory(batchSize, { batchSize });
    const firstMs = performance.now() - first;
    const firstWal = walBytes(path);
    const times = [firstMs];
    for (let through = 2 * batchSize;; through += batchSize) {
      const started = performance.now();
      const report = await compacting.compactHistory(through, { batchSize });
      times.push(performance.now() - started);
      if (report.compacted === 0 || through >= COMMITS) break;
    }
    await compacting.close();
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `| ${shape} | ${batchSize} | ${times.length} | ${mean.toFixed(1)} | ${
        Math.max(...times).toFixed(1)
      } | ${firstWal} | ${bytes} |`,
    );
  }
}

console.log(
  "\n## commits.db over cycles of 2,000 churning appends and a compaction\n",
);
console.log("| Cycle | Commits | Bytes compacted | Pages, free compacted | Bytes uncompacted |");
console.log("|---|---|---|---|---|");
{
  const compacted = join(dir, "cycles.db");
  const kept = join(dir, "cycles-kept.db");
  let seq = 0;
  for (let cycle = 1; cycle <= 8; cycle++) {
    await history(compacted, seq + 1, seq + 2000, churnCommit);
    await history(kept, seq + 1, seq + 2000, churnCommit);
    seq += 2000;
    const store = SqliteCommitStore.open(compacted);
    const status = await store.compactionStatus({
      commits: 500,
      since: "9999-12-31T00:00:00.000Z",
    });
    if (status.through !== undefined) {
      await store.compactHistory(status.through);
    }
    await store.close();
    const c = pages(compacted);
    console.log(
      `| ${cycle} | ${seq} | ${c.bytes} | ${c.pages}, ${c.free} | ${
        pages(kept).bytes
      } |`,
    );
  }
}

console.log(`\n## A fresh checkout of ${COMMITS} churning commits\n`);
{
  const source = sources.churning;
  const compacted = join(dir, "load.db");
  await Deno.copyFile(source, compacted);
  const store = SqliteCommitStore.open(compacted);
  await store.compactHistory(COMMITS);
  await store.close();
  for (const [label, path] of [["replays every commit", source], [
    "loads the compacted base",
    compacted,
  ]] as const) {
    const commitStore = SqliteCommitStore.open(path);
    const repo = join(dir, `checkout-${crypto.randomUUID()}`);
    const readModel = SqliteReadModel.open({
      commitStore,
      chunkStore: new ChunkStore(new MemoryStorage()),
      cacheRoot: () => join(repo, ".swamp"),
      stateDir: join(repo, ".swamp", "_read_model_v3"),
    });
    const started = performance.now();
    await readModel.catchUp(AbortSignal.timeout(600_000));
    console.log(`- ${label}: ${(performance.now() - started).toFixed(0)} ms`);
    await readModel.close();
    await commitStore.close();
  }
}

await Deno.remove(dir, { recursive: true });
