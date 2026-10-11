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
 *    `src/domain/datastore/mod.ts` barrel. The pinned edges are the shared
 *    typed staging route's and the repositories' builders
 *    (swamp-club#3250), which run only under a commit-log unit; the issue
 *    that wires v3 in adds its edges here.
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
 * 5. **The commit-log unit is dormant** (swamp-club#3240). The commit-log
 *    unit and its root (`commit_log_unit_of_work.ts`, `commit_log_root.ts`
 *    in `src/infrastructure/datastore_v3/`) have no importers outside the v3
 *    directories, so no command or request can open one before the opt-in.
 *    Rule 1 already implies it; this rule names the files. The binding
 *    registry it shares with v2 lives in persistence and is pinned in
 *    `datastore_write_seams_rules_test.ts`.
 * 6. **The commit store is the only writer of `commits.db`**
 *    (swamp-club#3239). The read model reads commits through the
 *    `CommitStore` port. No v3 file but `sqlite_commit_store.ts` may hold a
 *    statement that changes the commit tables, its chunk index
 *    (`chunk_refs`, swamp-club#3249) included, or import
 *    `openCommitsDatabase`.
 * 7. **The read model's state is never synced** (swamp-club#3239).
 *    `.swamp/_read_model_v3/` holds one checkout's cursor and catalog. It is
 *    no datastore subdirectory, so sync never routes it and no record key
 *    may be materialised into it.
 *
 * 8. **Chunk garbage collection is dormant** (swamp-club#3249). The
 *    collector (`chunk_collector.ts` in `src/domain/datastore_v3/`) has no
 *    importers outside the v3 directories, and no production code but the
 *    filesystem storage itself mentions `removeStaleTempFiles`, so nothing
 *    deletes a chunk or a temp file before a v3 `datastore gc` is wired in
 *    at the opt-in. Both pinned lists are empty.
 *
 * Rule 1 covers the read model too: it lives in the two v3 directories.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../src/domain/datastore/datastore_config.ts";
import { restoreNamespace } from "../src/domain/data/namespace.ts";
import {
  MATERIALISED_SUBDIRS,
  READ_MODEL_STATE_DIR,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
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
const PINNED_V3_IMPORTERS: readonly string[] = [
  // swamp-club#3250, the shared typed staging route: type-only imports of
  // `TypedChange`, which a repository's builder returns and the commit-log
  // adapter's registered stager takes. Nothing runs v3 code through them
  // until a hook requires a unit, which only a commit-log root marks.
  "src/infrastructure/persistence/unit_of_work_binding.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/unit_of_work_scope.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  // swamp-club#3250, the data and output repositories' typed builders: the
  // pure change factory (repository_changes.ts), the types it builds and
  // the inline limit that decides bytes or a stream. The builders run only
  // inside stageTyped, which returns before them on every v2 context.
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/op.ts",
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  "src/infrastructure/persistence/yaml_output_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/yaml_output_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
];

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

const COMMIT_LOG_FILES = [
  "infrastructure/datastore_v3/commit_log_unit_of_work.ts",
  "infrastructure/datastore_v3/commit_log_root.ts",
];

/** Production imports of the commit-log unit from outside v3. */
const PINNED_COMMIT_LOG_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 imports the commit-log unit", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      COMMIT_LOG_FILES.some((file) =>
        importsLayer(filePath, importPath, file)
      ) && !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_COMMIT_LOG_IMPORTERS,
    "Production imports of the dormant commit-log unit",
    "The commit-log unit of work is dormant until the v3 opt-in opens it\n" +
      "over a v3 repository context. Do not import it from production code\n" +
      "before then.",
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

const COMMIT_STORE = "src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** A statement that changes one of `commits.db`'s tables. */
const COMMIT_TABLE_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:commits|partition_heads|partition_snapshots|chunk_refs)\b/i;

/** v3 files other than the commit store that write its tables, as `file:line`. */
const PINNED_COMMIT_TABLE_WRITERS: readonly string[] = [];

Deno.test("datastore v3: only the commit store writes commits.db's tables", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (!isV3File(rel) || rel === COMMIT_STORE) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (COMMIT_TABLE_WRITE.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMMIT_TABLE_WRITERS,
    "Writes to commits.db's tables outside the commit store",
    "The commit store is the only writer of commits: append through the\n" +
      "CommitStore port. The read model only reads commits.",
  );
});

/** Production importers of `openCommitsDatabase` outside the commit store. */
const PINNED_COMMITS_DB_OPENERS: readonly string[] = [];

Deno.test("datastore v3: only the commit store opens commits.db", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === COMMIT_STORE) continue;
    if ((await Deno.readTextFile(filePath)).includes("openCommitsDatabase")) {
      found.push(rel);
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMMITS_DB_OPENERS,
    "Production code opening commits.db outside the commit store",
    "Open commits.db only through SqliteCommitStore.open.",
  );
});

Deno.test("datastore v3: the read model's state directory is never a datastore directory", () => {
  const datastoreDirs = new Set<string>([
    ...DEFAULT_DATASTORE_SUBDIRS,
    ...ALWAYS_LOCAL_SUBDIRS,
  ]);
  assertEquals(
    datastoreDirs.has(READ_MODEL_STATE_DIR),
    false,
    `${READ_MODEL_STATE_DIR} must stay out of DEFAULT_DATASTORE_SUBDIRS and ALWAYS_LOCAL_SUBDIRS: it holds one checkout's cursor and must never be synced`,
  );
  // No namespace may be named after the state directory, or its cache root
  // would be the state directory. Namespace validation refuses any name
  // starting with `_`, which this pins for the state directory's name.
  assertThrows(() => restoreNamespace(READ_MODEL_STATE_DIR));
  assertEquals(MATERIALISED_SUBDIRS.has(READ_MODEL_STATE_DIR), false);
  for (const dir of MATERIALISED_SUBDIRS) {
    assertEquals(
      datastoreDirs.has(dir),
      true,
      `${dir} is not a datastore directory`,
    );
  }
});

const CHUNK_COLLECTOR = "domain/datastore_v3/chunk_collector.ts";

/** Production imports of the chunk collector from outside v3. */
const PINNED_CHUNK_COLLECTOR_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 imports the chunk collector", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      importsLayer(filePath, importPath, CHUNK_COLLECTOR) &&
      !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_CHUNK_COLLECTOR_IMPORTERS,
    "Production imports of the dormant chunk collector",
    "Chunk garbage collection is dormant until a v3 datastore gc is wired\n" +
      "in at the opt-in. Do not import it from production code before then.",
  );
});

/** Production mentions of `removeStaleTempFiles` outside the storage. */
const PINNED_TEMP_FILE_SWEEPS: readonly string[] = [];

Deno.test("datastore v3: no production code sweeps storage temp files", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === FS_STORAGE || isV3File(rel)) continue;
    // The port's declaration beside storage/1.
    if (rel === "src/domain/datastore/datastore_storage.ts") continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("removeStaleTempFiles")) {
        found.push(`${rel}:${index + 1}`);
      }
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_TEMP_FILE_SWEEPS,
    "Production calls of removeStaleTempFiles",
    "Removing a storage's temp files is part of chunk garbage collection,\n" +
      "which is dormant until the v3 opt-in wires it in.",
  );
});
