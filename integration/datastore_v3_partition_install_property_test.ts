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
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import {
  dataVersionOp,
  leaseOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  commitOf,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITIONS = {
  a: partitionOf({ kind: "model", type: MODEL_TYPE, id: MODEL_ID }),
  x: partitionOf({ kind: "config", definitionKind: "model", name: "x" }),
  // lease ops only: no files, but while uninstalled it holds the copy's point
  z: partitionOf({
    kind: "model",
    type: MODEL_TYPE,
    id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
  }),
} as const;
type PartitionName = keyof typeof PARTITIONS;

const arbModelOp = fc.record({
  kind: fc.constantFrom("save", "version", "delete", "marker"),
  name: fc.constantFrom("n", "m"),
  version: fc.integer({ min: 1, max: 3 }),
  content: fc.integer({ min: 0, max: 2 }),
});

const arbDefinitionOp = fc.record({
  key: fc.integer({ min: 0, max: 1 }),
  text: fc.option(fc.constantFrom("p", "q"), { nil: undefined }),
});

const arbStep = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      partition: fc.constant("a" as const),
      ops: fc.array(arbModelOp, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("define" as const),
      ops: fc.array(arbDefinitionOp, { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("lease" as const) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("catchUp" as const) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("compact" as const),
      fraction: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("install" as const),
      difference: fc.boolean(),
      installZ: fc.boolean(),
    }),
  },
);

const DEFINITION_KEYS = [
  "models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
  "models/aws/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yaml",
] as const;

async function modelOp(
  spec: typeof arbModelOp extends fc.Arbitrary<infer T> ? T : never,
): Promise<Op> {
  const intent = (fields: Record<string, unknown>) =>
    createIntent({ ...fields, model: modelRef(MODEL_TYPE, MODEL_ID) });
  const base =
    `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${spec.name}/${spec.version}`;
  switch (spec.kind) {
    case "save":
      return await putOp({
        intent: intent({
          kind: "data.save",
          name: spec.name,
          version: spec.version,
        }),
        key: RecordKey.create(`${base}/raw`),
        inline: base64(`${spec.name}@${spec.version}#${spec.content}`),
      });
    case "version":
      return dataVersionOp({
        key: RecordKey.create(`${base}/metadata.yaml`),
        metadata: metadata(spec.name, spec.version),
      });
    case "marker":
      return dataVersionOp({
        key: RecordKey.create(`${base}/metadata.yaml`),
        metadata: {
          ...(metadata(spec.name, spec.version) as Record<string, unknown>),
          lifecycle: "deleted",
          renamedTo: spec.name === "n" ? "m" : "n",
        },
      });
    default:
      return tombstoneOp({
        intent: intent({
          kind: "data.delete",
          name: spec.name,
          version: spec.version,
        }),
        key: RecordKey.create(`${base}/raw`),
      });
  }
}

async function definitionOp(
  spec: typeof arbDefinitionOp extends fc.Arbitrary<infer T> ? T : never,
): Promise<Op> {
  const key = RecordKey.create(`definitions/${DEFINITION_KEYS[spec.key]}`);
  const definition = { kind: "model" as const, name: "x" };
  return spec.text === undefined
    ? tombstoneOp({ intent: { kind: "definition.delete", definition }, key })
    : await putOp({
      intent: { kind: "definition.edit", definition },
      key,
      inline: base64(`x:${spec.text}`),
    });
}

interface View {
  readonly readModel: SqliteReadModel;
  readonly root: string;
  readonly stateDir: string;
}

function openView(
  env: V3Env,
  name: string,
  commitStore: SqliteCommitStore,
): View {
  const repoDir = join(env.dir, name);
  const root = swampPath(repoDir);
  const stateDir = readModelStateDir(repoDir);
  return {
    readModel: env.openReadModel({
      commitStore,
      cacheRoot: (ns) => ns === "" ? root : join(root, ns),
      stateDir,
      pageSize: 3,
    }),
    root,
    stateDir,
  };
}

/** what a reader sees; ownership without its mark, which a copy rebases */
async function observe(view: View): Promise<unknown> {
  const db = new DatabaseSync(join(view.stateDir, "_read_model_v3.db"), {
    readOnly: true,
  });
  let versions, ownership;
  try {
    versions = db.prepare(
      "SELECT namespace, partition, name, version, metadata FROM data_versions ORDER BY 1, 2, 3, 4",
    ).all();
    ownership = db.prepare(
      "SELECT namespace, record_key, owner, present FROM materialised_keys ORDER BY 1, 2",
    ).all();
  } finally {
    db.close();
  }
  const index: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(PARTITIONS)) {
    index[name] = (await view.readModel.liveRecords("", key)).map((r) => ({
      key: r.key.toString(),
      sha256: r.sha256,
    }));
  }
  return {
    files: Object.fromEntries(await readTree(view.root)),
    catalog: readCatalog(join(view.stateDir, "_catalog_v3.db")),
    index,
    versions,
    ownership,
  };
}

async function install(
  serve: SqliteCommitStore,
  copy: SqliteCommitStore,
  live: View,
  difference: boolean,
  installZ: boolean,
): Promise<void> {
  const positions = await copy.basePositions("");
  for (const entry of await serve.readBaseIndex("")) {
    if (!installZ && entry.partition === PARTITIONS.z.toString()) continue;
    const local = positions.get(entry.partition);
    const since = difference && local?.source !== undefined &&
        local.source === local.compacted
      ? local.source
      : undefined;
    const read = await serve.readBaseOfPartition(
      "",
      entry.partition,
      since,
      100_000,
    );
    if (typeof read === "string") continue;
    await copy.installPartitionBase({
      namespace: "",
      partition: entry.partition,
      seq: read.seq,
      entries: read.entries.filter((e) => e.kind !== "partition").map((e) =>
        e as never
      ),
      removed: read.removed,
      mode: since === undefined ? "whole" : "difference",
      readModelCursor: live.readModel.cursor(),
    });
  }
}

Deno.test("base install by partition: a copy that installs serve's base reads what serve reads, live and rebuilt from scratch", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbStep, { minLength: 8, maxLength: 30 }),
      async (steps) => {
        await withV3Env(async (env) => {
          const signal = () => AbortSignal.timeout(30_000);
          const copy = SqliteCommitStore.open(join(env.dir, "copy.db"), {
            follower: true,
            snapshotInterval: 3,
          });
          const seqs = new Map<PartitionName, number>();
          const live = openView(env, "live", copy);
          const replay = openView(env, "replay", env.store);
          try {
            for (
              const step of [
                ...steps,
                { kind: "catchUp" as const },
                { kind: "compact" as const, fraction: 1 },
                { kind: "install" as const, difference: true, installZ: true },
              ]
            ) {
              if (
                step.kind === "commit" || step.kind === "define" ||
                step.kind === "lease"
              ) {
                const name: PartitionName = step.kind === "commit"
                  ? "a"
                  : step.kind === "define"
                  ? "x"
                  : "z";
                const ops: Op[] = [];
                if (step.kind === "lease") {
                  ops.push(leaseOp({ holder: "serve", fence: 1 }));
                }
                for (const spec of step.kind === "lease" ? [] : step.ops) {
                  ops.push(
                    step.kind === "commit"
                      ? await modelOp(spec as never)
                      : await definitionOp(spec as never),
                  );
                }
                const seq = (seqs.get(name) ?? 0) + 1;
                const commit = commitOf({
                  seq,
                  partition: PARTITIONS[name],
                  namespace: "",
                  ops,
                });
                try {
                  await env.store.append(commit);
                } catch (error) {
                  if (!(error instanceof CommitRejectedError)) throw error;
                  continue;
                }
                await copy.append(commit);
                seqs.set(name, seq);
              } else if (step.kind === "catchUp") {
                await live.readModel.catchUp(signal());
              } else if (step.kind === "compact") {
                // the reference reads the whole log before serve folds it
                const last = (await replay.readModel.catchUp(signal())).cursor;
                const point = await env.store.compactionPoint();
                await env.store.compactHistory(
                  point + Math.ceil(step.fraction * (last - point)),
                );
              } else {
                await install(
                  env.store,
                  copy,
                  live,
                  step.difference,
                  step.installZ,
                );
              }
            }
            await live.readModel.catchUp(signal());
            await replay.readModel.catchUp(signal());
            const expected = await observe(replay);
            assertEquals(await observe(live), expected);
            const fresh = openView(env, "fresh", copy);
            try {
              await fresh.readModel.catchUp(signal());
              assertEquals(await observe(fresh), expected);
            } finally {
              await fresh.readModel.close();
            }
          } finally {
            await live.readModel.close();
            await replay.readModel.close();
            await copy.close();
          }
        });
      },
    ),
    { numRuns: 60 },
  );
});

Deno.test("base install by partition: a read model behind the install point still reads every commit, since nothing it has not applied is folded", async () => {
  await withV3Env(async (env) => {
    const signal = () => AbortSignal.timeout(30_000);
    const copy = SqliteCommitStore.open(join(env.dir, "copy.db"), {
      follower: true,
      snapshotInterval: 3,
    });
    const live = openView(env, "live", copy);
    const replay = openView(env, "replay", env.store);
    try {
      const append = async (commit: ReturnType<typeof commitOf>) => {
        await env.store.append(commit);
        await copy.append(commit);
      };
      // z holds the copy's point at its own commit once the read model passed it
      await append(
        commitOf({
          seq: 1,
          partition: PARTITIONS.z,
          namespace: "",
          ops: [leaseOp({ holder: "serve", fence: 1 })],
        }),
      );
      await live.readModel.catchUp(signal());
      for (let seq = 1; seq <= 4; seq++) {
        await append(
          commitOf({
            seq,
            partition: PARTITIONS.a,
            namespace: "",
            ops: [
              await modelOp({
                kind: "save",
                name: "n",
                version: seq,
                content: 0,
              }),
              await modelOp({
                kind: "version",
                name: "n",
                version: seq,
                content: 0,
              }),
            ],
          }),
        );
      }
      await replay.readModel.catchUp(signal());
      await env.store.compactHistory(await env.store.compactionPoint() + 5);
      await install(env.store, copy, live, false, false);
      await live.readModel.catchUp(signal());
      assertEquals(await observe(live), await observe(replay));
    } finally {
      await live.readModel.close();
      await replay.readModel.close();
      await copy.close();
    }
  });
});
