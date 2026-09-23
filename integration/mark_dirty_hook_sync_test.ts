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

// Repositories wired to a sync service through the real markDirty hook, with
// the datastore cache outside the repo and definitions kept repo-local (no
// managedConfig). Pins that repo-local config sends no dirty signal, so it
// cannot turn a push into a walk of the whole cache, and that a model delete
// sends only per-path signals, so its remote deletes happen (swamp-club#2415).

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { isAbsolute, join } from "@std/path";
import { buildMarkDirtyHook } from "../src/cli/repo_context.ts";
import { Data } from "../src/domain/data/data.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  createLibSwampContext,
  createModelDeleteDeps,
  modelDelete,
} from "../src/libswamp/mod.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";

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

function createRecordingSyncService(): {
  service: DatastoreSyncService;
  marks: Array<string | undefined>;
} {
  const marks: Array<string | undefined> = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      marks.push(options?.relPath);
      return Promise.resolve();
    },
  };
  return { service, marks };
}

function assertCacheRelative(marks: Array<string | undefined>): void {
  for (const relPath of marks) {
    assert(relPath !== undefined, "expected no bare markDirty()");
    assert(
      !relPath.startsWith("..") && !isAbsolute(relPath) &&
        !relPath.includes("\\"),
      `expected a cache-relative forward-slash path, got ${relPath}`,
    );
  }
}

Deno.test("markDirty hook: repo-local definitions send no mark and model delete sends only per-path marks (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await ensureDir(repoDir);
    await ensureDir(cacheRoot);

    const { service, marks } = createRecordingSyncService();
    const markDirty = buildMarkDirtyHook(service, cacheRoot, repoDir);
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
      markDirty,
    });
    try {
      const type = ModelType.create("command/shell");
      const definition = Definition.create({
        name: "hook-probe",
        globalArguments: {},
      });

      // The definition lands in <repo>/models, which the datastore never
      // syncs. Before swamp-club#2415 this sent "../models/...", which the
      // S3 and GCS extensions treat as bulk invalidation.
      await repoContext.definitionRepo.save(type, definition);
      assertEquals(marks, [], "a repo-local definition must send no mark");

      const data = Data.create({
        name: "result",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource" },
        ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
      });
      await repoContext.unifiedDataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode("payload"),
      );
      assertEquals(marks.length, 1);
      assertCacheRelative(marks);
      const dataRelPath = marks[0]!;
      assert(
        dataRelPath.startsWith("data/") && dataRelPath.endsWith("/result"),
        `expected the data-name folder, got ${dataRelPath}`,
      );

      marks.length = 0;
      const deps = createModelDeleteDeps(
        repoDir,
        datastoreResolver,
        repoContext.unifiedDataRepo,
        markDirty,
        repoContext.definitionRepo,
      );
      for await (
        const event of modelDelete(createLibSwampContext(), deps, {
          modelIdOrName: "hook-probe",
          force: true,
        })
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
      }

      // Only per-path marks, so the scoped push sees the deleted version and
      // latest marker absent and deletes them remotely. A bulk mark would
      // skip deletion detection.
      assertCacheRelative(marks);
      assert(
        marks.some((m) => m!.startsWith(`${dataRelPath}/`)),
        `expected a mark under the deleted data folder, got ${marks}`,
      );
      assertEquals(
        await repoContext.definitionRepo.findByName(type, "hook-probe"),
        null,
      );
    } finally {
      repoContext.catalogStore.close();
    }
  });
});
