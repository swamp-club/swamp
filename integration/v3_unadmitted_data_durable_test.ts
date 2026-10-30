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
 * Durable v3 writes of data the checkout keeps local (swamp-club#4019): a
 * real v3 filesystem checkout whose datastore filter leaves data out hands
 * its units that filter, and the data repository the factory builds syncs
 * the versions those units drop, since no commit replays them. Data the
 * datastore commits stays unsynced.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Data } from "../src/domain/data/data.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

await initializeLogging({});

const modelType = ModelType.create("test/durable-local");

async function initRepo(
  repoDir: string,
  datastorePath: string,
  extra: readonly string[],
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + [
      "datastore:",
      "  type: filesystem",
      `  path: ${JSON.stringify(datastorePath)}`,
      "  format: 3",
      "  durable: true",
      ...extra,
    ].join("\n") + "\n",
  );
}

function stateData(modelId: string): Data {
  return Data.create({
    name: "state",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${modelType.normalized}:${modelId}`,
    },
  });
}

/**
 * Writes `state` of `modelId` in a checkout whose `datastore:` block adds
 * `extra`, through a streamed version, and returns whether the repository
 * made it durable. A second checkout with the default layout then reports
 * whether the datastore committed it.
 */
async function writeThroughCheckout(
  extra: readonly string[],
): Promise<{ durable: boolean; committed: boolean }> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-v3-durable-local-" }),
  );
  try {
    return await withMockedEnv(
      { SWAMP_DATASTORE_DURABLE: undefined },
      async () => {
        const datastorePath = join(dir, "datastore");
        await initializeV3Datastore(datastorePath, "test");
        const writer = join(dir, "writer");
        const reader = join(dir, "reader");
        await initRepo(writer, datastorePath, extra);
        await initRepo(reader, datastorePath, []);
        const modelId = crypto.randomUUID();

        const ctx = await requireInitializedRepoUnlocked({
          repoDir: writer,
          outputMode: "json",
        });
        const repo = ctx.repoContext.unifiedDataRepo;
        const durable = await runInRootUnitOfWork(
          ctx.repoContext,
          { flush: undefined },
          async () => {
            const data = stateData(modelId);
            const allocated = await repo.allocateVersion(
              modelType,
              modelId,
              data,
            );
            await Deno.writeTextFile(allocated.contentPath, "{}");
            await repo.finalizeVersion(
              modelType,
              modelId,
              data,
              allocated.version,
              allocated.priorVersions,
            );
            return allocated.durable === true;
          },
        );
        assertEquals(
          (await repo.findByName(modelType, modelId, "state"))?.version,
          1,
        );
        await closeV3Datastores();

        const other = await requireInitializedRepoUnlocked({
          repoDir: reader,
          outputMode: "json",
        });
        const committed = await other.repoContext.unifiedDataRepo.findByName(
          modelType,
          modelId,
          "state",
        ) !== null;
        await closeV3Datastores();
        return { durable, committed };
      },
    );
  } finally {
    await closeV3Datastores();
    await flushDatastoreSync();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("v3 durable writes: data left out of the datastore directories is synced and never committed (swamp-club#4019)", async () => {
  assertEquals(
    await writeThroughCheckout([
      "  directories:",
      "    - models",
      "    - workflows",
    ]),
    { durable: true, committed: false },
  );
});

Deno.test("v3 durable writes: data an exclude pattern keeps local is synced and never committed (swamp-club#4019)", async () => {
  assertEquals(
    await writeThroughCheckout(["  exclude:", "    - data/**"]),
    { durable: true, committed: false },
  );
});

Deno.test("v3 durable writes: data the datastore commits is left to replay, not synced (swamp-club#4019)", async () => {
  assertEquals(
    await writeThroughCheckout([]),
    { durable: false, committed: true },
  );
});
