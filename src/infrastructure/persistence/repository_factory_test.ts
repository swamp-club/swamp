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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  catalogDbPath,
  createRepositoryContext,
  createUnifiedDataRepository,
  namespaceFromResolver,
  writeCatalogExport,
} from "./repository_factory.ts";
import {
  type CatalogRow,
  CatalogStore,
  ITERATE_PAGE_SIZE,
} from "./catalog_store.ts";
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

// ── writeCatalogExport ────────────────────────────────────────────────────────

function makeRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    namespace: "test-ns",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: "data-uuid-001",
    version: 1,
    is_latest: 1,
    model_name: "test-model-name",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    streaming: 0,
    size: 256,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: '{"type":"resource","specName":"result"}',
    ...overrides,
  };
}

function setupCatalogExportFixture(): {
  store: CatalogStore;
  cachePath: string;
  cleanup: () => void;
} {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-export-test-" });
  const dbPath = join(dir, "_catalog.db");
  const cachePath = join(dir, "cache");
  Deno.mkdirSync(join(cachePath, "test-ns"), { recursive: true });
  const store = new CatalogStore(dbPath);
  return {
    store,
    cachePath,
    cleanup: () => {
      store.close();
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* Windows EBUSY */ }
    },
  };
}

Deno.test("writeCatalogExport: empty namespace produces valid empty JSON array", async () => {
  const { store, cachePath, cleanup } = setupCatalogExportFixture();
  try {
    const count = await writeCatalogExport(store, cachePath, "test-ns");
    assertEquals(count, 0);
    const content = await Deno.readTextFile(
      join(cachePath, "test-ns", ".catalog-export.json"),
    );
    const parsed = JSON.parse(content);
    assertEquals(parsed, []);
  } finally {
    cleanup();
  }
});

Deno.test("writeCatalogExport: single row produces valid JSON array", async () => {
  const { store, cachePath, cleanup } = setupCatalogExportFixture();
  try {
    const row = makeRow();
    store.upsert(row);
    const count = await writeCatalogExport(store, cachePath, "test-ns");
    assertEquals(count, 1);
    const content = await Deno.readTextFile(
      join(cachePath, "test-ns", ".catalog-export.json"),
    );
    const parsed = JSON.parse(content) as CatalogRow[];
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].namespace, "test-ns");
    assertEquals(parsed[0].model_id, "model-001");
    assertEquals(parsed[0].data_name, "my-data");
  } finally {
    cleanup();
  }
});

Deno.test("writeCatalogExport: multi-page namespace produces valid JSON", async () => {
  const { store, cachePath, cleanup } = setupCatalogExportFixture();
  try {
    const totalRows = ITERATE_PAGE_SIZE + 50;
    for (let i = 0; i < totalRows; i++) {
      store.upsert(makeRow({
        data_name: `data-${i}`,
        version: 1,
        id: `uuid-${i}`,
      }));
    }
    const count = await writeCatalogExport(store, cachePath, "test-ns");
    assertEquals(count, totalRows);
    const content = await Deno.readTextFile(
      join(cachePath, "test-ns", ".catalog-export.json"),
    );
    const parsed = JSON.parse(content) as CatalogRow[];
    assertEquals(parsed.length, totalRows);
  } finally {
    cleanup();
  }
});

Deno.test("writeCatalogExport: round-trip equivalence with direct iteration", async () => {
  const { store, cachePath, cleanup } = setupCatalogExportFixture();
  try {
    for (let i = 0; i < 5; i++) {
      store.upsert(makeRow({
        data_name: `item-${i}`,
        version: 1,
        id: `uuid-${i}`,
        size: i * 100,
      }));
    }
    await writeCatalogExport(store, cachePath, "test-ns");
    const content = await Deno.readTextFile(
      join(cachePath, "test-ns", ".catalog-export.json"),
    );
    const exported = JSON.parse(content) as CatalogRow[];
    const direct = [...store.iterateNamespace("test-ns")];
    assertEquals(exported.length, direct.length);
    for (let i = 0; i < exported.length; i++) {
      assertEquals(exported[i], direct[i]);
    }
  } finally {
    cleanup();
  }
});

Deno.test("writeCatalogExport: yields event loop between pages", async () => {
  const { store, cachePath, cleanup } = setupCatalogExportFixture();
  try {
    const totalRows = ITERATE_PAGE_SIZE * 2 + 1;
    for (let i = 0; i < totalRows; i++) {
      store.upsert(makeRow({
        data_name: `data-${i}`,
        version: 1,
        id: `uuid-${i}`,
      }));
    }
    let callbackRanDuringExport = false;
    const exportPromise = writeCatalogExport(store, cachePath, "test-ns");
    setTimeout(() => {
      callbackRanDuringExport = true;
    }, 0);
    await exportPromise;
    assert(
      callbackRanDuringExport,
      "setTimeout(0) callback should run during multi-page export",
    );
  } finally {
    cleanup();
  }
});
