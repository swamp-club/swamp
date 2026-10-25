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
 * History compaction (swamp-club#3258) on a real `commits.db`, the
 * filesystem `storage/1` and read models: compacted commits are gone, their
 * retries still land once, a checkout behind the compaction point loads and
 * reconciles the compacted base, and chunk GC reclaims superseded content
 * while keeping present content.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { ChunkCollector } from "../src/domain/datastore_v3/chunk_collector.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import {
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
} from "../src/domain/datastore_v3/commit_store.ts";
import { type Op, putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  dataKey,
  modelIntent,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import {
  SqliteCommitStore,
} from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  commitOf,
  readCatalog,
  readTree,
  SmallChunkStorage,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";
import type {
  CompactionCrashMessage,
  CompactionCrashRequest,
} from "./datastore_v3_compaction_crash_worker.ts";

const PARTITION = modelPartition();
const signal = () => AbortSignal.timeout(30_000);

/** Content of several chunks, distinct per seed. */
function content(seed: number): Uint8Array {
  return new Uint8Array(3 * TEST_CHUNK_BYTES + seed).map((_, i) =>
    (i * seed + seed) % 251
  );
}

function blobSave(name: string, version: number, blob: BlobRef) {
  return putOp({
    intent: modelIntent({ kind: "data.save", name, version }),
    key: dataKey(name, version),
    blob,
  });
}

function remove(name: string, version: number) {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name, version }),
    key: dataKey(name, version),
  });
}

/** Appends commits to the fixture model, from seq `from` on. */
async function appendAll(
  env: V3Env,
  history: readonly (readonly Op[])[],
  from = 1,
): Promise<void> {
  let seq = from;
  for (const ops of history) {
    await env.store.append(
      commitOf({ seq: seq++, partition: PARTITION, namespace: "", ops }),
    );
  }
}

/** A checkout of its own, with its own cache and state directories. */
function checkout(env: V3Env, name: string): {
  readModel: SqliteReadModel;
  root: string;
  stateDir: string;
} {
  const repoDir = join(env.dir, name);
  const stateDir = readModelStateDir(repoDir);
  const root = swampPath(repoDir);
  return {
    readModel: env.openReadModel({
      cacheRoot: (ns) => ns === "" ? root : join(root, ns),
      stateDir,
    }),
    root,
    stateDir,
  };
}

/** What a checkout holds: files, catalog, index and live versions. */
async function observe(
  view: { readModel: SqliteReadModel; root: string; stateDir: string },
): Promise<unknown> {
  const db = new DatabaseSync(join(view.stateDir, "_read_model_v3.db"), {
    readOnly: true,
  });
  let versions;
  try {
    versions = db.prepare(
      "SELECT namespace, partition, name, version, metadata FROM data_versions ORDER BY 1, 2, 3, 4",
    ).all();
  } finally {
    db.close();
  }
  return {
    files: Object.fromEntries(await readTree(view.root)),
    catalog: readCatalog(join(view.stateDir, "_catalog_v3.db")),
    index: (await view.readModel.liveRecords("", PARTITION)).map((r) => ({
      key: r.key.toString(),
      sha256: r.sha256,
    })),
    chunks: [...await view.readModel.chunksInUse("")].sort(),
    versions,
  };
}

/** Every row of every commits.db table, for comparing whole states. */
function dump(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path);
  // A terminated writer's lock is released asynchronously.
  db.exec("PRAGMA busy_timeout=5000");
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((t) => t.name);
    return Object.fromEntries(
      tables.map((table) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().length;
        const order = Array.from({ length: columns }, (_, i) => i + 1);
        return [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY ${order.join(", ")}`)
            .all(),
        ];
      }),
    );
  } finally {
    db.close();
  }
}

Deno.test("compaction: folds commits away, refuses reads below the point, and appends continue", async () => {
  await withV3Env(async (env) => {
    await appendAll(env, [
      [await savePut("a", 1), versionOp("a", 1)],
      [await savePut("a", 2), versionOp("a", 2)],
      [remove("a", 1)],
    ]);
    const report = await env.store.compactHistory(2, { batchSize: 1 });
    assertEquals(report, { point: 2, compacted: 2, batches: 2, released: 0 });

    await assertRejects(
      () => env.store.changesSince(1, 10),
      CommitsCompactedError,
    );
    await assertRejects(
      () => env.store.readPartition("", PARTITION, 2, 10),
      CommitsCompactedError,
    );
    assertEquals(
      (await env.store.changesSince(2, 10)).map((c) => c.commit.seq),
      [3],
    );
    assertEquals(
      (await env.store.readPartition("", PARTITION, 3, 10)).map((c) =>
        c.commit.seq
      ),
      [3],
    );
    assertEquals(await env.store.head("", PARTITION), {
      seq: 3,
      highestFence: undefined,
    });
    // Compacting past the last commit stops at it.
    assertEquals((await env.store.compactHistory(99)).point, 3);
    assertEquals(
      await env.store.append(
        commitOf({
          seq: 4,
          partition: PARTITION,
          namespace: "",
          ops: [await savePut("a", 3), versionOp("a", 3)],
        }),
      ),
      { kind: "appended", seq: 4 },
    );
  });
});

Deno.test("compaction: a retry of a compacted commit is still a duplicate, cached or rebuilt cold", async () => {
  await withV3Env(async (env) => {
    const commits = [];
    for (let seq = 1; seq <= 5; seq++) {
      commits.push(
        commitOf({
          seq,
          partition: PARTITION,
          namespace: "",
          ops: [await savePut("a", seq), versionOp("a", seq)],
        }),
      );
    }
    for (const commit of commits) await env.store.append(commit);
    await env.store.compactHistory(4);
    // The cached partition answers from compacted_txns.
    assertEquals(await env.store.append(commits[1]), {
      kind: "duplicate",
      seq: 2,
    });

    // A store opened afresh rebuilds from the snapshot compaction wrote.
    const path = join(env.dir, "commits.db");
    const cold = SqliteCommitStore.open(path, { snapshotInterval: 1000 });
    try {
      assertEquals(await cold.append(commits[0]), {
        kind: "duplicate",
        seq: 1,
      });
      assertEquals(await cold.append(commits[4]), {
        kind: "duplicate",
        seq: 5,
      });
      assertEquals(
        await cold.append(
          commitOf({
            seq: 6,
            partition: PARTITION,
            namespace: "",
            ops: [await savePut("a", 6), versionOp("a", 6)],
          }),
        ),
        { kind: "appended", seq: 6 },
      );
    } finally {
      await cold.close();
    }
  });
});

Deno.test("compaction: the status keeps the newest commits and those written recently", async () => {
  await withV3Env(async (env) => {
    const at = (minute: number) =>
      `2026-10-12T00:${String(minute).padStart(2, "0")}:00.000Z`;
    for (let seq = 1; seq <= 6; seq++) {
      await env.store.append(
        commitOf({
          seq,
          partition: PARTITION,
          namespace: "",
          ops: [await savePut("a", seq), versionOp("a", seq)],
        }),
      );
    }
    // commitOf stamps every commit at 2026-10-11T00:00:00.000Z.
    assertEquals(
      await env.store.compactionStatus({ commits: 2, since: at(0) }),
      { point: 0, through: 4, commits: 4 },
    );
    assertEquals(
      await env.store.compactionStatus({
        commits: 0,
        since: "2026-10-11T00:00:00.000Z",
      }),
      { point: 0, through: undefined, commits: 0 },
    );
    await env.store.compactHistory(3);
    assertEquals(
      await env.store.compactionStatus({ commits: 2, since: at(0) }),
      { point: 3, through: 4, commits: 1 },
    );
    assertEquals(
      await env.store.compactionStatus({ commits: 6, since: at(0) }),
      { point: 3, through: undefined, commits: 0 },
    );
  });
});

/** Sets every stored chunk's modification time to the epoch. */
async function ageChunks(env: V3Env): Promise<void> {
  for await (
    const entry of walk(join(env.dir, "datastore", "_blobs"), {
      includeDirs: false,
    })
  ) {
    await Deno.utime(entry.path, new Date(0), new Date(0));
  }
}

async function storedChunks(env: V3Env): Promise<string[]> {
  const hashes: string[] = [];
  for await (const chunk of env.storage.list("_default", signal())) {
    hashes.push(chunk.sha256);
  }
  return hashes.sort();
}

/** Overwrites, a delete and a gc whose content only history names. */
async function supersedingHistory(env: V3Env) {
  const store = (seed: number) =>
    env.chunkStore.write(SOLO_NAMESPACE, content(seed), signal());
  const v1 = await store(1);
  const overwritten = await store(2);
  const deleted = await store(3);
  const kept = await store(4);
  await appendAll(env, [
    [await blobSave("a", 1, v1), versionOp("a", 1)],
    [await blobSave("a", 1, overwritten)],
    [await blobSave("b", 1, deleted), versionOp("b", 1)],
    [remove("b", 1)],
    [await blobSave("c", 1, kept), versionOp("c", 1)],
  ]);
  const hashes = (...refs: BlobRef[]) =>
    [...new Set(refs.flatMap((ref) => ref.chunkHashes()))].sort();
  return {
    superseded: hashes(v1, deleted),
    present: hashes(overwritten, kept),
  };
}

Deno.test("compaction: GC then reclaims superseded chunks and keeps present ones; a fresh checkout loads the base", async () => {
  await withV3Env(async (env) => {
    const { superseded, present } = await supersedingHistory(env);
    const before = checkout(env, "before");
    await before.readModel.catchUp(signal());

    const report = await env.store.compactHistory(5);
    assertEquals(report.released, superseded.length);
    await ageChunks(env);
    const fs = new FileSystemStorage(join(env.dir, "datastore"));
    // Past the release grace: a sweep an hour later reclaims them.
    const collector = new ChunkCollector({
      commitStore: env.store,
      storage: fs,
      graceMs: 0,
      clock: () => new Date(Date.now() + 60 * 60 * 1000),
    });
    const sweep = await collector.collect(SOLO_NAMESPACE, { signal: signal() });
    assertEquals(sweep.deleted, superseded.length);
    assertEquals(await storedChunks(env), present);

    const fresh = checkout(env, "fresh");
    try {
      await fresh.readModel.catchUp(signal());
      assertEquals(await observe(fresh), await observe(before));
    } finally {
      await fresh.readModel.close();
      await before.readModel.close();
    }
  });
});

Deno.test("compaction: a chunk released within the sweep's grace period is kept", async () => {
  await withV3Env(async (env) => {
    const { superseded } = await supersedingHistory(env);
    const all = await storedChunks(env);
    await env.store.compactHistory(5);
    await ageChunks(env);
    const fs = new FileSystemStorage(join(env.dir, "datastore"));
    const collector = new ChunkCollector({
      commitStore: env.store,
      storage: fs,
      graceMs: 60 * 60 * 1000,
    });
    const sweep = await collector.collect(SOLO_NAMESPACE, { signal: signal() });
    assertEquals(sweep.deleted, 0);
    assertEquals(sweep.referenced, all.length);
    assertEquals(await storedChunks(env), all);
    assert(superseded.length > 0);
  });
});

Deno.test("compaction: released chunks are forgotten after the release retention, which a caller sets", async () => {
  await withV3Env(async (env) => {
    const { superseded, present } = await supersedingHistory(env);
    const hashes = [...superseded, ...present];
    // Released an hour ago, then forgotten by a later batch keeping
    // releases for less than that.
    await env.store.compactHistory(5, {
      clock: () => new Date(Date.now() - 60 * 60 * 1000),
    });
    assertEquals(
      [...await env.store.referencedChunks("", hashes)].sort(),
      [...hashes].sort(),
    );
    await appendAll(env, [[await savePut("d", 1), versionOp("d", 1)]], 6);
    await env.store.compactHistory(6, { releasedRetentionMs: 1000 });
    const referenced = await env.store.referencedChunks("", hashes);
    assertEquals([...referenced].sort(), present);
    await assertRejects(
      () => env.store.compactHistory(5, { releasedRetentionMs: -1 }),
      Error,
      "releasedRetentionMs",
    );
  });
});

Deno.test("compaction: a key refused only by its path gets no ownership from a load, as from a replay", async () => {
  await withV3Env(async (env) => {
    // A state directory inside a synced one: keys under it pass the
    // lexical check, and only the resolved path refuses them.
    const view = (name: string) => {
      const root = swampPath(join(env.dir, name));
      const stateDir = join(root, "data", "state");
      return {
        readModel: env.openReadModel({ cacheRoot: () => root, stateDir }),
        root,
        stateDir,
      };
    };
    const ownership = (stateDir: string) => {
      const db = new DatabaseSync(join(stateDir, "_read_model_v3.db"), {
        readOnly: true,
      });
      try {
        return db.prepare(
          "SELECT record_key, owner, mark, present FROM materialised_keys ORDER BY 1",
        ).all();
      } finally {
        db.close();
      }
    };
    const refused = await putOp({
      intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
      key: RecordKey.create("data/state/x"),
      inline: btoa("x"),
    });
    await appendAll(env, [
      [refused],
      [await savePut("a", 1), versionOp("a", 1)],
    ]);
    const reference = view("reference");
    const loaded = view("loaded");
    try {
      await reference.readModel.catchUp(signal());
      await env.store.compactHistory(2);
      await loaded.readModel.catchUp(signal());
      assertEquals(ownership(loaded.stateDir), ownership(reference.stateDir));
      const files = async (root: string) =>
        [...await readTree(root)].filter(([key]) =>
          !key.startsWith("data/state/")
        );
      assertEquals(await files(loaded.root), await files(reference.root));
    } finally {
      await reference.readModel.close();
      await loaded.readModel.close();
    }
  });
});

Deno.test("compaction: a checkout behind the point reconciles, removing records no longer present", async () => {
  await withV3Env(async (env) => {
    const behind = checkout(env, "behind");
    const reference = checkout(env, "reference");
    try {
      await appendAll(env, [
        [await savePut("a", 1), versionOp("a", 1)],
        [await savePut("b", 1), versionOp("b", 1)],
      ]);
      await behind.readModel.catchUp(signal());
      assert((await readTree(behind.root)).has(dataKey("b", 1).toString()));
      await appendAll(env, [
        [remove("b", 1)],
        [await savePut("a", 1, "rewritten")],
        [await savePut("c", 1), versionOp("c", 1)],
      ], 3);
      await reference.readModel.catchUp(signal());

      await env.store.compactHistory(4);
      await behind.readModel.catchUp(signal());
      const seen = await observe(behind);
      assertEquals(seen, await observe(reference));
      assertEquals(
        (await readTree(behind.root)).has(dataKey("b", 1).toString()),
        false,
      );
    } finally {
      await behind.readModel.close();
      await reference.readModel.close();
    }
  });
});

Deno.test("compaction: a checkout whose partition catch-up ran past the compacted seq reloads and replays it", async () => {
  await withV3Env(async (env) => {
    const view = checkout(env, "view");
    const reference = checkout(env, "reference");
    try {
      await appendAll(env, [
        [await savePut("a", 1), versionOp("a", 1)],
        [await savePut("a", 2), versionOp("a", 2)],
        [remove("a", 1)],
        [await savePut("b", 1), versionOp("b", 1)],
      ]);
      // Applied every commit of the partition, but the cursor is still 0.
      await view.readModel.catchUpPartition("", PARTITION, signal());
      await reference.readModel.catchUp(signal());
      await env.store.compactHistory(2);
      await view.readModel.catchUp(signal());
      assertEquals(await observe(view), await observe(reference));
      // And a partition catch-up from below its compacted seq loads too.
      const late = checkout(env, "late");
      try {
        await late.readModel.catchUpPartition("", PARTITION, signal());
        await late.readModel.catchUp(signal());
        assertEquals(await observe(late), await observe(reference));
      } finally {
        await late.readModel.close();
      }
    } finally {
      await view.readModel.close();
      await reference.readModel.close();
    }
  });
});

Deno.test("compaction: a batch that fails before committing leaves commits.db as it was", async () => {
  await withV3Env(async (env) => {
    await appendAll(env, [
      [await savePut("a", 1), versionOp("a", 1)],
      [await savePut("a", 2), versionOp("a", 2)],
    ]);
    const path = join(env.dir, "commits.db");
    const before = dump(path);
    await assertRejects(
      () =>
        env.store.compactHistory(2, {
          beforeCommit: () => {
            throw new Error("injected failure");
          },
        }),
      Error,
      "injected failure",
    );
    assertEquals(dump(path), before);
    // The store carries on: the same compaction then lands whole.
    assertEquals((await env.store.compactHistory(2)).compacted, 2);
  });
});

Deno.test("compaction: a writer stopped inside a batch's transaction leaves commits.db as it was", async () => {
  await withV3Env(async (env) => {
    await appendAll(env, [
      [await savePut("a", 1), versionOp("a", 1)],
      [await savePut("a", 2), versionOp("a", 2)],
      [remove("a", 1)],
    ]);
    const path = join(env.dir, "commits.db");
    const before = dump(path);
    const worker = new Worker(
      new URL("./datastore_v3_compaction_crash_worker.ts", import.meta.url)
        .href,
      { type: "module" },
    );
    let folded = false;
    try {
      worker.onmessage = (event: MessageEvent<CompactionCrashMessage>) => {
        if (event.data === "folded") folded = true;
      };
      worker.postMessage(
        { dbPath: path, through: 3 } satisfies CompactionCrashRequest,
      );
      await waitFor(() => folded, "the worker to fold its batch");
    } finally {
      worker.terminate();
    }
    assertEquals(dump(path), before);
    // A store opened afresh reads the old history. (Writing would wait on
    // the stopped worker's lock: in one process its connection is never
    // closed, unlike a real crash. The rollback test above covers the
    // compaction landing afterwards.)
    const reopened = SqliteCommitStore.open(path);
    try {
      assertEquals(
        (await reopened.changesSince(0, 10)).map((c) => c.commit.seq),
        [1, 2, 3],
      );
      assertEquals(await reopened.readCompactedBase(undefined, 10), {
        point: 0,
        entries: [],
        next: undefined,
      });
    } finally {
      await reopened.close();
    }
  });
});

/** A storage whose chunk reads fail while `failing` is set. */
class FlakyStorage extends SmallChunkStorage {
  failing = false;
  override get(namespace: string, sha256: string, s: AbortSignal) {
    if (this.failing) {
      return Promise.reject(new Error("injected read failure"));
    }
    return super.get(namespace, sha256, s);
  }
}

Deno.test("compaction: a load that fails part-way converges, even against a newer base", async () => {
  await withV3Env(async (env) => {
    const flaky = new FlakyStorage(env.storage.inner);
    const view = checkout(env, "view");
    const failingView = env.openReadModel({
      chunkStore: new ChunkStore(flaky),
      cacheRoot: (ns) => ns === "" ? view.root : join(view.root, ns),
      stateDir: view.stateDir,
    });
    await view.readModel.close();
    const reference = checkout(env, "reference");
    try {
      const big = await env.chunkStore.write(
        SOLO_NAMESPACE,
        content(9),
        signal(),
      );
      await appendAll(env, [
        // Inline content sorts first and is written before the blob fails.
        [await savePut("a", 1), versionOp("a", 1)],
        [await blobSave("b", 1, big), versionOp("b", 1)],
      ]);
      await env.store.compactHistory(2);
      flaky.failing = true;
      await assertRejects(() => failingView.catchUp(signal()));
      // The first attempt wrote a@1; a newer base no longer holds it.
      assert((await readTree(view.root)).has(dataKey("a", 1).toString()));
      await appendAll(env, [[remove("a", 1)]], 3);
      await env.store.compactHistory(3);
      flaky.failing = false;
      await failingView.catchUp(signal());
      await reference.readModel.catchUp(signal());
      assertEquals(
        await observe({ ...view, readModel: failingView }),
        await observe(reference),
      );
      assertEquals(
        (await readTree(view.root)).has(dataKey("a", 1).toString()),
        false,
      );
    } finally {
      await failingView.close();
      await reference.readModel.close();
    }
  });
});

/** A commit store that compacts everything right after the first feed page. */
class CompactingAfterFirstPage implements CommitStore {
  #compacted = false;
  constructor(readonly inner: SqliteCommitStore) {}
  append(...args: Parameters<CommitStore["append"]>) {
    return this.inner.append(...args);
  }
  readPartition(...args: Parameters<CommitStore["readPartition"]>) {
    return this.inner.readPartition(...args);
  }
  head(...args: Parameters<CommitStore["head"]>) {
    return this.inner.head(...args);
  }
  async changesSince(
    cursor: number,
    limit: number,
  ): Promise<readonly CommitChange[]> {
    const page = await this.inner.changesSince(cursor, limit);
    if (!this.#compacted) {
      this.#compacted = true;
      await this.inner.compactHistory(Number.MAX_SAFE_INTEGER);
    }
    return page;
  }
  referencedChunks(...args: Parameters<CommitStore["referencedChunks"]>) {
    return this.inner.referencedChunks(...args);
  }
  partitionsReferencing(
    ...args: Parameters<CommitStore["partitionsReferencing"]>
  ) {
    return this.inner.partitionsReferencing(...args);
  }
  compactionStatus(...args: Parameters<CommitStore["compactionStatus"]>) {
    return this.inner.compactionStatus(...args);
  }
  compactHistory(...args: Parameters<CommitStore["compactHistory"]>) {
    return this.inner.compactHistory(...args);
  }
  readCompactedBase(...args: Parameters<CommitStore["readCompactedBase"]>) {
    return this.inner.readCompactedBase(...args);
  }
  compactionPoint() {
    return this.inner.compactionPoint();
  }
  close() {
    return this.inner.close();
  }
}

Deno.test("compaction: a catch-up whose feed is compacted between pages loads the base and ends caught up", async () => {
  await withV3Env(async (env) => {
    await appendAll(env, [
      [await savePut("a", 1), versionOp("a", 1)],
      [
        await blobSave(
          "b",
          1,
          await env.chunkStore.write(SOLO_NAMESPACE, content(3), signal()),
        ),
        versionOp("b", 1),
      ],
      [remove("a", 1)],
      [await savePut("c", 1), versionOp("c", 1)],
    ]);
    const reference = checkout(env, "reference");
    await reference.readModel.catchUp(signal());
    const repoDir = join(env.dir, "racing");
    const root = swampPath(repoDir);
    const racing = {
      readModel: env.openReadModel({
        commitStore: new CompactingAfterFirstPage(env.store),
        cacheRoot: (ns) => ns === "" ? root : join(root, ns),
        stateDir: readModelStateDir(repoDir),
        pageSize: 2,
      }),
      root,
      stateDir: readModelStateDir(repoDir),
    };
    try {
      await racing.readModel.catchUp(signal());
      assertEquals(await observe(racing), await observe(reference));
    } finally {
      await racing.readModel.close();
      await reference.readModel.close();
    }
  });
});
