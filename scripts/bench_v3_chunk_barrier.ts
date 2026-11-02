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


import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import {
  dataKey,
  modelIntent,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  MemorySink,
  WRITER,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  FileSystemStorage,
  type FileSystemStorageOptions,
} from "../src/infrastructure/persistence/fs_datastore_storage.ts";

/** Each blob's size: over the 8 KiB inline limit, so it is one chunk. */
const BLOB_BYTES = 16 * 1024;
const COUNTS = [1, 10, 200];

const args = parseArgs(Deno.args, { string: ["dir", "runs"] });
const runs = Number(args.runs ?? 9);

function blobs(count: number, salt: string): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => {
    const bytes = new Uint8Array(BLOB_BYTES);
    crypto.getRandomValues(bytes.subarray(0, 64));
    new TextEncoder().encodeInto(`${salt}:${i}`, bytes.subarray(64));
    return bytes;
  });
}

function storageOf(
  dir: string,
  memo: Map<string, object> = new Map(),
): FileSystemStorage {
  return new FileSystemStorage(
    dir,
    {
      syncedAncestors: new Map(),
      durableChunks: memo,
      orderedBefore: join(dir, "commits.db"),
    } as FileSystemStorageOptions,
  );
}

async function commitGroup(
  storage: FileSystemStorage,
  contents: readonly Uint8Array[],
): Promise<number> {
  const uow = createCommitLogUnitOfWork(() => Promise.resolve(), {
    sink: new MemorySink(),
    chunkStore: new ChunkStore(storage),
    namespace: SOLO_NAMESPACE,
    writer: WRITER,
    signal: new AbortController().signal,
  });
  const started = performance.now();
  for (const [i, content] of contents.entries()) {
    await uow.stageOp({
      partition: modelPartition(),
      put: {
        intent: modelIntent({ kind: "data.save", name: `b${i}`, version: 1 }),
        key: dataKey(`b${i}`, 1),
        content,
      },
    });
  }
  await uow.commit();
  return performance.now() - started;
}

type Case = (dir: string, count: number) => Promise<number>;

const CASES: Record<string, Case> = {
  "new": async (dir, count) =>
    await commitGroup(storageOf(dir), blobs(count, crypto.randomUUID())),
  "dedupe, other process": async (dir, count) => {
    const contents = blobs(count, crypto.randomUUID());
    await commitGroup(storageOf(dir), contents);
    return await commitGroup(storageOf(dir), contents);
  },
  "dedupe, this process": async (dir, count) => {
    const contents = blobs(count, crypto.randomUUID());
    const memo = new Map<string, object>();
    await commitGroup(storageOf(dir, memo), contents);
    return await commitGroup(storageOf(dir, memo), contents);
  },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const parent = args.dir;
console.log(
  `v3 chunk barrier: ${runs} runs per case, ${BLOB_BYTES / 1024} KiB blobs, ` +
    `${Deno.build.os}/${Deno.build.arch}`,
);
console.log("case                          N     A ms   A' ms");
for (const [name, run] of Object.entries(CASES)) {
  for (const count of COUNTS) {
    const a: number[] = [];
    const aa: number[] = [];
    for (let i = 0; i < runs; i++) {
      for (const into of [a, aa]) {
        const dir = await Deno.makeTempDir({
          prefix: "swamp-bench-barrier-",
          ...(parent !== undefined ? { dir: parent } : {}),
        });
        try {
          into.push(await run(dir, count));
        } finally {
          await Deno.remove(dir, { recursive: true });
        }
      }
    }
    console.log(
      `${name.padEnd(28)}${String(count).padStart(4)}${
        median(a).toFixed(1).padStart(9)
      }${median(aa).toFixed(1).padStart(8)}`,
    );
  }
}
