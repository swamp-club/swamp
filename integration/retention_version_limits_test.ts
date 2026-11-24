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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { join } from "@std/path";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { GarbageCollectionPolicy } from "../src/domain/data/data_metadata.ts";
import {
  type RetentionConfig,
  RetentionPolicy,
} from "../src/domain/retention/retention_policy.ts";
import type { DatastorePathResolver } from "../src/domain/datastore/datastore_path_resolver.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { catalogDbPath } from "../src/infrastructure/persistence/repository_factory.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { resolveDatastoreForRepo } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { runRepoRetention } from "../src/libswamp/retention/run.ts";
import type { RetentionBatchResult } from "../src/libswamp/retention/pass.ts";
import type { DeclaredLimitScan } from "../src/domain/data/data_lifecycle_service.ts";
import {
  DAY_MS,
  saveAgedDataVersions,
} from "../src/libswamp/retention/retention_fixture_test_helpers.ts";

await initializeLogging({});

const TYPE = ModelType.create("test/version-limits");
const HOUR_MS = 3_600_000;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-version-limits-" });
  try {
    await fn(dir);
  } finally {
    await flushDatastoreSync().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

interface Repo {
  repoDir: string;
  resolver: DatastorePathResolver;
  catalog: CatalogStore;
  data: FileSystemUnifiedDataRepository;
  runs: YamlWorkflowRunRepository;
}

async function withRepo(
  dir: string,
  fn: (repo: Repo) => Promise<void>,
): Promise<void> {
  const repoDir = join(dir, "repo");
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(dir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  const resolver = new DefaultDatastorePathResolver(repoDir, datastoreConfig);
  const catalog = new CatalogStore(catalogDbPath(repoDir, resolver));
  try {
    const data = new FileSystemUnifiedDataRepository(
      repoDir,
      resolver.resolvePath(SWAMP_SUBDIRS.data),
      catalog,
    );
    const runs = new YamlWorkflowRunRepository(
      repoDir,
      undefined,
      resolver.resolvePath(SWAMP_SUBDIRS.workflowRuns),
    );
    await fn({ repoDir, resolver, catalog, data, runs });
  } finally {
    catalog.close();
  }
}

/** runs one pass as serve does and records every batch's result */
async function pass(
  repo: Repo,
  config: RetentionConfig,
  batchSize: number,
  expectComplete = true,
): Promise<{ batches: RetentionBatchResult[]; deleted: number }> {
  const policy = RetentionPolicy.fromConfig(config);
  const batches: RetentionBatchResult[] = [];
  const result = await runRepoRetention(
    {
      repoDir: repo.repoDir,
      datastoreResolver: repo.resolver,
      dataRepos: {
        catalogStore: repo.catalog,
        unifiedDataRepo: repo.data,
        workflowRunRepo: repo.runs,
      },
      runBatch: async <T>(fn: () => Promise<T>): Promise<T> => {
        const batch = await fn();
        batches.push(batch as RetentionBatchResult);
        return batch;
      },
    },
    { policy, batchSize, kinds: policy.enforcedKinds() },
  );
  assertEquals(result.complete, expectComplete, "the pass finished");
  return {
    batches,
    deleted: result.kinds.reduce((sum, kind) => sum + kind.deleted, 0),
  };
}

async function versionsOnDisk(
  repo: Repo,
  modelId: string,
  name: string,
): Promise<number[]> {
  const dir = join(
    repo.resolver.resolvePath(SWAMP_SUBDIRS.data),
    TYPE.normalized,
    modelId,
    name,
  );
  const versions: number[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory && /^\d+$/.test(entry.name)) {
      versions.push(Number(entry.name));
    }
  }
  return versions.sort((a, b) => a - b);
}

function save(
  repo: Repo,
  modelId: string,
  name: string,
  count: number,
  gc: GarbageCollectionPolicy,
  ageMs: (index: number) => number = () => 0,
): Promise<number[]> {
  return saveAgedDataVersions(
    repo.data,
    TYPE,
    modelId,
    name,
    Array.from({ length: count }, (_, i) => ageMs(i)),
    gc,
  );
}

Deno.test("versionLimits retention: a name declaring 3 keeps its newest 3; a name within its limit is untouched", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const over = await save(repo, "m1", "log", 20, 3);
      const within = await save(repo, "m1", "result", 5, 10);

      const { deleted } = await pass(repo, {}, 100);

      assertEquals(deleted, 17);
      assertEquals(await versionsOnDisk(repo, "m1", "log"), over.slice(-3));
      assertEquals(await versionsOnDisk(repo, "m1", "result"), within);
      assertEquals(
        repo.data.getLatestVersionSync(TYPE, "m1", "log"),
        over[over.length - 1],
      );
    })
  );
});

Deno.test("versionLimits retention: a duration declaration removes older versions and keeps the latest", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const ages = [5 * DAY_MS, 4 * DAY_MS, 3 * DAY_MS, 2 * HOUR_MS, HOUR_MS];
      const recent = await save(repo, "m1", "recent", 5, "1d", (i) => ages[i]);
      // every version is past the limit, the latest included
      const stale = await save(
        repo,
        "m1",
        "stale",
        3,
        "1d",
        (i) => (5 - i) * DAY_MS,
      );

      await pass(repo, {}, 100);

      assertEquals(await versionsOnDisk(repo, "m1", "recent"), recent.slice(3));
      assertEquals(await versionsOnDisk(repo, "m1", "stale"), stale.slice(-1));
    })
  );
});

Deno.test("versionLimits retention: versionLimits false deletes nothing", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const versions = await save(repo, "m1", "log", 12, 2);
      const policy = RetentionPolicy.fromConfig({ versionLimits: false });
      assertEquals(policy.enforcedKinds(), []);
      await runRepoRetention(
        {
          repoDir: repo.repoDir,
          datastoreResolver: repo.resolver,
          dataRepos: {
            catalogStore: repo.catalog,
            unifiedDataRepo: repo.data,
            workflowRunRepo: repo.runs,
          },
          runBatch: (fn) => fn(),
        },
        { policy, kinds: policy.enforcedKinds() },
      );
      assertEquals(await versionsOnDisk(repo, "m1", "log"), versions);
    })
  );
});

Deno.test("versionLimits retention: with automatic off only declared limits apply, never data retention", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      // all ten past data: 1d, which automatic off must not apply
      const versions = await save(
        repo,
        "m1",
        "log",
        10,
        4,
        (i) => (20 - i) * DAY_MS,
      );
      const { batches } = await pass(
        repo,
        { retention: "1d", data: "1d", workflowRuns: "1d" },
        100,
      );
      assertEquals(batches.length, 1);
      assertEquals(await versionsOnDisk(repo, "m1", "log"), versions.slice(-4));
    })
  );
});

Deno.test("versionLimits retention: a backlog clears over several batches, none above the batch size", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const names = ["a", "b", "c", "d"];
      const saved = new Map<string, number[]>();
      for (const name of names) {
        saved.set(name, await save(repo, "m1", name, 60, 7));
      }

      const { batches, deleted } = await pass(repo, {}, 25);

      assertEquals(deleted, 4 * 53);
      assert(batches.length > 1, `${batches.length} batches`);
      for (const batch of batches) {
        assert(batch.deleted <= 25, `a batch deleted ${batch.deleted}`);
      }
      assertEquals(batches[batches.length - 1].more, false);
      for (const name of names) {
        assertEquals(
          await versionsOnDisk(repo, "m1", name),
          saved.get(name)!.slice(-7),
        );
      }
    })
  );
});

Deno.test("versionLimits retention: batched passes leave the same versions as collectGarbage", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          count: fc.integer({ min: 1, max: 12 }),
          keep: fc.integer({ min: 1, max: 6 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      fc.integer({ min: 1, max: 9 }),
      async (specs, batchSize) => {
        await withTempDir(async (dir) => {
          const expected = new Map<string, number[]>();
          await withRepo(join(dir, "oracle"), async (repo) => {
            for (const [i, spec] of specs.entries()) {
              await save(repo, "m1", `n${i}`, spec.count, spec.keep);
            }
            await repo.data.collectGarbage(TYPE, "m1");
            for (const i of specs.keys()) {
              expected.set(`n${i}`, await versionsOnDisk(repo, "m1", `n${i}`));
            }
          });
          await withRepo(join(dir, "batched"), async (repo) => {
            for (const [i, spec] of specs.entries()) {
              await save(repo, "m1", `n${i}`, spec.count, spec.keep);
            }
            await pass(repo, {}, batchSize);
            for (const i of specs.keys()) {
              assertEquals(
                await versionsOnDisk(repo, "m1", `n${i}`),
                expected.get(`n${i}`),
              );
            }
          });
        });
      },
    ),
    { numRuns: 15 },
  );
});

Deno.test("versionLimits retention: a pass cut short resumes where the last stopped when the caller keeps the scan", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      // duration names first in key order, with nothing past their limit:
      // each is examined and kept
      for (const name of ["a1", "a2", "a3"]) {
        await save(repo, "m1", name, 2, "30d");
      }
      const late = await save(repo, "m1", "z", 6, 1);
      const policy = RetentionPolicy.fromConfig({});
      const scan: DeclaredLimitScan = {};
      // one batch per pass, as a serve whose budget runs out each hour
      const onePass = async () => {
        let checks = 0;
        await runRepoRetention(
          {
            repoDir: repo.repoDir,
            datastoreResolver: repo.resolver,
            dataRepos: {
              catalogStore: repo.catalog,
              unifiedDataRepo: repo.data,
              workflowRunRepo: repo.runs,
            },
            declaredLimitScan: scan,
            runBatch: (fn) => fn(),
          },
          {
            policy,
            batchSize: 2,
            kinds: policy.enforcedKinds(),
            isStopping: () => ++checks > 1,
          },
        );
      };

      await onePass();
      assertEquals(await versionsOnDisk(repo, "m1", "z"), late);
      await onePass();
      assertEquals(await versionsOnDisk(repo, "m1", "z"), late.slice(2));
    })
  );
});

Deno.test("versionLimits retention: a catalog row whose type cannot be read is skipped, and later names are still collected", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const later = await save(repo, "m1", "z", 5, 2);
      const template = [...repo.catalog.iterate()][0];
      for (let version = 1; version <= 3; version++) {
        repo.catalog.upsert({
          ...template,
          type_normalized: "",
          data_name: "broken",
          version,
          garbage_collection: "1",
        });
      }

      // the skipped name leaves the kind incomplete
      await pass(repo, {}, 100, false);

      assertEquals(await versionsOnDisk(repo, "m1", "z"), later.slice(-2));
    })
  );
});

Deno.test("versionLimits retention: a pass stops at its cap, counts each name once, and the next pass continues", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      const saved = await save(repo, "m1", "log", 40, 2);
      const policy = RetentionPolicy.fromConfig({});
      const scan: DeclaredLimitScan = {};
      const onePass = () =>
        runRepoRetention(
          {
            repoDir: repo.repoDir,
            datastoreResolver: repo.resolver,
            dataRepos: {
              catalogStore: repo.catalog,
              unifiedDataRepo: repo.data,
              workflowRunRepo: repo.runs,
            },
            declaredLimitScan: scan,
            declaredLimitPassCap: 25,
            runBatch: (fn) => fn(),
          },
          { policy, batchSize: 10, kinds: policy.enforcedKinds() },
        );

      const first = await onePass();
      assertEquals(first.kinds[0].deleted, 25);
      assertEquals(first.kinds[0].names, 1);
      assertEquals(first.kinds[0].complete, false);
      assertEquals(await versionsOnDisk(repo, "m1", "log"), saved.slice(25));

      const second = await onePass();
      assertEquals(second.kinds[0].deleted, 13);
      assertEquals(second.kinds[0].complete, true);
      assertEquals(await versionsOnDisk(repo, "m1", "log"), saved.slice(-2));
    })
  );
});

Deno.test("versionLimits retention: a batch signals the latest marker it rewrites before writing it, so v3 recovery stays scoped to the name", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      await save(repo, "m1", "log", 8, 2);
      const signalled: string[] = [];
      const latestPath = join(
        repo.resolver.resolvePath(SWAMP_SUBDIRS.data),
        TYPE.normalized,
        "m1",
        "log",
        "latest",
      );
      let latestBeforeSignal: string | undefined;
      const watched = new FileSystemUnifiedDataRepository(
        repo.repoDir,
        repo.resolver.resolvePath(SWAMP_SUBDIRS.data),
        repo.catalog,
        (path?: string) => {
          if (path !== undefined) signalled.push(path);
          if (path === latestPath) {
            latestBeforeSignal = Deno.readTextFileSync(latestPath);
          }
          return Promise.resolve();
        },
      );

      const batch = await watched.collectDeclaredGarbageBatch({
        limit: 100,
        now: Date.now(),
      });

      assertEquals(batch.versionsRemoved, 6);
      assert(
        signalled.includes(latestPath),
        `the latest marker was not signalled: ${signalled.join(", ")}`,
      );
      // the signal lands before the write it covers
      assertEquals(latestBeforeSignal, "8");
    })
  );
});

Deno.test("versionLimits retention: a staging error partway through a name leaves the catalog matching the disk", async () => {
  await withTempDir((dir) =>
    withRepo(dir, async (repo) => {
      await save(repo, "m1", "log", 10, 2);
      let staged = 0;
      // the second staged removal fails, as a v3 staging error would
      const original = Reflect.get(repo.data, "stageRemovedVersion") as (
        ...args: unknown[]
      ) => Promise<void>;
      Reflect.set(
        repo.data,
        "stageRemovedVersion",
        function (this: unknown, ...args: unknown[]) {
          if (++staged === 2) {
            return Promise.reject(new Error("staging refused"));
          }
          return original.apply(this, args);
        },
      );

      const batch = await repo.data.collectDeclaredGarbageBatch({
        limit: 100,
        now: Date.now(),
      });

      assertEquals(batch.failed, 1);
      const onDisk = await versionsOnDisk(repo, "m1", "log");
      const inCatalog = [...repo.catalog.iterate()]
        .filter((row) => row.data_name === "log")
        .map((row) => row.version)
        .sort((a, b) => a - b);
      assertEquals(inCatalog, onDisk);
    })
  );
});
