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
import { DatabaseSync } from "node:sqlite";
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
import { CATALOG_V3_FILE, readModelStateDir } from "./record_path_guard.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { READ_MODEL_STATE_FILE, SqliteReadModel } from "./sqlite_read_model.ts";
import { v3CacheRoot } from "./v3_datastore.ts";

interface Change {
  readonly put: boolean;
  readonly name: string;
  readonly version: number;
  readonly text: string;
}

const change: fc.Arbitrary<Change> = fc.record({
  put: fc.boolean(),
  name: fc.constantFrom("a", "b", "c"),
  version: fc.constantFrom(1, 2),
  text: fc.constantFrom("x", "y"),
});
const commits = (min: number, max: number) =>
  fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), {
    minLength: min,
    maxLength: max,
  });

/** the changes as a partition accepts them: a deleted version is never reused */
class Versions {
  readonly #live = new Set<string>();
  readonly #deleted = new Set<string>();
  #filler = 0;

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
          await savePut(c.name, c.version, `${id}:${c.text}`, undefined, kind),
          versionOp(c.name, c.version),
        );
        this.#live.add(id);
      } else if (this.#live.has(id)) {
        ops.push(deleteVersion(c.name, c.version));
        this.#live.delete(id);
        this.#deleted.add(id);
      }
    }
    if (ops.length === 0) {
      const name = `filler${++this.#filler}`;
      ops.push(await savePut(name, 1), versionOp(name, 1));
    }
    return ops;
  }
}

// the stat columns name the copy's inodes, not what the read model decided
const STAT_COLUMNS = new Set(["ino", "dev", "mtime", "ctime"]);
// when each catalog started tracking, a clock reading
const TRACKING_START = /_tracking_since$/;

function dumpDatabase(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    const dump: Record<string, string[]> = {};
    for (const table of tables) {
      dump[table] = (db.prepare(`SELECT * FROM "${table}"`).all() as Record<
        string,
        unknown
      >[]).filter((row) => !TRACKING_START.test(String(row.key))).map((row) =>
        JSON.stringify(
          Object.entries(row).filter(([column]) => !STAT_COLUMNS.has(column)),
        )
      ).toSorted();
    }
    return dump;
  } finally {
    db.close();
  }
}

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

interface Outcome {
  readonly state: Record<string, string[]>;
  readonly catalog: Record<string, string[]>;
  readonly files: Record<string, string>;
}

async function outcomeOf(repoDir: string): Promise<Outcome> {
  const stateDir = readModelStateDir(repoDir);
  return {
    state: dumpDatabase(join(stateDir, READ_MODEL_STATE_FILE)),
    catalog: dumpDatabase(join(stateDir, CATALOG_V3_FILE)),
    files: await filesUnder(v3CacheRoot(repoDir, ""), stateDir),
  };
}

/** a crash image: every file as it is now, but no SQLite shared memory */
function copyTreeSync(from: string, to: string): void {
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    if (entry.name.endsWith("-shm")) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) copyTreeSync(source, target);
    else if (entry.isFile) Deno.copyFileSync(source, target);
  }
}

async function withStore(
  fn: (dir: string, store: SqliteCommitStore) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-page-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  try {
    await fn(dir, store);
  } finally {
    await store.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function openReadModel(
  store: SqliteCommitStore,
  repoDir: string,
  pageSize: number,
  onCacheRoot: () => void = () => {},
): SqliteReadModel {
  return SqliteReadModel.open({
    commitStore: store,
    chunkStore: new ChunkStore(new MemoryStorage()),
    cacheRoot: (ns) => {
      onCacheRoot();
      return v3CacheRoot(repoDir, ns);
    },
    stateDir: readModelStateDir(repoDir),
    bootIdentity: () => Promise.resolve("boot-page-test"),
    netReplay: false,
    pooledWrites: 1,
    pageSize,
  });
}

async function appendAll(
  store: SqliteCommitStore,
  versions: Versions,
  from: number,
  changes: readonly (readonly Change[])[],
): Promise<number> {
  let seq = from;
  for (const commit of changes) {
    await store.append(modelCommit(++seq, await versions.opsOf(commit)));
  }
  return seq;
}

Deno.test("SqliteReadModel.catchUp: commits applied one per page and many per page leave the same read model state, catalog and files (swamp-club#5094)", async () => {
  await fc.assert(
    fc.asyncProperty(
      commits(1, 6),
      commits(1, 12),
      async (head, tail) => {
        await withStore(async (dir, store) => {
          const versions = new Versions();
          const seq = await appendAll(store, versions, 0, head);
          const outcomes: Outcome[] = [];
          for (const pageSize of [1, 500]) {
            const repoDir = join(dir, `repo-${pageSize}`);
            const readModel = openReadModel(store, repoDir, pageSize);
            try {
              await readModel.catchUp(new AbortController().signal);
            } finally {
              await readModel.close();
            }
          }
          await appendAll(store, versions, seq, tail);
          for (const pageSize of [1, 500]) {
            const repoDir = join(dir, `repo-${pageSize}`);
            const readModel = openReadModel(store, repoDir, pageSize);
            try {
              await readModel.catchUp(new AbortController().signal);
            } finally {
              await readModel.close();
            }
            outcomes.push(await outcomeOf(repoDir));
          }
          assertEquals(outcomes[1], outcomes[0]);
        });
      },
    ),
    { numRuns: 25 },
  );
});

function progressOf(repoDir: string): { cursor: unknown; applied: unknown } {
  const db = new DatabaseSync(
    join(readModelStateDir(repoDir), READ_MODEL_STATE_FILE),
    { readOnly: true },
  );
  try {
    return {
      cursor: db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get(),
      applied: db.prepare(
        "SELECT namespace, partition, applied_seq FROM partition_progress ORDER BY namespace, partition",
      ).all(),
    };
  } finally {
    db.close();
  }
}

Deno.test("SqliteReadModel.catchUp: a crash part way through a page leaves the cursor and applied seqs where the page started, and applying it again ends as an uncut catch-up (swamp-club#5094)", async () => {
  await fc.assert(
    fc.asyncProperty(
      commits(1, 4),
      commits(2, 10),
      fc.nat(),
      async (head, tail, cut) => {
        await withStore(async (dir, store) => {
          const versions = new Versions();
          const repoDir = join(dir, "repo");
          const crashDir = join(dir, "crash");
          let armed = false;
          let calls = 0;
          let cutAt = 0;
          let copied = false;
          const readModel = openReadModel(store, repoDir, 500, () => {
            if (!armed || copied || ++calls < cutAt) return;
            copyTreeSync(repoDir, crashDir);
            copied = true;
          });
          let before: ReturnType<typeof progressOf>;
          try {
            const seq = await appendAll(store, versions, 0, head);
            await readModel.catchUp(new AbortController().signal);
            before = progressOf(repoDir);
            await appendAll(store, versions, seq, tail);
            cutAt = 1 + cut % tail.length;
            armed = true;
            await readModel.catchUp(new AbortController().signal);
          } finally {
            await readModel.close();
          }
          const uncut = await outcomeOf(repoDir);
          assertEquals(copied, true);
          assertEquals(progressOf(crashDir), before);

          const recovered = openReadModel(store, crashDir, 500);
          try {
            await recovered.catchUp(new AbortController().signal);
          } finally {
            await recovered.close();
          }
          assertEquals(await outcomeOf(crashDir), uncut);
        });
      },
    ),
    { numRuns: 20 },
  );
});
