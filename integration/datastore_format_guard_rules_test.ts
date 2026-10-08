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

// Every production path that builds a datastore's sync service or takes one
// of its locks runs behind the datastore format guard (swamp-club#3189), so
// an old binary refuses a datastore marked with a newer format before it
// writes anything. A new call site fails here until it is classified.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

const ROOT = join(fromFileUrl(import.meta.url), "..", "..");
const SRC_DIR = join(ROOT, "src");

/**
 * A call that opens a datastore: a sync service, one of its locks, or the
 * provider's datastore-wide control-plane store.
 */
const DATASTORE_OPEN =
  /\.createSyncService(\?\.)?\s*\(|\.createLock\s*\(|\bcreateDatastoreLock\s*\(|\bcreateServerTokenLock\s*\(|\bresolveCustomProvider\s*\(|\.datastoreControlPlaneStore(\?\.)?\s*\(/;

/** A function declaration, which names the call without making it. */
const DECLARATION = /^\s*(export\s+)?(async\s+)?function\b/;

/** The guard itself, called directly or through setup's dep. */
const GUARD_CALL =
  /\bensureSupportedDatastoreFormat\s*\(|\bassertDatastoreFormat\s*\(/;

function opens(line: string): boolean {
  return !isCommentLine(line) && !DECLARATION.test(line) &&
    DATASTORE_OPEN.test(line);
}

Deno.test("opens: matches calls, not comments or declarations", () => {
  assertEquals(
    opens("  const s = provider.createSyncService?.(repo, c);"),
    true,
  );
  assertEquals(opens("    .createSyncService(repoDir, cachePath)"), true);
  assertEquals(
    opens("  const lock = await createDatastoreLock(config);"),
    true,
  );
  assertEquals(
    opens("    store = provider.datastoreControlPlaneStore();"),
    true,
  );
  assertEquals(opens("  // provider.createLock(path)"), false);
  assertEquals(
    opens("export async function createDatastoreLock(config: C) {"),
    false,
  );
});

async function openingOwners(): Promise<string[]> {
  const keys: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    const owners = topLevelOwners(lines);
    lines.forEach((line, i) => {
      if (opens(line)) keys.push(`${repoRelative(filePath)}:${owners[i]}`);
    });
  }
  return countedKeys(keys);
}

/**
 * Each owner that opens a datastore, and why it is guarded.
 *
 * Guarded through resolveDatastoreForRepo (src/cli/repo_context.ts), which
 * checks the format right after resolving the config, before its caller can
 * lock, pull or write: the three requireInitializedRepo* helpers, and the
 * commands that call resolveDatastoreForRepo themselves before opening —
 * catalog pull, lock status/release, namespace unset/migrate
 * (buildMigrateDeps), doctor datastores and its repair. Owners handed a
 * config those produced: datastore sync and its libswamp deps,
 * migrate-index, the managed lockfile transaction (coordinatedGlobalLock),
 * the per-model and run locks and flushes in repo_context, and the
 * global-lock and server-token-lock helpers, whose callers (access token
 * commands, serve handlers, token secret migration) all hold such a config.
 * acquireModelLocks checks its config itself as well.
 *
 * serveCommand: its first datastore access is requireInitializedRepoUnlocked;
 * its dedicated audit datastores are checked directly.
 *
 * datastoreSetupExtension checks the target datastore through its
 * assertDatastoreFormat dep before building anything that writes.
 *
 * readDatastoreFormatMarker is the guard's own read, and the only caller of
 * datastoreControlPlaneStore: once through that store, or twice through
 * createSyncService on the fallback (a fresh service, then the
 * shared-instance check). wrapExtensionProvider only wraps a provider's
 * createLock.
 */
const GUARDED_PINNED = [
  "src/cli/commands/datastore_catalog_pull.ts:datastoreCatalogPullCommand",
  "src/cli/commands/datastore_lock.ts:datastoreLockReleaseCommand",
  "src/cli/commands/datastore_lock.ts:datastoreLockStatusCommand",
  "src/cli/commands/datastore_namespace.ts:buildMigrateDeps",
  "src/cli/commands/datastore_sync.ts:datastoreSyncCommand",
  "src/cli/commands/doctor_datastores.ts:createDoctorDatastoresDeps",
  "src/cli/commands/doctor_datastores.ts:createRepairDeps",
  "src/cli/commands/serve.ts:serveCommand (x2)",
  "src/cli/managed_config_sync.ts:coordinatedGlobalLock",
  "src/cli/repo_context.ts:acquireModelLocks (x5)",
  "src/cli/repo_context.ts:createModelLock (x2)",
  "src/cli/repo_context.ts:createWorkflowRunLock (x2)",
  "src/cli/repo_context.ts:flushSinglePhasePush",
  "src/cli/repo_context.ts:flushTwoPhasePush",
  "src/cli/repo_context.ts:requireInitializedRepo (x3)",
  "src/cli/repo_context.ts:requireInitializedRepoReadOnly (x2)",
  "src/cli/repo_context.ts:requireInitializedRepoUnlocked (x2)",
  "src/domain/extensions/datastore_kind_adapter.ts:wrapExtensionProvider",
  "src/infrastructure/persistence/datastore_format_marker_reader.ts:readDatastoreFormatMarker (x3)",
  "src/infrastructure/persistence/datastore_global_lock.ts:createDatastoreLock (x2)",
  "src/infrastructure/persistence/datastore_global_lock.ts:datastoreGlobalLock",
  "src/infrastructure/persistence/server_token_lock.ts:createServerTokenLock (x2)",
  "src/infrastructure/persistence/server_token_lock.ts:withServerTokenLock",
  "src/libswamp/datastores/migrate_index.ts:createMigrateIndexDeps",
  "src/libswamp/datastores/setup.ts:datastoreSetupExtension",
  "src/libswamp/datastores/sync.ts:createDatastoreSyncDeps",
];

Deno.test("every production path that opens a datastore is behind the format guard", async () => {
  assertPinnedSet(
    await openingOwners(),
    GUARDED_PINNED,
    "datastore sync-service and lock call sites",
    "A new path that builds a datastore's sync service or takes its lock " +
      "must check the datastore's format first (swamp-club#3189): get the " +
      "config from resolveDatastoreForRepo or a requireInitializedRepo* " +
      "helper, or call ensureSupportedDatastoreFormat before the first " +
      "lock, pull, push or write. Then add the owner here with the reason.",
  );
});

/** Owners that must call the guard themselves. */
const GUARD_CALLERS = [
  ["src/cli/repo_context.ts", "resolveDatastoreForRepo"],
  ["src/cli/repo_context.ts", "acquireModelLocks"],
  ["src/cli/commands/serve.ts", "serveCommand"],
  ["src/libswamp/datastores/setup.ts", "datastoreSetupFilesystem"],
  ["src/libswamp/datastores/setup.ts", "datastoreSetupExtension"],
  ["src/libswamp/datastores/setup.ts", "createDatastoreSetupDeps"],
] as const;

Deno.test("the guard is called where datastores are first opened", async () => {
  for (const [file, owner] of GUARD_CALLERS) {
    const lines = (await Deno.readTextFile(join(ROOT, file))).split("\n");
    const owners = topLevelOwners(lines);
    const calls = lines.some((line, i) =>
      owners[i] === owner && !isCommentLine(line) && GUARD_CALL.test(line)
    );
    assertEquals(calls, true, `${file}:${owner} must call the format guard`);
  }
});
