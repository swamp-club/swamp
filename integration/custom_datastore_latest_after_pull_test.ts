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

// An extension datastore (S3, GCS) pulls a peer's new version into the local
// cache and then only clears the catalog's populated flag. getLatestRecord
// used to return the row it already had while that row's content still
// existed, so `data.latest()` and serve's pollers kept seeing the old version
// until something ran a full query (found while working on swamp-club#2858).
// It now prefers the version the on-disk latest marker names.

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const modelType = ModelType.create("test/latest-after-pull");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-latest-after-pull-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(repoDir: string, typeName: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
}

type Unlocked = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/** Takes the model lock (pulling), invalidates as the CLI does, runs fn, then flushes. */
async function withModelLock<T>(
  repoDir: string,
  modelId: string,
  fn: (ctx: Unlocked) => Promise<T>,
): Promise<T> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  const lock = await acquireModelLocks(
    ctx.datastoreConfig,
    [{ modelType: modelType.normalized, modelId }],
    repoDir,
    ctx.syncService,
    ctx.repoContext.catalogStore,
  );
  if (lock.synced) ctx.repoContext.catalogStore.invalidate();
  try {
    return await fn(ctx);
  } finally {
    await lock.flush();
    await flushDatastoreSync();
    ctx.repoContext.catalogStore.close();
  }
}

function item(): Data {
  return Data.create({
    name: "x",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource", modelName: "m1" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

for (const twoPhaseSync of [true, false]) {
  for (const populateFirst of [false, true]) {
    Deno.test(`extension datastore: getLatestRecord returns a pulled new version (twoPhaseSync=${twoPhaseSync}, populated first=${populateFirst})`, async () => {
      const remote = createInMemoryRemote({
        capabilities: twoPhaseSync ? { twoPhaseSync: true } : {},
      });
      const { typeName, dispose } = registerTestDatastoreType(remote);
      const modelId = crypto.randomUUID();
      try {
        await withTempDir(async (dir) => {
          const repoA = join(dir, "a");
          const repoB = join(dir, "b");
          await initRepo(repoA, typeName);
          await initRepo(repoB, typeName);
          const save = (body: string) =>
            withModelLock(
              repoA,
              modelId,
              (c) =>
                c.repoContext.unifiedDataRepo.save(
                  modelType,
                  modelId,
                  item(),
                  new TextEncoder().encode(body),
                ),
            );

          await save('{"v":1}');
          await withModelLock(repoB, modelId, async (c) => {
            const record = await c.repoContext.dataQueryService
              .getLatestRecord("m1", "x");
            assertEquals(record?.version, 1);
            if (populateFirst) {
              await c.repoContext.dataQueryService.query('modelName == "m1"');
            }
          });

          await save('{"v":2}');
          await withModelLock(repoB, modelId, async (c) => {
            const record = await c.repoContext.dataQueryService
              .getLatestRecord("m1", "x");
            assertEquals(record?.version, 2);
            assertEquals(record?.attributes, { v: 2 });
          });
        });
      } finally {
        dispose();
      }
    });
  }
}
