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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { waitFor } from "@swamp-club/swamp-testing";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { type Op, tombstoneOp } from "../../domain/datastore_v3/op.ts";
import {
  blobPut,
  dataKey,
  deleteVersion,
  MemoryStorage,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { ReadModelApplyError } from "../../domain/datastore_v3/read_model.ts";
import { findSpan, withCapturedSpans } from "../tracing/span_test_helpers.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import {
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "./sqlite_commit_store.ts";
import {
  CATALOG_V3_FILE,
  READ_MODEL_LOCK_FILE,
  READ_MODEL_STATE_FILE,
  SqliteReadModel,
  type SqliteReadModelOptions,
} from "./sqlite_read_model.ts";
import type { SpellingFolding } from "./spelling_folding.ts";
import { catalogRow, V3Catalog } from "./v3_catalog.ts";
import { datastoreKeyFilter, v3CacheRoot } from "./v3_datastore.ts";

interface Env {
  readonly repoDir: string;
  readonly store: SqliteCommitStore;
  readonly chunkStore: ChunkStore;
  open(overrides?: Partial<SqliteReadModelOptions>): SqliteReadModel;
  append(seq: number, namespace: string, ops: readonly Op[]): Promise<void>;
  contentPath(namespace: string, name: string, version: number): string;
  catalogRows(): unknown[][];
}

async function withEnv(
  fn: (env: Env) => Promise<void>,
  storeOptions: SqliteCommitStoreOptions = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-unit-" });
  const repoDir = join(dir, "repo");
  const store = SqliteCommitStore.open(join(dir, "commits.db"), storeOptions);
  const chunkStore = new ChunkStore(new MemoryStorage());
  const stateDir = readModelStateDir(repoDir);
  const env: Env = {
    repoDir,
    store,
    chunkStore,
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

async function listUnsyncedUnderBoot1(
  env: Env,
  count: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    await env.append(i, "", [await savePut(`r${i}`, 1), versionOp(`r${i}`, 1)]);
    paths.push(env.contentPath("", `r${i}`, 1));
  }
  const readModel = env.open({ bootIdentity: () => Promise.resolve("boot-1") });
  try {
    assertEquals((await readModel.catchUp(signal())).applied, count);
  } finally {
    await readModel.close();
  }
  return paths;
}

Deno.test("SqliteReadModel: where the boot cannot be named, the files an earlier boot listed are checked and synced, not replayed (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    const paths = await listUnsyncedUnderBoot1(env, 40);
    await Deno.writeTextFile(paths[6], "torn");
    const synced: string[] = [];
    const unnamed = () =>
      env.open({
        bootIdentity: () => Promise.resolve(undefined),
        syncFile: (path) => {
          synced.push(path);
          return Promise.resolve();
        },
      });
    let readModel = unnamed();
    try {
      assertEquals(
        (await readModel.catchUp(signal())).applied,
        0,
        "no commit is applied again",
      );
    } finally {
      await readModel.close();
    }
    assertEquals(
      await readOrAbsent(paths[6]),
      "r7@1",
      "a torn file is rewritten",
    );
    assertEquals(
      synced.toSorted(),
      paths.filter((_, i) => i !== 6).toSorted(),
      "every file that matched is synced",
    );

    synced.length = 0;
    readModel = unnamed();
    try {
      assertEquals((await readModel.catchUp(signal())).applied, 0);
    } finally {
      await readModel.close();
    }
    assertEquals(synced, [], "the list was cleared");
  });
});

Deno.test("SqliteReadModel: where the boot cannot be named and a listed file cannot be synced, every commit is applied again (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    await listUnsyncedUnderBoot1(env, 5);
    let refused = false;
    const readModel = env.open({
      bootIdentity: () => Promise.resolve(undefined),
      syncFile: () => {
        if (refused) return Promise.resolve();
        refused = true;
        return Promise.reject(new Error("sync refused"));
      },
    });
    try {
      assertEquals((await readModel.catchUp(signal())).applied, 5);
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: a catch-up that waits for another command's read-model lock says so, then catches up (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    const stateDir = readModelStateDir(env.repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    const held = await Deno.open(join(stateDir, READ_MODEL_LOCK_FILE), {
      read: true,
      write: true,
      create: true,
    });
    await held.lock(true);
    const messages: string[] = [];
    await configure({
      sinks: {
        capture: (record: LogRecord) =>
          messages.push(record.message.map(String).join("")),
      },
      loggers: [
        {
          category: ["swamp", "datastore", "read-model"],
          lowestLevel: "info",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    const readModel = env.open();
    let released = false;
    try {
      const catchingUp = readModel.catchUp(signal());
      await waitFor(
        () => messages.some((m) => m.includes("Waiting for another swamp")),
        "the wait to be reported",
      );
      held.close();
      released = true;
      assertEquals((await catchingUp).applied, 1);
    } finally {
      if (!released) held.close();
      await readModel.close();
      await reset();
    }
  });
});

Deno.test("SqliteReadModel: a catch-up waiting for another command's read-model lock stops when its signal aborts (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    const stateDir = readModelStateDir(env.repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    const held = await Deno.open(join(stateDir, READ_MODEL_LOCK_FILE), {
      read: true,
      write: true,
      create: true,
    });
    await held.lock(true);
    const readModel = env.open();
    try {
      const stop = new AbortController();
      const waiting = readModel.catchUp(stop.signal);
      stop.abort(new DOMException("stopped", "AbortError"));
      await assertRejects(() => waiting, DOMException);
    } finally {
      held.close();
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: a base overtaken by a compaction just after it loaded reapplies only the names that changed, and says so (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    for (let i = 1; i <= 5; i++) {
      await env.append(i, "", [
        await savePut(`r${i}`, 1),
        versionOp(`r${i}`, 1),
      ]);
    }
    await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    let compactedAgain = false;
    const store = new Proxy(env.store, {
      get(target, property) {
        if (property === "changesSince") {
          return async (cursor: number, limit: number) => {
            if (!compactedAgain && cursor > 0) {
              compactedAgain = true;
              await target.append(
                modelCommit(6, [await savePut("r6", 1), versionOp("r6", 1)]),
              );
              await target.compactHistory(Number.MAX_SAFE_INTEGER);
            }
            return await target.changesSince(cursor, limit);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const applied = new Map<string, number>();
    const inner = V3Catalog.open(
      join(readModelStateDir(env.repoDir), CATALOG_V3_FILE),
    );
    const catalog = new Proxy(inner, {
      get(target, property) {
        if (property === "apply") {
          return (
            namespace: string,
            partition: unknown,
            actions: readonly { name?: string }[],
          ) => {
            for (const name of new Set(actions.map((a) => a.name))) {
              if (name !== undefined) {
                applied.set(name, (applied.get(name) ?? 0) + 1);
              }
            }
            return (target.apply as (...args: unknown[]) => void)(
              namespace,
              partition,
              actions,
            );
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const readModel = env.open({
      commitStore: store,
      catalog,
      netReplay: false,
    });
    const messages: string[] = [];
    await configure({
      sinks: {
        capture: (record: LogRecord) =>
          messages.push(record.message.map(String).join("")),
      },
      loggers: [
        {
          category: ["swamp", "datastore", "read-model"],
          lowestLevel: "info",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    try {
      await readModel.catchUp(signal());
      assert(compactedAgain, "the compaction overtook the load");
      assertEquals(applied.get("r1"), 1, "an unchanged name is applied once");
      assertEquals(applied.get("r6"), 1);
      assertEquals(await readOrAbsent(env.contentPath("", "r6", 1)), "r6@1");
      assert(
        messages.some((m) => m.includes("compacted past the base")),
        messages.join("\n"),
      );
    } finally {
      await readModel.close();
      await reset();
    }
  });
});

const RECOVERY_COMMITS = 40;

/**
 * a checkout caught up through a compacted base and a tail, dated before the
 * marker by the injected clock, so only what the test touches looks changed
 */
async function interruptedCheckout(env: Env): Promise<{
  readonly since: number;
  readonly clock: () => Date;
  readonly counts: { compactedReads: number; firstCursor: number[] };
  readonly store: SqliteCommitStore;
}> {
  for (let i = 1; i <= RECOVERY_COMMITS; i++) {
    await env.append(i, "", [await savePut(`r${i}`, 1), versionOp(`r${i}`, 1)]);
    if (i === RECOVERY_COMMITS / 2) {
      await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
    }
  }
  const first = env.open({ pageSize: 5 });
  try {
    await first.catchUp(signal());
  } finally {
    await first.close();
  }
  const since = Date.now() + 60_000;
  const counts = { compactedReads: 0, firstCursor: [] as number[] };
  let open = false;
  const store = new Proxy(env.store, {
    get(target, property) {
      if (property === "readCompactedBase") {
        return (...args: unknown[]) => {
          counts.compactedReads++;
          return (target.readCompactedBase as (...a: unknown[]) => unknown)(
            ...args,
          );
        };
      }
      if (property === "changesSince") {
        return (cursor: number, limit: number) => {
          if (!open) {
            open = true;
            counts.firstCursor.push(cursor);
          }
          return target.changesSince(cursor, limit);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    since,
    clock: () => new Date(since + 60_000),
    counts,
    store,
  };
}

async function touchAfter(path: string, since: number): Promise<void> {
  const at = new Date(since + 1_000);
  await Deno.utime(path, at, at);
}

Deno.test("SqliteReadModel.recover: a targeted recovery after a long history applies nothing again, restores what the writer changed or removed, removes what it added, and leaves the catalog as a full rebuild does (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    const { since, clock, counts, store } = await interruptedCheckout(env);
    const tampered = env.contentPath("", "r3", 1);
    await Deno.writeTextFile(tampered, "uncommitted");
    await touchAfter(tampered, since);
    await Deno.remove(env.contentPath("", "r30", 1));
    const ghost = env.contentPath("", "ghost", 1);
    await writeLocal(ghost, "uncommitted");
    await touchAfter(ghost, since);
    const stateDir = readModelStateDir(env.repoDir);
    const catalog = new CatalogStore(join(stateDir, CATALOG_V3_FILE));
    try {
      catalog.upsertNewVersion(
        catalogRow(
          "",
          MODEL_TYPE.normalized,
          MODEL_ID,
          DataMetadataSchema.parse(metadata("ghost", 1)),
        ),
      );
    } finally {
      catalog.close();
    }

    const readModel = env.open({ commitStore: store, clock, pageSize: 5 });
    let targetedRows: unknown[][];
    try {
      const removed = await readModel.recover("", {
        since,
        admits: () => true,
        signal: signal(),
        targeted: true,
      });
      assertEquals(removed, [dataKey("ghost", 1).toString()]);
      assertEquals(counts.compactedReads, 0, "the base was not loaded again");
      assert(counts.firstCursor[0] > 0, "it caught up from the cursor");
      assertEquals(await readOrAbsent(tampered), "r3@1");
      assertEquals(await readOrAbsent(env.contentPath("", "r30", 1)), "r30@1");
      assertEquals(await readOrAbsent(ghost), undefined);
      targetedRows = env.catalogRows();

      await readModel.recover("", {
        since,
        admits: () => true,
        signal: signal(),
      });
    } finally {
      await readModel.close();
    }
    assertEquals(targetedRows, env.catalogRows());
    assertEquals(targetedRows.length, RECOVERY_COMMITS);
  });
});

Deno.test("SqliteReadModel.recover: a full rebuild stopped part way resumes from its cursor, and ends as an uninterrupted one does (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    const { since, clock } = await interruptedCheckout(env);
    const stop = new AbortController();
    let pages = 0;
    const stopping = new Proxy(env.store, {
      get(target, property) {
        if (property === "changesSince") {
          return (cursor: number, limit: number) => {
            if (++pages === 3) stop.abort();
            return target.changesSince(cursor, limit);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let readModel = env.open({ commitStore: stopping, clock, pageSize: 5 });
    try {
      await assertRejects(() =>
        readModel.recover("", {
          since,
          admits: () => true,
          signal: stop.signal,
        })
      );
    } finally {
      await readModel.close();
    }

    const cleared: number[] = [];
    const inner = V3Catalog.open(
      join(readModelStateDir(env.repoDir), CATALOG_V3_FILE),
    );
    const catalog = new Proxy(inner, {
      get(target, property) {
        if (property === "clear") {
          return (admits: (key: string) => boolean) => {
            cleared.push(1);
            return target.clear(admits);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    readModel = env.open({ catalog, clock, pageSize: 5 });
    try {
      await readModel.recover("", {
        since,
        admits: () => true,
        signal: signal(),
        targeted: true,
      });
    } finally {
      await readModel.close();
    }
    assertEquals(cleared, [], "the resumed rebuild did not clear again");
    assertEquals(env.catalogRows().length, RECOVERY_COMMITS);
    for (const i of [1, 20, RECOVERY_COMMITS]) {
      assertEquals(
        await readOrAbsent(env.contentPath("", `r${i}`, 1)),
        `r${i}@1`,
      );
    }
  });
});

Deno.test("SqliteReadModel.recover: a targeted recovery stopped part way leaves the marker's work to the next one, which carries on from the cursor (swamp-club#4512)", async () => {
  await withEnv(async (env) => {
    const { since, clock } = await interruptedCheckout(env);
    for (let i = RECOVERY_COMMITS + 1; i <= RECOVERY_COMMITS + 12; i++) {
      await env.append(i, "", [
        await savePut(`r${i}`, 1),
        versionOp(`r${i}`, 1),
      ]);
    }
    const tampered = env.contentPath("", "r3", 1);
    await Deno.writeTextFile(tampered, "uncommitted");
    await touchAfter(tampered, since);
    const stop = new AbortController();
    let pages = 0;
    const stopping = new Proxy(env.store, {
      get(target, property) {
        if (property === "changesSince") {
          return (cursor: number, limit: number) => {
            if (++pages === 2) stop.abort();
            return target.changesSince(cursor, limit);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let readModel = env.open({ commitStore: stopping, clock, pageSize: 5 });
    try {
      await assertRejects(() =>
        readModel.recover("", {
          since,
          admits: () => true,
          signal: stop.signal,
          targeted: true,
        })
      );
    } finally {
      await readModel.close();
    }
    const { counts, store } = await (async () => {
      const counts = { firstCursor: [] as number[] };
      let open = false;
      const store = new Proxy(env.store, {
        get(target, property) {
          if (property === "changesSince") {
            return (cursor: number, limit: number) => {
              if (!open) {
                open = true;
                counts.firstCursor.push(cursor);
              }
              return target.changesSince(cursor, limit);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { counts, store };
    })();
    readModel = env.open({ commitStore: store, clock, pageSize: 5 });
    try {
      await readModel.recover("", {
        since,
        admits: () => true,
        signal: signal(),
        targeted: true,
      });
    } finally {
      await readModel.close();
    }
    assert(
      counts.firstCursor[0] > RECOVERY_COMMITS,
      `resumed at ${counts.firstCursor[0]}`,
    );
    assertEquals(await readOrAbsent(tampered), "r3@1");
    assertEquals(
      await readOrAbsent(env.contentPath("", `r${RECOVERY_COMMITS + 12}`, 1)),
      `r${RECOVERY_COMMITS + 12}@1`,
    );
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

Deno.test("SqliteReadModel.recover: puts back a file whose commit the checkout calls its own work, which a catch-up leaves alone (swamp-club#4257)", async () => {
  await withEnv(async (env) => {
    await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
    const asked: number[] = [];
    const readModel = env.open({
      holdsOwnWork: (commit) => {
        asked.push(commit.seq);
        return true;
      },
    });
    try {
      const path = env.contentPath("", "a", 1);
      await writeLocal(path, "dropped");
      await readModel.catchUp(signal());
      assertEquals(asked, [1]);
      assertEquals(await readOrAbsent(path), "dropped");

      await readModel.recover("", {
        since: 0,
        admits: datastoreKeyFilter(undefined, undefined),
        signal: signal(),
      });
      assertEquals(await readOrAbsent(path), "a@1");
      assertEquals(asked, [1]);
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

for (const net of [true, false]) {
  Deno.test(
    `SqliteReadModel.catchUp: its span counts the commits, files and chunks it applied, in a ${
      net ? "net" : "full"
    } replay (swamp-club#3803)`,
    async () => {
      await withEnv(async (env) => {
        const blob = await env.chunkStore.write(
          SOLO_NAMESPACE,
          new Uint8Array(20_000).fill(3),
          signal(),
        );
        await env.append(1, "", [
          await blobPut("a", 1, blob),
          versionOp("a", 1),
        ]);
        await env.append(2, "", [await savePut("b", 1), versionOp("b", 1)]);
        await env.append(3, "", [deleteVersion("a", 1)]);
        if (!net) {
          await writeLocal(
            join(v3CacheRoot(env.repoDir, ""), "data", "local"),
            "x",
          );
        }
        const readModel = env.open();
        try {
          await withCapturedSpans(async (spans) => {
            await readModel.catchUp(signal());
            const span = findSpan(
              spans,
              "swamp.datastore.v3.readmodel.catchup",
            );
            const plan = findSpan(
              spans,
              "swamp.datastore.v3.readmodel.net_plan",
            );
            assertEquals(span.attributes["swamp.datastore.v3.commits"], 3);
            assertEquals(span.attributes["swamp.datastore.v3.pages"], 1);
            assertEquals(
              plan.attributes["swamp.datastore.v3.writes_replaceable"],
              1,
            );
            if (net) {
              assertEquals(
                span.attributes["swamp.datastore.v3.files_written"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.chunks_fetched"],
                0,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.writes_skipped"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.chunked_writes_skipped"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.removals_skipped"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.superseded_bytes"],
                0,
              );
            } else {
              assertEquals(
                plan.attributes["swamp.datastore.v3.writes_kept_for_directory"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.files_written"],
                2,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.chunks_fetched"],
                1,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.chunk_bytes"],
                20_000,
              );
              assertEquals(
                span.attributes["swamp.datastore.v3.superseded_bytes"],
                20_000,
              );
            }
          });
        } finally {
          await readModel.close();
        }
      });
    },
  );
}

for (const net of [true, false]) {
  Deno.test(
    `SqliteReadModel.catchUp: a fresh checkout ${
      net ? "leaves off disk" : "writes"
    } each base file the tail after a compacted base removes (swamp-club#3916)`,
    async () => {
      await withEnv(async (env) => {
        const blob = await env.chunkStore.write(
          SOLO_NAMESPACE,
          new Uint8Array(20_000).fill(5),
          signal(),
        );
        await env.append(1, "", [
          await blobPut("a", 1, blob),
          versionOp("a", 1),
        ]);
        await env.append(2, "", [await savePut("b", 1), versionOp("b", 1)]);
        await env.store.compactHistory(2);
        await env.append(3, "", [deleteVersion("a", 1)]);
        await env.append(4, "", [await savePut("c", 1), versionOp("c", 1)]);
        const readModel = env.open({ netReplay: net });
        try {
          await withCapturedSpans(async (spans) => {
            await readModel.catchUp(signal());
            const load = findSpan(
              spans,
              "swamp.datastore.v3.readmodel.catchup",
            );
            assertEquals(load.attributes["swamp.datastore.v3.base_writes"], 2);
            if (net) {
              assertEquals(
                load.attributes["swamp.datastore.v3.base_writes_skipped"],
                1,
              );
              assertEquals(
                load.attributes[
                  "swamp.datastore.v3.base_chunked_writes_skipped"
                ],
                1,
              );
              assertEquals(
                load.attributes["swamp.datastore.v3.chunks_fetched"],
                0,
              );
              assertEquals(
                load.attributes["swamp.datastore.v3.removals_skipped"],
                1,
              );
            } else {
              assertEquals(
                load.attributes["swamp.datastore.v3.base_writes_skipped"],
                undefined,
              );
              assertEquals(
                load.attributes["swamp.datastore.v3.chunks_fetched"],
                1,
              );
            }
          });
          assertEquals(
            await readOrAbsent(env.contentPath("", "a", 1)),
            undefined,
          );
          assertEquals(await readOrAbsent(env.contentPath("", "b", 1)), "b@1");
          assertEquals(await readOrAbsent(env.contentPath("", "c", 1)), "c@1");
        } finally {
          await readModel.close();
        }
      });
    },
  );
}

Deno.test({
  name:
    "SqliteReadModel.recover: the replay keeps a file that already holds its committed inline bytes, and rewrites one that does not (swamp-club#3893)",
  // Windows reports no link counts, and file symlinks need a privilege.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withEnv(async (env) => {
      const names = ["a", "b", "c", "d"];
      await env.append(
        1,
        "",
        [
          ...await Promise.all(names.map((name) => savePut(name, 1))),
          ...names.map((name) => versionOp(name, 1)),
        ] as Op[],
      );
      const readModel = env.open();
      try {
        await readModel.catchUp(signal());
        await Deno.writeTextFile(env.contentPath("", "b", 1), "uncommitted");
        const c = env.contentPath("", "c", 1);
        const elsewhere = `${c}.elsewhere`;
        await Deno.writeTextFile(elsewhere, "c@1");
        await Deno.remove(c);
        await Deno.symlink(elsewhere, c, { type: "file" });
        const d = env.contentPath("", "d", 1);
        const linked = `${d}.linked`;
        await Deno.link(d, linked);
        await withCapturedSpans(async (spans) => {
          await readModel.recover("", {
            since: 0,
            admits: datastoreKeyFilter(undefined, undefined),
            signal: signal(),
          });
          const span = findSpan(spans, "swamp.datastore.v3.readmodel.recover");
          assertEquals(span.attributes["swamp.datastore.v3.writes_kept"], 1);
          assertEquals(span.attributes["swamp.datastore.v3.files_written"], 3);
        });
        for (const name of names) {
          assertEquals(
            await readOrAbsent(env.contentPath("", name, 1)),
            `${name}@1`,
          );
        }
        assertEquals((await Deno.lstat(c)).isSymlink, false);
        assertEquals((await Deno.lstat(d)).nlink, 1);
      } finally {
        await readModel.close();
      }
    });
  },
});

async function foldsSpellings(dir: string): Promise<boolean> {
  await Deno.mkdir(dir, { recursive: true });
  const name = "oracle-é";
  await Deno.writeTextFile(join(dir, name), "");
  try {
    for (const spelling of [name.toUpperCase(), name.normalize("NFD")]) {
      try {
        await Deno.lstat(join(dir, spelling));
        return true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return false;
  } finally {
    await Deno.remove(join(dir, name));
  }
}

// case-sensitive APFS still folds normalization, so this checks case alone
function foldsCase(dir: string): Promise<boolean> {
  return reachesAs(dir, "oracle-case", "ORACLE-CASE");
}

/**
 * Whether the filesystem holding `dir` reaches a file under the decomposed
 * spelling of its name. NTFS folds case but not normalization, so this is
 * the oracle for keys that differ only in normalization.
 */
async function foldsNormalization(dir: string): Promise<boolean> {
  await Deno.mkdir(dir, { recursive: true });
  const name = "oracle-é";
  await Deno.writeTextFile(join(dir, name), "");
  try {
    await Deno.lstat(join(dir, name.normalize("NFD")));
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  } finally {
    await Deno.remove(join(dir, name));
  }
}

async function catchUpAttributes(
  readModel: SqliteReadModel,
): Promise<Record<string, unknown>> {
  let attributes: Record<string, unknown> = {};
  await withCapturedSpans(async (spans) => {
    await readModel.catchUp(signal());
    attributes = findSpan(spans, "swamp.datastore.v3.readmodel.catchup")
      .attributes;
  });
  return attributes;
}

const ALIASED = "swamp.datastore.v3.aliased_skipped";

function dataTombstone(name: string, version: number): Op {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name, version }),
    key: dataKey(name, version),
  });
}

const FORCED_MODES: readonly (SpellingFolding | undefined)[] = [
  undefined,
  "canonical",
  "list",
];

for (const spellingFolding of FORCED_MODES) {
  const mode = spellingFolding ?? "probed";

  Deno.test(`SqliteReadModel: a tombstone of a key nothing owns leaves a file another spelling of the key reaches (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("vpc", 1), versionOp("vpc", 1)]);
      await env.append(2, "", [dataTombstone("VPC", 1)]);
      const readModel = env.open({ spellingFolding });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 1)),
          "vpc@1",
        );
        const folds = await foldsSpellings(v3CacheRoot(env.repoDir, ""));
        assertEquals(attributes[ALIASED], folds ? 1 : undefined);
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a put of a key nothing owns does not overwrite a file another spelling of the key reaches (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("vpc", 1), versionOp("vpc", 1)]);
      await env.append(2, "", [await savePut("VPC", 1, "forged")]);
      const readModel = env.open({ spellingFolding });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 1)),
          "vpc@1",
        );
        const folds = await foldsSpellings(v3CacheRoot(env.repoDir, ""));
        assertEquals(attributes[ALIASED], folds ? 1 : undefined);
        if (!folds) {
          assertEquals(
            await readOrAbsent(env.contentPath("", "VPC", 1)),
            "forged",
          );
        }
        const live = await liveKeys(readModel, "");
        assert(live.includes(dataKey("VPC", 1).toString()));
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a put of a decomposed spelling of a key nothing owns does not overwrite the composed spelling's file (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      const composed = "café";
      const decomposed = composed.normalize("NFD");
      await env.append(1, "", [
        await savePut(composed, 1),
        versionOp(composed, 1),
      ]);
      await env.append(2, "", [await savePut(decomposed, 1, "forged")]);
      const readModel = env.open({ spellingFolding });
      try {
        await readModel.catchUp(signal());
        assertEquals(
          await readOrAbsent(env.contentPath("", composed, 1)),
          `${composed}@1`,
        );
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a key that owns its file is written through another spelling of its directory (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("VPC", 1), versionOp("VPC", 1)]);
      await env.append(2, "", [await savePut("vpc", 2), versionOp("vpc", 2)]);
      await env.append(3, "", [await savePut("vpc", 2, "second")]);
      // In full, so vpc@2's first file is on disk when the second put lands.
      const readModel = env.open({ spellingFolding, netReplay: false });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 2)),
          "second",
        );
        assertEquals(
          await readOrAbsent(env.contentPath("", "VPC", 1)),
          "VPC@1",
        );
        assertEquals(attributes[ALIASED], undefined);
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a recovery replay gives back ownership of a key written through another spelling of its directory (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("VPC", 1), versionOp("VPC", 1)]);
      await env.append(2, "", [await savePut("vpc", 2), versionOp("vpc", 2)]);
      const first = env.open({ spellingFolding });
      try {
        await first.catchUp(signal());
      } finally {
        await first.close();
      }
      const replay = env.open({
        spellingFolding,
        stateDir: join(dirname(env.repoDir), "recovered-state"),
        netReplay: false,
      });
      try {
        const attributes = await catchUpAttributes(replay);
        assertEquals(attributes[ALIASED], undefined);
        await env.append(3, "", [dataTombstone("vpc", 2)]);
        await replay.catchUp(signal());
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 2)),
          undefined,
        );
        assertEquals(
          await readOrAbsent(env.contentPath("", "VPC", 1)),
          "VPC@1",
        );
      } finally {
        await replay.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a put of another spelling in the same commit does not overwrite the key's file (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [
        await savePut("vpc", 1),
        versionOp("vpc", 1),
        await savePut("VPC", 1, "forged"),
      ]);
      const readModel = env.open({ spellingFolding });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 1)),
          "vpc@1",
        );
        const folds = await foldsSpellings(v3CacheRoot(env.repoDir, ""));
        assertEquals(attributes[ALIASED], folds ? 1 : undefined);
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a key whose own tombstone removed its file neither overwrites nor removes another spelling's file (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("VPC", 1), versionOp("VPC", 1)]);
      await env.append(2, "", [dataTombstone("VPC", 1)]);
      await env.append(3, "", [await savePut("vpc", 1), versionOp("vpc", 1)]);
      await env.append(4, "", [await savePut("VPC", 1, "forged")]);
      const readModel = env.open({ spellingFolding, netReplay: false });
      try {
        await readModel.catchUp(signal());
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 1)),
          "vpc@1",
        );
        await env.append(5, "", [dataTombstone("VPC", 1)]);
        await readModel.catchUp(signal());
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 1)),
          "vpc@1",
        );
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a key spelt as the disk spells a file another spelling owns neither overwrites nor removes it (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("VPC", 1), versionOp("VPC", 1)]);
      await env.append(2, "", [await savePut("vpc", 2), versionOp("vpc", 2)]);
      await env.append(3, "", [await savePut("VPC", 2, "forged")]);
      await env.append(4, "", [dataTombstone("VPC", 2)]);
      const readModel = env.open({ spellingFolding, netReplay: false });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", "vpc", 2)),
          "vpc@2",
        );
        const folds = await foldsSpellings(v3CacheRoot(env.repoDir, ""));
        assertEquals(attributes[ALIASED], folds ? 2 : undefined);
      } finally {
        await readModel.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a recovery replay over the files on disk keeps what an incremental catch-up kept (${mode}, swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      await env.append(1, "", [await savePut("vpc", 1), versionOp("vpc", 1)]);
      await env.append(2, "", [await savePut("VPC", 1, "forged")]);
      await env.append(3, "", [dataTombstone("VPC", 1)]);
      const first = env.open({ spellingFolding });
      try {
        await first.catchUp(signal());
      } finally {
        await first.close();
      }
      const after = await readOrAbsent(env.contentPath("", "vpc", 1));
      assertEquals(after, "vpc@1");
      const replay = env.open({
        spellingFolding,
        stateDir: join(dirname(env.repoDir), "recovered-state"),
        netReplay: false,
      });
      try {
        await replay.catchUp(signal());
        assertEquals(await readOrAbsent(env.contentPath("", "vpc", 1)), after);
      } finally {
        await replay.close();
      }
    });
  });

  Deno.test(`SqliteReadModel: a net replay of spellings that alias leaves what a full replay leaves (${mode}, swamp-club#3939)`, async () => {
    const outcomes: unknown[] = [];
    for (const netReplay of [true, false]) {
      await withEnv(async (env) => {
        await env.append(1, "", [
          await savePut("vpc", 1, "a"),
          versionOp("vpc", 1),
        ]);
        await env.append(2, "", [await savePut("VPC", 1, "forged")]);
        await env.append(3, "", [await savePut("vpc", 1, "b")]);
        const readModel = env.open({ spellingFolding, netReplay });
        try {
          const attributes = await catchUpAttributes(readModel);
          outcomes.push([
            await readOrAbsent(env.contentPath("", "vpc", 1)),
            await readOrAbsent(env.contentPath("", "VPC", 1)),
            attributes[ALIASED],
          ]);
        } finally {
          await readModel.close();
        }
      });
    }
    assertEquals(outcomes[0], outcomes[1]);
  });
}

if (Deno.build.os !== "windows") {
  Deno.test("SqliteReadModel: a key reached through a symlinked directory is not taken for another spelling (swamp-club#3939)", async () => {
    const outcomes: unknown[] = [];
    for (const spellingFolding of ["off", "canonical", "list"] as const) {
      await withEnv(async (env) => {
        await env.append(1, "", [await savePut("vpc", 1, "old")]);
        const link = dirname(dirname(env.contentPath("", "vpc", 1)));
        const real = join(dirname(link), "real");
        await writeLocal(join(real, "1", "raw"), "old");
        await Deno.symlink(real, link, { type: "dir" });
        await env.append(2, "", [await savePut("vpc", 1, "new")]);
        const readModel = env.open({ spellingFolding, netReplay: false });
        try {
          const attributes = await catchUpAttributes(readModel);
          outcomes.push([
            await readOrAbsent(join(real, "1", "raw")),
            attributes[ALIASED],
          ]);
        } finally {
          await readModel.close();
        }
      });
    }
    assertEquals(outcomes[1], outcomes[0]);
    assertEquals(outcomes[2], outcomes[0]);
  });
}

Deno.test("SqliteReadModel: a full replay over files spelt as their keys lists no directory unless the mode is list, and each at most once a page (swamp-club#3939)", async () => {
  const ITEMS = 50;
  for (const spellingFolding of ["off", "canonical", "list"] as const) {
    await withEnv(async (env) => {
      const ops: Op[] = [];
      for (let i = 0; i < ITEMS; i++) {
        ops.push(await savePut(`item-${i}`, 1), versionOp(`item-${i}`, 1));
      }
      await env.append(1, "", ops);
      const first = env.open({ spellingFolding: "off" });
      try {
        await first.catchUp(signal());
      } finally {
        await first.close();
      }
      const listed: string[] = [];
      const replay = env.open({
        spellingFolding,
        stateDir: join(dirname(env.repoDir), "recovered-state"),
        netReplay: false,
        readDir: (dir) => {
          listed.push(dir);
          return Deno.readDir(dir);
        },
      });
      try {
        await replay.catchUp(signal());
      } finally {
        await replay.close();
      }
      if (spellingFolding === "list") {
        const root = v3CacheRoot(env.repoDir, "");
        const dirs = new Set<string>();
        for (let i = 0; i < ITEMS; i++) {
          const segments = dataKey(`item-${i}`, 1).toString().split("/");
          for (let depth = 0; depth < segments.length; depth++) {
            dirs.add(join(root, ...segments.slice(0, depth)));
          }
        }
        assertEquals(listed.toSorted(), [...dirs].toSorted());
      } else {
        assertEquals(listed, []);
      }
    });
  }
});

Deno.test("SqliteReadModel: a recovery replay where names are listed decomposed gives back a composed key its own file (swamp-club#3939)", async () => {
  await withEnv(async (env) => {
    const name = "caf\u00e9";
    await env.append(1, "", [await savePut(name, 1), versionOp(name, 1)]);
    const first = env.open();
    try {
      await first.catchUp(signal());
    } finally {
      await first.close();
    }
    // As on HFS+, which lists every name decomposed and whose realPath
    // the probe cannot trust.
    const replay = env.open({
      spellingFolding: "list",
      readDir: decomposedReadDir,
      stateDir: join(dirname(env.repoDir), "recovered-state"),
      netReplay: false,
    });
    try {
      const attributes = await catchUpAttributes(replay);
      assertEquals(attributes[ALIASED], undefined);
      await env.append(2, "", [dataTombstone(name, 1)]);
      await replay.catchUp(signal());
      assertEquals(await readOrAbsent(env.contentPath("", name, 1)), undefined);
    } finally {
      await replay.close();
    }
  });
});

async function readModelWarnings(fn: () => Promise<void>): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "datastore", "read-model"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
  }
  return records.map((record) => record.message.map(String).join(""));
}

for (const tombstone of [false, true]) {
  const change = tombstone ? "tombstone" : "put";
  Deno.test(`SqliteReadModel: in list mode a ${change} of a key no listed name matches is skipped, warned about and counted (swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      const stray = env.contentPath("", "stray", 1);
      await writeLocal(stray, "on disk");
      await env.append(1, "", [await savePut("other", 1)]);
      await env.append(2, "", [
        tombstone ? dataTombstone("stray", 1) : await savePut("stray", 1),
      ]);
      const readModel = env.open({
        spellingFolding: "list",
        netReplay: false,
        readDir: async function* (dir) {
          for await (const entry of Deno.readDir(dir)) {
            if (entry.name !== "stray") yield entry;
          }
        },
      });
      try {
        let attributes: Record<string, unknown> = {};
        const warnings = await readModelWarnings(async () => {
          attributes = await catchUpAttributes(readModel);
        });
        assertEquals(attributes[ALIASED], 1);
        assert(
          warnings.some((message) =>
            message.includes(dataKey("stray", 1).toString()) &&
            message.includes("reaches another key's file")
          ),
          `no aliased-spelling warning in ${JSON.stringify(warnings)}`,
        );
        assertEquals(await readOrAbsent(stray), "on disk");
        assertEquals(
          await readOrAbsent(env.contentPath("", "other", 1)),
          "other@1",
        );
      } finally {
        await readModel.close();
      }
    });
  });
}

Deno.test("SqliteReadModel: in list mode a directory a write adds in a page is seen by a later change of another spelling in the same page (swamp-club#3939)", async () => {
  await withEnv(async (env) => {
    await writeLocal(env.contentPath("", "abc", 1), "on disk");
    await env.append(1, "", [await savePut("abc", 1)]);
    await env.append(2, "", [await savePut("vpc", 2), versionOp("vpc", 2)]);
    await env.append(3, "", [await savePut("VPC", 2, "forged")]);
    const listed: string[] = [];
    const readModel = env.open({
      spellingFolding: "list",
      netReplay: false,
      readDir: (dir) => {
        listed.push(dir);
        return Deno.readDir(dir);
      },
    });
    try {
      const attributes = await catchUpAttributes(readModel);
      assertEquals(attributes["swamp.datastore.v3.pages"], 1);
      assert(listed.length > 0, "abc@1's put listed the directories");
      assertEquals(await readOrAbsent(env.contentPath("", "vpc", 2)), "vpc@2");
      const folds = await foldsSpellings(v3CacheRoot(env.repoDir, ""));
      assertEquals(attributes[ALIASED], folds ? 1 : undefined);
    } finally {
      await readModel.close();
    }
  });
});

for (const tombstone of [false, true]) {
  const change = tombstone ? "tombstone" : "put";
  Deno.test(`SqliteReadModel: where names are listed decomposed, a ${change} of a decomposed key leaves its composed twin's file (swamp-club#3939)`, async () => {
    await withEnv(async (env) => {
      const composed = "caf\u00e9";
      const decomposed = composed.normalize("NFD");
      await env.append(1, "", [
        await savePut(composed, 1),
        versionOp(composed, 1),
      ]);
      await env.append(2, "", [
        tombstone
          ? dataTombstone(decomposed, 1)
          : await savePut(decomposed, 1, "forged"),
      ]);
      // As on HFS+, which lists every name decomposed and whose realPath
      // the probe cannot trust.
      const readModel = env.open({
        spellingFolding: "list",
        readDir: decomposedReadDir,
        netReplay: false,
      });
      try {
        const attributes = await catchUpAttributes(readModel);
        assertEquals(
          await readOrAbsent(env.contentPath("", composed, 1)),
          `${composed}@1`,
        );
        const folds = await foldsNormalization(v3CacheRoot(env.repoDir, ""));
        assertEquals(attributes[ALIASED], folds ? 1 : undefined);
      } finally {
        await readModel.close();
      }
    });
  });
}

const FOLLOWER_SEQS = [2, 5, 9];

async function appendGapped(env: Env): Promise<string[]> {
  for (const seq of FOLLOWER_SEQS) {
    await env.append(seq, "", [await savePut("a", seq), versionOp("a", seq)]);
  }
  return FOLLOWER_SEQS.map((seq) => dataKey("a", seq).toString());
}

Deno.test("SqliteReadModel follower: catchUp applies gapped commits (swamp-club#3985)", async () => {
  await withEnv(async (env) => {
    const keys = await appendGapped(env);
    const readModel = env.open({ follower: true });
    try {
      await readModel.catchUp(signal());
      const live = await liveKeys(readModel, "");
      for (const key of keys) assert(live.includes(key), key);
      for (const seq of FOLLOWER_SEQS) {
        assertEquals(
          await readOrAbsent(env.contentPath("", "a", seq)),
          `a@${seq}`,
        );
      }
      await env.append(14, "", [await savePut("a", 14), versionOp("a", 14)]);
      await readModel.catchUp(signal());
      assertEquals(await readOrAbsent(env.contentPath("", "a", 14)), "a@14");
    } finally {
      await readModel.close();
    }
  }, { follower: true });
});

Deno.test("SqliteReadModel follower: catchUpPartition reads past the gaps", async () => {
  await withEnv(async (env) => {
    const keys = await appendGapped(env);
    const readModel = env.open({ follower: true });
    try {
      const result = await readModel.catchUpPartition(
        "",
        modelPartition(),
        signal(),
      );
      assertEquals(result.applied, FOLLOWER_SEQS.length);
      await env.append(11, "", [await savePut("a", 11), versionOp("a", 11)]);
      assertEquals(
        (await readModel.catchUpPartition("", modelPartition(), signal()))
          .applied,
        1,
      );
      await readModel.catchUp(signal());
      const live = await liveKeys(readModel, "");
      for (const key of [...keys, dataKey("a", 11).toString()]) {
        assert(live.includes(key), key);
      }
    } finally {
      await readModel.close();
    }
  }, { follower: true });
});

Deno.test("SqliteReadModel: a solo read model still refuses a gap", async () => {
  await withEnv(async (env) => {
    await appendGapped(env);
    const readModel = env.open();
    try {
      const error = await assertRejects(
        () => readModel.catchUp(signal()),
        ReadModelApplyError,
      );
      assertStringIncludes(error.message, "next commit must be seq 1");
    } finally {
      await readModel.close();
    }
  }, { follower: true });
});

Deno.test("SqliteReadModel: recordsChanged is told the keys each applied page wrote or removed, and its failure never fails the catch-up (swamp-club#3985)", async () => {
  await withEnv(async (env) => {
    const told: [string, string[]][] = [];
    let fail = false;
    const readModel = env.open({
      recordsChanged: (namespace, keys) => {
        told.push([namespace, [...keys]]);
        return fail
          ? Promise.reject(new Error("index unwritable"))
          : Promise.resolve();
      },
    });
    try {
      const key = dataKey("a", 1).toString();
      await env.append(1, "", [await savePut("a", 1), versionOp("a", 1)]);
      await readModel.catchUp(signal());
      assertEquals(told, [["", [key]]]);

      await readModel.catchUp(signal());
      assertEquals(told.length, 1);

      fail = true;
      await env.append(2, "", [deleteVersion("a", 1)]);
      await readModel.catchUp(signal());
      assertEquals(told.at(-1), ["", [key]]);
      assertEquals(await readOrAbsent(env.contentPath("", "a", 1)), undefined);
    } finally {
      await readModel.close();
    }
  });
});

Deno.test({
  name:
    "SqliteReadModel: in list mode a directory that cannot be listed does not stop the catch-up; the key is checked by its own spelling (swamp-club#4277)",
  // chmod 300 has no meaning on Windows
  ignore: Deno.build.os === "windows",
  async fn() {
    await withEnv(async (env) => {
      const path = env.contentPath("", "locked", 1);
      await writeLocal(path, "on disk");
      const locked = dirname(dirname(path));
      await env.append(1, "", [await savePut("locked", 1)]);
      await env.append(2, "", [await savePut("other", 1)]);
      const readModel = env.open({ spellingFolding: "list", netReplay: false });
      // deletable and enterable, but not listable
      await Deno.chmod(locked, 0o300);
      try {
        const warnings = await readModelWarnings(async () => {
          await readModel.catchUp(signal());
        });
        assertEquals(await readOrAbsent(path), "locked@1");
        assertEquals(
          await readOrAbsent(env.contentPath("", "other", 1)),
          "other@1",
        );
        assert(
          warnings.some((message) =>
            message.includes(locked) && message.includes("cannot be listed")
          ),
          `no unlistable-directory warning in ${JSON.stringify(warnings)}`,
        );
      } finally {
        await Deno.chmod(locked, 0o755);
        await readModel.close();
      }
    });
  },
});

Deno.test("SqliteReadModel: in list mode a directory removed before it is listed does not stop the catch-up (swamp-club#4277)", async () => {
  await withEnv(async (env) => {
    const path = env.contentPath("", "gone", 1);
    await writeLocal(path, "on disk");
    await env.append(1, "", [await savePut("gone", 1)]);
    await env.append(2, "", [await savePut("other", 1)]);
    const vanished = dirname(path);
    const readModel = env.open({
      spellingFolding: "list",
      netReplay: false,
      // gone between the key guard's walk and its listing
      readDir: (dir) => {
        if (dir === vanished) {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(new Deno.errors.NotFound(`readdir '${dir}'`)),
            }),
          };
        }
        return Deno.readDir(dir);
      },
    });
    try {
      await readModel.catchUp(signal());
      assertEquals(await readOrAbsent(path), "gone@1");
      assertEquals(
        await readOrAbsent(env.contentPath("", "other", 1)),
        "other@1",
      );
    } finally {
      await readModel.close();
    }
  });
});

Deno.test("SqliteReadModel: in list mode on a root that keeps case-variant keys apart, a replay restores each key's own file and reports no alias (swamp-club#4277)", async () => {
  await withEnv(async (env) => {
    const root = v3CacheRoot(env.repoDir, "");
    // only a filesystem that keeps both spellings apart holds both files
    if (await foldsCase(root)) return;
    await env.append(1, "", [await savePut("vpc", 1), versionOp("vpc", 1)]);
    await env.append(2, "", [await savePut("VPC", 1), versionOp("VPC", 1)]);
    const first = env.open({ spellingFolding: "list", netReplay: false });
    try {
      await first.catchUp(signal());
    } finally {
      await first.close();
    }
    // stands in for a writer killed mid-command
    await Deno.writeTextFile(env.contentPath("", "VPC", 1), "dirty");
    await Deno.remove(
      join(readModelStateDir(env.repoDir), READ_MODEL_STATE_FILE),
    );
    const again = env.open({ spellingFolding: "list", netReplay: false });
    try {
      const attributes = await catchUpAttributes(again);
      assertEquals(attributes[ALIASED], undefined);
      assertEquals(await readOrAbsent(env.contentPath("", "VPC", 1)), "VPC@1");
      assertEquals(await readOrAbsent(env.contentPath("", "vpc", 1)), "vpc@1");
    } finally {
      await again.close();
    }
  });
});

for (const [owner, alias] of [["vpcσ", "vpcς"], ["ſvpc", "svpc"]]) {
  for (const spellingFolding of FORCED_MODES) {
    const mode = spellingFolding ?? "probed";
    Deno.test(`SqliteReadModel: a put of ${alias}, which a case-insensitive filesystem folds with ${owner} though lower-casing does not, does not overwrite ${owner}'s file (${mode}, swamp-club#4277)`, async () => {
      await withEnv(async (env) => {
        await env.append(1, "", [
          await savePut(owner, 1),
          versionOp(owner, 1),
        ]);
        await env.append(2, "", [await savePut(alias, 1, "forged")]);
        const readModel = env.open({ spellingFolding, netReplay: false });
        try {
          const attributes = await catchUpAttributes(readModel);
          const folds = await reachesAs(
            v3CacheRoot(env.repoDir, ""),
            owner,
            alias,
          );
          assertEquals(
            await readOrAbsent(env.contentPath("", owner, 1)),
            `${owner}@1`,
          );
          assertEquals(attributes[ALIASED], folds ? 1 : undefined);
        } finally {
          await readModel.close();
        }
      });
    });
  }
}

async function reachesAs(
  dir: string,
  name: string,
  as: string,
): Promise<boolean> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, name), "");
  try {
    await Deno.lstat(join(dir, as));
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  } finally {
    await Deno.remove(join(dir, name));
  }
}

class PrefetchRecorder extends MemoryStorage {
  readonly prefetched: string[][] = [];
  prefetch(
    _namespace: string,
    hashes: readonly string[],
    _signal: AbortSignal,
  ): Promise<void> {
    this.prefetched.push([...hashes]);
    return Promise.resolve();
  }
}

function hashesOf(ref: BlobRef): string[] {
  return (ref.parts ?? [{ sha256: ref.sha256 }]).map((part) => part.sha256);
}

Deno.test("SqliteReadModel.catchUp: a replay fetches the chunks it writes together, never one a later write of the key replaces (swamp-club#4457)", async () => {
  await withEnv(async (env) => {
    const storage = new PrefetchRecorder();
    const chunks = new ChunkStore(storage);
    const blob = (fill: number) =>
      chunks.write(SOLO_NAMESPACE, new Uint8Array(20_000).fill(fill), signal());
    const first = await blob(1);
    const rewritten = await blob(2);
    const b = await blob(3);
    const c = await blob(4);
    await env.append(1, "", [await blobPut("a", 1, first), versionOp("a", 1)]);
    await env.append(2, "", [await blobPut("a", 1, rewritten)]);
    await env.append(3, "", [
      await blobPut("b", 1, b),
      versionOp("b", 1),
      await blobPut("c", 1, c),
      versionOp("c", 1),
    ]);
    const readModel = env.open({ chunkStore: chunks });
    try {
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(storage.prefetched.length, 1, "one batch for the page");
    assertEquals(
      storage.prefetched.flat().sort(),
      [...hashesOf(rewritten), ...hashesOf(b), ...hashesOf(c)].sort(),
    );
    assertEquals(
      await readOrAbsent(env.contentPath("", "a", 1)) !== undefined,
      true,
    );
  });
});

Deno.test("SqliteReadModel.catchUp: a page of new commits fetches no chunk for a key the checkout does not project (swamp-club#4457)", async () => {
  await withEnv(async (env) => {
    const storage = new PrefetchRecorder();
    const chunks = new ChunkStore(storage);
    const blob = (fill: number) =>
      chunks.write(SOLO_NAMESPACE, new Uint8Array(20_000).fill(fill), signal());
    const shown = await blob(1);
    const alsoShown = await blob(2);
    const hidden = await blob(3);
    await env.append(1, "", [await savePut("seed", 1), versionOp("seed", 1)]);
    const readModel = env.open({
      chunkStore: chunks,
      checkout: { namespace: "", admits: (key) => !key.includes("hidden") },
    });
    try {
      await readModel.catchUp(signal());
      await env.append(2, "", [
        await blobPut("shown", 1, shown),
        versionOp("shown", 1),
        await blobPut("also-shown", 1, alsoShown),
        versionOp("also-shown", 1),
        await blobPut("hidden", 1, hidden),
        versionOp("hidden", 1),
      ]);
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(
      storage.prefetched.flat().sort(),
      [...hashesOf(shown), ...hashesOf(alsoShown)].sort(),
    );
  });
});
