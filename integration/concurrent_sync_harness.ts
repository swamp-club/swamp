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

// Test helpers for swamp-club#3146: one repo on an in-memory remote, a model
// lock over it, and another connection to the same cache standing in for a
// concurrent run of the same serve process.

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
  type InMemorySyncService,
} from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import type {
  DatastoreSyncService,
  WrittenVersion,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  type ModelLockResult,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

export const DATA_NAME = "state";

export interface Harness {
  remote: InMemoryRemote;
  repoDir: string;
  cachePath: string;
  modelType: ModelType;
  modelId: string;
  context: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;
  /** Another connection to the same cache: one serve process's other run. */
  other: InMemorySyncService;
  /** Takes the model lock, pushing through `syncService` when given. */
  lock: (syncService?: DatastoreSyncService) => Promise<ModelLockResult>;
  /** Writes one version of DATA_NAME, inside a unit of work like a step. */
  write: (content: string) => Promise<number>;
  remoteText: (relPath: string) => string | undefined;
  localLatest: () => Promise<string>;
}

export async function withHarness(
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  const dir = await Deno.makeTempDir({ prefix: "swamp-concurrent-sync-" });
  try {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    await configureTestDatastore(repoDir, typeName);
    const context = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const cachePath = join(repoDir, ".test-cache");
    const modelType = ModelType.create("test/concurrent-sync");
    const modelId = crypto.randomUUID();
    const dataDir = `data/${modelType.normalized}/${modelId}/${DATA_NAME}`;
    await fn({
      remote,
      repoDir,
      cachePath,
      modelType,
      modelId,
      context,
      other: remote.connect(cachePath, { instance: "other-run" }),
      lock: (syncService) =>
        acquireModelLocks(
          context.datastoreConfig,
          [{ modelType: modelType.normalized, modelId }],
          repoDir,
          syncService ?? context.syncService,
          context.repoContext.catalogStore,
          () => {},
          { repoContext: context.repoContext },
        ),
      write: (content) =>
        runInRootUnitOfWork(
          context.repoContext,
          { flush: undefined },
          async () => {
            const data = Data.create({
              name: DATA_NAME,
              contentType: "text/plain",
              lifetime: "infinite",
              garbageCollection: 100,
              tags: { type: "test" },
              ownerDefinition: { ownerType: "manual", ownerRef: "test" },
            });
            const saved = await context.repoContext.unifiedDataRepo.save(
              modelType,
              modelId,
              data,
              new TextEncoder().encode(content),
            );
            return saved.version;
          },
        ),
      remoteText: (relPath) => {
        const bytes = remote.files().get(`${dataDir}/${relPath}`);
        return bytes === undefined
          ? undefined
          : new TextDecoder().decode(bytes);
      },
      localLatest: () => Deno.readTextFile(join(cachePath, dataDir, "latest")),
    });
  } finally {
    await flushDatastoreSync();
    dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

export function written(h: Harness, version: number): WrittenVersion[] {
  return [{
    modelType: h.modelType.normalized,
    modelId: h.modelId,
    dataName: DATA_NAME,
    version,
  }];
}
