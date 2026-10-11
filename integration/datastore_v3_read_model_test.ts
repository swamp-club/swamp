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
import { join } from "@std/path";
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
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  READ_MODEL_LOCK_FILE,
  READ_MODEL_STATE_FILE,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
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
