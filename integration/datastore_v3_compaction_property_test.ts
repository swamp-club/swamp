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
 * Property test of history compaction (swamp-club#3258): for random
 * histories over several partitions and namespaces (saves inline and as
 * chunks, deletes, gc, expiry, renames, file and directory conflicts, and a
 * key two partitions write), compacted at random points between random
 * catch-ups, a checkout that catches up through compactions and a fresh
 * checkout end with the same files, catalog, index, chunks in use and live
 * versions as a reference that replayed every commit before it was
 * compacted.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import type { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import {
  dataVersionOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  commitOf,
  readCatalog,
  readTree,
  TEST_CHUNK_BYTES,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const OTHER_MODEL_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

/** The partitions a history writes, with their namespaces. */
const PARTITIONS = {
  a: {
    namespace: "",
    key: partitionOf({ kind: "model", type: MODEL_TYPE, id: MODEL_ID }),
    model: MODEL_ID,
  },
  b: {
    namespace: "acme",
    key: partitionOf({ kind: "model", type: MODEL_TYPE, id: OTHER_MODEL_ID }),
    model: OTHER_MODEL_ID,
  },
  x: {
    namespace: "",
    key: partitionOf({ kind: "config", definitionKind: "model", name: "x" }),
    model: undefined,
  },
  y: {
    namespace: "",
    key: partitionOf({ kind: "config", definitionKind: "model", name: "y" }),
    model: undefined,
  },
} as const;
type PartitionName = keyof typeof PARTITIONS;

const NAMES = ["n", "m"] as const;
const arbName = fc.constantFrom(...NAMES);
const arbVersion = fc.integer({ min: 1, max: 2 });

const arbModelOp = fc.oneof(
  fc.record({
    kind: fc.constant("save" as const),
    name: arbName,
    version: arbVersion,
    content: fc.integer({ min: 0, max: 2 }),
    blob: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("version" as const),
    name: arbName,
    version: arbVersion,
  }),
  fc.record({
    kind: fc.constant("marker" as const),
    name: arbName,
    version: arbVersion,
  }),
  fc.record({
    kind: fc.constantFrom("delete" as const, "gc" as const),
    name: arbName,
    version: arbVersion,
  }),
  fc.record({ kind: fc.constant("expire" as const), name: arbName }),
  fc.record({
    kind: fc.constant("conflict" as const),
    at: fc.constantFrom("file", "under", "remove"),
  }),
);
type ModelOpSpec = typeof arbModelOp extends fc.Arbitrary<infer T> ? T
  : never;

const arbDefinitionOp = fc.record({
  kind: fc.constant("definition" as const),
  key: fc.integer({ min: 0, max: 1 }),
  text: fc.option(fc.constantFrom("p", "q"), { nil: undefined }),
});
type DefinitionOpSpec = typeof arbDefinitionOp extends fc.Arbitrary<infer T> ? T
  : never;

/** Compacts through a point between the current one and the last commit. */
const arbCompact = fc.record({
  kind: fc.constant("compact" as const),
  fraction: fc.double({ min: 0, max: 1, noNaN: true }),
  batchSize: fc.integer({ min: 1, max: 4 }),
});

const arbStep = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      partition: fc.constantFrom("a" as const, "b" as const),
      ops: fc.array(arbModelOp, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      partition: fc.constantFrom("x" as const, "y" as const),
      ops: fc.array(arbDefinitionOp, { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("catchUp" as const) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("catchUpPartition" as const),
      partition: fc.constantFrom("a" as const, "b" as const, "x" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("compact" as const),
      fraction: fc.double({ min: 0, max: 1, noNaN: true }),
      batchSize: fc.integer({ min: 1, max: 4 }),
    }),
  },
);

const DEFINITION_KEYS = [
  "models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
  "models/aws/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yaml",
] as const;

function keyOf(model: string, name: string, version: number): RecordKey {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${model}/${name}/${version}/raw`,
  );
}

function versionKey(model: string, name: string, version: number): RecordKey {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${model}/${name}/${version}/metadata.yaml`,
  );
}

async function buildModelOp(
  model: string,
  spec: ModelOpSpec,
  blobs: readonly BlobRef[],
): Promise<Op> {
  const intent = (fields: Record<string, unknown>) =>
    createIntent({ ...fields, model: modelRef(MODEL_TYPE, model) });
  switch (spec.kind) {
    case "save": {
      const fields = {
        intent: intent({
          kind: "data.save",
          name: spec.name,
          version: spec.version,
        }),
        key: keyOf(model, spec.name, spec.version),
      };
      return spec.blob
        ? await putOp({ ...fields, blob: blobs[spec.content] })
        : await putOp({
          ...fields,
          inline: base64(`${spec.name}@${spec.version}#${spec.content}`),
        });
    }
    case "version":
      return dataVersionOp({
        key: versionKey(model, spec.name, spec.version),
        metadata: metadata(spec.name, spec.version),
      });
    case "marker":
      return dataVersionOp({
        key: versionKey(model, spec.name, spec.version),
        metadata: {
          ...(metadata(spec.name, spec.version) as Record<string, unknown>),
          lifecycle: "deleted",
          renamedTo: spec.name === "n" ? "m" : "n",
        },
      });
    case "delete":
    case "gc":
      return tombstoneOp({
        intent: intent({
          kind: spec.kind === "gc" ? "data.gc" : "data.delete",
          name: spec.name,
          version: spec.version,
        }),
        key: keyOf(model, spec.name, spec.version),
      });
    case "expire":
      return tombstoneOp({
        intent: intent({ kind: "data.gc", name: spec.name }),
        key: RecordKey.create(
          `data/${MODEL_TYPE.normalized}/${model}/${spec.name}/latest`,
        ),
      });
    case "conflict": {
      // `c` as a file, or `c/x` under it: the two claim one path.
      const base = `data/${MODEL_TYPE.normalized}/${model}/c`;
      const fields = {
        intent: intent({ kind: "data.save", name: "c", version: 1 }),
      };
      if (spec.at === "remove") {
        return tombstoneOp({ ...fields, key: RecordKey.create(base) });
      }
      return await putOp({
        ...fields,
        key: RecordKey.create(spec.at === "file" ? base : `${base}/x`),
        inline: base64(spec.at),
      });
    }
  }
}

async function buildDefinitionOp(
  name: string,
  spec: DefinitionOpSpec,
): Promise<Op> {
  const key = RecordKey.create(`definitions/${DEFINITION_KEYS[spec.key]}`);
  const definition = { kind: "model" as const, name };
  return spec.text === undefined
    ? tombstoneOp({ intent: { kind: "definition.delete", definition }, key })
    : await putOp({
      intent: { kind: "definition.edit", definition },
      key,
      inline: base64(`${name}:${spec.text}`),
    });
}

interface View {
  readonly readModel: SqliteReadModel;
  readonly root: string;
  readonly stateDir: string;
}

function openView(env: V3Env, name: string): View {
  const repoDir = join(env.dir, name);
  const root = swampPath(repoDir);
  const stateDir = readModelStateDir(repoDir);
  return {
    readModel: env.openReadModel({
      cacheRoot: (ns) => ns === "" ? root : join(root, ns),
      stateDir,
      pageSize: 3,
    }),
    root,
    stateDir,
  };
}

async function observe(view: View): Promise<unknown> {
  const db = new DatabaseSync(join(view.stateDir, "_read_model_v3.db"), {
    readOnly: true,
  });
  let versions, ownership, progress;
  try {
    versions = db.prepare(
      "SELECT namespace, partition, name, version, metadata FROM data_versions ORDER BY 1, 2, 3, 4",
    ).all();
    // Which put each file shows, so a fold that materialised a key a replay
    // skipped is caught even where the files agree.
    ownership = db.prepare(
      "SELECT namespace, record_key, owner, mark, present FROM materialised_keys ORDER BY 1, 2",
    ).all();
    progress = db.prepare(
      "SELECT namespace, partition, applied_seq FROM partition_progress ORDER BY 1, 2",
    ).all();
  } finally {
    db.close();
  }
  const index: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(PARTITIONS)) {
    index[name] = (await view.readModel.liveRecords(p.namespace, p.key)).map(
      (r) => ({
        key: r.key.toString(),
        sha256: r.sha256,
        content: r.content.kind === "blob"
          ? r.content.blob.toJSON()
          : r.content,
      }),
    );
  }
  return {
    files: Object.fromEntries(await readTree(view.root)),
    catalog: readCatalog(join(view.stateDir, "_catalog_v3.db")),
    index,
    chunks: {
      solo: [...await view.readModel.chunksInUse("")].sort(),
      acme: [...await view.readModel.chunksInUse("acme")].sort(),
    },
    versions,
    ownership,
    progress,
  };
}

function blobContent(seed: number): Uint8Array {
  return new Uint8Array(2 * TEST_CHUNK_BYTES + seed).map((_, i) =>
    (i * (seed + 3) + seed) % 251
  );
}

Deno.test("compaction: catching up through compactions ends where a full replay does", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbStep, { minLength: 8, maxLength: 30 }),
      arbCompact,
      async (steps, last) => {
        await withV3Env(async (env) => {
          const signal = () => AbortSignal.timeout(30_000);
          const blobs = {
            "": [] as BlobRef[],
            acme: [] as BlobRef[],
          };
          for (let seed = 0; seed < 3; seed++) {
            blobs[""].push(
              await env.chunkStore.write(
                SOLO_NAMESPACE,
                blobContent(seed),
                signal(),
              ),
            );
            blobs.acme.push(
              await env.chunkStore.write(
                restoreNamespace("acme"),
                blobContent(seed),
                signal(),
              ),
            );
          }
          const seqs = new Map<PartitionName, number>();
          const live = openView(env, "live");
          const reference = openView(env, "reference");
          try {
            // A final compaction, so nearly every history ends compacted.
            for (const step of [...steps, last]) {
              if (step.kind === "commit") {
                const p = PARTITIONS[step.partition];
                const ops: Op[] = [];
                for (const spec of step.ops) {
                  ops.push(
                    spec.kind === "definition"
                      ? await buildDefinitionOp(step.partition, spec)
                      : await buildModelOp(
                        p.model as string,
                        spec,
                        blobs[p.namespace as "" | "acme"],
                      ),
                  );
                }
                const seq = (seqs.get(step.partition) ?? 0) + 1;
                try {
                  await env.store.append(
                    commitOf({
                      seq,
                      partition: p.key as PartitionKey,
                      namespace: p.namespace,
                      ops,
                    }),
                  );
                  seqs.set(step.partition, seq);
                } catch (error) {
                  if (!(error instanceof CommitRejectedError)) throw error;
                }
              } else if (step.kind === "catchUp") {
                await live.readModel.catchUp(signal());
              } else if (step.kind === "catchUpPartition") {
                const p = PARTITIONS[step.partition];
                await live.readModel.catchUpPartition(
                  p.namespace,
                  p.key,
                  signal(),
                );
              } else {
                // The reference replays every commit before it is compacted.
                const last = (await reference.readModel.catchUp(signal()))
                  .cursor;
                const point = (await env.store.readCompactedBase(undefined, 1))
                  .point;
                await env.store.compactHistory(
                  point + Math.ceil(step.fraction * (last - point)),
                  { batchSize: step.batchSize },
                );
              }
            }
            await reference.readModel.catchUp(signal());
            await live.readModel.catchUp(signal());
            const expected = await observe(reference);
            assertEquals(await observe(live), expected);
            const fresh = openView(env, "fresh");
            try {
              await fresh.readModel.catchUp(signal());
              assertEquals(await observe(fresh), expected);
            } finally {
              await fresh.readModel.close();
            }
          } finally {
            await live.readModel.close();
            await reference.readModel.close();
          }
        });
      },
    ),
    { numRuns: 60 },
  );
});
