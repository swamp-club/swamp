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
 * A datastore's `durable` setting reaches the writers that act on it
 * (swamp-club#4017). The setting is resolved from the `.swamp.yaml`
 * datastore block, or `SWAMP_DATASTORE_DURABLE` when the block does not
 * say, into the repository factory's unified data repository, which tells
 * a streaming writer whether to sync, and into the per-model lock, which
 * syncs the model directories it creates.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createModelLock } from "../src/cli/repo_context.ts";
import { resolveDatastoreConfig } from "../src/cli/resolve_datastore.ts";
import { Data } from "../src/domain/data/mod.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { RepoMarkerData } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";

const modelType = ModelType.create("test/durable");

function marker(datastorePath: string, durable?: boolean): RepoMarkerData {
  return {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01",
    repoId: crypto.randomUUID(),
    datastore: {
      type: "filesystem",
      path: datastorePath,
      ...(durable === undefined ? {} : { durable }),
    },
  };
}

/**
 * What the resolved datastore tells its writers: whether a streaming
 * writer must sync, and whether the model lock syncs what it creates.
 */
async function writersOf(
  repoDir: string,
  repoMarker: RepoMarkerData,
): Promise<{ allocation: boolean | undefined; lock: boolean }> {
  const config = await resolveDatastoreConfig(repoMarker, undefined, repoDir);
  const datastoreResolver = new DefaultDatastorePathResolver(repoDir, config);
  const context = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    datastoreResolver,
  });
  try {
    const modelId = crypto.randomUUID();
    const allocated = await context.unifiedDataRepo.allocateVersion(
      modelType,
      modelId,
      Data.create({
        name: "stream",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "file" },
        ownerDefinition: { ownerType: "manual", ownerRef: "test" },
      }),
    );
    const lock = await createModelLock(config, modelType.normalized, modelId);
    return {
      allocation: allocated.durable,
      lock: (lock as FileLock).syncCreatedDirectories,
    };
  } finally {
    context.catalogStore.close();
  }
}

async function withRepo(fn: (repoDir: string) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-durable-it-" });
  try {
    await withMockedEnv({ SWAMP_DATASTORE: undefined }, () => fn(repoDir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("durable writes: off by default, no writer syncs", async () => {
  await withRepo(async (repoDir) => {
    await withMockedEnv({ SWAMP_DATASTORE_DURABLE: undefined }, async () => {
      assertEquals(
        await writersOf(repoDir, marker(join(repoDir, "ds"))),
        { allocation: false, lock: false },
      );
    });
  });
});

Deno.test("durable writes: durable true in the datastore block turns every writer's syncing on", async () => {
  await withRepo(async (repoDir) => {
    await withMockedEnv({ SWAMP_DATASTORE_DURABLE: "0" }, async () => {
      assertEquals(
        await writersOf(repoDir, marker(join(repoDir, "ds"), true)),
        { allocation: true, lock: true },
      );
    });
  });
});

Deno.test("durable writes: SWAMP_DATASTORE_DURABLE=1 turns syncing on when the block does not say", async () => {
  await withRepo(async (repoDir) => {
    await withMockedEnv({ SWAMP_DATASTORE_DURABLE: "1" }, async () => {
      assertEquals(
        await writersOf(repoDir, marker(join(repoDir, "ds"))),
        { allocation: true, lock: true },
      );
      // The block wins over the env.
      assertEquals(
        await writersOf(repoDir, marker(join(repoDir, "ds2"), false)),
        { allocation: false, lock: false },
      );
    });
  });
});
