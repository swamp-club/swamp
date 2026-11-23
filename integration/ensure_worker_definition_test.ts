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
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../src/domain/models/worker/worker_model.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { ensureWorkerDefinition } from "../src/libswamp/worker/ensure_definition.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("ensureWorkerDefinition: creates the worker definition on a v3 datastore, which refuses a write outside a unit", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
      namespace: "team-a",
    };
    const repo = join(dir, "repo");
    await Deno.mkdir(repo, { recursive: true });
    const ctx = createRepositoryContext({
      repoDir: repo,
      enableIndexing: false,
      namespace: "team-a",
      datastoreResolver: new DefaultDatastorePathResolver(repo, config, {
        engine: "v3",
      }),
      ...await v3RepositoryFactoryConfig(repo, config),
    });
    try {
      await ensureWorkerDefinition(repo, ctx, "fleet-ab12cd34");
      const found = await ctx.definitionRepo.findByName(
        WORKER_MODEL_TYPE,
        workerDefinitionName("fleet-ab12cd34"),
      );
      assertEquals(found?.name, workerDefinitionName("fleet-ab12cd34"));
    } finally {
      await closeV3Datastores();
    }
  });
});

Deno.test("ensureWorkerDefinition: signals its write inside a unit of work", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      markDirty: () => Promise.resolve(),
    });
    try {
      await withUnscopedWriteGuard(() =>
        ensureWorkerDefinition(dir, ctx, "ci-runner-3")
      );
    } finally {
      ctx.catalogStore.close();
    }
  });
});
