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
 * Cross-component integration tests for the serve catalog-store FD-leak fix
 * (swamp-club#1120). These exercise the real serve composition root — the
 * `repoContext` / `datastoreResolver` pair that `handleConnection` injects into
 * every request handler — and lock two invariants that the per-factory unit
 * tests cannot show:
 *
 *  1. Namespace consistency (ADV-1): the shared `repoContext.unifiedDataRepo`
 *     that serve handlers now inject carries the exact namespace the old
 *     per-request factory would have derived from `ctx.datastoreResolver`, so
 *     switching to the injected store shifts no write/read target.
 *  2. Concurrency safety (ADV-2): several affected mutating/evaluating requests
 *     built the handler-way against the single shared catalog connection run
 *     concurrently without error or corruption.
 *
 * The FD-leak itself (a per-request factory opening a *new* file-based catalog
 * store when it should reuse the injected one) is regression-guarded at the
 * unit level: a leaked store and a reused one resolve to the *same* on-disk
 * `_catalog.db` path (the leak is duplicate file descriptors to one file, not
 * new files), so it is only observable as a created-vs-not-created file in an
 * isolated empty repo with an injected store — see the `create*Deps` factory
 * `*_test.ts` files. Here we assert instead that no affected factory opens a
 * store at a *different* (e.g. mis-namespaced) path.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  consumeStream,
  createDataDeleteDeps,
  createDataRenameDeps,
  createLibSwampContext,
  createModelDeleteDeps,
  createModelEvaluateDeps,
  createModelOutputDataDeps,
  createModelOutputLogsDeps,
  createModelValidateDeps,
  createNamespace,
  createRepoInitDeps,
  repoInit,
  SOLO_NAMESPACE,
  withDefaults,
} from "../src/libswamp/mod.ts";
import {
  createRepositoryContext,
  namespaceFromResolver,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withInitializedRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-catalog-reuse-" });
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        { path: repoDir, force: false, version: "20260101.120000.0" },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );
    await fn(repoDir);
  } finally {
    // Best-effort: on Windows EBUSY can fire before V8 GCs native sqlite
    // handles. Temp dir is ephemeral, the OS reclaims it either way.
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

async function countCatalogDbs(root: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      count += await countCatalogDbs(path);
    } else if (entry.name === "_catalog.db") {
      count += 1;
    }
  }
  return count;
}

Deno.test({
  name:
    "serve seam: injected shared repo carries the connection's namespace (solo)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withInitializedRepo(async (repoDir) => {
      const { repoContext, datastoreConfig, repoDir: resolvedRepoDir } =
        await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
      const resolver = new DefaultDatastorePathResolver(
        resolvedRepoDir,
        datastoreConfig,
      );

      // The namespace the old per-request factory would derive from
      // ctx.datastoreResolver must equal the namespace of the shared repo that
      // serve handlers now inject.
      assertEquals(
        repoContext.unifiedDataRepo.namespace,
        namespaceFromResolver(resolver),
      );
      assertEquals(repoContext.unifiedDataRepo.namespace, SOLO_NAMESPACE);
    });
  },
});

Deno.test({
  name:
    "serve seam: injected shared repo carries the connection's namespace (namespaced)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp-catalog-ns-" });
    try {
      const config: DatastoreConfig = {
        type: "filesystem",
        path: repoDir,
        namespace: "security",
      };
      const resolver = new DefaultDatastorePathResolver(repoDir, config);
      const repoContext = createRepositoryContext({
        repoDir,
        namespace: config.namespace,
        datastoreResolver: resolver,
      });

      assertEquals(
        repoContext.unifiedDataRepo.namespace,
        namespaceFromResolver(resolver),
      );
      assertEquals(
        repoContext.unifiedDataRepo.namespace,
        createNamespace("security"),
      );
      repoContext.catalogStore.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "serve seam: affected handlers reuse the shared store across concurrent requests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withInitializedRepo(async (repoDir) => {
      const { repoContext, datastoreConfig, repoDir: resolvedRepoDir } =
        await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
      const resolver = new DefaultDatastorePathResolver(
        resolvedRepoDir,
        datastoreConfig,
      );

      // Build the seven affected deps exactly as their serve handlers now do —
      // injecting the process-scoped shared repo (and catalog store for the two
      // that feed a DataQueryService directly). None of these should open a new
      // store, and none should open one at a different path.
      const buildAllAffectedDeps = () => {
        createModelEvaluateDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
          repoContext.catalogStore,
        );
        createModelValidateDeps(
          resolvedRepoDir,
          undefined,
          resolver,
          repoContext.unifiedDataRepo,
          repoContext.catalogStore,
        );
        createModelDeleteDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
        );
        createModelOutputDataDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
        );
        createModelOutputLogsDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
        );
        createDataDeleteDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
        );
        createDataRenameDeps(
          resolvedRepoDir,
          resolver,
          repoContext.unifiedDataRepo,
        );
      };

      // Concurrently construct deps and drive a real read through the shared
      // catalog connection (evaluate deps -> DataQueryService -> shared store)
      // to confirm the single shared store tolerates concurrent use.
      const REQUESTS = 24;
      const results = await Promise.all(
        Array.from({ length: REQUESTS }, async () => {
          buildAllAffectedDeps();
          const evalDeps = createModelEvaluateDeps(
            resolvedRepoDir,
            resolver,
            repoContext.unifiedDataRepo,
            repoContext.catalogStore,
          );
          return await evalDeps.evaluateAllDefinitions();
        }),
      );

      assertEquals(results.length, REQUESTS);
      // Exactly one file-based catalog store exists — the one the shared
      // repoContext opened. No affected factory opened another (which, if it
      // resolved a different namespaced path, would surface as a second file).
      assertEquals(await countCatalogDbs(resolvedRepoDir), 1);
    });
  },
});
