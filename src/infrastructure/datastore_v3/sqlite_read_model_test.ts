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

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Op } from "../../domain/datastore_v3/op.ts";
import {
  dataKey,
  deleteVersion,
  MemoryStorage,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import {
  CATALOG_V3_FILE,
  SqliteReadModel,
  type SqliteReadModelOptions,
} from "./sqlite_read_model.ts";
import { catalogRow } from "./v3_catalog.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";

interface Env {
  readonly repoDir: string;
  readonly store: SqliteCommitStore;
  open(overrides?: Partial<SqliteReadModelOptions>): SqliteReadModel;
  /** Appends a fixture-model commit in `namespace`. */
  append(seq: number, namespace: string, ops: readonly Op[]): Promise<void>;
  /** The path the fixture data version's content lands at. */
  contentPath(namespace: string, name: string, version: number): string;
  /** The v3 catalog's rows: namespace, name, version, id and size. */
  catalogRows(): unknown[][];
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-unit-" });
  const repoDir = join(dir, "repo");
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const chunkStore = new ChunkStore(new MemoryStorage());
  const stateDir = readModelStateDir(repoDir);
  const env: Env = {
    repoDir,
    store,
    open: (overrides = {}) =>
      SqliteReadModel.open({
        commitStore: store,
        chunkStore,
        cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
        stateDir,
        ...overrides,
      }),
    append: async (seq, namespace, ops) => {
      await store.append(modelCommit(seq, ops, { namespace }));
    },
    contentPath: (namespace, name, version) =>
      join(
        v3CacheRoot(repoDir, namespace),
        ...dataKey(name, version).toString().split("/"),
      ),
    catalogRows: () => {
      const db = new DatabaseSync(join(stateDir, CATALOG_V3_FILE), {
        readOnly: true,
      });
      try {
        return (db.prepare(
          "SELECT namespace, data_name, version, id, size FROM catalog ORDER BY namespace, data_name, version",
        ).all() as Record<string, unknown>[]).map((row) => Object.values(row));
      } finally {
        db.close();
      }
    },
  };
  try {
    await fn(env);
  } finally {
    await store.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function signal(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

async function readOrAbsent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Writes a checkout's own local-only file at `path`. */
async function writeLocal(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function liveKeys(
  readModel: SqliteReadModel,
  namespace: string,
): Promise<string[]> {
  return (await readModel.liveRecords(namespace, modelPartition())).map((r) =>
    r.key.toString()
  );
}

/** A namespaced checkout `alpha` whose directories hold only `config`. */
const ALPHA_CONFIG_ONLY = {
  namespace: "alpha",
  admits: datastoreKeyFilter(["config"], undefined),
};

Deno.test("SqliteReadModel: a reserved namespace's commits are indexed but never materialised or catalogued, and a solo recovery removes nothing (swamp-club#3691)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "data", [await savePut("a", 1), versionOp("a", 1)]);
    const readModel = env.open();
    try {
      await readModel.catchUp(signal());
      // `.swamp/data/data/...`: the namespace's cache root aliases the solo
      // namespace's data directory.
      assertEquals(
        await readOrAbsent(env.contentPath("data", "a", 1)),
        undefined,
      );
      assertEquals(env.catalogRows(), []);
      assert(
        (await liveKeys(readModel, "data")).includes(
          dataKey("a", 1).toString(),
        ),
        "the record stays indexed, so chunks and history stay whole",
      );
      assertEquals(
        await readModel.recover("", {
          since: 0,
          admits: () => true,
          signal: signal(),
        }),
        [],
      );
    } finally {
      await readModel.close();
    }
  });
});

for (const namespace of ["", "alpha"]) {
  Deno.test(`SqliteReadModel: a key of namespace "${namespace}" the checkout's directories leave out is never written, removed or catalogued, even after a reboot (swamp-club#3691)`, async () => {
    await withEnv(async (env) => {
      const local = env.contentPath(namespace, "a", 1);
      await writeLocal(local, "local");
      await env.append(1, namespace, [
        await savePut("a", 1),
        versionOp("a", 1),
      ]);
      // Another namespace's keys are materialised whatever the filter.
      await env.append(1, "beta", [await savePut("b", 1), versionOp("b", 1)]);
      const options = {
        checkout: ALPHA_CONFIG_ONLY,
        bootIdentity: () => Promise.resolve("boot-1"),
      };
      let readModel = env.open(options);
      try {
        await readModel.catchUp(signal());
        assertEquals(await readOrAbsent(local), "local");
        assert(
          (await liveKeys(readModel, namespace)).includes(
            dataKey("a", 1).toString(),
          ),
          "the record stays indexed",
        );
        assertEquals(
          await readOrAbsent(env.contentPath("beta", "b", 1)),
          "b@1",
        );
        assertEquals(
          env.catalogRows().map((row) => row.slice(0, 3)),
          [["beta", "b", 1]],
        );

        await env.append(2, namespace, [deleteVersion("a", 1)]);
        await readModel.catchUp(signal());
        assertEquals(await readOrAbsent(local), "local", "a delete leaves it");
      } finally {
        await readModel.close();
      }

      readModel = env.open({
        ...options,
        bootIdentity: () => Promise.resolve("boot-2"),
      });
      try {
        assertEquals(
          (await readModel.catchUp(signal())).applied,
          0,
          "a reboot applies nothing again",
        );
        assertEquals(await readOrAbsent(local), "local");
      } finally {
        await readModel.close();
      }
    });
  });
}

Deno.test("SqliteReadModel: the reboot check skips a listed key the checkout's directories now leave out, rather than resetting (swamp-club#3691)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    const local = env.contentPath("", "a", 1);
    // Projected unfiltered, unsynced, in boot 1.
    let readModel = env.open({ bootIdentity: () => Promise.resolve("boot-1") });
    try {
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(await readOrAbsent(local), "a@1");
    await writeLocal(local, "local");

    readModel = env.open({
      checkout: { namespace: "", admits: datastoreKeyFilter(["config"], []) },
      bootIdentity: () => Promise.resolve("boot-2"),
    });
    try {
      assertEquals(
        (await readModel.catchUp(signal())).applied,
        0,
        "the state is not reset",
      );
      assertEquals(await readOrAbsent(local), "local");
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: a compacted base's keys the checkout's directories leave out are never written or catalogued (swamp-club#3691)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    await env.append(2, "", [await savePut("a", 2), versionOp("a", 2)]);
    await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    const local = env.contentPath("", "a", 2);
    await writeLocal(local, "local");
    const readModel = env.open({ checkout: ALPHA_CONFIG_ONLY });
    try {
      await readModel.catchUp(signal());
      assertEquals(await readOrAbsent(local), "local");
      assertEquals(await readOrAbsent(env.contentPath("", "a", 1)), undefined);
      assertEquals(env.catalogRows(), []);
      assert(
        (await liveKeys(readModel, "")).includes(dataKey("a", 2).toString()),
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: another checkout's upsert and delete of a name never reach a local-only catalog row (swamp-club#3691)", async () => {
  await withEnv(async (env) => {
    // The solo checkout keeps data local: its own row, as its repository
    // writes it.
    const stateDir = readModelStateDir(env.repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    const local = { ...(metadata("a", 1) as Record<string, unknown>) };
    local.id = crypto.randomUUID();
    const seeded = new CatalogStore(join(stateDir, CATALOG_V3_FILE));
    try {
      seeded.upsertNewVersion(
        catalogRow(
          "",
          MODEL_TYPE.normalized,
          MODEL_ID,
          DataMetadataSchema.parse(local),
        ),
      );
    } finally {
      seeded.close();
    }
    const before = env.catalogRows();
    assertEquals(before.length, 1);

    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    await env.append(2, "", [deleteVersion("a", 1)]);
    const readModel = env.open({
      checkout: { namespace: "", admits: datastoreKeyFilter(["config"], []) },
    });
    try {
      await readModel.catchUp(signal());
      assertEquals(env.catalogRows(), before);
    } finally {
      await readModel.close();
    }
  });
});

/**
 * Lists directories as HFS+ does: every name decomposed (NFD), and a path
 * spelled either way found, so the sweep walks into what it lists on every
 * filesystem.
 */
async function* decomposedReadDir(dir: string): AsyncIterable<Deno.DirEntry> {
  for await (const entry of Deno.readDir(dir.normalize("NFC"))) {
    yield { ...entry, name: entry.name.normalize("NFD") };
  }
}

Deno.test("SqliteReadModel.recover: a committed file whose name the filesystem lists decomposed is kept (swamp-club#3736)", async () => {
  await withEnv(async (env) => {
    const name = "café";
    await env.append(1, "", [await savePut(name, 1), versionOp(name, 1)]);
    const readModel = env.open({ readDir: decomposedReadDir });
    try {
      await readModel.catchUp(signal());
      // Every file is newer than `since`, as after the replay refreshed it.
      const removed = await readModel.recover("", {
        since: 0,
        admits: datastoreKeyFilter(undefined, undefined),
        signal: signal(),
      });
      assertEquals(removed, []);
      assertEquals(
        await readOrAbsent(env.contentPath("", name, 1)),
        `${name}@1`,
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel.recover: an unowned file listed decomposed is kept when its composed key is filtered out, and removed when not (swamp-club#3736)", async () => {
  await withEnv(async (env) => {
    const kept = env.contentPath("", "café", 1);
    const swept = env.contentPath("", "plain", 1);
    await writeLocal(kept, "local");
    await writeLocal(swept, "dropped");
    const readModel = env.open({ readDir: decomposedReadDir });
    try {
      await readModel.catchUp(signal());
      const removed = await readModel.recover("", {
        since: 0,
        // An exclude written composed, as a user types it.
        admits: (key) => !key.includes("café"),
        signal: signal(),
      });
      assertEquals(removed, [dataKey("plain", 1).toString()]);
      assertEquals(await readOrAbsent(kept), "local");
      assertEquals(await readOrAbsent(swept), undefined);
    } finally {
      await readModel.close();
    }
  });
});

for (const admitsAll of [false, true]) {
  Deno.test(`SqliteReadModel.recover: a key the checkout's directories keep local is neither written by the replay nor removed by the sweep, ${admitsAll ? "whatever filter the caller passes" : "with the checkout's own filter"} (swamp-club#3736)`, async () => {
    await withEnv(async (env) => {
      const committed = env.contentPath("", "a", 1);
      const uncommitted = env.contentPath("", "b", 1);
      await writeLocal(committed, "local");
      await writeLocal(uncommitted, "local");
      await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
      const checkout = {
        namespace: "",
        admits: datastoreKeyFilter(["config"], []),
      };
      const readModel = env.open({ checkout });
      try {
        await readModel.catchUp(signal());
        const removed = await readModel.recover("", {
          since: 0,
          // A caller admitting everything is still overruled by the
          // checkout's own filter, the check every replay makes.
          admits: admitsAll ? () => true : checkout.admits,
          signal: signal(),
        });
        assertEquals(removed, []);
        assertEquals(await readOrAbsent(committed), "local");
        assertEquals(await readOrAbsent(uncommitted), "local");
      } finally {
        await readModel.close();
      }
    });
  });
}

Deno.test("SqliteReadModel: a compacted base no longer showing a key the checkout now keeps local leaves its local file (swamp-club#3736)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    const local = env.contentPath("", "a", 1);
    let readModel = env.open();
    try {
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(await readOrAbsent(local), "a@1");
    await writeLocal(local, "local");
    await env.append(2, "", [deleteVersion("a", 1)]);
    await env.append(3, "", [await savePut("b", 1), versionOp("b", 1)]);
    await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    readModel = env.open({
      checkout: { namespace: "", admits: datastoreKeyFilter(["config"], []) },
    });
    try {
      await readModel.catchUp(signal());
      assertEquals(await readOrAbsent(local), "local");
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: the reboot check leaves a removal it listed for a key the checkout now keeps local (swamp-club#3736)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    await env.append(2, "", [deleteVersion("a", 1)]);
    const local = env.contentPath("", "a", 1);
    let readModel = env.open({ bootIdentity: () => Promise.resolve("boot-1") });
    try {
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(await readOrAbsent(local), undefined);
    await writeLocal(local, "local");
    readModel = env.open({
      checkout: { namespace: "", admits: datastoreKeyFilter(["config"], []) },
      bootIdentity: () => Promise.resolve("boot-2"),
    });
    try {
      assertEquals((await readModel.catchUp(signal())).applied, 0);
      assertEquals(await readOrAbsent(local), "local");
    } finally {
      await readModel.close();
    }
  });
});
