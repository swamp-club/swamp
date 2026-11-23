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

// shaped like a datastore with few models and thousands of live versions per name

import { join } from "@std/path";
import { walk } from "@std/fs";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { DataMetadataSchema } from "../src/domain/data/data_metadata.ts";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import { dataVersionOp, type Op, putOp } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  metadata,
  MODEL_TYPE,
  modelCommit,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  CATALOG_V3_FILE,
  SqliteReadModel,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { catalogRow } from "../src/infrastructure/datastore_v3/v3_catalog.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";

// SCALE shrinks the dataset for a quick run
const SCALE = Number(Deno.env.get("SCALE") ?? "1");
const NAMES_PER_MODEL = [4, 4, 4, 5];
const VERSIONS = Math.round(4_300 * SCALE);
const AFTER_COMPACTION = Math.round(1_850 * SCALE);

const dir = await Deno.makeTempDir({ prefix: "swamp-reproject-bench-" });
const ids = NAMES_PER_MODEL.map((_, i) =>
  `6f1c2a3b-4d5e-4f60-8a7b-${String(i).padStart(12, "0")}`
);

async function saveOps(id: string, name: string, version: number): Promise<Op[]> {
  const prefix = `data/${MODEL_TYPE.normalized}/${id}/${name}`;
  const intent = createIntent({
    kind: "data.save",
    name,
    version,
    model: modelRef(MODEL_TYPE, id),
  });
  return [
    await putOp({
      intent,
      key: RecordKey.create(`${prefix}/${version}/raw`),
      inline: base64(`${name}@${version}`),
    }),
    dataVersionOp({
      key: RecordKey.create(`${prefix}/${version}/metadata.yaml`),
      metadata: metadata(name, version),
    }),
    await putOp({
      intent,
      key: RecordKey.create(`${prefix}/latest`),
      inline: base64(String(version)),
    }),
  ];
}

const storePath = join(dir, "commits.db");
const repoDir = join(dir, "repo");
const stateDir = readModelStateDir(repoDir);
const chunkStore = new ChunkStore(new FileSystemStorage(join(dir, "datastore")));

function openReadModel(store: SqliteCommitStore, clock?: () => Date) {
  return SqliteReadModel.open({
    commitStore: store,
    chunkStore,
    cacheRoot: (namespace) =>
      namespace === "" ? swampPath(repoDir) : swampPath(repoDir, namespace),
    stateDir,
    targetedShare: 1,
    ...(clock === undefined ? {} : { clock }),
  } as Parameters<typeof SqliteReadModel.open>[0]);
}

let started = performance.now();
{
  // each commit is one run of a model, writing a version of each of its names
  const store = SqliteCommitStore.open(storePath);
  try {
    for (let v = 1; v <= VERSIONS; v++) {
      for (const [m, id] of ids.entries()) {
        const ops: Op[] = [];
        for (let n = 0; n < NAMES_PER_MODEL[m]; n++) {
          ops.push(...await saveOps(id, `name${n}`, v));
        }
        await store.append(
          modelCommit(v, ops, {
            partition: partitionOf({ kind: "model", type: MODEL_TYPE, id }),
            txnId: `bench-${m}-${v}`,
          }),
        );
      }
      if (v === VERSIONS - AFTER_COMPACTION) {
        await store.compactHistory(Number.MAX_SAFE_INTEGER);
      }
    }
  } finally {
    await store.close();
  }
  const caughtUp = SqliteCommitStore.open(storePath);
  const readModel = openReadModel(caughtUp, () => new Date(1_000));
  try {
    await readModel.catchUp(AbortSignal.timeout(3_600_000));
  } finally {
    await readModel.close();
    await caughtUp.close();
  }
  const old = new Date(Date.now() - 3_600_000);
  for await (const entry of walk(swampPath(repoDir), { includeFiles: true })) {
    if (entry.isFile) await Deno.utime(entry.path, old, old);
  }
}
console.log(
  `built ${ids.length} models x ${VERSIONS} versions (${AFTER_COMPACTION} after compaction) in ${
    Math.round(performance.now() - started)
  } ms`,
);

// a dead writer's uncommitted row on every name
const writer = new CatalogStore(join(stateDir, CATALOG_V3_FILE));
try {
  for (const [m, id] of ids.entries()) {
    for (let n = 0; n < NAMES_PER_MODEL[m]; n++) {
      writer.upsertNewVersion(
        catalogRow(
          "",
          MODEL_TYPE.normalized,
          id,
          DataMetadataSchema.parse(metadata(`name${n}`, VERSIONS + 1)),
        ),
      );
    }
  }
} finally {
  writer.close();
}

const store = SqliteCommitStore.open(storePath);
const readModel = openReadModel(store);
try {
  await withCapturedSpans(async (spans) => {
    started = performance.now();
    await readModel.recover("", {
      since: Date.now() - 1_000,
      admits: () => true,
      signal: AbortSignal.timeout(3_600_000),
      entry: "interrupted_writer",
      targeted: true,
    } as Parameters<SqliteReadModel["recover"]>[1]);
    const total = Math.round(performance.now() - started);
    const report: Record<string, unknown> = { total_ms: total };
    for (const span of spans) {
      if (!span.name.startsWith("swamp.datastore.v3.readmodel.recover")) {
        continue;
      }
      const [s, ns] = span.duration;
      report[span.name.replace("swamp.datastore.v3.readmodel.", "")] = {
        ms: Math.round(s * 1000 + ns / 1e6),
        ...Object.fromEntries(
          Object.entries(span.attributes).filter(([k]) =>
            /reproject\.|path|history_commits|touched_names|fallback/.test(k)
          ).map(([k, v]) => [k.split(".").slice(-2).join("."), v]),
        ),
      };
    }
    console.log(JSON.stringify(report, null, 2));
  });
} finally {
  await readModel.close();
  await store.close();
  await Deno.remove(dir, { recursive: true });
}
