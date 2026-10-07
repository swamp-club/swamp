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

// Worker prune deletes a worker model whose auto-definition is kept in the
// datastore, with the model delete deps wired as the worker prune callers wire
// them (swamp-club#3155).

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Definition } from "../src/domain/definitions/definition.ts";
import { WORKER_MODEL_TYPE } from "../src/domain/models/worker/worker_model.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelDeleteDeps,
  modelDelete,
} from "../src/libswamp/models/delete.ts";
import {
  workerPrune,
  type WorkerPruneEvent,
} from "../src/libswamp/worker/prune.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("integration: worker prune deletes a worker auto-definition kept in the datastore (swamp-club#3155)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await Deno.mkdir(repoDir);
    await Deno.mkdir(cacheRoot);
    const datastoreResolver = new DefaultDatastorePathResolver(repoDir, {
      type: "@test/remote",
      config: {},
      datastorePath: join(dir, "remote"),
      cachePath: cacheRoot,
    });
    const repoContext = createRepositoryContext({
      repoDir,
      enableIndexing: false,
      datastoreResolver,
    });
    try {
      // Saved the way the worker model run deps save it.
      const autoRepo = new YamlDefinitionRepository(
        repoDir,
        undefined,
        repoContext.autoDefinitionsDir,
        false,
      );
      const definition = Definition.create({
        name: "worker-w1",
        type: WORKER_MODEL_TYPE.normalized,
        globalArguments: {},
      });
      await autoRepo.save(WORKER_MODEL_TYPE, definition);
      const path = autoRepo.getPath(WORKER_MODEL_TYPE, definition.id);
      assertEquals(path.startsWith(cacheRoot), true);

      // Deps wired as worker prune, serve's worker GC and the serve admin
      // worker prune handler wire them.
      const deleteDeps = createModelDeleteDeps(
        repoDir,
        datastoreResolver,
        undefined,
        repoContext.markDirty,
        repoContext.definitionRepo,
      );

      const ctx = createLibSwampContext();
      const events: WorkerPruneEvent[] = [];
      for await (
        const event of workerPrune(ctx, {
          listWorkers: () =>
            Promise.resolve([{
              name: "w1",
              definitionName: "worker-w1",
              status: "disconnected",
              tokenName: "tok",
              disconnectedAt: new Date(0).toISOString(),
            }]),
          listTokens: () => Promise.resolve([]),
          deleteWorker: (definitionName) =>
            modelDelete(ctx, deleteDeps, {
              modelIdOrName: definitionName,
              force: true,
            }),
          pruneBindings: () => {
            throw new Error("pruneBindings is not expected");
          },
        }, { gracePeriodMs: 0, dryRun: false })
      ) {
        events.push(event);
      }

      assertEquals(
        events.filter((e) => e.kind === "worker_delete_failed"),
        [],
      );
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(
        completed?.kind === "completed" ? completed.result.workersDeleted : 0,
        1,
      );
      assertEquals(await fileExists(path), false);
    } finally {
      repoContext.catalogStore.close();
    }
  });
});
