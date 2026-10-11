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
 * Fitness rules for the v3 datastore: the domain model (swamp-club#3233), the
 * commit store (swamp-club#3236) and chunk storage (swamp-club#3237).
 *
 * 1. **Dormancy.** The model in `src/domain/datastore_v3/` and the commit
 *    store in `src/infrastructure/datastore_v3/` are built ahead of the
 *    opt-in that will use them. Until then no production code outside those
 *    two directories may import either, so they cannot change behaviour.
 *    That covers `src/cli`, `src/serve`, `src/libswamp` and the
 *    `src/domain/datastore/mod.ts` barrel. The pinned list is empty; the
 *    issue that wires them in adds its edges here.
 * 2. **Partition keys come from aggregate identity.** `partitionOf()` is the
 *    only way to build a key. No string or template literal elsewhere may
 *    start with a partition-key prefix, so nobody assembles a key by hand.
 * 3. **Chunk storage is dormant too** (swamp-club#3237). The chunk store
 *    lives in the v3 model, so rule 1 covers it. The filesystem `storage/1`
 *    implementation has no production importers, and no production code
 *    calls a provider's `storage()`. Both pinned lists are empty; the v3
 *    opt-in adds its edges here.
 * 4. **No forced checkpoints.** `commits.db` keeps SQLite's default
 *    auto-checkpoint and never forces one: Litestream replicates the WAL, and
 *    a forced `TRUNCATE` checkpoint made its replica 11 times larger
 *    (`design/enablers/datastore-litestream.md`). No v3 file may mention
 *    `wal_checkpoint` or `wal_autocheckpoint`. `catalog_store.ts` checkpoints
 *    `_catalog.db` on purpose, so the rule covers the v3 directories only.
 */

import {
  assertPinnedSet,
  collectImportEdges,
  importsLayer,
  isUnder,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const V3_DIR = "src/domain/datastore_v3";

/** Every directory holding v3 code, under `src/`. */
const V3_LAYERS = ["domain/datastore_v3", "infrastructure/datastore_v3"];

function isV3File(rel: string): boolean {
  return V3_LAYERS.some((layer) => isUnder(rel, `src/${layer}`));
}

/** The production imports of v3 code from outside it. */
const PINNED_V3_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 imports it", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      V3_LAYERS.some((layer) => importsLayer(filePath, importPath, layer)) &&
      !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_V3_IMPORTERS,
    "Production imports of the dormant v3 datastore",
    "The v3 model and commit store are dormant until the opt-in wires them\n" +
      "in. Do not import them from production code before then.",
  );
});

/** A pragma that checkpoints the WAL or changes when it is checkpointed. */
const CHECKPOINT = /wal_(?:auto)?checkpoint/i;

/** v3 files that mention a checkpoint pragma, as `file:line`. */
const PINNED_V3_CHECKPOINTS: readonly string[] = [];

Deno.test("datastore v3: no v3 code forces or tunes a WAL checkpoint", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (!isV3File(rel)) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (CHECKPOINT.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_V3_CHECKPOINTS,
    "WAL checkpoint pragmas in v3 code",
    "commits.db keeps SQLite's default auto-checkpoint and never forces a\n" +
      "checkpoint: Litestream replicates the WAL. See\n" +
      "design/enablers/datastore-litestream.md.",
  );
});

/**
 * A string or template literal that starts with a partition-key prefix. It
 * can also match unrelated text that happens to start that way (help text
 * such as `"run--dry"`). For such a false positive, pin the `file:line` in
 * PINNED_HAND_BUILT_KEYS with a comment saying it is not a key.
 */
const HAND_BUILT_KEY = /["'`](?:model|run|config|definition)--/;

/** The one file allowed to spell partition keys. */
const KEY_BUILDER = `${V3_DIR}/partition_key.ts`;

/** Hand-built partition keys outside `partition_key.ts`, as `file:line`. */
const PINNED_HAND_BUILT_KEYS: readonly string[] = [];

Deno.test("datastore v3: partition keys are built only by partitionOf()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === KEY_BUILDER) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (HAND_BUILT_KEY.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_HAND_BUILT_KEYS,
    "Hand-built partition keys",
    "Build partition keys with partitionOf() from the aggregate's identity\n" +
      `(${KEY_BUILDER}), not by hand.`,
  );
});

const FS_STORAGE = "src/infrastructure/persistence/fs_datastore_storage.ts";

/** Production imports of the filesystem storage. */
const PINNED_FS_STORAGE_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code imports the filesystem storage", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      importsLayer(
        filePath,
        importPath,
        "infrastructure/persistence/fs_datastore_storage.ts",
      ),
  );
  assertPinnedSet(
    edges,
    PINNED_FS_STORAGE_IMPORTERS,
    "Production imports of the dormant filesystem storage",
    "Chunk storage is dormant until the v3 opt-in wires it in. Do not\n" +
      "import it from production code before then.",
  );
});

/** A call of a provider's `storage()`: `.storage(` or `.storage?.(`. */
const STORAGE_CALL = /\.storage\??\.?\(/;

/** Production calls of a provider's `storage()`, as `file:line`. */
const PINNED_STORAGE_CALLS: readonly string[] = [];

Deno.test("datastore v3: no production code calls a provider's storage()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (isUnder(rel, V3_DIR) || rel === FS_STORAGE) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (STORAGE_CALL.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_STORAGE_CALLS,
    "Production calls of DatastoreProvider.storage()",
    "Chunk storage is dormant until the v3 opt-in wires it in. Do not\n" +
      "reach an extension's storage from production code before then.",
  );
});
