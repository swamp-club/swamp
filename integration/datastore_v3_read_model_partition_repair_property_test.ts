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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import {
  dataVersionOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import { ObservedDropRefusedError } from "../src/domain/datastore_v3/commit_store.ts";
import { catalogNamesOfCommit } from "../src/domain/datastore_v3/name_history_replay.ts";
import {
  metadata,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  CATALOG_V3_FILE,
  type PartitionRepairScope,
  READ_MODEL_STATE_FILE,
  SqliteReadModel,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { V3Catalog } from "../src/infrastructure/datastore_v3/v3_catalog.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  base64Of,
  commitOf,
  readCatalog,
  readStateTables,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const IDS = [
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
] as const;
const NAMES = ["a", "b", "c"] as const;

const FOLLOWER = { follower: true };

function partitionOfModel(id: string): PartitionKey {
  return partitionOf({ kind: "model", type: MODEL_TYPE, id });
}

function keyOf(
  id: string,
  name: string,
  version: number,
  file = "raw",
): RecordKey {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${id}/${name}/${version}/${file}`,
  );
}

function intentOf(id: string, kind: string, name: string, version: number) {
  return createIntent({ kind, name, version, model: modelRef(MODEL_TYPE, id) });
}

function putOf(
  id: string,
  name: string,
  version: number,
  text: string,
  key = keyOf(id, name, version),
): Promise<Op> {
  return putOp({
    intent: intentOf(id, "data.save", name, version),
    key,
    inline: base64Of(new TextEncoder().encode(text)),
  });
}

function versionOf(id: string, name: string, version: number): Op {
  return dataVersionOp({
    key: keyOf(id, name, version, "metadata.yaml"),
    metadata: metadata(name, version),
  });
}

interface Action {
  readonly p: number;
  readonly kind: "save" | "delete" | "rewrite";
  readonly name: number;
  readonly pick: number;
  readonly text: string;
}

const arbAction: fc.Arbitrary<Action> = fc.record({
  p: fc.nat(3),
  kind: fc.constantFrom("save", "save", "delete", "rewrite"),
  name: fc.nat(NAMES.length - 1),
  pick: fc.nat(9),
  text: fc.constantFrom("x", "y", "z"),
});

/** the ops an action makes against the partition's live versions, if any */
async function opsOf(
  store: SqliteCommitStore,
  id: string,
  action: Action,
): Promise<Op[] | undefined> {
  const name = NAMES[action.name];
  const held = (await store.partitionState("", partitionOfModel(id)))
    .snapshot().names.find((entry) => entry.name === name);
  if (action.kind === "save") {
    const version = (held?.highWater ?? 0) + 1;
    return [
      await putOf(id, name, version, `${name}@${version} ${action.text}`),
      versionOf(id, name, version),
    ];
  }
  const live = held?.live ?? [];
  if (live.length === 0) return undefined;
  const version = live[action.pick % live.length];
  if (action.kind === "delete") {
    return [
      tombstoneOp({
        intent: intentOf(id, "data.delete", name, version),
        key: keyOf(id, name, version),
      }),
    ];
  }
  return [await putOf(id, name, version, `${name}@${version} ${action.text}`)];
}

async function land(
  store: SqliteCommitStore,
  id: string,
  ops: readonly Op[],
): Promise<boolean> {
  const partition = partitionOfModel(id);
  const seq = (await store.head("", partition)).seq + 1;
  try {
    await store.append(commitOf({ seq, partition, namespace: "", ops }));
    return true;
  } catch (error) {
    if (!(error instanceof CommitRejectedError)) throw error;
    return false;
  }
}

async function landAction(
  store: SqliteCommitStore,
  id: string,
  action: Action,
): Promise<void> {
  const ops = await opsOf(store, id, action);
  if (ops !== undefined) await land(store, id, ops);
}

/** what the commits a repair drops from `fromSeq` touched, as serve's note keeps it */
async function scopeOf(
  store: SqliteCommitStore,
  partition: PartitionKey,
  fromSeq: number,
): Promise<PartitionRepairScope> {
  const changes = await store.readPartition("", partition, fromSeq, 10_000);
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const { commit } of changes) {
    for (const op of commit.ops) {
      if (op.kind === "put" || op.kind === "tombstone") {
        keys.add(op.key.toString());
      }
    }
    for (const name of catalogNamesOfCommit(commit)) names.add(name);
  }
  return {
    keys: [...keys].sort(),
    names: [...names].sort(),
    minCursor: Math.min(...changes.map((change) => change.cursor)),
  };
}

const signal = () => AbortSignal.timeout(60_000);

async function repair(
  readModel: SqliteReadModel,
  partition: PartitionKey,
  keep: number,
  scope: PartitionRepairScope,
): Promise<{ path: unknown; fallback: unknown }> {
  let found: { path: unknown; fallback: unknown } = {
    path: undefined,
    fallback: undefined,
  };
  await withCapturedSpans(async (spans) => {
    await readModel.repairPartition("", partition, keep, scope, {
      since: 0,
      admits: () => true,
      signal: signal(),
    });
    const span = findSpan(
      spans,
      "swamp.datastore.v3.readmodel.repair_partition",
    );
    found = {
      path: span.attributes[
        "swamp.datastore.v3.readmodel.repair_partition.path"
      ],
      fallback: span.attributes[
        "swamp.datastore.v3.readmodel.repair_partition.fallback"
      ],
    };
  });
  return found;
}

/**
 * the repaired read model equals a fresh one of the same store: every derived
 * table, the catalog and, once both hydrate what they owe, the file tree; a
 * file the repair put back is written where a fresh one may still owe it
 */
async function assertMatchesFresh(
  env: V3Env,
  readModel: SqliteReadModel,
  lazy: boolean,
): Promise<void> {
  const freshRepo = join(env.dir, `fresh-${crypto.randomUUID()}`);
  const fresh = SqliteReadModel.open({
    commitStore: env.store,
    chunkStore: env.chunkStore,
    cacheRoot: (ns) =>
      ns === "" ? swampPath(freshRepo) : swampPath(freshRepo, ns),
    stateDir: readModelStateDir(freshRepo),
    follower: true,
    lazyModelFiles: lazy,
  });
  try {
    await fresh.catchUp(signal());
    const repaired = comparable(readStateTables(env.stateDir));
    const expected = comparable(
      readStateTables(readModelStateDir(freshRepo)),
    );
    const owedByFresh = new Set(
      expected.owed_files.map((row) => JSON.stringify(row)),
    );
    for (const row of repaired.owed_files) {
      assert(
        owedByFresh.has(JSON.stringify(row)),
        `owed only by the repaired read model: ${JSON.stringify(row)}`,
      );
    }
    const { owed_files: _a, ...repairedRest } = repaired;
    const { owed_files: _b, ...expectedRest } = expected;
    assertEquals(repairedRest, expectedRest);
    assertEquals(
      readCatalog(join(env.stateDir, CATALOG_V3_FILE)),
      readCatalog(join(readModelStateDir(freshRepo), CATALOG_V3_FILE)),
    );
    await readModel.drainOwed(60_000, signal());
    await fresh.drainOwed(60_000, signal());
    assertEquals(
      await readTree(env.cacheRoot("")),
      await readTree(swampPath(freshRepo)),
    );
  } finally {
    await fresh.close();
  }
}

/**
 * a record a commit applied names its writer empty where one loaded from the
 * compacted base names none, whichever read model holds it
 */
function comparable(
  tables: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  return {
    ...tables,
    live_records: tables.live_records.map((row) => ({
      ...row,
      writer: row.writer ?? "",
    })),
  };
}

interface Case {
  readonly partitions: number;
  readonly history: readonly Action[];
  readonly target: number;
  readonly tail: number;
  readonly alternative: readonly Action[];
  readonly after: readonly Action[];
  readonly compact: "none" | "before" | "after";
  readonly compactPick: number;
  readonly lazy: boolean;
}

async function compactBelow(
  store: SqliteCommitStore,
  partition: PartitionKey,
  fromSeq: number,
  pick: number,
): Promise<void> {
  const changes = await store.changesSince(0, 10_000);
  const first = changes.find((change) =>
    change.commit.partition.equals(partition) && change.commit.seq === fromSeq
  );
  if (first === undefined) return;
  const below = changes.filter((change) => change.cursor < first.cursor);
  if (below.length === 0) return;
  await store.compactHistory(below[pick % below.length].cursor);
}

async function runCase(c: Case): Promise<void> {
  await withV3Env(async (env) => {
    const ids = IDS.slice(0, c.partitions);
    for (const action of c.history) {
      await landAction(env.store, ids[action.p % ids.length], action);
    }
    const id = ids[c.target % ids.length];
    const partition = partitionOfModel(id);
    const head = (await env.store.head("", partition)).seq;
    if (head === 0) return;
    const fromSeq = head - Math.min(c.tail, head) + 1;
    const readModel = env.openReadModel({
      ...FOLLOWER,
      lazyModelFiles: c.lazy,
    });
    try {
      if (c.compact === "before") {
        await compactBelow(env.store, partition, fromSeq, c.compactPick);
      }
      await readModel.catchUp(signal());
      if (c.compact === "after") {
        await compactBelow(env.store, partition, fromSeq, c.compactPick);
      }
      const scope = await scopeOf(env.store, partition, fromSeq);
      try {
        await env.store.dropObservedFrom("", partition, fromSeq);
      } catch (error) {
        if (error instanceof ObservedDropRefusedError) return;
        throw error;
      }
      const repaired = await repair(readModel, partition, fromSeq - 1, scope);
      assertEquals(repaired, { path: "targeted", fallback: undefined });
      // serve's lineage: another tail of the partition, then other work
      for (const action of c.alternative) {
        await landAction(env.store, id, action);
      }
      for (const action of c.after) {
        await landAction(env.store, ids[action.p % ids.length], action);
      }
      await readModel.catchUp(signal());
      await assertMatchesFresh(env, readModel, c.lazy);
    } finally {
      await readModel.close();
    }
  }, FOLLOWER);
}

Deno.test("SqliteReadModel.repairPartition: rolling one partition back and catching up equals a fresh read model of the store (swamp-club#5127)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        partitions: fc.integer({ min: 2, max: 4 }),
        history: fc.array(arbAction, { minLength: 2, maxLength: 16 }),
        target: fc.nat(3),
        tail: fc.integer({ min: 1, max: 3 }),
        alternative: fc.array(arbAction, { maxLength: 3 }),
        after: fc.array(arbAction, { maxLength: 3 }),
        compact: fc.constantFrom(
          "none" as const,
          "before" as const,
          "after" as const,
        ),
        compactPick: fc.nat(20),
        lazy: fc.boolean(),
      }),
      (c) => runCase(c),
    ),
    { numRuns: 40 },
  );
});

const save = (name: number, text = "x"): Action => ({
  p: 0,
  kind: "save",
  name,
  pick: 0,
  text,
});
const del = (name: number): Action => ({
  p: 0,
  kind: "delete",
  name,
  pick: 0,
  text: "x",
});
const rewrite = (name: number, text: string): Action => ({
  p: 0,
  kind: "rewrite",
  name,
  pick: 0,
  text,
});

Deno.test("SqliteReadModel.repairPartition: seeded cases equal a fresh read model: a tombstone, a version bump and an owed file dropped, and a partition compacted below its kept head (swamp-club#5127)", async () => {
  const cases: Case[] = [
    {
      partitions: 2,
      history: [save(0), save(1), { ...save(0), p: 1 }, del(0), save(1)],
      target: 0,
      tail: 2,
      alternative: [save(2)],
      after: [{ ...save(1), p: 1 }],
      compact: "none",
      compactPick: 0,
      lazy: true,
    },
    {
      partitions: 2,
      history: [
        save(0),
        save(1),
        del(1),
        { ...save(0), p: 1 },
        rewrite(0, "y"),
      ],
      target: 0,
      tail: 1,
      alternative: [],
      after: [],
      compact: "before",
      compactPick: 20,
      lazy: false,
    },
    {
      partitions: 3,
      history: [save(0), { ...save(0), p: 1 }, save(0), del(0), save(2)],
      target: 0,
      tail: 2,
      alternative: [save(1), del(1)],
      after: [{ ...save(2), p: 2 }],
      compact: "after",
      compactPick: 1,
      lazy: true,
    },
  ];
  for (const c of cases) await runCase(c);
});

Deno.test("SqliteReadModel.repairPartition: a key another partition holds live, or a config partition, takes the full rebuild and still equals a fresh read model (swamp-club#5127)", async () => {
  await withV3Env(async (env) => {
    const [p, q] = IDS;
    const partition = partitionOfModel(p);
    await land(env.store, p, [
      await putOf(p, "a", 1, "mine"),
      versionOf(p, "a", 1),
    ]);
    // another aggregate's commit writes a key of this partition's layout
    await land(env.store, q, [
      await putOf(q, "a", 2, "theirs", keyOf(p, "a", 2)),
    ]);
    await land(env.store, p, [
      await putOf(p, "a", 2, "mine 2"),
      versionOf(p, "a", 2),
    ]);
    const readModel = env.openReadModel(FOLLOWER);
    try {
      await readModel.catchUp(signal());
      const scope = await scopeOf(env.store, partition, 2);
      await env.store.dropObservedFrom("", partition, 2);
      assertEquals(await repair(readModel, partition, 1, scope), {
        path: "full",
        fallback: "shared_key",
      });
      await readModel.catchUp(signal());
      await assertMatchesFresh(env, readModel, false);
    } finally {
      await readModel.close();
    }
  }, FOLLOWER);
  await withV3Env(async (env) => {
    const partition = partitionOf({
      kind: "config",
      definitionKind: "model",
      name: "web",
    });
    const definition = { kind: "model" as const, name: "web" };
    const key = RecordKey.create(
      "config/models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
    );
    for (const [seq, text] of [[1, "one"], [2, "two"]] as const) {
      await env.store.append(commitOf({
        seq,
        partition,
        namespace: "",
        ops: [
          await putOp({
            intent: { kind: "definition.edit", definition },
            key,
            inline: base64Of(new TextEncoder().encode(text)),
          }),
        ],
      }));
    }
    const readModel = env.openReadModel(FOLLOWER);
    try {
      await readModel.catchUp(signal());
      const changes = await env.store.readPartition("", partition, 2, 10);
      await env.store.dropObservedFrom("", partition, 2);
      assertEquals(
        await repair(readModel, partition, 1, {
          keys: [key.toString()],
          names: [],
          minCursor: changes[0].cursor,
        }),
        { path: "full", fallback: "partition_kind" },
      );
      await readModel.catchUp(signal());
      await assertMatchesFresh(env, readModel, false);
    } finally {
      await readModel.close();
    }
  }, FOLLOWER);
});

Deno.test("SqliteReadModel.repairPartition: a repair cut short once the state rolled back is rebuilt whole by the next, and equals a fresh read model (swamp-club#5127)", async () => {
  await withV3Env(async (env) => {
    const [p, q] = IDS;
    const partition = partitionOfModel(p);
    await landAction(env.store, p, save(0));
    await landAction(env.store, q, { ...save(1), p: 1 });
    await landAction(env.store, p, save(0, "y"));
    await landAction(env.store, p, save(1));
    const controller = new AbortController();
    let cut = true;
    const inner = V3Catalog.open(join(env.stateDir, CATALOG_V3_FILE));
    const catalog = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "apply") {
          return (...args: Parameters<V3Catalog["apply"]>) => {
            // the process dies between the state's rollback and the catalog's
            if (cut && args[1].equals(partition) && args[2].length > 0) {
              const state = new DatabaseSync(
                join(env.stateDir, READ_MODEL_STATE_FILE),
                { readOnly: true },
              );
              const marked = state.prepare(
                "SELECT 1 FROM meta WHERE key = 'partition_repair'",
              ).get() !== undefined;
              state.close();
              if (marked) {
                controller.abort(new Error("power cut"));
                throw new Error("power cut");
              }
            }
            return target.apply(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const readModel = env.openReadModel({ ...FOLLOWER, catalog });
    try {
      await readModel.catchUp(signal());
      const scope = await scopeOf(env.store, partition, 2);
      await env.store.dropObservedFrom("", partition, 2);
      await assertRejects(
        () =>
          readModel.repairPartition("", partition, 1, scope, {
            since: 0,
            admits: () => true,
            signal: controller.signal,
          }),
        Error,
        "power cut",
      );
      cut = false;
      assertEquals(await repair(readModel, partition, 1, scope), {
        path: "full",
        fallback: "state_reset",
      });
      await landAction(env.store, p, save(2));
      await readModel.catchUp(signal());
      await assertMatchesFresh(env, readModel, false);
    } finally {
      await readModel.close();
    }
  }, FOLLOWER);
});
