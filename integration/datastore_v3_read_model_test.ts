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
 * The v3 read model (swamp-club#3239) on real temp directories: idempotence,
 * crash safety, partition catch-up, concurrency, aborts, catalog rebuilds,
 * the key guard and the failure policy. Its agreement with v2 is in
 * `datastore_v3_read_model_v2_oracle_test.ts`.
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import type { CatalogAction } from "../src/domain/datastore_v3/catalog_projection.ts";
import {
  ChunkMissingError,
  ChunkStore,
} from "../src/domain/datastore_v3/chunk_store.ts";
import {
  leaseOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import {
  ReadModelApplyError,
  ReadModelIncompleteError,
} from "../src/domain/datastore_v3/read_model.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  dataKey,
  deleteVersion,
  MODEL_ID,
  MODEL_TYPE,
  modelIntent,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { PathTraversalError } from "../src/infrastructure/persistence/safe_path.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  READ_MODEL_LOCK_FILE,
  READ_MODEL_STATE_FILE,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import {
  type ReadModelCatalog,
  V3Catalog,
} from "../src/infrastructure/datastore_v3/v3_catalog.ts";
import {
  catalogV3Path,
  commitOf,
  observeReadModel,
  readCatalog,
  SmallChunkStorage,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();
const PARTITIONS = [{ namespace: "", partition: PARTITION }];
const signal = () => AbortSignal.timeout(30_000);

function latestPut(name: string, version: number) {
  return putOp({
    intent: modelIntent({ kind: "data.save", name, version }),
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/latest`,
    ),
    inline: base64(String(version)),
  });
}

/** Content stored as several chunks. */
const LARGE = new Uint8Array(5 * TEST_CHUNK_BYTES + 7).map((_, i) => i % 251);

/** A small history: saves (inline and multi-chunk), a delete, a lease. */
async function appendScenario(env: V3Env): Promise<number> {
  const blob = await env.chunkStore.write(SOLO_NAMESPACE, LARGE, signal());
  const commits: Op[][] = [
    [await savePut("a", 1), versionOp("a", 1), await latestPut("a", 1)],
    [
      await putOp({
        intent: modelIntent({ kind: "data.save", name: "a", version: 2 }),
        key: dataKey("a", 2),
        blob,
      }),
      versionOp("a", 2),
      await latestPut("a", 2),
    ],
    [await savePut("b", 1), versionOp("b", 1), await latestPut("b", 1)],
    [deleteVersion("a", 1), await latestPut("a", 2)],
    [leaseOp({ holder: "cli", fence: 1 })],
  ];
  let seq = 0;
  for (const ops of commits) {
    await env.store.append(
      commitOf({ seq: ++seq, partition: PARTITION, namespace: "", ops }),
    );
  }
  return commits.length;
}

/** What a clean read model produces for the scenario. */
async function cleanResult(): Promise<unknown> {
  let result: unknown;
  await withV3Env(async (env) => {
    await appendScenario(env);
    const readModel = env.openReadModel();
    try {
      await readModel.catchUp(signal());
      result = await observeReadModel(env, readModel, PARTITIONS);
    } finally {
      await readModel.close();
    }
  });
  return result;
}

async function observe(env: V3Env): Promise<unknown> {
  const readModel = env.openReadModel();
  try {
    return await observeReadModel(env, readModel, PARTITIONS);
  } finally {
    await readModel.close();
  }
}

/** A catalog that throws once, before or after applying a commit's actions. */
class FailingCatalog implements ReadModelCatalog {
  #armed = true;
  constructor(
    readonly inner: V3Catalog,
    readonly when: "before" | "after",
  ) {}
  generation(): number {
    return this.inner.generation();
  }
  isPopulated(): boolean {
    return this.inner.isPopulated();
  }
  markPopulated(generation: number): void {
    this.inner.markPopulated(generation);
  }
  clear(admits: (key: string) => boolean): number {
    return this.inner.clear(admits);
  }
  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void {
    if (this.#armed && this.when === "before") {
      this.#armed = false;
      throw new Error("injected crash after the files");
    }
    this.inner.apply(namespace, partition, actions);
    if (this.#armed && actions.length > 0) {
      this.#armed = false;
      throw new Error("injected crash after the catalog");
    }
  }
  close(): void {
    this.inner.close();
  }
}

Deno.test("read model: applies a history of saves, a delete and a lease", async () => {
  await withV3Env(async (env) => {
    const total = await appendScenario(env);
    const readModel = env.openReadModel();
    try {
      const result = await readModel.catchUp(signal());
      assertEquals(result.applied, total);
      assertEquals(result.cursor, total);
      const root = swampPath(env.repoDir);
      assertEquals(
        await Deno.readFile(
          join(root, ...dataKey("a", 2).toString().split("/")),
        ),
        LARGE,
      );
      // a@1 was deleted, and its version directory pruned.
      await assertRejects(
        () =>
          Deno.stat(
            join(root, "data", MODEL_TYPE.normalized, MODEL_ID, "a", "1"),
          ),
        Deno.errors.NotFound,
      );
      const { rows } = readCatalog(catalogV3Path(env));
      assertEquals(
        rows.map((r) => [r.data_name, r.version, r.is_latest]),
        [["a", 2, 1], ["b", 1, 1]],
      );
      // The index lists a@2's chunks, parts expanded.
      const chunks = await readModel.chunksInUse("");
      assertEquals(chunks.size, Math.ceil(LARGE.length / TEST_CHUNK_BYTES));
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: applying every commit twice gives the same result", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const first = env.openReadModel();
    await first.catchUp(signal());
    await first.close();
    // Without its state the read model starts over at cursor 0, over the
    // files and catalog it already wrote.
    await Deno.remove(join(env.stateDir, READ_MODEL_STATE_FILE));
    const again = env.openReadModel();
    try {
      assertEquals((await again.catchUp(signal())).applied, 5);
    } finally {
      await again.close();
    }
    assertEquals(await observe(env), clean);
  });
});

for (const when of ["before", "after"] as const) {
  const point = when === "before" ? "the files" : "the catalog";
  Deno.test(`read model: a crash after ${point} is repaired by catching up again`, async () => {
    const clean = await cleanResult();
    await withV3Env(async (env) => {
      await appendScenario(env);
      const crashing = env.openReadModel({
        catalog: new FailingCatalog(V3Catalog.open(catalogV3Path(env)), when),
      });
      try {
        const error = await assertRejects(
          () => crashing.catchUp(signal()),
          ReadModelApplyError,
        );
        assertEquals(error.seq, 1);
        assertEquals((await crashing.catchUp(signal())).cursor, 5);
      } finally {
        await crashing.close();
      }
      assertEquals(await observe(env), clean);
    });
  });
}

/** A catalog that throws once, on applying the commit with seq `seq`. */
class FailAtSeqCatalog implements ReadModelCatalog {
  #applied = 0;
  constructor(readonly inner: V3Catalog, readonly seq: number) {}
  generation(): number {
    return this.inner.generation();
  }
  isPopulated(): boolean {
    return this.inner.isPopulated();
  }
  markPopulated(generation: number): void {
    this.inner.markPopulated(generation);
  }
  clear(admits: (key: string) => boolean): number {
    return this.inner.clear(admits);
  }
  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void {
    if (++this.#applied === this.seq) {
      throw new Error(`injected failure at commit ${this.seq}`);
    }
    this.inner.apply(namespace, partition, actions);
  }
  close(): void {
    this.inner.close();
  }
}

/**
 * The cursor another connection sees: what the state has committed, which
 * is what survives a crash. 0 before any.
 */
function committedCursor(env: V3Env): number {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'cursor'")
      .get() as { value: number } | undefined;
    return row?.value ?? 0;
  } finally {
    db.close();
  }
}

/**
 * A batch that records the paths it writes, and fails its barrier once
 * while `control.armed`: `before` syncs nothing, `during` syncs the files
 * and fails on the first directory.
 */
class CrashingBatch extends DurableWriteBatch {
  constructor(
    readonly control: { armed: "before" | "during" | false; written: string[] },
  ) {
    const failing = control.armed === "during";
    let thrown = false;
    super({
      syncDirectory: () => {
        if (failing && !thrown) {
          thrown = true;
          return Promise.reject(new Error("injected crash during the barrier"));
        }
        return Promise.resolve();
      },
    });
    if (failing) control.armed = false;
  }
  override async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options?: { readonly absentDirectories?: readonly string[] },
  ): Promise<void> {
    await super.write(path, content, signal, options);
    this.control.written.push(path);
  }
  override async barrier(): Promise<void> {
    if (this.control.armed === "before") {
      this.control.armed = false;
      throw new Error("injected crash before the barrier");
    }
    await super.barrier();
  }
}

for (const when of ["before", "during"] as const) {
  Deno.test(`read model: a crash ${when} a page's barrier leaves the cursor and is repaired by catching up again (swamp-club#3337)`, async () => {
    const clean = await cleanResult();
    await withV3Env(async (env) => {
      await appendScenario(env);
      const control = {
        armed: when as typeof when | false,
        written: [] as string[],
      };
      const crashing = env.openReadModel({
        writeBatch: () => new CrashingBatch(control),
      });
      try {
        await assertRejects(
          () => crashing.catchUp(signal()),
          Error,
          `injected crash ${when}`,
        );
        assertEquals(committedCursor(env), 0);
        assertEquals((await crashing.catchUp(signal())).cursor, 5);
      } finally {
        await crashing.close();
      }
      assertEquals(committedCursor(env), 5);
      assertEquals(await observe(env), clean);
    });
  });
}

Deno.test("read model: files a crashed page wrote but never synced are lost and repaired on the next open (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const control = {
      armed: "before" as "before" | false,
      written: [] as string[],
    };
    const crashing = env.openReadModel({
      writeBatch: () => new CrashingBatch(control),
    });
    try {
      await assertRejects(() => crashing.catchUp(signal()));
    } finally {
      await crashing.close();
    }
    // A power loss drops what was never synced: one file comes back empty,
    // another not at all.
    const present = control.written.filter((path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    });
    assert(present.length >= 2, "the page wrote too few files");
    await Deno.truncate(present[0], 0);
    await Deno.remove(present[1]);
    const reopened = env.openReadModel();
    try {
      assertEquals((await reopened.catchUp(signal())).cursor, 5);
    } finally {
      await reopened.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: a page's state commits only after its barrier (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const atBarrier: number[] = [];
    class SpyBatch extends DurableWriteBatch {
      override async barrier(): Promise<void> {
        atBarrier.push(committedCursor(env));
        await super.barrier();
      }
    }
    const readModel = env.openReadModel({
      pageSize: 2,
      writeBatch: () => new SpyBatch(),
    });
    try {
      assertEquals((await readModel.catchUp(signal())).cursor, 5);
    } finally {
      await readModel.close();
    }
    // Pages [1, 2], [3, 4] and [5]: each barrier sees only the pages before.
    assertEquals(atBarrier, [0, 2, 4]);
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: a failed commit keeps the commits before it in its page, even when the barrier fails too (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  for (const barrierFails of [false, true]) {
    await withV3Env(async (env) => {
      await appendScenario(env);
      const control = {
        armed: (barrierFails ? "before" : false) as "before" | false,
        written: [] as string[],
      };
      const failing = env.openReadModel({
        catalog: new FailAtSeqCatalog(V3Catalog.open(catalogV3Path(env)), 3),
        writeBatch: () => new CrashingBatch(control),
      });
      try {
        const error = await assertRejects(
          () => failing.catchUp(signal()),
          ReadModelApplyError,
        );
        assertEquals(error.seq, 3);
        // Without a barrier nothing of the page is durable, so none of it
        // is recorded; with one, commits 1 and 2 are.
        assertEquals(committedCursor(env), barrierFails ? 0 : 2);
        assertEquals((await failing.catchUp(signal())).cursor, 5);
      } finally {
        await failing.close();
      }
      assertEquals(await observe(env), clean);
    });
  }
});

/** How many files the state lists as written without a sync. */
function unsyncedCount(env: V3Env): number {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    return (db.prepare("SELECT count(*) AS n FROM unsynced_keys").get() as {
      n: number;
    }).n;
  } finally {
    db.close();
  }
}

Deno.test("read model: files a reboot lost after their page committed are repaired on the next open (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    let boot = "boot-id:1";
    const open = () => env.openReadModel({ bootIdentity: () => boot });
    const first = open();
    try {
      assertEquals((await first.catchUp(signal())).cursor, 5);
    } finally {
      await first.close();
    }
    assert(unsyncedCount(env) > 0, "the catch-up listed no unsynced files");
    // A power loss: one file comes back empty, one not at all, and the
    // removal of a@1 never reached the disk.
    const root = swampPath(env.repoDir);
    const fileOf = (key: RecordKey) => join(root, ...key.toString().split("/"));
    await Deno.truncate(fileOf(dataKey("b", 1)), 0);
    await Deno.remove(fileOf(dataKey("a", 2)));
    await Deno.mkdir(dirname(fileOf(dataKey("a", 1))), { recursive: true });
    await Deno.writeTextFile(fileOf(dataKey("a", 1)), "a@1");
    boot = "boot-id:2";
    const reopened = open();
    try {
      assertEquals(await reopened.catchUp(signal()), { applied: 5, cursor: 5 });
    } finally {
      await reopened.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: a commit whose unsynced keys cannot be recorded is not recorded as applied (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const readModel = env.openReadModel();
    // Recording unsynced keys fails, as on a full disk.
    const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE));
    db.exec(
      "CREATE TRIGGER refuse_unsynced BEFORE INSERT ON unsynced_keys BEGIN SELECT RAISE(ABORT, 'injected: disk full'); END",
    );
    try {
      const error = await assertRejects(
        () => readModel.catchUp(signal()),
        ReadModelApplyError,
      );
      assertEquals(error.seq, 1);
      // Commit 1 is not applied: its keys would be missing from the
      // reboot check.
      assertEquals(committedCursor(env), 0);
      db.exec("DROP TRIGGER refuse_unsynced");
      assertEquals((await readModel.catchUp(signal())).cursor, 5);
    } finally {
      db.close();
      await readModel.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: a reboot that kept every file clears the unsynced list without applying anything again (swamp-club#3337)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    let boot = "boot-id:1";
    const open = () => env.openReadModel({ bootIdentity: () => boot });
    const first = open();
    try {
      await first.catchUp(signal());
    } finally {
      await first.close();
    }
    boot = "boot-id:2";
    const reopened = open();
    try {
      assertEquals(await reopened.catchUp(signal()), { applied: 0, cursor: 5 });
    } finally {
      await reopened.close();
    }
    assertEquals(unsyncedCount(env), 0);
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: within one boot the unsynced files are trusted and not checked (swamp-club#3337)", async () => {
  await withV3Env(async (env) => {
    await appendScenario(env);
    const open = () => env.openReadModel({ bootIdentity: () => "boot-id:1" });
    const first = open();
    try {
      await first.catchUp(signal());
    } finally {
      await first.close();
    }
    const listed = unsyncedCount(env);
    const reopened = open();
    try {
      assertEquals(await reopened.catchUp(signal()), { applied: 0, cursor: 5 });
    } finally {
      await reopened.close();
    }
    assertEquals(unsyncedCount(env), listed);
  });
});

Deno.test("read model: a partition catch-up is not applied again by catchUp", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    const total = await appendScenario(env);
    const readModel = env.openReadModel();
    try {
      const partition = await readModel.catchUpPartition(
        "",
        PARTITION,
        signal(),
      );
      assertEquals(partition, { applied: total, cursor: 0 });
      assertEquals(await readModel.catchUp(signal()), {
        applied: 0,
        cursor: total,
      });
    } finally {
      await readModel.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: its index is not read after a reset until a catch-up drains the feed", async () => {
  await withV3Env(async (env) => {
    await appendScenario(env);
    // Another partition, whose chunk a partial index would leave out.
    const otherId = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
    const other = partitionOf({ kind: "model", type: MODEL_TYPE, id: otherId });
    const blob = await env.chunkStore.write(
      SOLO_NAMESPACE,
      new Uint8Array(3 * TEST_CHUNK_BYTES).fill(7),
      signal(),
    );
    await env.store.append(commitOf({
      seq: 1,
      partition: other,
      namespace: "",
      ops: [
        await putOp({
          intent: createIntent({
            kind: "output.save",
            model: modelRef(MODEL_TYPE, otherId),
            outputId: "8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e",
          }),
          key: RecordKey.create("outputs/o/1.yaml"),
          blob,
        }),
      ],
    }));

    const fresh = env.openReadModel();
    try {
      // Nothing applied yet.
      await assertRejects(
        () => fresh.chunksInUse(""),
        ReadModelIncompleteError,
      );
      await fresh.catchUp(signal());
      const all = await fresh.chunksInUse("");
      // A deleted catalog resets the state; a partition catch-up then fills
      // only the fixture partition.
      await fresh.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        await Deno.remove(`${catalogV3Path(env)}${suffix}`).catch(() => {});
      }
      const reset = env.openReadModel();
      try {
        await reset.catchUpPartition("", PARTITION, signal());
        await assertRejects(
          () => reset.chunksInUse(""),
          ReadModelIncompleteError,
        );
        await assertRejects(
          () => reset.liveRecords("", PARTITION),
          ReadModelIncompleteError,
        );
        await reset.catchUp(signal());
        assertEquals(await reset.chunksInUse(""), all);
      } finally {
        await reset.close();
      }
    } finally {
      await fresh.close();
    }
  });
});

Deno.test("read model: two read models catching up at once agree", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const a = env.openReadModel();
    const b = env.openReadModel();
    try {
      const results = await Promise.all([
        a.catchUp(signal()),
        b.catchUp(signal()),
      ]);
      assertEquals(results.map((r) => r.cursor), [5, 5]);
      // The lock serializes them: one applies everything, the other nothing.
      assertEquals(results.map((r) => r.applied).sort(), [0, 5]);
    } finally {
      await a.close();
      await b.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: an abort during a chunk read leaves no partial file and resumes", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const controller = new AbortController();
    const storage = new SmallChunkStorage(env.storage.inner);
    const get = storage.get.bind(storage);
    storage.get = (namespace, sha256, s) => {
      controller.abort(new Error("stopped"));
      return get(namespace, sha256, s);
    };
    const aborting = env.openReadModel({ chunkStore: new ChunkStore(storage) });
    try {
      await assertRejects(
        () => aborting.catchUp(controller.signal),
        Error,
        "stopped",
      );
    } finally {
      await aborting.close();
    }
    const resumed = env.openReadModel();
    try {
      // Commit 1 landed before the abort; commit 2 holds the blob.
      assertEquals(await resumed.catchUp(signal()), { applied: 4, cursor: 5 });
    } finally {
      await resumed.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: a rebuilt catalog makes it replay every commit", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const first = env.openReadModel();
    await first.catchUp(signal());
    await first.close();
    const catalog = new CatalogStore(catalogV3Path(env));
    catalog.invalidate();
    catalog.close();
    const second = env.openReadModel();
    try {
      assertEquals(await second.catchUp(signal()), { applied: 5, cursor: 5 });
    } finally {
      await second.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: recover replays a compacted history and removes only the unowned files written since the mark (swamp-club#3299)", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    await env.store.compactHistory(3);
    const readModel = env.openReadModel();
    try {
      await readModel.catchUp(signal());
      const root = env.cacheRoot("");
      const write = async (key: string, text: string) => {
        const path = join(root, ...key.split("/"));
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(path, text);
        return path;
      };
      // Older than the mark: left alone, as a file no recovery owns.
      const older = await write("data/stray/older/1/raw", "older");
      await Deno.utime(older, new Date(0), new Date(0));
      const since = Date.now() - 1_000;
      const committed = Object.keys(
        (await observeReadModel(env, readModel, PARTITIONS) as {
          files: Record<string, Record<string, string>>;
        }).files[""],
      ).find((key) => key.startsWith("data/"))!;
      await write(committed, "overwritten");
      await write("data/stray/uncommitted/1/raw", "uncommitted");
      await write("outputs/stray/run/run.log", "log");
      await write("data/stray/.lock", "lock");
      await write("audit/commands.jsonl", "audit");
      // Pulled extension sources under managed config are never committed.
      await write("config/pulled-extensions/@x/y/mod.ts", "source");
      await write(
        "config/pulled-extensions/.swamp-staging/abc/journal.json",
        "{}",
      );

      const removed = await readModel.recover("", {
        since,
        admits: () => true,
        signal: signal(),
      });
      assertEquals(removed, ["data/stray/uncommitted/1/raw"]);
      for (
        const key of [
          "outputs/stray/run/run.log",
          "data/stray/.lock",
          "config/pulled-extensions/@x/y/mod.ts",
          "config/pulled-extensions/.swamp-staging/abc/journal.json",
        ]
      ) {
        // Each kept file is still there.
        await Deno.remove(join(root, ...key.split("/")));
      }
      await Deno.remove(join(root, "config"), { recursive: true });
      await Deno.remove(join(root, "audit"), { recursive: true });
      await Deno.remove(older);
      await Deno.remove(join(root, "data", "stray"), { recursive: true });
    } finally {
      await readModel.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: recover rebuilds the catalog rows of committed data and keeps the rows of data the datastore keeps local (swamp-club#3299)", async () => {
  await withV3Env(async (env) => {
    await appendScenario(env);
    const readModel = env.openReadModel();
    try {
      await readModel.catchUp(signal());
      const insert = (type: string, name: string) => {
        const db = new DatabaseSync(catalogV3Path(env));
        try {
          db.prepare(
            `INSERT INTO catalog (namespace, type_normalized, model_id,
               data_name, id, version, model_name, created_at)
             VALUES ('', ?, 'm', ?, ?, 1, 'm', ?)`,
          ).run(type, name, crypto.randomUUID(), new Date().toISOString());
          db.prepare(
            `INSERT INTO catalog_renames (namespace, type_normalized,
               model_id, data_name, renamed_to) VALUES ('', ?, 'm', ?, 'x')`,
          ).run(type, name);
        } finally {
          db.close();
        }
      };
      // A row an uncommitted write left, and one for data `directories`
      // or `exclude` keep local, which no commit ever carries.
      insert("residue/type", "uncommitted");
      insert("local/type", "kept");
      const before = readCatalog(catalogV3Path(env)).rows;

      await readModel.recover("", {
        since: Date.now(),
        admits: (key) => !key.startsWith("data/local/"),
        signal: signal(),
      });
      const db = new DatabaseSync(catalogV3Path(env), { readOnly: true });
      try {
        const names = (table: string) =>
          (db.prepare(`SELECT data_name FROM ${table} ORDER BY data_name`)
            .all() as { data_name: string }[]).map((r) => r.data_name);
        assertEquals(names("catalog_renames"), ["kept"]);
        const rows = names("catalog");
        assert(rows.includes("kept"), "the local data's row is kept");
        assert(!rows.includes("uncommitted"), "the residue's row is gone");
        assertEquals(rows.length, before.length - 1);
      } finally {
        db.close();
      }
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: a deleted catalog is refilled by replaying every commit", async () => {
  const clean = await cleanResult();
  await withV3Env(async (env) => {
    await appendScenario(env);
    const first = env.openReadModel();
    await first.catchUp(signal());
    await first.close();
    // A fresh catalog starts at the same generation the state recorded, so
    // the generation alone cannot tell it apart from the one deleted.
    for (const suffix of ["", "-wal", "-shm"]) {
      await Deno.remove(`${catalogV3Path(env)}${suffix}`).catch(() => {});
    }
    const second = env.openReadModel();
    try {
      assertEquals(await second.catchUp(signal()), { applied: 5, cursor: 5 });
    } finally {
      await second.close();
    }
    assertEquals(await observe(env), clean);
  });
});

Deno.test("read model: refuses keys outside the synced directories but indexes them", async () => {
  await withV3Env(async (env) => {
    const root = swampPath(env.repoDir);
    await Deno.mkdir(join(root, "data"), { recursive: true });
    await Deno.writeTextFile(join(root, "data", "_catalog.db"), "sentinel");
    const refused = [
      "data/_catalog.db",
      "data/_catalog.db-wal",
      "secrets/vault/keyfile",
      "_read_model_v3/_read_model_v3.db",
      "_read_model_v3/_catalog_v3.db",
      "_read_model_v3/read_model.lock",
    ];
    const intent = modelIntent({ kind: "data.save", name: "x", version: 1 });
    const puts: Op[] = [];
    for (const key of refused) {
      puts.push(
        await putOp({
          intent,
          key: RecordKey.create(key),
          inline: base64("evil"),
        }),
      );
    }
    const tombstones = refused.map((key) =>
      tombstoneOp({ intent, key: RecordKey.create(key) })
    );
    await env.store.append(
      commitOf({ seq: 1, partition: PARTITION, namespace: "", ops: puts }),
    );

    const readModel = env.openReadModel();
    try {
      assertEquals(await readModel.catchUp(signal()), {
        applied: 1,
        cursor: 1,
      });
      assertEquals(
        (await readModel.liveRecords("", PARTITION)).map((r) =>
          r.key.toString()
        ),
        [...refused].sort(),
      );
      assertEquals(
        await Deno.readTextFile(join(root, "data", "_catalog.db")),
        "sentinel",
      );
      await assertRejects(
        () => Deno.stat(join(root, "data", "_catalog.db-wal")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(root, "secrets")),
        Deno.errors.NotFound,
      );
      assertNotEquals(
        await Deno.readTextFile(join(env.stateDir, READ_MODEL_LOCK_FILE)),
        "evil",
      );

      await env.store.append(
        commitOf({
          seq: 2,
          partition: PARTITION,
          namespace: "",
          ops: tombstones,
        }),
      );
      assertEquals(await readModel.catchUp(signal()), {
        applied: 1,
        cursor: 2,
      });
      assertEquals(await readModel.liveRecords("", PARTITION), []);
      // The tombstones removed nothing either.
      assertEquals(
        await Deno.readTextFile(join(root, "data", "_catalog.db")),
        "sentinel",
      );
      for (
        const file of [
          READ_MODEL_STATE_FILE,
          "_catalog_v3.db",
          READ_MODEL_LOCK_FILE,
        ]
      ) {
        assert(
          (await Deno.stat(join(env.stateDir, file))).isFile,
          `${file} was removed`,
        );
      }
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: skips a put where a file and a directory claim one path, and goes on", async () => {
  await withV3Env(async (env) => {
    const root = swampPath(env.repoDir);
    const intent = modelIntent({ kind: "data.save", name: "x", version: 1 });
    const put = (key: string) =>
      putOp({ intent, key: RecordKey.create(key), inline: base64(key) });
    const commits: Op[][] = [
      [await put("data/x")],
      // data/x is a file, so it cannot hold data/x/y.
      [await put("data/x/y")],
      [await put("data/d/e")],
      // data/d is a directory, so it cannot be a file.
      [await put("data/d")],
      // A tombstone under a file has nothing to remove.
      [tombstoneOp({ intent, key: RecordKey.create("data/x/y") })],
      [await put("data/after")],
    ];
    let seq = 0;
    for (const ops of commits) {
      await env.store.append(
        commitOf({ seq: ++seq, partition: PARTITION, namespace: "", ops }),
      );
    }
    const readModel = env.openReadModel();
    try {
      assertEquals(await readModel.catchUp(signal()), {
        applied: commits.length,
        cursor: commits.length,
      });
      assertEquals(await Deno.readTextFile(join(root, "data", "x")), "data/x");
      assertEquals(
        await Deno.readTextFile(join(root, "data", "d", "e")),
        "data/d/e",
      );
      assertEquals(
        await Deno.readTextFile(join(root, "data", "after")),
        "data/after",
      );
      // The skipped puts are indexed, so the index stays exact.
      assertEquals(
        (await readModel.liveRecords("", PARTITION)).map((r) =>
          r.key.toString()
        ),
        ["data/after", "data/d", "data/d/e", "data/x"],
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: a commit's tombstones clear the way for its puts", async () => {
  await withV3Env(async (env) => {
    const root = swampPath(env.repoDir);
    const intent = modelIntent({ kind: "data.save", name: "x", version: 1 });
    const put = (key: string) =>
      putOp({ intent, key: RecordKey.create(key), inline: base64(key) });
    const tombstone = (key: string) =>
      tombstoneOp({ intent, key: RecordKey.create(key) });
    await env.store.append(commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [await put("data/x/y"), await put("data/f")],
    }));
    // The put of data/x comes first, but data/x is free only once the
    // tombstone of data/x/y has removed the directory under it; likewise
    // data/f/g needs the file data/f gone.
    await env.store.append(commitOf({
      seq: 2,
      partition: PARTITION,
      namespace: "",
      ops: [
        await put("data/x"),
        tombstone("data/x/y"),
        await put("data/f/g"),
        tombstone("data/f"),
      ],
    }));
    const readModel = env.openReadModel();
    try {
      assertEquals(await readModel.catchUp(signal()), {
        applied: 2,
        cursor: 2,
      });
      assertEquals(await Deno.readTextFile(join(root, "data", "x")), "data/x");
      assertEquals(
        await Deno.readTextFile(join(root, "data", "f", "g")),
        "data/f/g",
      );
      assertEquals(
        (await readModel.liveRecords("", PARTITION)).map((r) =>
          r.key.toString()
        ),
        ["data/f/g", "data/x"],
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test({
  name:
    "read model: refuses a key a symlink in the cache routes into the state directory",
  // Creating a symlink needs privileges on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withV3Env(async (env) => {
      const root = swampPath(env.repoDir);
      await Deno.mkdir(join(root, "data"), { recursive: true });
      // data/up leads back to .swamp, so data/up/_read_model_v3/... lands in
      // the state directory although the key starts with a synced segment.
      await Deno.symlink(root, join(root, "data", "up"), { type: "dir" });
      const intent = modelIntent({ kind: "data.save", name: "x", version: 1 });
      await env.store.append(commitOf({
        seq: 1,
        partition: PARTITION,
        namespace: "",
        ops: [
          await putOp({
            intent,
            key: RecordKey.create(
              `data/up/_read_model_v3/${READ_MODEL_LOCK_FILE}`,
            ),
            inline: base64("evil"),
          }),
        ],
      }));
      const readModel = env.openReadModel();
      try {
        assertEquals(await readModel.catchUp(signal()), {
          applied: 1,
          cursor: 1,
        });
        assertNotEquals(
          await Deno.readTextFile(join(env.stateDir, READ_MODEL_LOCK_FILE)),
          "evil",
        );
      } finally {
        await readModel.close();
      }
    });
  },
});

for (const at of ["directory", "file"] as const) {
  Deno.test({
    name:
      `read model: a ${at} symlink leading out of the cache fails the commit, after keys in the same page resolved its parent (swamp-club#3337)`,
    // Creating a symlink needs privileges on Windows.
    ignore: Deno.build.os === "windows",
    fn: async () => {
      await withV3Env(async (env) => {
        const root = swampPath(env.repoDir);
        const outside = join(env.dir, "outside");
        await Deno.mkdir(outside);
        await Deno.writeTextFile(join(outside, "raw"), "untouched");
        const base = join(root, "data", MODEL_TYPE.normalized, MODEL_ID);
        await Deno.mkdir(join(base, "b"), { recursive: true });
        // data/.../a leads out of the cache, or data/.../b/raw is a symlink
        // to a file out of it.
        if (at === "directory") {
          await Deno.symlink(outside, join(base, "a"), { type: "dir" });
        } else {
          await Deno.symlink(join(outside, "raw"), join(base, "b", "raw"), {
            type: "file",
          });
        }
        const keyOf = (name: string) =>
          RecordKey.create(
            `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/raw`,
          );
        const put = (name: string) =>
          putOp({
            intent: modelIntent({ kind: "data.save", name, version: 1 }),
            key: keyOf(name),
            inline: base64("evil"),
          });
        // Two keys beside the symlink come first, so the model's directory
        // is already resolved when the symlink's key is checked.
        for (
          const [seq, names] of [[1, ["c", "d"]], [2, [
            at === "directory" ? "a" : "b",
          ]]] as const
        ) {
          await env.store.append(commitOf({
            seq,
            partition: PARTITION,
            namespace: "",
            ops: await Promise.all(names.map(put)),
          }));
        }
        const readModel = env.openReadModel();
        try {
          const error = await assertRejects(
            () => readModel.catchUp(signal()),
            ReadModelApplyError,
          );
          assertEquals(error.seq, 2);
          assertInstanceOf(error.cause, PathTraversalError);
        } finally {
          await readModel.close();
        }
        assertEquals(
          await Deno.readTextFile(join(outside, "raw")),
          "untouched",
        );
        assertEquals([...Deno.readDirSync(outside)].length, 1);
        assertEquals(await Deno.readTextFile(join(base, "c", "raw")), "evil");
      });
    },
  });
}

Deno.test("read model: a missing chunk fails the commit until the chunk is stored", async () => {
  await withV3Env(async (env) => {
    const blob = await env.chunkStore.write(SOLO_NAMESPACE, LARGE, signal());
    const firstPart = blob.parts![0].sha256;
    await env.storage.delete("_default", firstPart, signal());
    await env.store.append(commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [
        await putOp({
          intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
          key: dataKey("a", 1),
          blob,
        }),
      ],
    }));
    const readModel = env.openReadModel();
    try {
      const error = await assertRejects(
        () => readModel.catchUp(signal()),
        ReadModelApplyError,
      );
      assertInstanceOf(error.cause, ChunkMissingError);
      await assertRejects(
        () => readModel.chunksInUse(""),
        ReadModelIncompleteError,
      );

      await env.chunkStore.write(SOLO_NAMESPACE, LARGE, signal());
      assertEquals(await readModel.catchUp(signal()), {
        applied: 1,
        cursor: 1,
      });
      assertEquals(
        await Deno.readFile(
          join(
            swampPath(env.repoDir),
            ...dataKey("a", 1).toString().split("/"),
          ),
        ),
        LARGE,
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: refuses a blob still in a pre-v3 layout", async () => {
  await withV3Env(async (env) => {
    const ref = await env.chunkStore.write(SOLO_NAMESPACE, LARGE, signal());
    const legacy = BlobRef.create({
      sha256: ref.sha256,
      size: ref.size,
      parts: ref.parts,
      legacyKey: RecordKey.create("data/legacy/raw"),
    });
    await env.store.append(commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [
        await putOp({
          intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
          key: dataKey("a", 1),
          blob: legacy,
        }),
      ],
    }));
    const readModel = env.openReadModel();
    try {
      const error = await assertRejects(
        () => readModel.catchUp(signal()),
        ReadModelApplyError,
      );
      assertStringIncludes(error.message, "pre-v3 layout");
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("read model: every call after close rejects", async () => {
  await withV3Env(async (env) => {
    const readModel = env.openReadModel();
    await readModel.close();
    await readModel.close();
    await assertRejects(() => readModel.catchUp(signal()), Error, "closed");
    await assertRejects(
      () => readModel.catchUpPartition("", PARTITION, signal()),
      Error,
      "closed",
    );
    await assertRejects(
      () => readModel.liveRecords("", PARTITION),
      Error,
      "closed",
    );
    await assertRejects(() => readModel.chunksInUse(""), Error, "closed");
  });
});
