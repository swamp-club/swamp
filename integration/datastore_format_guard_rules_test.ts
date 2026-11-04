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

const DATASTORE_OPEN =
  /\.createSyncService(\?\.)?\s*\(|\.createLock\s*\(|\bcreateDatastoreLock\s*\(|\bcreateServerTokenLock\s*\(|\bresolveCustomProvider\s*\(|\.datastoreControlPlaneStore(\?\.)?\s*\(|\bopenV3Datastore\s*\(|\bv3DatastoreFor\s*\(|\bacquireV3WriterLock\s*\(|\bv3WriterLockHandle\s*\(|\bv3WriterLeaseHolder\s*\(/;

const DECLARATION = /^\s*(export\s+)?(async\s+)?function\b/;

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
 * each owner that opens a datastore must run behind the format guard, so it
 * checks before its caller can lock, pull or write; entries are pinned so a new
 * call site must be classified
 */
const GUARDED_PINNED = [
  "src/cli/last_evaluated_trust.ts:realDeps",
  "src/cli/commands/datastore_catalog_pull.ts:datastoreCatalogPullCommand",
  "src/cli/commands/datastore_gc.ts:datastoreGcCommand",
  // through serve it reads the checkout's copy, resolved and format-checked by
  // resolveDatastoreForRepo
  "src/cli/commands/datastore_status.ts:datastoreStatusCommand (x2)",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:anotherProcessWritesCheckout",
  "src/infrastructure/datastore_v3/datastore_writer_lease_store.ts:datastoreWriterLeaseStore",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3DatastoreConfigOf",
  "src/infrastructure/datastore_v3/v3_bucket_setup.ts:holdsV2RootData",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:takeV3WriterHold (x5)",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:holdV3Writer",
  "src/infrastructure/datastore_v3/serve_upstream_binding.ts:resetCopyForCaller",
  "src/infrastructure/datastore_v3/checkout_view.ts:leaseUnlessAligned",
  "src/infrastructure/datastore_v3/serve_catch_up.ts:ServeCatchUp",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:ensureV3CopyCurrentNow",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:startV3ReplicationUpkeep",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:recoverAndMark",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:refuseUnlessOwner",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3ClaimCommitLog",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:followV3Datastore",
  "src/infrastructure/datastore_v3/interrupted_writer_recovery.ts:lockHeldByLiveProcess",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3DatastoreFor",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3CommitFeedSource",
  "src/infrastructure/datastore_v3/serve_feed.ts:applyV3LeaderChanges",
  "src/infrastructure/datastore_v3/serve_feed.ts:v3FollowerCopyCursor",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3RepositoryFactoryConfig",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3RetentionHistory",
  "src/infrastructure/datastore_v3/v3_config_adoption.ts:planV3ConfigAdoption",
  "src/serve/handlers/admin_handlers.ts:handleDatastoreStatus",
  "src/cli/commands/datastore_lock.ts:datastoreLockReleaseCommand (x2)",
  "src/cli/commands/datastore_lock.ts:datastoreLockStatusCommand (x4)",
  "src/cli/commands/datastore_namespace.ts:buildMigrateDeps",
  "src/cli/commands/datastore_sync.ts:datastoreSyncCommand",
  "src/cli/commands/doctor_datastores.ts:createDoctorDatastoresDeps (x2)",
  "src/cli/commands/doctor_datastores.ts:createRepairDeps",
  "src/cli/commands/doctor_datastores.ts:createUnpushedRepairSetup",
  "src/cli/commands/serve.ts:serveCommand (x8)",
  "src/cli/retention_teardown.ts:runRetentionAtCommandEnd",
  "src/cli/managed_config_sync.ts:coordinatedGlobalLock",
  "src/infrastructure/persistence/repo_execution_locks.ts:acquireModelLocks (x5)",
  "src/infrastructure/persistence/repo_execution_locks.ts:pullModelsUnlocked (x3)",
  "src/infrastructure/persistence/repo_execution_locks.ts:createModelLock (x2)",
  "src/infrastructure/persistence/repo_execution_locks.ts:createWorkflowRunLock (x2)",
  "src/infrastructure/persistence/repo_execution_locks.ts:flushSinglePhasePush",
  "src/infrastructure/persistence/repo_execution_locks.ts:flushTwoPhasePush",
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
  "src/libswamp/datastores/lock.ts:scanCustomModelLocks",
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

const GUARD_CALLERS = [
  ["src/cli/repo_context.ts", "resolveDatastoreForRepo"],
  [
    "src/infrastructure/persistence/repo_execution_locks.ts",
    "acquireModelLocks",
  ],
  [
    "src/infrastructure/persistence/repo_execution_locks.ts",
    "pullModelsUnlocked",
  ],
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
