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
 * A call that opens a datastore: a sync service, one of its locks, the
 * provider's datastore-wide control-plane store, or a v3 datastore's commit
 * log or writer lock (swamp-club#3279), or its lease's holder
 * (swamp-club#3564).
 */
const DATASTORE_OPEN =
  /\.createSyncService(\?\.)?\s*\(|\.createLock\s*\(|\bcreateDatastoreLock\s*\(|\bcreateServerTokenLock\s*\(|\bresolveCustomProvider\s*\(|\.datastoreControlPlaneStore(\?\.)?\s*\(|\bopenV3Datastore\s*\(|\bv3DatastoreFor\s*\(|\bacquireV3WriterLock\s*\(|\bv3WriterLockHandle\s*\(|\bv3WriterLeaseHolder\s*\(/;

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
 * its dedicated audit datastores are checked directly. The datastore API's
 * v3 handle (swamp-club#3915) is the one that requireInitializedRepoUnlocked
 * already opened.
 *
 * datastoreSetupExtension checks the target datastore through its
 * assertDatastoreFormat dep before building anything that writes.
 *
 * readDatastoreFormatMarker is the guard's own read of
 * datastoreControlPlaneStore: once through that store, or twice through
 * createSyncService on the fallback (a fresh service, then the
 * shared-instance check). datastoreWriterLeaseStore is its only other
 * caller. wrapExtensionProvider only wraps a provider's
 * createLock.
 */
const GUARDED_PINNED = [
  "src/cli/commands/datastore_catalog_pull.ts:datastoreCatalogPullCommand",
  // swamp-club#3279: v3 opens (the commit log, the writer lock). Each is
  // handed a config resolveDatastoreForRepo or requireInitializedRepo* has
  // already checked: gc, lock, status, serve's maintenance timer and status
  // handler, and the v3 context helpers repo_context calls after its check.
  "src/cli/commands/datastore_gc.ts:datastoreGcCommand",
  "src/cli/commands/datastore_status.ts:datastoreStatusCommand",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:anotherProcessWritesCheckout",
  // swamp-club#3364: the v3 writer lease's datastore-wide store. The bucket
  // binding (swamp-club#3534) calls it with the provider of a config it has
  // already checked, as holdV3Writer does on filesystem.
  "src/infrastructure/datastore_v3/datastore_writer_lease_store.ts:datastoreWriterLeaseStore",
  // swamp-club#3534, v3 on buckets: binding a bucket datastore resolves the
  // provider of a config the format guard already opened as v3, and setup's
  // target check builds a sync service on a scratch cache only to read two
  // root keys (fetchContent), after setup's own format check.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3DatastoreConfigOf",
  "src/infrastructure/datastore_v3/v3_bucket_setup.ts:holdsV2RootData",
  // swamp-club#3359: holdV3Writer also opens the handle, to record its
  // writer lease's fence in commits.db. swamp-club#3482: while replicating
  // it opens it once the copy is current, raises the fence there, and
  // opens it for the sidecar's path. swamp-club#3802: the body moved into
  // takeV3WriterHold, which only holdV3Writer calls, so a storage failure
  // gets its code.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:takeV3WriterHold (x5)",
  // swamp-club#3985: a checkout whose upstream is serve catches its copy up
  // from serve once the hold is taken. Its config came through
  // resolveDatastoreForRepo, which records it as v3 through serve; its
  // storage is never opened.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:holdV3Writer",
  // swamp-club#3985: binding a serve-mode checkout with another token than
  // its copy was built with takes the local root's writer lease to reset the
  // copy. The binding runs from v3LocationOf on a config
  // resolveDatastoreForRepo already recorded as v3 through serve; only the
  // local root is locked, never the storage. A context opened with another
  // view than its projection's rebuilds it under the lease of the handle
  // v3RepositoryFactoryConfig opened, after the same check.
  "src/infrastructure/datastore_v3/serve_upstream_binding.ts:resetCopyForCaller",
  "src/infrastructure/datastore_v3/checkout_view.ts:alignCheckoutView",
  // swamp-club#4006: a serve-mode copy loading serve's compacted base takes
  // the local root's writer lease, so two commands never load one copy at
  // once. It runs only on a handle whose upstream is serve, opened after
  // the same check; only the local root is locked, never the storage.
  "src/infrastructure/datastore_v3/serve_catch_up.ts:ServeCatchUp",
  // swamp-club#3482: making the copy current reads the handle of the
  // datastore holdV3Writer or v3RepositoryFactoryConfig passes it, after
  // the same check; serve's upkeep does the same for the config serve's
  // checked context resolved.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:ensureV3CopyCurrentNow",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:startV3ReplicationUpkeep",
  // swamp-club#3299: interrupted-writer recovery opens the handle and
  // inspects the writer lock (the lease's holder since swamp-club#3564) of
  // the datastore v3RepositoryFactoryConfig or holdV3Writer passes it, after
  // the same check.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:recoverAndMark",
  // swamp-club#4063: the hold reads the claim through the handle it opened
  // once the lease is held, after the same check; the claim log of
  // `datastore claim` and `release`, CLI and serve, uses the handle of a
  // checked repository context.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:refuseUnlessOwner",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3ClaimCommitLog",
  // swamp-club#4096: a serve node that follows reads the claim through the
  // handle it opened, inside holdV3Writer's hold path, after the same check.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:followV3Datastore",
  "src/infrastructure/datastore_v3/interrupted_writer_recovery.ts:lockHeldByLiveProcess",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3DatastoreFor",
  // swamp-club#4120: serve's commit feed and a follower applying its
  // leader's feed open the handle serve's start opened, after its guard.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3CommitFeedSource",
  "src/infrastructure/datastore_v3/serve_feed.ts:applyV3LeaderChanges",
  "src/infrastructure/datastore_v3/serve_feed.ts:v3FollowerCopyCursor",
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3RepositoryFactoryConfig",
  // swamp-club#3473: `doctor datastores --retention` reads the oldest
  // stored commit, after a read-only repository context opened the repo.
  "src/infrastructure/datastore_v3/v3_repo_context.ts:v3RetentionHistory",
  // swamp-club#3300: config adoption reads partition heads through the
  // handle a checked context already opened; its callers (config migrate,
  // repo_context's context helpers) pass a config the helpers checked.
  "src/infrastructure/datastore_v3/v3_config_adoption.ts:planV3ConfigAdoption",
  "src/serve/handlers/admin_handlers.ts:handleDatastoreStatus",
  "src/cli/commands/datastore_lock.ts:datastoreLockReleaseCommand (x2)",
  // swamp-club#3372: lock status also resolves a custom datastore's provider
  // and builds each model's lock to inspect it, after the same check.
  "src/cli/commands/datastore_lock.ts:datastoreLockStatusCommand (x4)",
  "src/cli/commands/datastore_namespace.ts:buildMigrateDeps",
  "src/cli/commands/datastore_sync.ts:datastoreSyncCommand",
  "src/cli/commands/doctor_datastores.ts:createDoctorDatastoresDeps",
  "src/cli/commands/doctor_datastores.ts:createRepairDeps",
  // swamp-club#3473: serve's retention pass compacts v3 history through the
  // handle of the config requireInitializedRepoUnlocked checked; so does the
  // evaluation trust serve gives its repository context (swamp-club#3922).
  "src/cli/commands/serve.ts:serveCommand (x6)",
  // swamp-club#3473: the end-of-command retention pass opens the repository
  // through requireInitializedRepo and resolveDatastoreForRepo, then
  // compacts v3 history through that checked config.
  "src/cli/retention_teardown.ts:runRetentionAtCommandEnd",
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
  // swamp-club#3372: builds locks only through the source lock status hands
  // it, from that command's checked config.
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
