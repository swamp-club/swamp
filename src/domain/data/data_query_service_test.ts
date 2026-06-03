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
import { ensureDirSync } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { DataQueryService } from "./data_query_service.ts";
import type { DataRecord } from "./data_record.ts";
import { createNamespace } from "./namespace.ts";
import { UserError } from "../errors.ts";

function makeRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: "00000000-0000-1000-8000-000000000001",
    version: 1,
    is_latest: 1,
    model_name: "ingest",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 256,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: '{"type":"resource","specName":"result","modelName":"ingest"}',
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    ...overrides,
  };
}

function setupTest(): {
  catalog: CatalogStore;
  service: DataQueryService;
  dir: string;
} {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated(); // Pre-mark to avoid backfill
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);
  return { catalog, service, dir };
}

Deno.test("DataQueryService: basic modelName filter", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "ingest" }));
  catalog.upsert(
    makeRow({
      data_name: "other",
      model_name: "scanner",
      id: "data-uuid-002",
    }),
  );

  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].modelName, "ingest");
  assertEquals(results[0].name, "my-data");
  catalog.close();
});

Deno.test("DataQueryService: compound predicate", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "ingest", spec_name: "result" }));
  catalog.upsert(
    makeRow({
      data_name: "other",
      model_name: "ingest",
      spec_name: "raw",
      id: "data-uuid-002",
    }),
  );

  const results = service.querySync(
    'modelName == "ingest" && specName == "result"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].specName, "result");
  catalog.close();
});

Deno.test("DataQueryService: tag filter", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(
    makeRow({
      tags: '{"type":"resource","env":"prod"}',
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "staging",
      id: "data-uuid-002",
      tags: '{"type":"resource","env":"staging"}',
    }),
  );

  const results = service.querySync('tags.env == "prod"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].tags["env"], "prod");
  catalog.close();
});

Deno.test("DataQueryService: missing tag is lenient (no error)", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(
    makeRow({
      tags: '{"type":"resource"}',
    }),
  );

  // tags.env doesn't exist on this record — should not match, not error
  const results = service.querySync('tags.env == "prod"') as DataRecord[];
  assertEquals(results.length, 0);
  catalog.close();
});

Deno.test("DataQueryService: unknown root field produces error", () => {
  const { service, catalog } = setupTest();
  catalog.upsert(makeRow());

  assertThrows(
    () => service.querySync('modelname == "ingest"'),
    UserError,
    'Unknown field "modelname"',
  );
  catalog.close();
});

Deno.test("DataQueryService: limit stops early", () => {
  const { catalog, service } = setupTest();
  for (let i = 0; i < 10; i++) {
    catalog.upsert(
      makeRow({
        data_name: `data-${i}`,
        id: `uuid-${i}`,
        model_name: "ingest",
      }),
    );
  }

  const results = service.querySync('modelName == "ingest"', {
    limit: 3,
  }) as DataRecord[];
  assertEquals(results.length, 3);
  catalog.close();
});

Deno.test("DataQueryService: empty results", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "ingest" }));

  const results = service.querySync(
    'modelName == "nonexistent"',
  ) as DataRecord[];
  assertEquals(results.length, 0);
  catalog.close();
});

Deno.test("DataQueryService: boolean and numeric fields", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ streaming: 1, size: 1000 }));
  catalog.upsert(
    makeRow({
      data_name: "small",
      id: "uuid-2",
      streaming: 0,
      size: 50,
    }),
  );

  const streamingResults = service.querySync(
    "streaming == true",
  ) as DataRecord[];
  assertEquals(streamingResults.length, 1);
  assertEquals(streamingResults[0].streaming, true);

  const sizeResults = service.querySync("size > 500") as DataRecord[];
  assertEquals(sizeResults.length, 1);
  assertEquals(sizeResults[0].size, 1000);
  catalog.close();
});

Deno.test("DataQueryService: version filter", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ version: 1, data_name: "a", id: "u1" }));
  catalog.upsert(makeRow({ version: 5, data_name: "b", id: "u2" }));

  const results = service.querySync("version > 3") as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].version, 5);
  catalog.close();
});

Deno.test("DataQueryService: OR predicate", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(
    makeRow({ spec_name: "result", data_name: "a", id: "u1" }),
  );
  catalog.upsert(
    makeRow({ spec_name: "summary", data_name: "b", id: "u2" }),
  );
  catalog.upsert(
    makeRow({ spec_name: "raw", data_name: "c", id: "u3" }),
  );

  const results = service.querySync(
    'specName == "result" || specName == "summary"',
  );
  assertEquals(results.length, 2);
  catalog.close();
});

Deno.test("DataQueryService: attributes filter with content on disk", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-attr-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();

  // Create data on disk so getContentSync can find it
  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-data",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(
    join(dataDir, "raw"),
    JSON.stringify({ status: "failed", count: 42 }),
  );
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "my-data",
      id: "00000000-0000-1000-8000-000000000001",
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  // Write a latest marker
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", "test-model", "model-001", "my-data", "latest"),
    "1",
  );

  catalog.upsert(makeRow());

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  const results = service.querySync(
    'attributes.status == "failed"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].attributes["status"], "failed");
  assertEquals(results[0].attributes["count"], 42);
  catalog.close();
});

Deno.test("DataQueryService: no-attributes predicate skips content", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ content_type: "application/json" }));

  // This predicate doesn't reference attributes, so content should not be loaded
  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  // attributes should be empty since content was not loaded
  assertEquals(results[0].attributes, {});
  catalog.close();
});

Deno.test("DataQueryService: select loads attributes for map literal projection", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-select-attr-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();

  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-data",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(
    join(dataDir, "raw"),
    JSON.stringify({ kernel: "6.1.0", hostname: "test-host" }),
  );
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "my-data",
      id: "00000000-0000-1000-8000-000000000001",
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", "test-model", "model-001", "my-data", "latest"),
    "1",
  );

  catalog.upsert(makeRow());

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Filter doesn't reference attributes, but select does (in a map literal).
  // Without the fix, attributes wouldn't be loaded and CEL would throw "No such key".
  const selectExpr = '{"name": name, "kernel": attributes.kernel}';
  const results = service.querySync('modelName == "ingest"', {
    select: selectExpr,
  });
  assertEquals(results.length, 1);
  // Results are projected — each is a map with name and kernel
  const projected = results[0] as Record<string, unknown>;
  assertEquals(projected["name"], "my-data");
  assertEquals(projected["kernel"], "6.1.0");
  catalog.close();
});

Deno.test("DataQueryService: backfill triggers on unpopulated catalog", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-backfill-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark as populated

  // Create actual data on disk for backfill to find
  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-data",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(
    join(dataDir, "raw"),
    JSON.stringify({ hello: "world" }),
  );
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "my-data",
      id: "00000000-0000-1000-8000-000000000001",
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", "test-model", "model-001", "my-data", "latest"),
    "1",
  );

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Should trigger backfill since catalog is not populated
  const results = await service.query('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].modelName, "ingest");
  assertEquals(catalog.isPopulated(), true);
  catalog.close();
});

Deno.test("DataQueryService: backfill stamps the repo namespace onto rebuilt rows", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-backfill-ns-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark as populated — query must trigger a backfill from disk.

  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-data",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(
    join(dataDir, "raw"),
    JSON.stringify({ hello: "world" }),
  );
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "my-data",
      id: "00000000-0000-1000-8000-000000000001",
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", "test-model", "model-001", "my-data", "latest"),
    "1",
  );

  // Repo configured with a non-solo namespace — the backfill must stamp it.
  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    catalog,
    undefined,
    undefined,
    createNamespace("infra"),
  );
  const service = new DataQueryService(catalog, dataRepo);

  const results = await service.query('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].namespace, "infra");
  catalog.close();
});

// ============================================================================
// Implicit isLatest injection
// ============================================================================

function seedVersions(catalog: CatalogStore): void {
  // Three versions of "my-data"; version 3 is the current latest.
  catalog.upsert(
    makeRow({ version: 1, is_latest: 0, id: "u1", size: 100 }),
  );
  catalog.upsert(
    makeRow({ version: 2, is_latest: 0, id: "u2", size: 200 }),
  );
  catalog.upsert(
    makeRow({ version: 3, is_latest: 1, id: "u3", size: 300 }),
  );
}

Deno.test("DataQueryService: predicate without version or isLatest returns latest only", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].version, 3);
  assertEquals(results[0].isLatest, true);
  catalog.close();
});

Deno.test("DataQueryService: predicate referencing version opts into history", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  const all = service.querySync("version >= 0") as DataRecord[];
  assertEquals(all.length, 3);
  assertEquals(all.map((r) => r.version).sort(), [1, 2, 3]);

  const exact = service.querySync("version == 2") as DataRecord[];
  assertEquals(exact.length, 1);
  assertEquals(exact[0].version, 2);
  assertEquals(exact[0].isLatest, false);

  const range = service.querySync("version > 1") as DataRecord[];
  assertEquals(range.length, 2);
  assertEquals(range.map((r) => r.version).sort(), [2, 3]);
  catalog.close();
});

Deno.test("DataQueryService: isLatest in predicate composes with version filter", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  // "the latest row, but only if its version number is > 1"
  const results = service.querySync(
    "isLatest == true && version > 1",
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].version, 3);
  catalog.close();
});

Deno.test("DataQueryService: string literal containing 'version' does not opt into history", () => {
  const { catalog, service } = setupTest();
  // Two distinct data items so we can tell injection is working.
  catalog.upsert(
    makeRow({
      data_name: "version-report",
      version: 1,
      is_latest: 0,
      id: "vr1",
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "version-report",
      version: 2,
      is_latest: 1,
      id: "vr2",
    }),
  );

  const results = service.querySync(
    'name == "version-report"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].version, 2);
  catalog.close();
});

Deno.test("DataQueryService: explicit isLatest == false returns non-latest versions", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  const results = service.querySync("isLatest == false") as DataRecord[];
  assertEquals(results.length, 2);
  assertEquals(results.map((r) => r.version).sort(), [1, 2]);
  catalog.close();
});

Deno.test("DataQueryService: select version projection with history opt-in", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  const versions = service.querySync("version >= 0", {
    select: "version",
  }) as number[];
  assertEquals(versions.slice().sort((a, b) => a - b), [1, 2, 3]);
  catalog.close();
});

Deno.test("DataQueryService: select version without history opt-in returns latest only", () => {
  const { catalog, service } = setupTest();
  seedVersions(catalog);

  // Projection alone is NOT enough to opt into history.
  const versions = service.querySync('modelName == "ingest"', {
    select: "version",
  }) as number[];
  assertEquals(versions, [3]);
  catalog.close();
});

Deno.test("DataQueryService: catalog backfill works with metadata-only files (no raw)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-lazy-hydration-test-" });
  try {
    // Create the data directory structure with metadata.yaml + latest but NO raw file
    // This simulates lazy hydration state after a metadata-only pull
    const dataDir = join(
      dir,
      ".swamp",
      "data",
      "test",
      "model",
      "my-model-id",
      "lazy-data",
      "1",
    );
    ensureDirSync(dataDir);

    // Write metadata.yaml with all required fields (id, version included)
    const metadata = {
      name: "lazy-data",
      id: "00000000-0000-1000-8000-000000000001",
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "lazy-model" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "test/model:run",
      },
      createdAt: "2026-01-15T10:00:00.000Z",
      size: 42,
      checksum: "abc123",
    };
    Deno.writeTextFileSync(
      join(dataDir, "metadata.yaml"),
      stringifyYaml(metadata as Record<string, unknown>),
    );

    // Write the latest marker pointing to version 1
    const dataNameDir = join(
      dir,
      ".swamp",
      "data",
      "test",
      "model",
      "my-model-id",
      "lazy-data",
    );
    Deno.writeTextFileSync(join(dataNameDir, "latest"), "1");

    // Do NOT create a "raw" file — this is the key: lazy hydration skips raw

    // Create catalog and repo with no pre-populated catalog (forces backfill)
    const dbPath = join(dir, ".swamp", "data", "_catalog.db");
    const catalogObj = new CatalogStore(dbPath);
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalogObj,
    );
    const svc = new DataQueryService(catalogObj, dataRepo);

    // Query with a predicate that doesn't need content — should trigger
    // backfill from metadata.yaml and return the item
    const results = await svc.query("true") as DataRecord[];
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "lazy-data");
    assertEquals(results[0].modelType, "test/model");
    assertEquals(results[0].version, 1);
    assertEquals(results[0].isLatest, true);
    assertEquals(results[0].tags.type, "resource");
    assertEquals(results[0].tags.modelName, "lazy-model");

    catalogObj.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("DataQueryService: ns field is queryable for namespace filtering", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ namespace: "", model_name: "solo-model" }));
  catalog.upsert(
    makeRow({
      namespace: "infra",
      model_name: "infra-model",
      data_name: "infra-data",
      id: "uuid-infra",
    }),
  );
  catalog.upsert(
    makeRow({
      namespace: "security",
      model_name: "sec-model",
      data_name: "sec-data",
      id: "uuid-sec",
    }),
  );

  const infraResults = service.querySync(
    'ns == "infra"',
  ) as DataRecord[];
  assertEquals(infraResults.length, 1);
  assertEquals(infraResults[0].namespace, "infra");
  assertEquals(infraResults[0].modelName, "infra-model");

  const soloResults = service.querySync('ns == ""') as DataRecord[];
  assertEquals(soloResults.length, 1);
  assertEquals(soloResults[0].namespace, "");
  assertEquals(soloResults[0].modelName, "solo-model");

  const allResults = service.querySync(
    'modelName == "solo-model" || modelName == "infra-model" || modelName == "sec-model"',
  ) as DataRecord[];
  assertEquals(allResults.length, 3);

  // ns must also work in select projections
  const projected = service.querySync(
    'ns == "infra"',
    { select: "ns" },
  ) as string[];
  assertEquals(projected.length, 1);
  assertEquals(projected[0], "infra");

  catalog.close();
});

// ── Phase 6d: foreign content fetch ─────────────────────────────────────────

Deno.test("DataQueryService: foreign content fetcher hydrates attributes for foreign rows", async () => {
  const { catalog, service } = setupTest();

  catalog.upsert(makeRow({
    namespace: "security",
    model_name: "scanner",
    data_name: "results",
    content_type: "application/json",
  }));

  const fetchCalls: Array<{ namespace: string; relPath: string }> = [];
  service.setForeignContentFetcher(
    (namespace: string, relPath: string) => {
      fetchCalls.push({ namespace, relPath });
      const content = JSON.stringify({ severity: "high", count: 42 });
      return Promise.resolve(new TextEncoder().encode(content));
    },
  );

  const results = await service.query(
    'modelName == "scanner"',
    { loadAttributes: true },
  ) as DataRecord[];

  assertEquals(results.length, 1);
  assertEquals(results[0].attributes.severity, "high");
  assertEquals(results[0].attributes.count, 42);
  assertEquals(fetchCalls.length, 1);
  assertEquals(fetchCalls[0].namespace, "security");

  catalog.close();
});

Deno.test("DataQueryService: foreign content fetcher caches results across queries", async () => {
  const { catalog, service } = setupTest();

  catalog.upsert(makeRow({
    namespace: "foreign",
    model_name: "model-a",
    data_name: "data-a",
    content_type: "application/json",
  }));

  let fetchCount = 0;
  service.setForeignContentFetcher(() => {
    fetchCount++;
    return Promise.resolve(
      new TextEncoder().encode(JSON.stringify({ cached: true })),
    );
  });

  await service.query('ns == "foreign"', { loadAttributes: true });
  assertEquals(fetchCount, 1);

  // Second query should hit the cache, not fetch again
  await service.query('ns == "foreign"', { loadAttributes: true });
  assertEquals(fetchCount, 1);

  catalog.close();
});

Deno.test("DataQueryService: foreign content fetcher returns null gracefully", async () => {
  const { catalog, service } = setupTest();

  catalog.upsert(makeRow({
    namespace: "unavailable",
    model_name: "missing",
    data_name: "data",
    content_type: "application/json",
  }));

  service.setForeignContentFetcher(() => Promise.resolve(null));

  const results = await service.query(
    'modelName == "missing"',
    { loadAttributes: true },
  ) as DataRecord[];

  assertEquals(results.length, 1);
  assertEquals(Object.keys(results[0].attributes).length, 0);

  catalog.close();
});

Deno.test("DataQueryService: foreign content fetcher does not fire for own namespace", async () => {
  const { catalog, service } = setupTest();

  // Own namespace is "" (solo mode)
  catalog.upsert(makeRow({
    namespace: "",
    model_name: "local",
    data_name: "data",
    content_type: "application/json",
  }));

  let fetched = false;
  service.setForeignContentFetcher(() => {
    fetched = true;
    return Promise.resolve(null);
  });

  await service.query(
    'modelName == "local"',
    { loadAttributes: true },
  );

  assertEquals(fetched, false);

  catalog.close();
});
