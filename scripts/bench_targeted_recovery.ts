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

import { join } from "@std/path";
import { walk } from "@std/fs";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { Data } from "../src/domain/data/data.ts";
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
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";

const dir = await Deno.makeTempDir({ prefix: "swamp-targeted-recovery-bench-" });
const tracks = "ensureDirtyTracking" in CatalogStore.prototype;


const SAVES = 40;

function dataNamed(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "bench" },
  });
}

function saveRepo(triggers: boolean) {
  const repoDir = join(dir, `save-${triggers ? "tracked" : "plain"}`);
  const catalog = new CatalogStore(join(repoDir, "catalog.db"));
  if (triggers) {
    (catalog as unknown as { ensureDirtyTracking(now: number): void })
      .ensureDirtyTracking(0);
  }
  const repo = new FileSystemUnifiedDataRepository(repoDir, undefined, catalog);
  return { repo, catalog };
}

const MODEL = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
let round = 0;

async function saveRound(
  repo: FileSystemUnifiedDataRepository,
): Promise<void> {
  const r = round++;
  const bytes = new TextEncoder().encode(`{"round":${r}}`);
  for (let i = 0; i < SAVES; i++) {
    const name = `n${r}-${i % 8}`;
    await repo.save(MODEL_TYPE, MODEL, dataNamed(name), bytes);
  }
  await repo.rename(MODEL_TYPE, MODEL, `n${r}-0`, `renamed-${r}`);
  await repo.delete(MODEL_TYPE, MODEL, `n${r}-1`, 1);
  await repo.removeLatestMarker(MODEL_TYPE, MODEL, `n${r}-2`);
}

for (const triggers of tracks ? [false, true] : [false]) {
  const { repo } = saveRepo(triggers);
  Deno.bench(
    `save path: ${SAVES} saves, a rename, a delete and an expiry, ${
      triggers ? "with" : "without"
    } dirty-name triggers`,
    { group: "save", baseline: !triggers, n: 30, warmup: 3 },
    async () => await saveRound(repo),
  );
}


const CATALOG_WRITES = 200;

for (const triggers of tracks ? [false, true] : [false]) {
  const catalog = new CatalogStore(
    join(dir, `catalog-${triggers ? "tracked" : "plain"}.db`),
  );
  if (triggers) {
    (catalog as unknown as { ensureDirtyTracking(now: number): void })
      .ensureDirtyTracking(0);
  }
  let written = 0;
  Deno.bench(
    `catalog: ${CATALOG_WRITES} new versions over 8 names, ${
      triggers ? "with" : "without"
    } dirty-name triggers`,
    { group: "catalog", baseline: !triggers, n: 50, warmup: 5 },
    () => {
      const r = written++;
      for (let i = 0; i < CATALOG_WRITES; i++) {
        catalog.upsertNewVersion(
          catalogRow(
            "",
            MODEL_TYPE.normalized,
            MODEL,
            DataMetadataSchema.parse(
              metadata(`c${r}-${i % 8}`, Math.floor(i / 8) + 1),
            ),
          ),
        );
      }
      return Promise.resolve();
    },
  );
}


const MODELS = 30;
const COMMITS = 3_000;
const NAMES_PER_COMMIT = 3;
const COMPACT_AT = 2_000;
const ids = Array.from(
  { length: MODELS },
  (_, i) => `6f1c2a3b-4d5e-4f60-8a7b-${String(i).padStart(12, "0")}`,
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
      inline: base64(`${name}@${version} `.repeat(8)),
    }),
    await putOp({
      intent,
      key: RecordKey.create(`${prefix}/${version}/metadata.yaml`),
      inline: base64(`name: ${name}\nversion: ${version}\n`),
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

async function buildStore(
  path: string,
  models: readonly string[],
  commits: number,
  compactAt: number,
): Promise<void> {
  const store = SqliteCommitStore.open(path);
  const seqs = new Map<string, number>();
  const versions = new Map<string, number>();
  for (let c = 0; c < commits; c++) {
    const id = models[c % models.length];
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const ops: Op[] = [];
    for (let k = 0; k < NAMES_PER_COMMIT; k++) {
      const round = Math.floor(c / models.length);
      const name = `d${(round * NAMES_PER_COMMIT + k) % NAMES_PER_MODEL}`;
      const key = `${id}/${name}`;
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      ops.push(...await saveOps(id, name, version));
    }
    const commit: Commit = modelCommit(seq, ops, {
      partition: partitionOf({ kind: "model", type: MODEL_TYPE, id }),
      txnId: `bench-${c}`,
    });
    await store.append(commit);
    if (c + 1 === compactAt) {
      await store.compactHistory(Number.MAX_SAFE_INTEGER);
    }
  }
  await store.close();
}

const chunkStore = new ChunkStore(
  new FileSystemStorage(join(dir, "datastore")),
);

interface Checkout {
  readonly storePath: string;
  readonly repoDir: string;
  readonly stateDir: string;
  readonly models: readonly string[];
}

function openReadModel(
  checkout: Checkout,
  store: SqliteCommitStore,
  options: { clock?: () => Date; targetedShare?: number } = {},
) {
  return SqliteReadModel.open({
    commitStore: store,
    chunkStore,
    cacheRoot: (namespace) =>
      namespace === ""
        ? swampPath(checkout.repoDir)
        : swampPath(checkout.repoDir, namespace),
    stateDir: checkout.stateDir,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.targetedShare === undefined
      ? {}
      : { targetedShare: options.targetedShare }),
  } as Parameters<typeof SqliteReadModel.open>[0]);
}

async function checkoutOf(
  name: string,
  models: readonly string[],
  commits: number,
  compactAt: number,
): Promise<Checkout> {
  const storePath = join(dir, `${name}.db`);
  await buildStore(storePath, models, commits, compactAt);
  const repoDir = join(dir, name);
  const checkout = {
    storePath,
    repoDir,
    stateDir: readModelStateDir(repoDir),
    models,
  };
  const store = SqliteCommitStore.open(storePath);
  // tracking that started long before any writer this bench interrupts
  const readModel = openReadModel(checkout, store, {
    clock: () => new Date(1_000),
  });
  try {
    await readModel.catchUp(AbortSignal.timeout(600_000));
  } finally {
    await readModel.close();
    await store.close();
  }
  // written long before the writer the bench interrupts
  const old = new Date(Date.now() - 3_600_000);
  for await (const entry of walk(swampPath(repoDir), { includeFiles: true })) {
    if (entry.isFile) await Deno.utime(entry.path, old, old);
  }
  return checkout;
}

/** a dead writer's uncommitted rows of a share of the names, then a recovery */
async function recoverOnce(
  b: Deno.BenchContext,
  checkout: Checkout,
  dirtyShare: number,
  mode: "full" | "targeted" | "capped",
  tear = false,
): Promise<void> {
  const writer = new CatalogStore(join(checkout.stateDir, CATALOG_V3_FILE));
  try {
    const names = checkout.models.flatMap((id) =>
      Array.from({ length: NAMES_PER_MODEL }, (_, n) => ({ id, n }))
    );
    const dirty = Math.max(1, Math.round(names.length * dirtyShare));
    for (let i = 0; i < dirty; i++) {
      const { id, n } = names[Math.floor(i * names.length / dirty)];
      writer.upsertNewVersion(
        catalogRow(
          "",
          MODEL_TYPE.normalized,
          id,
          DataMetadataSchema.parse(metadata(`d${n}`, 9_999)),
        ),
      );
    }
  } finally {
    writer.close();
  }
  if (tear) {
    // the writer rewrote every file of the checkout
    for await (
      const entry of walk(swampPath(checkout.repoDir, "data"), {
        includeDirs: false,
      })
    ) {
      await Deno.writeTextFile(entry.path, "torn");
    }
  }
  const store = SqliteCommitStore.open(checkout.storePath);
  const readModel = openReadModel(
    checkout,
    store,
    mode === "targeted" ? { targetedShare: 1 } : {},
  );
  try {
    b.start();
    await readModel.recover("", {
      since: Date.now() - 1_000,
      admits: () => true,
      signal: AbortSignal.timeout(600_000),
      entry: "interrupted_writer",
      targeted: mode !== "full",
    } as Parameters<SqliteReadModel["recover"]>[1]);
    b.end();
  } finally {
    await readModel.close();
    await store.close();
  }
}

const NAMES_PER_MODEL = 40;
const wide = await checkoutOf("wide", ids, COMMITS, COMPACT_AT);

const CASES = [
  { label: "one name dirty", share: 0, tear: false },
  { label: "25% of names dirty", share: 0.25, tear: false },
  { label: "every name dirty", share: 1, tear: false },
  { label: "every name dirty and every file rewritten", share: 1, tear: true },
];
const MODES = tracks
  ? ["full", "targeted", "capped"] as const
  : ["full"] as const;

for (const { label, share, tear } of CASES) {
  for (const mode of MODES) {
    Deno.bench(
      `recover ${COMMITS} commits over ${MODELS} models (${COMPACT_AT} compacted), ${label}: ${mode}`,
      { group: label, baseline: mode === "full", n: 3, warmup: 0 },
      async (b) => await recoverOnce(b, wide, share, mode, tear),
    );
  }
}

if (tracks) {
  // one model: every touched name's history is the whole feed
  const narrow = await checkoutOf("narrow", ids.slice(0, 1), 1_000, 600);
  for (const mode of MODES) {
    Deno.bench(
      `recover 1000 commits of one model, one name dirty: ${mode}`,
      { group: "narrow", baseline: mode === "full", n: 3, warmup: 0 },
      async (b) => await recoverOnce(b, narrow, 0, mode),
    );
  }
}

globalThis.addEventListener("unload", () => {
  Deno.removeSync(dir, { recursive: true });
});
