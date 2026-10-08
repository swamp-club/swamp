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
 * Peer propagation over one extension datastore (swamp-club#2857): two or
 * three repos, each with its own cache dir and catalog, all connected to one
 * in-memory remote. A writes, deletes, renames or collects garbage through
 * the real composition — `requireInitializedRepoUnlocked`, then
 * `acquireModelLocks` (pull), the catalog invalidation the CLI runs when
 * `lock.synced`, then `lock.flush()` (`flushTwoPhasePush` or
 * `flushSinglePhasePush`) and `flushDatastoreSync()` — and the test records
 * what B sees through `DataQueryService.getLatestRecord`, `query` (latest
 * and `version >= 0` history) and the unified data repository's
 * `findByName`/`listVersions`. This is the in-repo counterpart of
 * swamp-uat#485.
 *
 * Every scenario runs twice: with `capabilities: { twoPhaseSync: true }`
 * (prepare/commit) and with `{}` (single-phase push), as
 * `integration/in_memory_remote_wiring_test.ts` does. There is no separate
 * GCS run: `@swamp/s3-datastore` and `@swamp/gcs-datastore` share the
 * fake's default semantics (`packages/testing/in_memory_remote.ts`), so the
 * run with the default semantics is both the S3 and the GCS run.
 *
 * Today's behaviour is pinned, gaps included. Each observation is compared
 * with the outcome a user would expect; when it differs it must equal
 * today's pinned outcome, and its key must be in {@link PINNED_GAPS}. A fix
 * makes a key disappear and the pinned-set check fail, so the list is
 * updated on purpose.
 *
 * Drift from the issue text: its catalog claims predate swamp-club#2856 and
 * swamp-club#2858. After an invalidation `getLatestRecord` now prefers the
 * version the on-disk latest marker names, so "B keeps its older row" only
 * holds without invalidation. Scenarios 1 and 2 pin both sub-cases.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, equal } from "@std/assert";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  flushDatastoreSync,
  getRegisteredLockKeys,
} from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

await initializeLogging({});

/**
 * Today's gaps, one key per observation that differs from the outcome a user
 * would expect. Keys start with the scenario number so each test checks its
 * own slice. Each pin models `@swamp/s3-datastore` and `@swamp/gcs-datastore`
 * 2026.10.06.1 through 2026.10.07.1, as the fake's default semantics do
 * (S3SYNC cites swamp-extensions 7c0b1eacf, see
 * packages/testing/in_memory_remote.ts). The causes, as named in the
 * comments below:
 *
 * - UNCOUNTED REMOVAL: a pull removes the local copy of a file a peer
 *   deleted (swamp-club#2999) but leaves it out of its count
 *   (S3SYNC:2537-2543, 2875), so a delete-only pull returns 0, `lock.synced`
 *   is false and the catalog is not invalidated. B's files lose the deleted
 *   items while its query and catalog still list them (swamp-club#2892).
 * - EMPTY REMOTE: a sync removes nothing when no committed file is left in
 *   its scope (S3SYNC:4197-4214). These scenarios hold only the model's
 *   data, so deleting all of it empties the remote and B keeps its copy; a
 *   remote holding other files would remove it.
 * - SHARD SCOPE: a push of per-path marks reconciles only the index shards
 *   those marks read (S3SYNC:1548-1610, 4174-4182), so a scoped push for a
 *   new item removes nothing else.
 * - NO INVALIDATION: a populated catalog never backfills, so a caller that
 *   skips `catalogStore.invalidate()` after a pull that changed files sees
 *   its old rows.
 * - ADDITIVE BACKFILL: an invalidated catalog backfills with upserts and
 *   never removes rows (catalog_store.ts bulkUpsert), so version rows for
 *   data removed only on disk stay in history queries.
 * - UNMARKED LATEST REWRITE (swamp-club#2855): `delete(version)` rewrites
 *   the latest marker without marking it, so the remote keeps a pointer to
 *   the deleted version.
 * - BULK DISABLES DELETES: a bare `markDirty()` makes the next push a full
 *   walk that uploads and deletes nothing, dropping the per-path delete marks
 *   of the same cycle (S3SYNC:1757-1817, 3206-3276).
 * - SETTLE/HASALL RESURRECTION: after a full-walk push the cache is armed for
 *   the pull fast path only when it holds every remote key (S3SYNC:3398-3427,
 *   4049-4062); the deleting cache does not, so its next pull downloads the
 *   deleted objects back (fake modelling).
 * - STALE CLONE BULK PUSH (no issue filed): a clone that still holds the
 *   deleted data and pushes after a bare mark uploads everything it holds, so
 *   the deleted data comes back for every peer (S3SYNC:3206-3276, fake
 *   modelling). From 2026.10.06.1 the push first removes the copy when it
 *   has a last sync to compare with and the remote is not empty
 *   (S3SYNC:3103-3109).
 *
 * No pin depends on the fake's `pullClearsPendingPush`: every mark in this
 * file happens after the pull that precedes it, and each push settles the
 * cache clean.
 */
const PINNED_GAPS: readonly string[] = [
  // NO INVALIDATION (scenarios 1 and 2 also pin the invalidated sub-case,
  // which matches the expected outcome since swamp-club#2856/#2858).
  "s1 without invalidation: B's catalog misses the new name",
  "s2 without invalidation: B's catalog keeps the old version",
  // UNCOUNTED REMOVAL (swamp-club#2892).
  "s3 version delete: B's catalog still lists the version its files lost",
  // UNMARKED LATEST REWRITE (swamp-club#2855).
  "s3 latest-version delete: the remote latest marker still names the deleted version",
  // UNCOUNTED REMOVAL plus the stale remote latest marker above: B's files
  // lose version 3 but its latest marker still names it.
  "s3 latest-version delete: B reads x as missing while its catalog lists the deleted version",
  // EMPTY REMOTE.
  "s3 delete all: B still has the deleted data",
  "s3 after B's push: B still has the deleted data",
  // ADDITIVE BACKFILL: the old name's row survives the invalidation.
  "s4 rename: B's catalog still serves the old name",
  // UNCOUNTED REMOVAL (swamp-club#2892), and ADDITIVE BACKFILL for the
  // prune.
  "s5 collectGarbage: B's catalog still lists the collected versions",
  "s5 autoGc prune: B's history still lists the pruned version",
  // EMPTY REMOTE, for config-tier files too.
  "s6 definition delete: B still has the deleted definition",
  // BULK DISABLES DELETES and SETTLE/HASALL RESURRECTION, in both mark
  // orders.
  "s7 bare mark with delete: the remote keeps the deleted data",
  "s7 bare mark with delete: A's next pull brings the deleted data back",
  "s7 bare mark with delete: B still has the deleted data",
  // SHARD SCOPE: C never pulled after the delete, and its scoped push
  // reads only y's shard, so it keeps its stale copy until its bare-mark
  // push removes it.
  "s8 scoped push: C keeps its stale copy",
  // The same under the model lock, where C's pull finds the remote empty
  // (EMPTY REMOTE) and keeps x, so the bare-mark full walk still uploads it
  // (STALE CLONE BULK PUSH, no issue filed).
  "s8 lock scoped push: C keeps its stale copy",
  "s8 lock bare-mark push: the stale clone brings the deleted data back to the remote",
  "s8 lock bare-mark push: A's next pull brings the deleted data back",
];

const modelType = ModelType.create("test/peer-propagation");
const MODEL_NAME = "m1";

type Unlocked = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

const FLUSH_MODES = [
  { label: "two-phase", twoPhaseSync: true },
  { label: "single-phase", twoPhaseSync: false },
] as const;

interface Peers {
  remote: InMemoryRemote;
  /** Repo dir per instance name. */
  repo: Record<string, string>;
}

const MANAGED_CONFIG_LINE = "  managedConfig: true";

async function initRepo(
  repoDir: string,
  typeName: string,
  managedConfig: boolean,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
  if (managedConfig) {
    // configureTestDatastore appends the datastore block last, so this line
    // lands inside it (as integration/usecase_sync_fixtures.ts does).
    const markerPath = join(repoDir, ".swamp.yaml");
    const marker = await Deno.readTextFile(markerPath);
    await Deno.writeTextFile(
      markerPath,
      marker.trimEnd() + "\n" + MANAGED_CONFIG_LINE + "\n",
    );
  }
}

/**
 * Runs `fn` against a fresh remote and one repo per instance name, each on
 * its own per-run datastore type so the op log names the instance.
 */
async function withPeers(
  options: {
    twoPhaseSync: boolean;
    instances: readonly string[];
    managedConfig?: boolean;
  },
  fn: (peers: Peers) => Promise<void>,
): Promise<void> {
  assertEquals(getRegisteredLockKeys(), [], "a previous test leaked a sync");
  const remote = createInMemoryRemote({
    capabilities: options.twoPhaseSync ? { twoPhaseSync: true } : {},
  });
  const types = options.instances.map((instance) => ({
    instance,
    type: registerTestDatastoreType({
      connect: (cache) => remote.connect(cache, { instance }),
    }),
  }));
  const dir = await Deno.makeTempDir({ prefix: "swamp-peer-propagation-" });
  try {
    const repo: Record<string, string> = {};
    for (const { instance, type } of types) {
      repo[instance] = join(dir, instance.toLowerCase());
      await initRepo(
        repo[instance],
        type.typeName,
        options.managedConfig === true,
      );
    }
    // A hooked write from production code that takes signalChange's hook
    // fallback fails the test (swamp-club#3056).
    await withUnscopedWriteGuard(() => fn({ remote, repo }));
  } finally {
    try {
      await flushDatastoreSync();
    } finally {
      for (const { type } of types) type.dispose();
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
  assertEquals(getRegisteredLockKeys(), [], "a datastore sync was left held");
}

interface LockOptions {
  /**
   * Invalidate the catalog when the pull changed files, as the CLI does
   * (data_delete.ts, data_rename.ts). Default true. With false, `fn` runs
   * on the catalog as the pull left it and may invalidate itself.
   */
  invalidate?: boolean;
  /** Open the repo with write-time GC (`autoGc`). */
  autoGc?: boolean;
}

/**
 * Takes the model lock (pulling), invalidates as the CLI does, runs fn, then
 * flushes the lock and the coordinator and closes the catalog.
 */
async function withModelLock<T>(
  repoDir: string,
  modelId: string,
  fn: (ctx: Unlocked, lock: { synced: boolean }) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const ctx = await requireInitializedRepoUnlocked(
    { repoDir, outputMode: "json" },
    options.autoGc ? { autoGc: true } : undefined,
  );
  try {
    const lock = await acquireModelLocks(
      ctx.datastoreConfig,
      [{ modelType: modelType.normalized, modelId }],
      repoDir,
      ctx.syncService,
      ctx.repoContext.catalogStore,
    );
    if (lock.synced && options.invalidate !== false) {
      ctx.repoContext.catalogStore.invalidate();
    }
    try {
      return await fn(ctx, { synced: lock.synced });
    } finally {
      await lock.flush();
      await flushDatastoreSync();
    }
  } finally {
    ctx.repoContext.catalogStore.close();
  }
}

/**
 * Opens the repo without a lock or a pull, runs fn, closes the catalog. Used
 * for serve-style direct `syncService.pushChanged()` (src/serve/handlers/
 * shared.ts pushChangedToRemote).
 */
async function withUnlocked<T>(
  repoDir: string,
  fn: (ctx: Unlocked) => Promise<T>,
): Promise<T> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  try {
    return await fn(ctx);
  } finally {
    ctx.repoContext.catalogStore.close();
  }
}

function makeData(name: string, garbageCollection = 100): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection,
    tags: { type: "resource", modelName: MODEL_NAME },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

async function save(
  ctx: Unlocked,
  modelId: string,
  name: string,
  body: unknown,
  garbageCollection?: number,
): Promise<number> {
  const { version } = await ctx.repoContext.unifiedDataRepo.save(
    modelType,
    modelId,
    makeData(name, garbageCollection),
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return version;
}

/** Saves one version of `name` on `repoDir` under the model lock. */
function saveOn(
  repoDir: string,
  modelId: string,
  name: string,
  body: unknown,
  garbageCollection?: number,
): Promise<number> {
  return withModelLock(
    repoDir,
    modelId,
    (ctx) => save(ctx, modelId, name, body, garbageCollection),
  );
}

/** What a peer sees, read in this order: catalog lookups, then the repo. */
interface View {
  /** `getLatestRecord` per name, as `name@version` or null. */
  latest: Record<string, string | null>;
  /** `query` (latest only), as sorted `name@version`. */
  query: string[];
  /** `query` with `version >= 0` (history), as sorted `name@version`. */
  history: string[];
  /** `findByName` per name (follows renames), as `name@version` or null. */
  repo: Record<string, string | null>;
  /** `listVersions` per name. */
  versions: Record<string, number[]>;
}

const tag = (r: { name: string; version: number }) => `${r.name}@${r.version}`;

async function observe(
  ctx: Unlocked,
  modelId: string,
  names: readonly string[],
): Promise<View> {
  const { dataQueryService, unifiedDataRepo } = ctx.repoContext;
  const latest: Record<string, string | null> = {};
  for (const name of names) {
    const record = await dataQueryService.getLatestRecord(MODEL_NAME, name);
    latest[name] = record ? tag(record) : null;
  }
  const query = (await dataQueryService.query(
    `modelName == "${MODEL_NAME}"`,
  ) as DataRecord[]).map(tag).sort();
  const history = (await dataQueryService.query(
    `modelName == "${MODEL_NAME}" && version >= 0`,
  ) as DataRecord[]).map(tag).sort();
  const repo: Record<string, string | null> = {};
  const versions: Record<string, number[]> = {};
  for (const name of names) {
    const data = await unifiedDataRepo.findByName(modelType, modelId, name);
    repo[name] = data ? tag(data) : null;
    versions[name] = await unifiedDataRepo.listVersions(
      modelType,
      modelId,
      name,
    );
  }
  return { latest, query, history, repo, versions };
}

/** Pulls under the model lock (CLI composition) and observes. */
function observeOn(
  repoDir: string,
  modelId: string,
  names: readonly string[],
): Promise<View> {
  return withModelLock(repoDir, modelId, (ctx) => observe(ctx, modelId, names));
}

/**
 * Remote keys under the model's data dir, relative to it and forward-slash
 * (`x/1/raw`, `x/latest`), sorted.
 */
function remoteData(remote: InMemoryRemote, modelId: string): string[] {
  const marker = `/${modelId}/`;
  const keys: string[] = [];
  for (const key of remote.files().keys()) {
    const at = key.indexOf(marker);
    if (key.startsWith("data/") && at !== -1) {
      keys.push(key.slice(at + marker.length));
    }
  }
  return keys.sort();
}

/** The latest marker's content on the remote for `name`, or undefined. */
function remoteLatest(
  remote: InMemoryRemote,
  modelId: string,
  name: string,
): string | undefined {
  for (const [key, bytes] of remote.files()) {
    if (key.startsWith("data/") && key.endsWith(`/${modelId}/${name}/latest`)) {
      return new TextDecoder().decode(bytes).trim();
    }
  }
  return undefined;
}

/**
 * Compares an observation with the expected outcome. When it differs it must
 * equal today's pinned outcome, and `key` is recorded as a gap.
 */
function expectOrGap<T>(
  gaps: string[],
  key: string,
  actual: T,
  expected: T,
  today: T,
): void {
  if (equal(actual, expected)) return;
  assertEquals(
    actual,
    today,
    `${key}: neither the expected outcome nor today's pinned one`,
  );
  gaps.push(key);
}

function assertGaps(gaps: string[], scenario: string): void {
  assertPinnedSet(
    [...new Set(gaps)].sort(),
    PINNED_GAPS.filter((key) => key.startsWith(`${scenario} `)),
    `peer propagation gaps (${scenario})`,
    "A new divergence from the expected outcome: fix it, or pin it in " +
      "PINNED_GAPS with a comment naming the gap.",
  );
}

function versionsOf(name: string, versions: number[]) {
  return versions.map((v) => `${name}@${v}`);
}

// ---------------------------------------------------------------------------

for (const { label, twoPhaseSync } of FLUSH_MODES) {
  Deno.test(`acquireModelLocks: s1 A saves a new name and B sees it (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
      // B's catalog is populated before A writes.
      await withModelLock(p.repo.B, modelId, async (ctx, lock) => {
        assertEquals(lock.synced, false);
        assertEquals(await ctx.repoContext.dataQueryService.query("true"), []);
      });
      await saveOn(p.repo.A, modelId, "x", { v: 1 });
      assertEquals(remoteData(p.remote, modelId), [
        "x/1/metadata.yaml",
        "x/1/raw",
        "x/latest",
      ]);

      const expected: View = {
        latest: { x: "x@1" },
        query: ["x@1"],
        history: ["x@1"],
        repo: { x: "x@1" },
        versions: { x: [1] },
      };
      await withModelLock(p.repo.B, modelId, async (ctx, lock) => {
        assertEquals(lock.synced, true, "B's pull downloaded A's write");
        // NO INVALIDATION: a populated catalog never backfills, so a caller
        // that skips invalidate() misses the new name in the catalog.
        expectOrGap(
          gaps,
          "s1 without invalidation: B's catalog misses the new name",
          await observe(ctx, modelId, ["x"]),
          expected,
          {
            ...expected,
            latest: { x: null },
            query: [],
            history: [],
          },
        );
        ctx.repoContext.catalogStore.invalidate();
        expectOrGap(
          gaps,
          "s1 with invalidation: B misses the new name",
          await observe(ctx, modelId, ["x"]),
          expected,
          expected,
        );
      }, { invalidate: false });
    });
    assertGaps(gaps, "s1");
  });

  Deno.test(`acquireModelLocks: s2 A saves a new version of a name B knows and B sees it (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
      await saveOn(p.repo.A, modelId, "x", { v: 1 });
      assertEquals((await observeOn(p.repo.B, modelId, ["x"])).latest, {
        x: "x@1",
      });
      await saveOn(p.repo.A, modelId, "x", { v: 2 });

      const expected: View = {
        latest: { x: "x@2" },
        query: ["x@2"],
        history: ["x@1", "x@2"],
        repo: { x: "x@2" },
        versions: { x: [1, 2] },
      };
      await withModelLock(p.repo.B, modelId, async (ctx, lock) => {
        assertEquals(lock.synced, true);
        // NO INVALIDATION: B's populated catalog keeps its older row.
        expectOrGap(
          gaps,
          "s2 without invalidation: B's catalog keeps the old version",
          await observe(ctx, modelId, ["x"]),
          expected,
          {
            ...expected,
            latest: { x: "x@1" },
            query: ["x@1"],
            history: ["x@1"],
          },
        );
        ctx.repoContext.catalogStore.invalidate();
        expectOrGap(
          gaps,
          "s2 with invalidation: B misses the new version",
          await observe(ctx, modelId, ["x"]),
          expected,
          expected,
        );
      }, { invalidate: false });
    });
    assertGaps(gaps, "s2");
  });

  Deno.test(`acquireModelLocks: s3 A deletes a version, the latest version, then all versions (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
      for (const v of [1, 2, 3]) {
        await saveOn(p.repo.A, modelId, "x", { v });
      }
      const allOfX: View = {
        latest: { x: "x@3" },
        query: ["x@3"],
        history: versionsOf("x", [1, 2, 3]),
        repo: { x: "x@3" },
        versions: { x: [1, 2, 3] },
      };
      assertEquals(await observeOn(p.repo.B, modelId, ["x"]), allOfX);

      // (a) One older version.
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.delete(modelType, modelId, "x", 1),
      );
      assertEquals(
        remoteData(p.remote, modelId).filter((k) => k.startsWith("x/1/")),
        [],
      );
      // UNCOUNTED REMOVAL: B's pull removes version 1 but returns 0, so
      // lock.synced is false and the catalog is not invalidated
      // (swamp-club#2892).
      const afterVersionDelete = await withModelLock(
        p.repo.B,
        modelId,
        async (ctx, lock) => {
          assertEquals(lock.synced, false, "a delete-only pull reports 0");
          return await observe(ctx, modelId, ["x"]);
        },
      );
      expectOrGap(
        gaps,
        "s3 version delete: B's catalog still lists the version its files lost",
        afterVersionDelete,
        {
          ...allOfX,
          history: versionsOf("x", [2, 3]),
          versions: { x: [2, 3] },
        },
        { ...allOfX, versions: { x: [2, 3] } },
      );

      // (b) The latest version.
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.delete(modelType, modelId, "x", 3),
      );
      assertEquals(
        remoteData(p.remote, modelId).filter((k) => k.startsWith("x/3/")),
        [],
      );
      // UNMARKED LATEST REWRITE (swamp-club#2855): A rewrote its latest
      // marker to 2 without marking it, so the remote still names 3.
      expectOrGap(
        gaps,
        "s3 latest-version delete: the remote latest marker still names the deleted version",
        remoteLatest(p.remote, modelId, "x"),
        "2",
        "3",
      );
      // UNCOUNTED REMOVAL: B removes version 3, but its latest marker
      // still names it, so the repository finds no x; the catalog still
      // lists every version.
      const staleCatalog: View = {
        latest: { x: "x@3" },
        query: ["x@3"],
        history: versionsOf("x", [1, 2, 3]),
        repo: { x: null },
        versions: { x: [2] },
      };
      expectOrGap(
        gaps,
        "s3 latest-version delete: B reads x as missing while its catalog lists the deleted version",
        await observeOn(p.repo.B, modelId, ["x"]),
        {
          latest: { x: "x@2" },
          query: ["x@2"],
          history: ["x@2"],
          repo: { x: "x@2" },
          versions: { x: [2] },
        },
        staleCatalog,
      );

      // (c) Every version.
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.delete(modelType, modelId, "x"),
      );
      assertEquals(remoteData(p.remote, modelId), []);
      const gone: View = {
        latest: { x: null },
        query: [],
        history: [],
        repo: { x: null },
        versions: { x: [] },
      };
      // EMPTY REMOTE: nothing is left on the remote, so B's pull removes
      // nothing and B keeps version 2.
      expectOrGap(
        gaps,
        "s3 delete all: B still has the deleted data",
        await observeOn(p.repo.B, modelId, ["x"]),
        gone,
        staleCatalog,
      );

      // (d) B pushes an unrelated item; nothing deleted comes back.
      await saveOn(p.repo.B, modelId, "y", { y: 1 });
      assertEquals(remoteData(p.remote, modelId), [
        "y/1/metadata.yaml",
        "y/1/raw",
        "y/latest",
      ]);
      assertEquals(await observeOn(p.repo.A, modelId, ["x", "y"]), {
        latest: { x: null, y: "y@1" },
        query: ["y@1"],
        history: ["y@1"],
        repo: { x: null, y: "y@1" },
        versions: { x: [], y: [1] },
      });
      expectOrGap(
        gaps,
        "s3 after B's push: B still has the deleted data",
        (await observeOn(p.repo.B, modelId, ["x"])).versions,
        { x: [] },
        { x: [2] },
      );
    });
    assertGaps(gaps, "s3");
  });

  Deno.test(`acquireModelLocks: s4 A renames and B sees the new name only (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
      await saveOn(p.repo.A, modelId, "x", { v: 1 });
      assertEquals((await observeOn(p.repo.B, modelId, ["x"])).query, ["x@1"]);
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.rename(modelType, modelId, "x", "y"),
      );

      const view = await observeOn(p.repo.B, modelId, ["x", "y"]);
      // The repository follows the tombstone's forward reference.
      assertEquals(view.repo, { x: "y@1", y: "y@1" });
      assertEquals(view.versions, { x: [1, 2], y: [1] });
      // ADDITIVE BACKFILL: the invalidated catalog keeps B's row for the old
      // name, and getLatestRecord serves it because its content is still on
      // disk (the tombstone is skipped by the latest-marker refresh).
      expectOrGap(
        gaps,
        "s4 rename: B's catalog still serves the old name",
        { latest: view.latest, query: view.query },
        { latest: { x: null, y: "y@1" }, query: ["y@1"] },
        { latest: { x: "x@1", y: "y@1" }, query: ["x@1", "y@1"] },
      );
    });
    assertGaps(gaps, "s4");
  });

  Deno.test(`acquireModelLocks: s5 A collects garbage and B reflects it (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
      // (a) collectGarbage through requireInitializedRepo and the
      // coordinator's teardown flush, as `swamp data gc` does.
      for (const v of [1, 2, 3]) {
        await saveOn(p.repo.A, modelId, "x", { v }, 1);
      }
      assertEquals(
        (await observeOn(p.repo.B, modelId, ["x"])).versions,
        { x: [1, 2, 3] },
      );
      const gc = await requireInitializedRepo({
        repoDir: p.repo.A,
        outputMode: "json",
      });
      try {
        const result = await gc.repoContext.unifiedDataRepo.collectGarbage(
          modelType,
          modelId,
        );
        assertEquals(result.versionsRemoved, 2);
      } finally {
        await flushDatastoreSync();
        gc.repoContext.catalogStore.close();
      }
      assertEquals(remoteData(p.remote, modelId), [
        "x/3/metadata.yaml",
        "x/3/raw",
        "x/latest",
      ]);
      // UNCOUNTED REMOVAL: B's files lose the collected versions, but the
      // delete-only pull leaves the catalog populated (swamp-club#2892).
      expectOrGap(
        gaps,
        "s5 collectGarbage: B's catalog still lists the collected versions",
        await observeOn(p.repo.B, modelId, ["x"]),
        {
          latest: { x: "x@3" },
          query: ["x@3"],
          history: ["x@3"],
          repo: { x: "x@3" },
          versions: { x: [3] },
        },
        {
          latest: { x: "x@3" },
          query: ["x@3"],
          history: versionsOf("x", [1, 2, 3]),
          repo: { x: "x@3" },
          versions: { x: [3] },
        },
      );

      // (b) Write-time GC (autoGc) pruning on save.
      for (const v of [1, 2]) {
        await saveOn(p.repo.A, modelId, "w", { v }, 2);
      }
      assertEquals(
        (await observeOn(p.repo.B, modelId, ["w"])).versions,
        { w: [1, 2] },
      );
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) => save(ctx, modelId, "w", { v: 3 }, 2),
        { autoGc: true },
      );
      assertEquals(
        remoteData(p.remote, modelId).filter((k) => k.startsWith("w/")),
        [
          "w/2/metadata.yaml",
          "w/2/raw",
          "w/3/metadata.yaml",
          "w/3/raw",
          "w/latest",
        ],
      );
      // ADDITIVE BACKFILL: the pull brought version 3, removed version 1 and
      // invalidated, but the backfill keeps version 1 in B's history.
      const pruned = await observeOn(p.repo.B, modelId, ["w"]);
      expectOrGap(
        gaps,
        "s5 autoGc prune: B's history still lists the pruned version",
        {
          latest: pruned.latest,
          history: pruned.history.filter((t) => t.startsWith("w@")),
          versions: pruned.versions,
        },
        {
          latest: { w: "w@3" },
          history: versionsOf("w", [2, 3]),
          versions: { w: [2, 3] },
        },
        {
          latest: { w: "w@3" },
          history: versionsOf("w", [1, 2, 3]),
          versions: { w: [2, 3] },
        },
      );
    });
    assertGaps(gaps, "s5");
  });

  Deno.test(`acquireModelLocks: s6 A deletes a model definition under managedConfig (${label})`, async () => {
    const gaps: string[] = [];
    await withPeers(
      { twoPhaseSync, instances: ["A", "B"], managedConfig: true },
      async (p) => {
        const definition = Definition.create({ name: "peer-def" });
        const id = definition.id;
        const configKeys = () =>
          [...p.remote.files().keys()].filter((k) =>
            k.startsWith("config/models/")
          );
        await withModelLock(
          p.repo.A,
          id,
          (ctx) => ctx.repoContext.definitionRepo.save(modelType, definition),
        );
        assertEquals(configKeys().length, 1);
        const findOnB = () =>
          withModelLock(p.repo.B, id, async (ctx) => {
            const found = await ctx.repoContext.definitionRepo.findById(
              modelType,
              id,
            );
            return found?.name ?? null;
          });
        assertEquals(await findOnB(), "peer-def");

        await withModelLock(
          p.repo.A,
          id,
          (ctx) => ctx.repoContext.definitionRepo.delete(modelType, id),
        );
        assertEquals(configKeys(), []);
        // EMPTY REMOTE: the deleted definition was the only file, so B's
        // pull removes nothing and keeps it.
        expectOrGap(
          gaps,
          "s6 definition delete: B still has the deleted definition",
          await findOnB(),
          null,
          "peer-def",
        );
      },
    );
    assertGaps(gaps, "s6");
  });

  for (const order of ["bare mark first", "bare mark after"] as const) {
    Deno.test(`acquireModelLocks: s7 a bare mark and a per-path delete in one cycle, ${order} (${label})`, async () => {
      const gaps: string[] = [];
      const modelId = crypto.randomUUID();
      await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
        for (const v of [1, 2]) {
          await saveOn(p.repo.A, modelId, "x", { v });
        }
        assertEquals(
          (await observeOn(p.repo.B, modelId, ["x"])).versions,
          { x: [1, 2] },
        );
        await withModelLock(p.repo.A, modelId, async (ctx) => {
          if (order === "bare mark first") await ctx.syncService!.markDirty();
          await ctx.repoContext.unifiedDataRepo.delete(modelType, modelId, "x");
          if (order === "bare mark after") await ctx.syncService!.markDirty();
        });
        // BULK DISABLES DELETES: the bare mark turns the push into a full
        // walk that deletes nothing (S3SYNC:1757-1817, 3206-3276).
        expectOrGap(
          gaps,
          "s7 bare mark with delete: the remote keeps the deleted data",
          remoteData(p.remote, modelId),
          [],
          [
            "x/1/metadata.yaml",
            "x/1/raw",
            "x/2/metadata.yaml",
            "x/2/raw",
            "x/latest",
          ],
        );
        // SETTLE/HASALL RESURRECTION: A's full-walk push did not arm the
        // pull fast path because A no longer holds every remote key
        // (S3SYNC:3398-3427, 4049-4062), so A's next pull downloads the
        // deleted data back.
        expectOrGap(
          gaps,
          "s7 bare mark with delete: A's next pull brings the deleted data back",
          (await observeOn(p.repo.A, modelId, ["x"])).repo,
          { x: null },
          { x: "x@2" },
        );
        // The remote kept the data, so B has nothing to remove.
        expectOrGap(
          gaps,
          "s7 bare mark with delete: B still has the deleted data",
          (await observeOn(p.repo.B, modelId, ["x"])).repo,
          { x: null },
          { x: "x@2" },
        );
      });
      assertGaps(gaps, "s7");
    });
  }

  Deno.test(`acquireModelLocks: s8 a stale clone pushes after A's delete, serve-style and under the model lock (${label})`, async () => {
    const gaps: string[] = [];
    const modelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "C"] }, async (p) => {
      await saveOn(p.repo.A, modelId, "x", { v: 1 });
      // C pulls before the delete and never again before writing.
      assertEquals((await observeOn(p.repo.C, modelId, ["x"])).repo, {
        x: "x@1",
      });
      await withModelLock(
        p.repo.A,
        modelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.delete(modelType, modelId, "x"),
      );
      assertEquals(remoteData(p.remote, modelId), []);

      // (a) C saves and pushes directly, as serve's pushChangedToRemote
      // does (src/serve/handlers/shared.ts), with no pull first.
      await withUnlocked(p.repo.C, async (ctx) => {
        await save(ctx, modelId, "y", { y: 1 });
        await ctx.syncService!.pushChanged();
      });
      // The scoped push uploads only y: nothing deleted comes back.
      assertEquals(remoteData(p.remote, modelId), [
        "y/1/metadata.yaml",
        "y/1/raw",
        "y/latest",
      ]);
      assertEquals((await observeOn(p.repo.A, modelId, ["x", "y"])).repo, {
        x: null,
        y: "y@1",
      });
      // SHARD SCOPE: C's scoped push read only y's shard, so it keeps its
      // stale copy of x.
      expectOrGap(
        gaps,
        "s8 scoped push: C keeps its stale copy",
        await withUnlocked(
          p.repo.C,
          async (ctx) => (await observe(ctx, modelId, ["x"])).repo,
        ),
        { x: null },
        { x: "x@1" },
      );

      // (b) A bare mark on C (pushManagedConfigChanges marks bare, see
      // src/cli/managed_config_sync.ts) and a direct push.
      await withUnlocked(p.repo.C, async (ctx) => {
        await ctx.syncService!.markDirty();
        await ctx.syncService!.pushChanged();
      });
      // The bare-mark push reads the whole index and removes C's unchanged
      // stale copy before its full walk (S3SYNC:3103-3109), so nothing comes
      // back. Up to 2026.10.01.1 the walk uploaded it (STALE CLONE BULK
      // PUSH, no issue filed).
      expectOrGap(
        gaps,
        "s8 bare-mark push: the stale clone brings the deleted data back to the remote",
        remoteData(p.remote, modelId).filter((k) => k.startsWith("x/")),
        [],
        ["x/1/metadata.yaml", "x/1/raw", "x/latest"],
      );
      expectOrGap(
        gaps,
        "s8 bare-mark push: A's next pull brings the deleted data back",
        (await observeOn(p.repo.A, modelId, ["x"])).repo,
        { x: null },
        { x: "x@1" },
      );
    });

    // The CLI path on a fresh set of peers: C takes the model lock, which
    // pulls first (acquireModelLocks), invalidates when synced, saves y and
    // flushes the lock.
    const lockModelId = crypto.randomUUID();
    await withPeers({ twoPhaseSync, instances: ["A", "C"] }, async (p) => {
      await saveOn(p.repo.A, lockModelId, "x", { v: 1 });
      assertEquals((await observeOn(p.repo.C, lockModelId, ["x"])).repo, {
        x: "x@1",
      });
      await withModelLock(
        p.repo.A,
        lockModelId,
        (ctx) =>
          ctx.repoContext.unifiedDataRepo.delete(modelType, lockModelId, "x"),
      );
      assertEquals(remoteData(p.remote, lockModelId), []);

      // (c) A scoped write under the lock. C's pull runs first but, under
      // legacy semantics, never deletes: it downloads nothing, returns 0
      // (lock.synced false, no invalidation) and C still holds x locally.
      const staleOnC = await withModelLock(
        p.repo.C,
        lockModelId,
        async (ctx, lock) => {
          assertEquals(lock.synced, false, "a delete-only pull reports 0");
          await save(ctx, lockModelId, "y", { y: 1 });
          return (await observe(ctx, lockModelId, ["x"])).repo;
        },
      );
      // The per-path marks keep the push scoped to y: x stays deleted on the
      // remote and on A.
      assertEquals(remoteData(p.remote, lockModelId), [
        "y/1/metadata.yaml",
        "y/1/raw",
        "y/latest",
      ]);
      assertEquals(
        (await observeOn(p.repo.A, lockModelId, ["x", "y"])).repo,
        { x: null, y: "y@1" },
      );
      // EMPTY REMOTE: the pull under the lock found nothing left on the
      // remote, so it kept C's stale copy.
      expectOrGap(
        gaps,
        "s8 lock scoped push: C keeps its stale copy",
        staleOnC,
        { x: null },
        { x: "x@1" },
      );

      // (d) A bare mark under the lock (as pushManagedConfigChanges does,
      // src/cli/managed_config_sync.ts) with the save. C's pull and push
      // last read an empty remote, so they kept x, and the full walk
      // uploads C's stale copy.
      await withModelLock(p.repo.C, lockModelId, async (ctx) => {
        await ctx.syncService!.markDirty();
        await save(ctx, lockModelId, "y", { y: 2 });
      });
      // STALE CLONE BULK PUSH (no issue filed; S3SYNC:3206-3276).
      expectOrGap(
        gaps,
        "s8 lock bare-mark push: the stale clone brings the deleted data back to the remote",
        remoteData(p.remote, lockModelId).filter((k) => k.startsWith("x/")),
        [],
        ["x/1/metadata.yaml", "x/1/raw", "x/latest"],
      );
      expectOrGap(
        gaps,
        "s8 lock bare-mark push: A's next pull brings the deleted data back",
        (await observeOn(p.repo.A, lockModelId, ["x"])).repo,
        { x: null },
        { x: "x@1" },
      );
    });
    assertGaps(gaps, "s8");
  });
}

// ---------------------------------------------------------------------------
// Ambient unit of work (swamp-club#2971, datastore rework Phase 1)
// ---------------------------------------------------------------------------

/**
 * Scenario s1 on fresh peers: B reads first, A saves `x` under the model
 * lock (inside a legacy unit-of-work scope bound to A's own hook when
 * `scoped`), then B pulls and observes with invalidation. Returns what the
 * remote and B saw.
 */
async function s1Outcome(
  twoPhaseSync: boolean,
  modelId: string,
  scoped: boolean,
): Promise<{ ops: readonly unknown[]; remote: string[]; view: View }> {
  let outcome:
    | { ops: readonly unknown[]; remote: string[]; view: View }
    | undefined;
  await withPeers({ twoPhaseSync, instances: ["A", "B"] }, async (p) => {
    await observeOn(p.repo.B, modelId, ["x"]);
    await withModelLock(p.repo.A, modelId, async (ctx) => {
      if (!scoped) return await save(ctx, modelId, "x", { v: 1 });
      const hook = ctx.repoContext.markDirty;
      assert(hook !== undefined, "expected A's composition-built mark hook");
      const uow = createLegacyUnitOfWork(hook, { flush: undefined });
      const version = await runInUnitOfWork(
        uow,
        () => save(ctx, modelId, "x", { v: 1 }),
      );
      assert(uow.staged().length > 0, "expected A's save to stage");
      return version;
    });
    const view = await observeOn(p.repo.B, modelId, ["x"]);
    outcome = {
      ops: p.remote.ops(),
      remote: remoteData(p.remote, modelId),
      view,
    };
  });
  assert(outcome !== undefined);
  return outcome;
}

for (const { label, twoPhaseSync } of FLUSH_MODES) {
  Deno.test(`acquireModelLocks: s1 inside a legacy unit of work scope gives the remote and B exactly what s1 without one does (${label})`, async () => {
    const modelId = crypto.randomUUID();
    const unscoped = await s1Outcome(twoPhaseSync, modelId, false);
    const scoped = await s1Outcome(twoPhaseSync, modelId, true);
    assertEquals(unscoped.remote, ["x/1/metadata.yaml", "x/1/raw", "x/latest"]);
    assertEquals(scoped.ops, unscoped.ops);
    assertEquals(scoped.remote, unscoped.remote);
    assertEquals(scoped.view, unscoped.view);
  });
}
