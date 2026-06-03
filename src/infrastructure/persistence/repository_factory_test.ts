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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  catalogDbPath,
  createRepositoryContext,
  createUnifiedDataRepository,
  namespaceFromResolver,
} from "./repository_factory.ts";
import { CatalogStore } from "./catalog_store.ts";
import {
  createNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { DefaultDatastorePathResolver } from "./default_datastore_path_resolver.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

function tempRepoDir(): string {
  return Deno.makeTempDirSync({ prefix: "swamp-factory-test-" });
}

Deno.test("createRepositoryContext: resolves config namespace into the repository", () => {
  const dir = tempRepoDir();
  const ctx = createRepositoryContext({
    repoDir: dir,
    enableIndexing: false,
    namespace: "infra",
  });
  assertEquals(ctx.unifiedDataRepo.namespace, "infra");
  ctx.catalogStore.close();
});

Deno.test("createRepositoryContext: defaults to SOLO_NAMESPACE when no namespace is configured", () => {
  const dir = tempRepoDir();
  const ctx = createRepositoryContext({
    repoDir: dir,
    enableIndexing: false,
  });
  assertEquals(ctx.unifiedDataRepo.namespace, SOLO_NAMESPACE);
  ctx.catalogStore.close();
});

Deno.test("createRepositoryContext: rejects a malformed namespace slug", () => {
  const dir = tempRepoDir();
  assertThrows(
    () =>
      createRepositoryContext({
        repoDir: dir,
        enableIndexing: false,
        namespace: "Not Valid",
      }),
    Error,
    "Namespace must match",
  );
});

Deno.test("createUnifiedDataRepository: passes the namespace through to the repository", () => {
  const dir = tempRepoDir();
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = createUnifiedDataRepository(
    dir,
    catalog,
    undefined,
    undefined,
    createNamespace("security"),
  );
  assertEquals(repo.namespace, "security");
  catalog.close();
});

Deno.test("createUnifiedDataRepository: defaults to SOLO_NAMESPACE", () => {
  const dir = tempRepoDir();
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = createUnifiedDataRepository(dir, catalog);
  assertEquals(repo.namespace, SOLO_NAMESPACE);
  catalog.close();
});

// ── Giga-swamp catalog is repo-local (Phase 3, Decision 1a) ─────────────────

Deno.test("catalogDbPath: repo-local for a default (no datastore) repo", () => {
  assertPathEquals(catalogDbPath("/repo"), "/repo/.swamp/data/_catalog.db");
});

Deno.test("catalogDbPath: repo-local even with an external filesystem datastore", () => {
  const config: DatastoreConfig = { type: "filesystem", path: "/shared/ds" };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // Catalog stays under .swamp/data — NOT in the (shared) datastore dir.
  assertPathEquals(
    catalogDbPath("/repo", resolver),
    "/repo/.swamp/data/_catalog.db",
  );
});

Deno.test("catalogDbPath: repo-local and identical with vs without a namespace", () => {
  const solo: DatastoreConfig = { type: "filesystem", path: "/shared/ds" };
  const namespaced: DatastoreConfig = {
    type: "filesystem",
    path: "/shared/ds",
    namespace: "infra",
  };
  const soloPath = catalogDbPath(
    "/repo",
    new DefaultDatastorePathResolver("/repo", solo),
  );
  const nsPath = catalogDbPath(
    "/repo",
    new DefaultDatastorePathResolver("/repo", namespaced),
  );
  assertPathEquals(soloPath, "/repo/.swamp/data/_catalog.db");
  // The namespace must NOT partition or relocate the catalog.
  assertPathEquals(nsPath, soloPath);
});

Deno.test("catalogDbPath: repo-local for a custom (S3) datastore", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "b" },
    datastorePath: "/home/user/.swamp/repos/abc",
    cachePath: "/home/user/.swamp/repos/abc",
    namespace: "platform",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertPathEquals(
    catalogDbPath("/repo", resolver),
    "/repo/.swamp/data/_catalog.db",
  );
});

Deno.test("namespaceFromResolver: derives the configured namespace value", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/ds",
    namespace: "security",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(namespaceFromResolver(resolver), createNamespace("security"));
});

Deno.test("namespaceFromResolver: SOLO_NAMESPACE for no resolver or empty namespace", () => {
  assertEquals(namespaceFromResolver(undefined), SOLO_NAMESPACE);
  const solo = new DefaultDatastorePathResolver("/repo", {
    type: "filesystem",
    path: "/ds",
  });
  assertEquals(namespaceFromResolver(solo), SOLO_NAMESPACE);
});
