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

import { assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { walk } from "@std/fs";
import fc from "fast-check";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Op } from "../../domain/datastore_v3/op.ts";
import {
  deleteVersion,
  MemoryStorage,
  modelCommit,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { findSpan, withCapturedSpans } from "../tracing/span_test_helpers.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import {
  POOLED_WRITES,
  SqliteReadModel,
  TAIL_NET_MIN_COMMITS,
} from "./sqlite_read_model.ts";
import { v3CacheRoot } from "./v3_datastore.ts";

type Change =
  | {
    readonly put: true;
    readonly name: string;
    readonly version: number;
    readonly text: string;
  }
  | { readonly put: false; readonly name: string; readonly version: number };

const change: fc.Arbitrary<Change> = fc.oneof(
  fc.record({
    put: fc.constant(true as const),
    name: fc.constantFrom("a", "b", "c", "A"),
    version: fc.constantFrom(1, 2),
    text: fc.constantFrom("x", "y", "z"),
  }),
  fc.record({
    put: fc.constant(false as const),
    name: fc.constantFrom("a", "b", "c", "A"),
    version: fc.constantFrom(1, 2),
  }),
);
const commits = (min: number, max: number) =>
  fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), {
    minLength: min,
    maxLength: max,
  });

/** the changes as a partition accepts them: a live version is re-put by an append, a deleted one is never reused */
class Versions {
  readonly #live = new Set<string>();
  readonly #deleted = new Set<string>();

  async opsOf(changes: readonly Change[]): Promise<Op[]> {
    const ops: Op[] = [];
    const touched = new Set<string>();
    for (const c of changes) {
      const id = `${c.name}/${c.version}`;
      if (touched.has(id) || this.#deleted.has(id)) continue;
      touched.add(id);
      if (c.put) {
        const kind = this.#live.has(id) ? "data.append" : "data.save";
        ops.push(
          await savePut(
            c.name,
            c.version,
            `${id}:${c.text}`,
            undefined,
            kind,
          ),
        );
        ops.push(versionOp(c.name, c.version));
        this.#live.add(id);
      } else if (this.#live.has(id)) {
        ops.push(deleteVersion(c.name, c.version));
        this.#live.delete(id);
        this.#deleted.add(id);
      }
    }
    return ops;
  }
}

/** every projected record under the checkout's cache, with its content */
async function filesUnder(
  root: string,
  stateDir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      if (!relative(stateDir, entry.path).startsWith("..")) continue;
      files[relative(root, entry.path)] = await Deno.readTextFile(entry.path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files;
}

/** catches a copy up over `head`, then over `tail`, and reports what is on disk */
async function project(
  head: readonly (readonly Change[])[],
  tail: readonly (readonly Change[])[],
  options: { readonly netReplay: boolean; readonly pooledWrites: number },
): Promise<{ files: Record<string, string>; skipped: number; pooled: number }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-tail-net-" });
  const repoDir = join(dir, "repo");
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const readModel = SqliteReadModel.open({
    commitStore: store,
    chunkStore: new ChunkStore(new MemoryStorage()),
    cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
    stateDir: readModelStateDir(repoDir),
    ...options,
  });
  try {
    let seq = 0;
    const versions = new Versions();
    // every commit lands, so a generated tail is as long as generated
    const append = async (changes: readonly Change[]) => {
      const ops = await versions.opsOf(changes);
      if (ops.length === 0) {
        ops.push(
          await savePut(`filler${seq + 1}`, 1),
          versionOp(`filler${seq + 1}`, 1),
        );
      }
      await store.append(modelCommit(++seq, ops));
    };
    for (const changes of head) await append(changes);
    await readModel.catchUp(new AbortController().signal);
    for (const changes of tail) await append(changes);
    let skipped = 0;
    let pooled = 0;
    await withCapturedSpans(async (spans) => {
      await readModel.catchUp(new AbortController().signal);
      const span = findSpan(spans, "swamp.datastore.v3.readmodel.catchup");
      skipped = Number(
        span.attributes["swamp.datastore.v3.writes_skipped"] ?? 0,
      );
      pooled = Number(span.attributes["swamp.datastore.v3.writes_pooled"] ?? 0);
    });
    return {
      files: await filesUnder(
        v3CacheRoot(repoDir, ""),
        readModelStateDir(repoDir),
      ),
      skipped,
      pooled,
    };
  } finally {
    await readModel.close();
    await store.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("SqliteReadModel.catchUp: a netted tail over files already on disk leaves exactly the files a full replay does", async () => {
  let netted = 0;
  let pooled = 0;
  await fc.assert(
    fc.asyncProperty(
      commits(1, 4),
      commits(TAIL_NET_MIN_COMMITS, TAIL_NET_MIN_COMMITS + 8),
      async (head, tail) => {
        const full = await project(head, tail, {
          netReplay: false,
          pooledWrites: 1,
        });
        const net = await project(head, tail, {
          netReplay: true,
          pooledWrites: POOLED_WRITES,
        });
        assertEquals(net.files, full.files);
        assertEquals(full.skipped, 0);
        assertEquals(full.pooled, 0);
        netted += net.skipped;
        pooled += net.pooled;
      },
    ),
    { numRuns: 40 },
  );
  // the property is vacuous unless some runs skipped and pooled writes
  assertEquals(netted > 0, true);
  assertEquals(pooled > 0, true);
});
