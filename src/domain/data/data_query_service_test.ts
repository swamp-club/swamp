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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import {
  computeLatestFlags,
  type DataQueryOptions,
  DataQueryService,
  type ModelReferenceResolver,
  type ResolvedModelReference,
} from "./data_query_service.ts";
import type { DataRecord } from "./data_record.ts";
import { createNamespace } from "./namespace.ts";
import { UserError } from "../errors.ts";
import { BinaryContentPredicateError } from "./binary_content_predicate_error.ts";
import { ModelType } from "../models/model_type.ts";
import { Data } from "./data.ts";

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
    garbage_collection: "10",
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
    // Rows default to a step latest exactly when they are latest.
    is_step_latest: overrides.is_step_latest ?? overrides.is_latest ?? 1,
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

Deno.test("DataQueryService: garbageCollection filters count and duration policies", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ data_name: "count", garbage_collection: "5" }));
  catalog.upsert(
    makeRow({
      data_name: "duration",
      garbage_collection: "7d",
      id: "data-uuid-002",
    }),
  );

  const names = (predicate: string) =>
    (service.querySync(predicate) as DataRecord[]).map((r) => r.name).sort();

  assertEquals(names("garbageCollection == 5"), ["count"]);
  assertEquals(names('garbageCollection == "7d"'), ["duration"]);
  // Ordering a duration row against an int throws, which skips that row;
  // the type guard keeps the comparison to count policies.
  assertEquals(
    names("type(garbageCollection) != string && garbageCollection < 10"),
    ["count"],
  );
  assertEquals(
    service.querySync('name == "duration"', { select: "garbageCollection" }),
    ["7d"],
  );
  catalog.close();
});

Deno.test("DataQueryService: specName equality filters through the SQL pushdown", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ spec_name: "result" }));
  catalog.upsert(
    makeRow({ data_name: "other", spec_name: "raw", id: "data-uuid-002" }),
  );

  const results = service.querySync(
    'specName == "raw" && size > 0',
  ) as DataRecord[];
  assertEquals(results.map((r) => r.name), ["other"]);
  catalog.close();
});

Deno.test("DataQueryService.specNameFallback: swaps name for specName and keeps scoping", () => {
  const { catalog, service } = setupTest();
  assertEquals(
    service.specNameFallback(
      'workflowRunId == "run-1" && name == "classification"',
    ),
    {
      specNamePredicate:
        'workflowRunId == "run-1" && specName == "classification"',
      namePredicate: 'workflowRunId == "run-1" && name == "classification"',
      droppedConjuncts: false,
    },
  );
  assertEquals(service.specNameFallback('modelName == "m"'), null);
  assertEquals(service.specNameFallback("name == "), null, "unparseable");
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

Deno.test("DataQueryService: no-attributes predicate hydrates matched results", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-hydrate-" });
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
    JSON.stringify({ status: "ok", count: 7 }),
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

  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].attributes["status"], "ok");
  assertEquals(results[0].attributes["count"], 7);
  catalog.close();
});

Deno.test("DataQueryService: select projection skips hydration", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ content_type: "application/json" }));

  const results = service.querySync('modelName == "ingest"', {
    select: "name",
  }) as string[];
  assertEquals(results.length, 1);
  assertEquals(results[0], "my-data");
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

Deno.test("DataQueryService: select coerces CEL BigInt to number", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-select-bigint-" });
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
    JSON.stringify({ items: ["a", "b", "c"] }),
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

  const results = service.querySync('modelName == "ingest"', {
    select: "attributes.items.size()",
  });
  assertEquals(results.length, 1);
  assertEquals(results[0], 3);
  assertEquals(typeof results[0], "number");

  const mapResults = service.querySync('modelName == "ingest"', {
    select: '{"len": attributes.items.size()}',
  });
  assertEquals(mapResults.length, 1);
  const projected = mapResults[0] as Record<string, unknown>;
  assertEquals(projected["len"], 3);
  assertEquals(typeof projected["len"], "number");

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
  assertEquals(results[0].garbageCollection, 10, "backfill carries GC");
  assertEquals(catalog.isPopulated(), true);
  catalog.close();
});

Deno.test("DataQueryService: backfill preserves catalog rows the walk cannot see", async () => {
  const dir = Deno.makeTempDirSync({
    prefix: "swamp-query-backfill-preserve-",
  });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);

  // Seed a row that represents data in the remote datastore but not on local
  // disk (e.g. lazy hydration — metadata not yet pulled).
  catalog.upsert(makeRow({
    data_name: "remote-only",
    id: "00000000-0000-1000-8000-000000000099",
  }));
  // Do NOT mark as populated — the next query must trigger backfill.

  // Create one data item on disk for the walk to find.
  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "on-disk",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(
    join(dataDir, "raw"),
    JSON.stringify({ found: true }),
  );
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "on-disk",
      id: "00000000-0000-1000-8000-000000000002",
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
    join(dir, ".swamp", "data", "test-model", "model-001", "on-disk", "latest"),
    "1",
  );

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Backfill runs — the walk finds "on-disk" but NOT "remote-only".
  // With additive upsert, "remote-only" must survive.
  const results = await service.query("true") as DataRecord[];
  const names = results.map((r) => r.name).sort();
  assertEquals(names, ["on-disk", "remote-only"]);
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

// ── Scoped backfill tests (issue #919) ─────────────────────────────────────

function createOnDiskData(
  dir: string,
  typeNormalized: string,
  modelId: string,
  dataName: string,
  modelName: string,
  version = 1,
): void {
  const versionDir = join(
    dir,
    ".swamp",
    "data",
    typeNormalized,
    modelId,
    dataName,
    String(version),
  );
  ensureDirSync(versionDir);
  Deno.writeTextFileSync(
    join(versionDir, "raw"),
    JSON.stringify({ value: `${modelName}/${dataName}` }),
  );
  Deno.writeTextFileSync(
    join(versionDir, "metadata.yaml"),
    stringifyYaml({
      name: dataName,
      id: "00000000-0000-1000-8000-000000000001",
      version,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: false,
      tags: { type: "resource", specName: dataName, modelName },
      ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", typeNormalized, modelId, dataName, "latest"),
    String(version),
  );
}

Deno.test("getLatestRecord: check-first returns write-through row without backfill", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-scoped-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated — simulates invalidated catalog

  // Create data on disk + upsert via write-through
  createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest");
  catalog.upsertNewVersion(makeRow());

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  const record = await service.getLatestRecord("ingest", "my-data");
  assertNotEquals(record, null);
  assertEquals(record!.name, "my-data");
  assertEquals(record!.modelName, "ingest");

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: loads text content for non-JSON artifacts", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-text-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));

  createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest");
  Deno.writeTextFileSync(
    join(
      dir,
      ".swamp",
      "data",
      "test-model",
      "model-001",
      "my-data",
      "1",
      "raw",
    ),
    "hello",
  );
  catalog.upsertNewVersion(makeRow({ content_type: "text/plain" }));

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  const record = await service.getLatestRecord("ingest", "my-data");
  assertEquals(record!.content, "hello");

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: stale row falls through to scoped backfill", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-scoped-stale-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated

  // Create a catalog row WITHOUT corresponding on-disk data (stale row)
  catalog.upsertNewVersion(makeRow({
    type_normalized: "stale-type",
    model_id: "stale-model",
    data_name: "stale-data",
    model_name: "stale-model-name",
  }));

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Should detect stale row and return null (no on-disk data to find)
  const record = await service.getLatestRecord(
    "stale-model-name",
    "stale-data",
  );
  assertEquals(record, null);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: hydrates a lazily-synced row instead of treating it as stale", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-lazy-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  // Do NOT mark populated — a datastore sync invalidates the catalog.

  // A lazy-hydration datastore syncs metadata.yaml but not raw.
  createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest");
  const rawPath = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-data",
    "1",
    "raw",
  );
  const remoteBytes = Deno.readFileSync(rawPath);
  Deno.removeSync(rawPath);
  catalog.upsertNewVersion(makeRow());

  const hydrated: string[] = [];
  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    catalog,
    undefined,
    async (absPath: string) => {
      hydrated.push(absPath);
      await Deno.writeFile(absPath, remoteBytes);
      return true;
    },
  );
  const service = new DataQueryService(catalog, dataRepo);

  const record = await service.getLatestRecord("ingest", "my-data");
  assertNotEquals(record, null);
  assertEquals(record!.attributes, { value: "ingest/my-data" });
  assertEquals(hydrated.length, 1);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: a row whose content is missing remotely is still stale", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-lazy-gone-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));

  createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest");
  Deno.removeSync(
    join(
      dir,
      ".swamp",
      "data",
      "test-model",
      "model-001",
      "my-data",
      "1",
      "raw",
    ),
  );
  catalog.upsertNewVersion(makeRow());

  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    catalog,
    undefined,
    () => Promise.resolve(false),
  );
  const service = new DataQueryService(catalog, dataRepo);

  assertEquals(await service.getLatestRecord("ingest", "my-data"), null);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: scoped backfill finds orphan data without full backfill", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-scoped-orphan-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated

  // Create multiple data items on disk — only one is the target
  createOnDiskData(
    dir,
    "type-a",
    "00000000-0000-4000-8000-000000000001",
    "result",
    "model-a",
  );
  createOnDiskData(
    dir,
    "type-b",
    "00000000-0000-4000-8000-000000000002",
    "result",
    "model-b",
  );
  createOnDiskData(
    dir,
    "type-orphan",
    "00000000-0000-4000-8000-000000000003",
    "orphan-output",
    "orphan-model",
  );

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Look up the orphan data — should find it via scoped backfill
  const record = await service.getLatestRecord("orphan-model", "orphan-output");
  assertNotEquals(record, null);
  assertEquals(record!.name, "orphan-output");
  assertEquals(record!.modelName, "orphan-model");

  // Catalog should NOT be marked as populated (scoped backfill doesn't set it)
  assertEquals(catalog.isPopulated(), false);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: query() still triggers full backfill independently", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-scoped-query-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated

  createOnDiskData(
    dir,
    "type-a",
    "00000000-0000-4000-8000-000000000011",
    "result",
    "model-a",
  );
  createOnDiskData(
    dir,
    "type-b",
    "00000000-0000-4000-8000-000000000012",
    "output",
    "model-b",
  );

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // getLatestRecord for one item — scoped backfill
  const record = await service.getLatestRecord("model-a", "result");
  assertNotEquals(record, null);
  assertEquals(catalog.isPopulated(), false);

  // query() should trigger full backfill and find ALL data
  const results = await service.query('modelName == "model-b"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].modelName, "model-b");
  assertEquals(catalog.isPopulated(), true);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: populated catalog returns null for missing data", async () => {
  const { catalog, service } = setupTest();
  // setupTest calls markPopulated — catalog is populated

  const record = await service.getLatestRecord("nonexistent", "missing");
  assertEquals(record, null);

  catalog.close();
});

Deno.test("getLatestRecord: namespace filtering works in scoped path", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-scoped-ns-test-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated

  // Create data on disk + catalog row with specific namespace
  createOnDiskData(dir, "type-a", "model-aaa", "result", "model-a");
  catalog.upsertNewVersion(makeRow({
    namespace: "team-alpha",
    type_normalized: "type-a",
    model_id: "model-aaa",
    data_name: "result",
    model_name: "model-a",
  }));

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // Lookup with matching namespace — should find
  const found = await service.getLatestRecord(
    "model-a",
    "result",
    "team-alpha",
  );
  assertNotEquals(found, null);

  // Lookup with wrong namespace — should not find
  const notFound = await service.getLatestRecord(
    "model-a",
    "result",
    "team-beta",
  );
  assertEquals(notFound, null);

  catalog.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("getLatestRecord: exact data name skips specName ambiguity check (swamp-club#1838)", async () => {
  const { catalog, service } = setupTest();

  // Two data items with different names but the same specName "state"
  catalog.upsert(
    makeRow({
      data_name: "hs",
      spec_name: "state",
      id: "00000000-0000-1000-8000-000000001838",
      tags: '{"type":"resource","specName":"state","modelName":"ingest"}',
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "learning",
      spec_name: "state",
      id: "00000000-0000-1000-8000-000000001839",
      tags: '{"type":"resource","specName":"state","modelName":"ingest"}',
    }),
  );

  // Calling with exact data name "hs" must NOT throw — the caller is
  // unambiguously requesting a specific data item, not a specName.
  const record = await service.getLatestRecord("ingest", "hs");
  assertNotEquals(record, null);
  assertEquals(record!.name, "hs");

  catalog.close();
});

Deno.test("getLatestRecord: dataName matching specName still throws on ambiguity", async () => {
  const { catalog, service } = setupTest();

  // Data name "state" matches its own specName "state" — ambiguity check fires
  catalog.upsert(
    makeRow({
      data_name: "state",
      spec_name: "state",
      id: "00000000-0000-1000-8000-000000001840",
      tags: '{"type":"resource","specName":"state","modelName":"ingest"}',
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "learning",
      spec_name: "state",
      id: "00000000-0000-1000-8000-000000001841",
      tags: '{"type":"resource","specName":"state","modelName":"ingest"}',
    }),
  );

  await assertRejects(
    () => service.getLatestRecord("ingest", "state"),
    Error,
    "Ambiguous data.latest() match",
  );

  catalog.close();
});

// ---------------------------------------------------------------------------
// SQL pushdown tests — verify that pushdown produces identical results to
// full CEL evaluation for all predicate shapes.
// ---------------------------------------------------------------------------

Deno.test("DataQueryService pushdown: isLatest pushdown returns same results as CEL-only", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "a", is_latest: 1 }));
  catalog.upsert(
    makeRow({
      data_name: "old",
      model_name: "a",
      is_latest: 0,
      version: 1,
      id: "uuid-old",
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "other",
      model_name: "b",
      is_latest: 1,
      id: "uuid-b",
    }),
  );

  const results = service.querySync('modelName == "a"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].modelName, "a");
  assertEquals(results[0].isLatest, true);
  catalog.close();
});

Deno.test("DataQueryService pushdown: modelName equality narrows scan", () => {
  const { catalog, service } = setupTest();
  for (let i = 0; i < 50; i++) {
    catalog.upsert(
      makeRow({
        data_name: `data-${i}`,
        model_name: i < 5 ? "target" : "other",
        id: `uuid-${i}`,
      }),
    );
  }

  const results = service.querySync(
    'modelName == "target"',
  ) as DataRecord[];
  assertEquals(results.length, 5);
  for (const r of results) {
    assertEquals(r.modelName, "target");
  }
  catalog.close();
});

Deno.test("DataQueryService pushdown: compound modelName + specName", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "m1", spec_name: "result" }));
  catalog.upsert(
    makeRow({
      data_name: "d2",
      model_name: "m1",
      spec_name: "log",
      id: "uuid-2",
    }),
  );
  catalog.upsert(
    makeRow({
      data_name: "d3",
      model_name: "m2",
      spec_name: "result",
      id: "uuid-3",
    }),
  );

  const results = service.querySync(
    'modelName == "m1" && specName == "result"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].modelName, "m1");
  assertEquals(results[0].specName, "result");
  catalog.close();
});

Deno.test("DataQueryService pushdown: version opt-in skips isLatest pushdown", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(
    makeRow({ model_name: "a", version: 1, is_latest: 0, id: "uuid-v1" }),
  );
  catalog.upsert(
    makeRow({ model_name: "a", version: 2, is_latest: 1, id: "uuid-v2" }),
  );

  const all = service.querySync("version >= 0") as DataRecord[];
  assertEquals(all.length, 2);

  const latest = service.querySync("version == 2") as DataRecord[];
  assertEquals(latest.length, 1);
  assertEquals(latest[0].version, 2);
  catalog.close();
});

Deno.test("DataQueryService pushdown: OR predicate falls back to full scan", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ model_name: "a", id: "uuid-a" }));
  catalog.upsert(
    makeRow({ data_name: "d2", model_name: "b", id: "uuid-b" }),
  );
  catalog.upsert(
    makeRow({ data_name: "d3", model_name: "c", id: "uuid-c" }),
  );

  const results = service.querySync(
    'modelName == "a" || modelName == "b"',
  ) as DataRecord[];
  assertEquals(results.length, 2);
  const names = results.map((r) => r.modelName).sort();
  assertEquals(names, ["a", "b"]);
  catalog.close();
});

Deno.test("DataQueryService pushdown: limit interacts correctly with pushdown", () => {
  const { catalog, service } = setupTest();
  for (let i = 0; i < 10; i++) {
    catalog.upsert(
      makeRow({
        data_name: `data-${i}`,
        model_name: "target",
        id: `uuid-${i}`,
      }),
    );
  }

  const results = service.querySync('modelName == "target"', {
    limit: 3,
  }) as DataRecord[];
  assertEquals(results.length, 3);
  catalog.close();
});

Deno.test("DataQueryService: content.field works as alias for attributes.field in predicate", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-content-alias-" });
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
    JSON.stringify({ status: "ok", count: 7 }),
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

  const results = service.querySync(
    'content.status == "ok"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].attributes["status"], "ok");
  assertEquals(results[0].attributes["count"], 7);
  catalog.close();
});

Deno.test("DataQueryService: content.field works in --select projection", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-content-select-" });
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
    JSON.stringify({ kernel: "6.1", arch: "x86_64" }),
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

  const projected = service.querySync(
    'modelName == "ingest"',
    { select: '{"k": content.kernel}' },
  ) as Record<string, unknown>[];
  assertEquals(projected.length, 1);
  assertEquals(projected[0], { k: "6.1" });
  catalog.close();
});

Deno.test("DataQueryService: content stays raw string for non-JSON records", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-content-text-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();

  const dataDir = join(
    dir,
    ".swamp",
    "data",
    "test-model",
    "model-001",
    "my-log",
    "1",
  );
  ensureDirSync(dataDir);
  Deno.writeTextFileSync(join(dataDir, "raw"), "hello world");
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: "my-log",
      id: "00000000-0000-1000-8000-000000000002",
      version: 1,
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "file", specName: "log", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(
    join(dir, ".swamp", "data", "test-model", "model-001", "my-log", "latest"),
    "1",
  );

  catalog.upsert(makeRow({
    data_name: "my-log",
    id: "00000000-0000-1000-8000-000000000002",
    content_type: "text/plain",
    spec_name: "log",
    data_type: "file",
    streaming: 1,
  }));

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  const results = service.querySync(
    'content == "hello world"',
  ) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].content, "hello world");
  catalog.close();
});

// ============================================================================
// Backfill must not delete rows for models the predicate never mentions.
//
// Full backfill commits with a replace, not an insert, so any model the disk
// walk fails to see is deleted from the catalog rather than merely left
// unindexed. A model whose data names are bare integers used to be invisible to
// that walk, which meant *any* query — including one matching nothing — wiped
// its rows. See swamp-club#1580.
//
// The type must be scoped (`@scope/name`) to reproduce: with a single-segment
// type the misclassified branch is skipped by the `childSegments.length >= 2`
// guard in collectAllData, so only multi-segment types are affected — which is
// every model that comes from an extension.
// ============================================================================

Deno.test("DataQueryService: a non-matching query preserves rows for models with numeric data names", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-numeric-names-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  // Do NOT mark populated — the query must trigger a full backfill, which is
  // the destructive path.

  const numericNames = ["207333", "124364"];
  for (const [index, name] of numericNames.entries()) {
    const dataDir = join(
      dir,
      ".swamp",
      "data",
      "@scope",
      "shows",
      "model-001",
      name,
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
        name,
        id: `00000000-0000-1000-8000-00000000010${index}`,
        version: 1,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "resource", specName: "result", modelName: "shows" },
        ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    Deno.writeTextFileSync(
      join(
        dir,
        ".swamp",
        "data",
        "@scope",
        "shows",
        "model-001",
        name,
        "latest",
      ),
      "1",
    );
  }

  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  // A predicate that matches nothing at all, and never mentions this model.
  const results = await service.query(
    'name == "__nonexistent__"',
  ) as DataRecord[];
  assertEquals(results.length, 0);

  // The query returning nothing is correct. Deleting the rows is the bug.
  assertEquals(
    catalog.count(),
    numericNames.length,
    "backfill dropped rows for a model the predicate never mentioned",
  );

  catalog.close();
});

Deno.test("DataQueryService: skips stale catalog rows with missing backing files (swamp-club#1737)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-stale-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo, {
    filterStaleRows: true,
  });

  // Insert a catalog row whose backing file does NOT exist on disk.
  const staleRow = makeRow({
    model_name: "story-analyzer",
    data_name: "analysis",
    type_normalized: "test/stale-type",
    model_id: "stale-model-id",
    version: 27,
    is_latest: 1,
  });
  catalog.upsert(staleRow);

  // Insert a live row WITH a backing file on disk.
  const liveRow = makeRow({
    model_name: "story-analyzer",
    data_name: "analysis",
    type_normalized: "test/live-type",
    model_id: "live-model-id",
    version: 1,
    is_latest: 1,
    id: "00000000-0000-1000-8000-000000000002",
  });
  catalog.upsert(liveRow);

  // Create the backing file for the live row only.
  const livePath = join(
    dir,
    ".swamp",
    "data",
    "test",
    "live-type",
    "live-model-id",
    "analysis",
    "1",
  );
  ensureDirSync(livePath);
  Deno.writeTextFileSync(
    join(livePath, "raw"),
    JSON.stringify({ result: "live data" }),
  );

  const results = service.querySync(
    'modelName == "story-analyzer"',
  ) as DataRecord[];

  // Only the live row should be returned; the stale row is skipped.
  assertEquals(
    results.length,
    1,
    "stale row with missing backing file must be skipped",
  );
  assertEquals(results[0].modelId, "live-model-id");
  assertEquals(results[0].version, 1);

  catalog.close();
});

Deno.test("DataQueryService: filterStaleRows disabled preserves rows with missing backing files (remote datastore)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-no-stale-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo, {
    filterStaleRows: false,
  });

  catalog.upsert(makeRow({
    model_name: "remote-model",
    data_name: "state-main",
    type_normalized: "test/remote-type",
    model_id: "remote-model-id",
    version: 1,
    is_latest: 1,
    id: "00000000-0000-1000-8000-000000000077",
  }));

  const results = service.querySync(
    'modelName == "remote-model"',
  ) as DataRecord[];

  assertEquals(
    results.length,
    1,
    "rows with missing backing files must be kept when filterStaleRows is disabled",
  );
  assertEquals(results[0].modelId, "remote-model-id");

  catalog.close();
});

Deno.test("DataQueryService: filterStaleRows skips foreign namespace rows (no local backing file expected)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-foreign-stale-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo, {
    filterStaleRows: true,
  });

  // Foreign namespace row — no backing file on disk (catalog-only pull).
  catalog.upsert(makeRow({
    namespace: "infra",
    model_name: "scanner",
    data_name: "results",
    type_normalized: "test/foreign",
    model_id: "foreign-model-id",
    version: 1,
    is_latest: 1,
    id: "00000000-0000-1000-8000-000000000099",
  }));

  // The repo's own namespace is "" (solo mode). The foreign row's namespace
  // ("infra") differs, so filterStaleRows must NOT stat-check it.
  const results = service.querySync(
    'modelName == "scanner"',
  ) as DataRecord[];

  assertEquals(
    results.length,
    1,
    "foreign namespace rows must not be filtered as stale",
  );
  assertEquals(results[0].namespace, "infra");
  assertEquals(results[0].modelId, "foreign-model-id");

  catalog.close();
});

// --- computeLatestFlags tests ---

/** Returns `version:is_latest:is_step_latest` for each row, in input order. */
function flags(rows: CatalogRow[]): string[] {
  return rows.map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

Deno.test("computeLatestFlags: model-method write demotes all prior step outputs", () => {
  const rows: CatalogRow[] = [
    makeRow({ version: 1, step_name: "step-a" }),
    makeRow({ version: 2, step_name: "step-b" }),
    makeRow({ version: 3, step_name: "" }),
  ];
  computeLatestFlags(rows);

  assertEquals(flags(rows), ["1:0:0", "2:0:0", "3:1:1"]);
});

Deno.test("computeLatestFlags: different workflow steps keep independent step latests above watermark", () => {
  const rows: CatalogRow[] = [
    makeRow({ version: 1, step_name: "" }),
    makeRow({ version: 2, step_name: "step-a" }),
    makeRow({ version: 3, step_name: "step-b" }),
  ];
  computeLatestFlags(rows);

  // swamp-club#2520: one is_latest per name; each step keeps its latest.
  assertEquals(flags(rows), ["1:0:0", "2:0:1", "3:1:1"]);
});

Deno.test("computeLatestFlags: rows below global watermark are demoted", () => {
  const rows: CatalogRow[] = [
    makeRow({ version: 1, step_name: "" }),
    makeRow({ version: 2, step_name: "step-a" }),
    makeRow({ version: 3, step_name: "" }),
    makeRow({ version: 4, step_name: "step-b" }),
  ];
  computeLatestFlags(rows);

  assertEquals(flags(rows), ["1:0:0", "2:0:0", "3:0:0", "4:1:1"]);
});

Deno.test("computeLatestFlags: no model-method rows means each step gets own step latest", () => {
  const rows: CatalogRow[] = [
    makeRow({ version: 1, step_name: "step-a" }),
    makeRow({ version: 2, step_name: "step-a" }),
    makeRow({ version: 3, step_name: "step-b" }),
  ];
  computeLatestFlags(rows);

  assertEquals(flags(rows), ["1:0:0", "2:0:1", "3:1:1"]);
});

Deno.test("computeLatestFlags: model-method as latest version demotes everything", () => {
  const rows: CatalogRow[] = [
    makeRow({ version: 1, step_name: "step-a" }),
    makeRow({ version: 2, step_name: "step-b" }),
    makeRow({ version: 3, step_name: "" }),
  ];
  computeLatestFlags(rows);

  const latestRows = rows.filter((r) => r.is_latest === 1);
  assertEquals(latestRows.length, 1);
  assertEquals(latestRows[0].version, 3);
  assertEquals(latestRows[0].step_name, "");
  assertEquals(rows.filter((r) => r.is_step_latest === 1).length, 1);
});

Deno.test("computeLatestFlags: different namespaces keep independent is_latest", () => {
  const rows: CatalogRow[] = [
    makeRow({ namespace: "local", version: 1 }),
    makeRow({ namespace: "foreign", version: 3 }),
  ];
  computeLatestFlags(rows);

  assertEquals(rows[0].is_latest, 1);
  assertEquals(rows[1].is_latest, 1);
});

Deno.test("computeLatestFlags: different type_normalized keep independent is_latest", () => {
  const rows: CatalogRow[] = [
    makeRow({ type_normalized: "model-a", version: 1 }),
    makeRow({ type_normalized: "model-b", version: 3 }),
  ];
  computeLatestFlags(rows);

  assertEquals(rows[0].is_latest, 1);
  assertEquals(rows[1].is_latest, 1);
});

// --- Lazy body loading (swamp-club#2122) ---

/** Counts body reads per data name and throws for names marked unreadable. */
class TracingDataRepository extends FileSystemUnifiedDataRepository {
  readonly reads = new Map<string, number>();
  readonly unreadable = new Set<string>();

  override getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null {
    this.reads.set(dataName, (this.reads.get(dataName) ?? 0) + 1);
    if (this.unreadable.has(dataName)) {
      throw new Deno.errors.PermissionDenied(`cannot read ${dataName}`);
    }
    return super.getContentSync(type, modelId, dataName, version);
  }
}

function setupLazyTest(
  bodies: { name: string; specName: string; body: unknown }[],
): {
  catalog: CatalogStore;
  service: DataQueryService;
  dataRepo: TracingDataRepository;
  writeBody: (name: string, body: unknown) => void;
} {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-lazy-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  catalog.markPopulated();
  const dataRepo = new TracingDataRepository(dir, undefined, catalog);
  const writeBody = (name: string, body: unknown) => {
    const path = dataRepo.getContentPath(
      ModelType.create("test-model"),
      "model-001",
      name,
      1,
    );
    ensureDirSync(dirname(path));
    Deno.writeTextFileSync(path, JSON.stringify(body));
  };
  for (const { name, specName, body } of bodies) {
    writeBody(name, body);
    catalog.upsert(
      makeRow({
        data_name: name,
        id: crypto.randomUUID(),
        spec_name: specName,
      }),
    );
  }
  return {
    catalog,
    service: new DataQueryService(catalog, dataRepo),
    dataRepo,
    writeBody,
  };
}

Deno.test("DataQueryService: metadata-rejected rows do not read bodies", () => {
  const { catalog, service, dataRepo } = setupLazyTest([
    { name: "report-a", specName: "report", body: { value: 10 } },
    { name: "report-b", specName: "report", body: { value: 20 } },
    { name: "question", specName: "question", body: { value: 1 } },
  ]);
  dataRepo.unreadable.add("report-a");

  const results = service.querySync(
    'specName == "question" && attributes.value > 0',
  ) as DataRecord[];

  assertEquals(results.map((r) => r.name), ["question"]);
  assertEquals(results[0].attributes, { value: 1 });
  assertEquals(dataRepo.reads.get("report-a"), undefined);
  assertEquals(dataRepo.reads.get("report-b"), undefined);
  catalog.close();
});

Deno.test("DataQueryService: unreadable body of a matching row fails the query", () => {
  const { catalog, service, dataRepo } = setupLazyTest([
    { name: "question", specName: "question", body: { value: 1 } },
  ]);
  dataRepo.unreadable.add("question");

  assertThrows(
    () => service.querySync('specName == "question" && attributes.value > 0'),
    Deno.errors.PermissionDenied,
  );
  catalog.close();
});

Deno.test("DataQueryService: CEL evaluation errors still skip the row", () => {
  const { catalog, service } = setupLazyTest([
    { name: "with-detail", specName: "result", body: { detail: { deep: 1 } } },
    { name: "without-detail", specName: "result", body: { value: 1 } },
  ]);

  const results = service.querySync(
    "attributes.detail.deep > 0",
  ) as DataRecord[];

  assertEquals(results.map((r) => r.name), ["with-detail"]);
  catalog.close();
});

Deno.test("DataQueryService: read error absorbed by CEL resurfaces for a matched row", () => {
  const { catalog, service, dataRepo } = setupLazyTest([
    { name: "report-a", specName: "report", body: { value: 10 } },
  ]);
  dataRepo.unreadable.add("report-a");

  assertThrows(
    () => service.querySync('attributes.value > 0 || specName == "report"'),
    Deno.errors.PermissionDenied,
  );
  catalog.close();
});

Deno.test("DataQueryService: projection and loadAttributes read matched rows only", () => {
  const { catalog, service, dataRepo } = setupLazyTest([
    { name: "report-a", specName: "report", body: { value: 10 } },
    { name: "question", specName: "question", body: { value: 1 } },
  ]);
  dataRepo.unreadable.add("report-a");

  const projected = service.querySync('specName == "question"', {
    select: "attributes.value",
  });
  assertEquals(projected, [1]);

  const loaded = service.querySync('specName == "question"', {
    loadAttributes: true,
  }) as DataRecord[];
  assertEquals(loaded[0].attributes, { value: 1 });

  assertEquals(dataRepo.reads.get("report-a"), undefined);
  assertEquals(dataRepo.reads.get("question"), 2);
  catalog.close();
});

Deno.test("DataQueryService: successive queries see rewritten bodies", () => {
  const { catalog, service, writeBody } = setupLazyTest([
    { name: "question", specName: "question", body: { value: 1 } },
  ]);

  assertEquals(service.querySync("attributes.value == 1").length, 1);

  writeBody("question", { value: 2 });

  assertEquals(service.querySync("attributes.value == 1").length, 0);
  const results = service.querySync("attributes.value == 2") as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].attributes, { value: 2 });
  catalog.close();
});

// ============================================================================
// includeContentPath — path is opt-in so it never leaves the process
// ============================================================================

function expectedContentPath(dir: string, catalog: CatalogStore): string {
  return new FileSystemUnifiedDataRepository(dir, undefined, catalog)
    .getContentPath(
      ModelType.create("test-model"),
      "model-001",
      "my-data",
      1,
    );
}

Deno.test("DataQueryService: records carry an empty path by default", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow());

  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].path, "");
  catalog.close();
});

Deno.test("DataQueryService: includeContentPath sets the local content path", () => {
  const { catalog, service, dir } = setupTest();
  catalog.upsert(makeRow());

  const results = service.querySync('modelName == "ingest"', {
    includeContentPath: true,
  }) as DataRecord[];
  assertEquals(results.length, 1);
  assertEquals(results[0].path, expectedContentPath(dir, catalog));
  catalog.close();
});

Deno.test("DataQueryService: a select projection of path is empty unless opted in", () => {
  const { catalog, service, dir } = setupTest();
  catalog.upsert(makeRow());

  const hidden = service.querySync('modelName == "ingest"', {
    select: "path",
  }) as string[];
  assertEquals(hidden, [""]);

  const shown = service.querySync('modelName == "ingest"', {
    select: "path",
    includeContentPath: true,
  }) as string[];
  assertEquals(shown, [expectedContentPath(dir, catalog)]);
  catalog.close();
});

Deno.test("DataQueryService: getLatestRecord sets path only when requested", async () => {
  const { catalog, service, dir } = setupTest();
  catalog.upsert(makeRow());

  const hidden = await service.getLatestRecord("ingest", "my-data");
  assertEquals(hidden?.path, "");

  const shown = await service.getLatestRecord("ingest", "my-data", undefined, {
    includeContentPath: true,
  });
  assertEquals(shown?.path, expectedContentPath(dir, catalog));
  catalog.close();
});

Deno.test("DataQueryService.latestDataNamesForSpec: returns data names newest first", () => {
  const { catalog, service } = setupTest();
  const write = (name: string, createdAt: string, id: string) =>
    catalog.upsert(
      makeRow({
        data_name: name,
        spec_name: "summary",
        created_at: createdAt,
        id,
      }),
    );
  write("run-b", "2026-01-01T00:00:01.000Z", "data-uuid-b");
  write("run-c", "2026-01-01T00:00:03.000Z", "data-uuid-c");
  write("run-a", "2026-01-01T00:00:02.000Z", "data-uuid-a");
  catalog.upsert(makeRow({ data_name: "other", spec_name: "raw" }));

  assertEquals(service.latestDataNamesForSpec("ingest", "summary"), [
    "run-c",
    "run-a",
    "run-b",
  ]);
  catalog.close();
});

Deno.test("DataQueryService.latestDataNamesForSpec: scopes to the given namespace", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ data_name: "local", spec_name: "summary" }));
  catalog.upsert(
    makeRow({
      namespace: "infra",
      data_name: "remote",
      spec_name: "summary",
      id: "data-uuid-infra",
    }),
  );

  assertEquals(service.latestDataNamesForSpec("ingest", "summary", ""), [
    "local",
  ]);
  assertEquals(service.latestDataNamesForSpec("ingest", "summary", "infra"), [
    "remote",
  ]);
  catalog.close();
});

Deno.test("DataQueryService.latestDataNamesForSpec: returns no names for an unknown spec", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ spec_name: "result" }));

  assertEquals(service.latestDataNamesForSpec("ingest", "missing"), []);
  assertEquals(service.latestDataNamesForSpec("other-model", "result"), []);
  catalog.close();
});

Deno.test("DataQueryService: include drops records before select projects them", async () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({ content_type: "application/json" }));
  catalog.upsert(makeRow({
    content_type: "application/json",
    model_id: "model-002",
    model_name: "secret",
    data_name: "secret-data",
    id: "00000000-0000-1000-8000-000000000099",
  }));

  const seen: string[] = [];
  const results = await service.query("true", {
    select: "name",
    include: (record) => {
      seen.push(record.modelName);
      return Promise.resolve(record.modelName !== "secret");
    },
  }) as string[];

  assertEquals(results, ["my-data"]);
  assertEquals(seen.sort(), ["ingest", "secret"]);
  catalog.close();
});

Deno.test("DataQueryService: with include, the limit counts accepted records only", async () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({
    content_type: "application/json",
    model_id: "model-002",
    model_name: "secret",
    data_name: "a-secret",
    id: "00000000-0000-1000-8000-000000000098",
  }));
  catalog.upsert(makeRow({ content_type: "application/json" }));

  const results = await service.query("true", {
    select: "name",
    limit: 1,
    include: (record) => Promise.resolve(record.modelName !== "secret"),
  }) as string[];

  assertEquals(results, ["my-data"]);
  catalog.close();
});

Deno.test("DataQueryService: returns sensitive vault references unresolved", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-sensitive-" });
  const dbPath = join(dir, ".swamp", "data", "_catalog.db");
  const catalog = new CatalogStore(dbPath);
  catalog.markPopulated();
  try {
    const ref = "${{ vault.get('my-vault', 'api-key') }}";
    const tags = {
      type: "resource",
      specName: "result",
      modelName: "ingest",
      "_swamp.sensitiveFields": JSON.stringify(["apiKey"]),
    };
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
      JSON.stringify({ apiKey: ref }),
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
        tags,
        ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    Deno.writeTextFileSync(
      join(
        dir,
        ".swamp",
        "data",
        "test-model",
        "model-001",
        "my-data",
        "latest",
      ),
      "1",
    );
    catalog.upsert(makeRow({ tags: JSON.stringify(tags) }));

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    // Resolution belongs to callers that record the value in the run's
    // RunSensitiveValues; the query service hands back what was stored.
    const results = await service.query('modelName == "ingest"', {
      loadAttributes: true,
    }) as DataRecord[];
    assertEquals(results.length, 1);
    assertEquals(results[0].attributes["apiKey"], ref);

    const latest = await service.getLatestRecord("ingest", "my-data");
    assertEquals(latest?.attributes["apiKey"], ref);
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// ── excludeModelTypes (swamp-club#2756) ─────────────────────────────────

function seedControlPlane(catalog: CatalogStore): void {
  catalog.upsert(makeRow({
    type_normalized: "swamp/grant",
    model_id: "grant-001",
    model_name: "grant-abc",
    data_name: "grant-main",
    spec_name: "grant",
    id: "data-grant-001",
  }));
  catalog.upsert(makeRow({
    type_normalized: "swamp/server-token",
    model_id: "token-001",
    model_name: "tok",
    data_name: "token-main",
    spec_name: "token",
    id: "data-token-001",
    namespace: "other-repo",
  }));
  catalog.upsert(makeRow({ id: "data-user-001" }));
}

const EXCLUDED = ["swamp/grant", "swamp/server-token"];

Deno.test("DataQueryService: excludeModelTypes drops the types whatever the predicate says", () => {
  const { catalog, service } = setupTest();
  seedControlPlane(catalog);

  const all = service.querySync("true", {
    excludeModelTypes: EXCLUDED,
  }) as DataRecord[];
  assertEquals(all.map((r) => r.modelName), ["ingest"]);

  const targeted = service.querySync(
    'modelType == "swamp/grant" || modelName == "tok"',
    { excludeModelTypes: EXCLUDED },
  ) as DataRecord[];
  assertEquals(targeted, []);

  // Without the option the same records match.
  assertEquals(
    (service.querySync('modelType == "swamp/grant"') as DataRecord[]).length,
    1,
  );
  catalog.close();
});

Deno.test("DataQueryService: excludeModelTypes applies before the limit and a projection", async () => {
  const { catalog, service } = setupTest();
  seedControlPlane(catalog);

  const limited = await service.query("true", {
    limit: 1,
    excludeModelTypes: EXCLUDED,
  }) as DataRecord[];
  assertEquals(limited.map((r) => r.modelName), ["ingest"]);

  const projected = await service.query("true", {
    select: "modelName",
    excludeModelTypes: EXCLUDED,
  });
  assertEquals(projected, ["ingest"]);
  catalog.close();
});

Deno.test("DataQueryService: excludeModelTypes hides an excluded latest record and spec instance", async () => {
  const { catalog, service } = setupTest();
  seedControlPlane(catalog);

  assertEquals(
    await service.getLatestRecord("grant-abc", "grant-main", undefined, {
      excludeModelTypes: EXCLUDED,
    }),
    null,
  );
  assertEquals(
    service.latestDataNamesForSpec("grant-abc", "grant", undefined, EXCLUDED),
    [],
  );
  assertEquals(
    service.latestDataNamesForSpec("grant-abc", "grant"),
    ["grant-main"],
  );
  catalog.close();
});

Deno.test("getLatestRecord: excludeModelTypes holds while a full backfill is in flight", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-exclude-backfill-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  // Not populated, as after invalidate(): the next query starts a backfill.
  createOnDiskData(dir, "swamp/grant", "grant-001", "grant-main", "grant-abc");
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);

  const filling = service.ensurePopulated();
  const record = await service.getLatestRecord(
    "grant-abc",
    "grant-main",
    undefined,
    { excludeModelTypes: EXCLUDED },
  );
  await filling;

  assertEquals(record, null);
  // The same lookup without the option finds it once populated.
  assertEquals(
    (await service.getLatestRecord("grant-abc", "grant-main"))?.modelType,
    "swamp/grant",
  );
  catalog.close();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("getLatestRecord: an excluded newer row does not hide a same-named record of another type", async () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({
    model_name: "shared",
    data_name: "main",
    type_normalized: "test-model",
    id: "data-user-001",
  }));
  catalog.upsert(makeRow({
    model_name: "shared",
    data_name: "main",
    type_normalized: "swamp/grant",
    model_id: "grant-001",
    id: "data-grant-001",
  }));

  const record = await service.getLatestRecord("shared", "main", undefined, {
    excludeModelTypes: EXCLUDED,
  });
  assertEquals(record?.modelType, "test-model");
  catalog.close();
});

Deno.test("checkSpecNameAmbiguity: excluded rows are neither peers nor named", () => {
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow({
    model_name: "shared",
    data_name: "user-main",
    spec_name: "main",
    id: "data-user-001",
  }));
  catalog.upsert(makeRow({
    model_name: "shared",
    data_name: "grant-main",
    spec_name: "main",
    type_normalized: "swamp/grant",
    model_id: "grant-001",
    id: "data-grant-001",
  }));

  // Without the exclusion the two rows are ambiguous, naming the grant.
  assertThrows(
    () => service.checkSpecNameAmbiguity("main", "shared"),
    UserError,
    "grant-main",
  );
  service.checkSpecNameAmbiguity("main", "shared", undefined, EXCLUDED);
  catalog.close();
});

// The declared keys of T, without any string or number index signature.
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]:
    T[K];
};

Deno.test("DataQueryService: every DataRecord field resolves to the row's value in a select", () => {
  // Typed against DataRecord so a new field fails type checking until it is
  // listed here, and a field named after a cel-js constant (cel, type, int,
  // ...) fails the probe instead of silently resolving to the built-in
  // (swamp-club#2851). namespace is a CEL reserved word, so it is probed
  // through its ns alias.
  const fields: Record<DeclaredKeys<DataRecord>, string> = {
    id: "id",
    name: "name",
    version: "version",
    isLatest: "isLatest",
    createdAt: "createdAt",
    namespace: "ns",
    attributes: "attributes",
    tags: "tags",
    modelName: "modelName",
    modelId: "modelId",
    modelType: "modelType",
    specName: "specName",
    dataType: "dataType",
    contentType: "contentType",
    lifetime: "lifetime",
    garbageCollection: "garbageCollection",
    ownerType: "ownerType",
    streaming: "streaming",
    size: "size",
    content: "content",
    path: "path",
    ownerRef: "ownerRef",
    workflowRunId: "workflowRunId",
    workflowName: "workflowName",
    jobName: "jobName",
    stepName: "stepName",
    source: "source",
  };
  const { catalog, service } = setupTest();
  catalog.upsert(makeRow());

  const [record] = service.querySync("true", {
    loadAttributes: true,
  }) as DataRecord[];
  for (const [field, identifier] of Object.entries(fields)) {
    const [projected] = service.querySync("true", { select: identifier });
    // content of a JSON row is exposed as its parsed attributes.
    const expected = field === "content"
      ? record.attributes
      : record[field as keyof DataRecord];
    assertEquals(
      projected,
      expected,
      `${identifier} does not resolve to the row's ${field}`,
    );
  }
  catalog.close();
});

// ============================================================================
// Freshness of an unpopulated catalog (swamp-club#2858)
// ============================================================================

Deno.test("getLatestRecord: an unpopulated row behind the on-disk latest marker returns the marker's version", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-marker-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    // The catalog knows v1; another writer (a pull, or a repository sharing
    // the datastore) has since written v2 and moved the latest marker.
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 1);
    catalog.upsertNewVersion(makeRow({ version: 1 }));
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 2);
    catalog.invalidate();

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const record = await service.getLatestRecord("ingest", "my-data");
    assertEquals(record?.version, 2);
    assertEquals(
      catalog.findLatestRow("ingest", "my-data")?.version,
      2,
      "the refreshed version becomes the catalog's latest row",
    );
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("getLatestRecord: an unpopulated row ahead of the on-disk latest marker whose version was deleted yields to the marker (swamp-club#2520)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-marker-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    // The catalog knows v1-v3; another repository sharing the datastore has
    // since deleted v3, leaving the marker on v2.
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 1);
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 2);
    for (const version of [1, 2, 3]) {
      catalog.upsertNewVersion(makeRow({ version }));
    }
    catalog.invalidate();

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const record = await service.getLatestRecord("ingest", "my-data");
    assertEquals(record?.version, 2);
    assertEquals(catalog.findLatestRow("ingest", "my-data")?.version, 2);
    assertEquals(
      [...catalog.iterate()].map((r) => r.version).sort(),
      [1, 2],
      "the deleted version's row is dropped",
    );
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("getLatestRecord: an unpopulated row ahead of a lagging on-disk latest marker stays latest (swamp-club#2520)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-marker-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    // v2 still exists on disk, but the marker was left on v1 by an
    // out-of-order write from an older build.
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 2);
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 1);
    catalog.upsertNewVersion(makeRow({ version: 1 }));
    catalog.upsertNewVersion(makeRow({ version: 2 }));
    catalog.invalidate();

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const record = await service.getLatestRecord("ingest", "my-data");
    assertEquals([record?.version, record?.isLatest], [2, true]);
    assertEquals(catalog.findLatestRow("ingest", "my-data")?.version, 2);
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("getLatestRecord: an unpromoted deferred version above the marker does not stop the refresh (swamp-club#2520)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-marker-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    // The catalog knows v1 and an in-flight deferred v3; another writer has
    // since written v2 and moved the marker to it.
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 1);
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 3);
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 2);
    catalog.upsertNewVersion(makeRow({ version: 1 }));
    catalog.upsert(makeRow({ version: 3, is_latest: 0 }));
    catalog.invalidate();

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const record = await service.getLatestRecord("ingest", "my-data");
    assertEquals(record?.version, 2);
    assertEquals(catalog.findLatestRow("ingest", "my-data")?.version, 2);
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("getLatestRecord: a row from another namespace is never refreshed from this repository's layout", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-foreign-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 1);
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest", 2);
    catalog.upsertNewVersion(makeRow({ namespace: "infra", version: 1 }));

    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const record = await service.getLatestRecord("ingest", "my-data", "infra");
    assertEquals(record?.version, 1);
    assertEquals(record?.namespace, "infra");
    assertEquals(
      catalog.findLatestRow("ingest", "my-data", "")?.version,
      undefined,
    );
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("DataQueryService: a backfill that started before an invalidate does not mark the catalog populated", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-backfill-race-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    createOnDiskData(dir, "test-model", "model-001", "my-data", "ingest");
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    // ensurePopulated reads the generation synchronously, then walks the disk
    // asynchronously; the invalidate lands in between.
    const backfill = service.ensurePopulated();
    catalog.invalidate();
    await backfill;
    assertEquals(catalog.isPopulated(), false);

    await service.ensurePopulated();
    assertEquals(catalog.isPopulated(), true);
  } finally {
    catalog.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

// latestRun("<workflow>") (swamp-club#2957)

/** Two runs of "deploy" that wrote "out", and one model-method item. */
function setupLatestRunTest() {
  const ctx = setupTest();
  ctx.catalog.upsert(makeRow({
    id: "00000000-0000-1000-8000-0000000000a1",
    model_id: "model-new",
    data_name: "out",
    workflow_run_id: "run-new",
    workflow_name: "deploy",
    job_name: "main",
    step_name: "build",
  }));
  ctx.catalog.upsert(makeRow({
    id: "00000000-0000-1000-8000-0000000000a2",
    model_id: "model-old",
    data_name: "out",
    workflow_run_id: "run-old",
    workflow_name: "deploy",
    job_name: "main",
    step_name: "build",
  }));
  ctx.catalog.upsert(makeRow({
    id: "00000000-0000-1000-8000-0000000000a3",
    model_id: "model-direct",
    data_name: "out",
  }));
  return ctx;
}

function resolverOf(runs: Record<string, string | null>) {
  const calls: string[] = [];
  const resolve = (workflow: string): Promise<string | null> => {
    calls.push(workflow);
    if (!(workflow in runs)) {
      return Promise.reject(new UserError(`Workflow not found: ${workflow}`));
    }
    return Promise.resolve(runs[workflow]);
  };
  return { calls, resolve };
}

function runIds(results: unknown[]): string[] {
  return (results as DataRecord[]).map((r) => r.workflowRunId).sort();
}

Deno.test("DataQueryService.query: latestRun selects the resolved run, without include", async () => {
  const { catalog, service } = setupLatestRunTest();
  const resolver = resolverOf({ deploy: "run-new" });
  const results = await service.query(
    'workflowRunId == latestRun("deploy") && name == "out"',
    { latestRunResolver: resolver.resolve },
  );
  assertEquals(runIds(results), ["run-new"]);
  assertEquals(resolver.calls, ["deploy"]);
  catalog.close();
});

Deno.test("DataQueryService.query: latestRun is resolved once across include batches", async () => {
  const { catalog, service } = setupLatestRunTest();
  for (let i = 0; i < 5; i++) {
    catalog.upsert(makeRow({
      id: `00000000-0000-1000-8000-0000000000b${i}`,
      model_id: `model-extra-${i}`,
      data_name: i === 4 ? "target" : "out",
      workflow_run_id: "run-new",
    }));
  }
  const resolver = resolverOf({ deploy: "run-new" });
  let included = 0;
  // Only the last matching row is accepted, so the first batch of four
  // matches holds none and the batch has to grow.
  const results = await service.query(
    'workflowRunId == latestRun("deploy")',
    {
      limit: 1,
      include: (record) => {
        included++;
        return Promise.resolve(record.name === "target");
      },
      latestRunResolver: resolver.resolve,
    },
  ) as DataRecord[];
  assertEquals(results.map((r) => r.name), ["target"]);
  assert(included > 4, `expected more than one batch, saw ${included}`);
  assertEquals(resolver.calls, ["deploy"]);
  catalog.close();
});

Deno.test("DataQueryService.query: a workflow with no runs matches nothing with ==, inside an OR too, and everything with !=", async () => {
  const { catalog, service } = setupLatestRunTest();
  const latestRunResolver = resolverOf({ deploy: null }).resolve;
  assertEquals(
    await service.query('workflowRunId == latestRun("deploy")', {
      latestRunResolver,
    }),
    [],
  );
  assertEquals(
    await service.query(
      'workflowRunId == latestRun("deploy") || name == "none"',
      { latestRunResolver },
    ),
    [],
  );
  assertEquals(
    runIds(
      await service.query('workflowRunId != latestRun("deploy")', {
        latestRunResolver,
      }),
    ),
    ["", "run-new", "run-old"],
  );
  catalog.close();
});

Deno.test("DataQueryService.query: latestRun without a resolver is a UserError, raised before backfill", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);
  await assertRejects(
    () => service.query('workflowRunId == latestRun("deploy")'),
    UserError,
    "latestRun() is only available in swamp data query",
  );
  assertEquals(catalog.isPopulated(), false);
  catalog.close();
});

Deno.test("DataQueryService.querySync: latestRun is a UserError, not an empty result", () => {
  const { catalog, service } = setupLatestRunTest();
  assertThrows(
    () => service.querySync('workflowRunId == latestRun("deploy")'),
    UserError,
    "latestRun() is only available in swamp data query; here, compare " +
      'workflowRunId with the run id as a string, e.g. workflowRunId == "<run-id>"',
  );
  catalog.close();
});

Deno.test("DataQueryService.query: latestRun may be called in select alone", async () => {
  const { catalog, service } = setupLatestRunTest();
  const resolver = resolverOf({ deploy: "run-new" });
  const results = await service.query('workflowRunId == "run-old"', {
    select: 'latestRun("deploy")',
    latestRunResolver: resolver.resolve,
  });
  assertEquals(results, ["run-new"]);
  catalog.close();
});

Deno.test("DataQueryService.query: concurrent queries keep their own latest runs", async () => {
  const { catalog, service } = setupLatestRunTest();
  const predicate = 'workflowRunId == latestRun("deploy")';
  const [newer, older] = await Promise.all([
    service.query(predicate, {
      latestRunResolver: async () => {
        await Promise.resolve();
        return "run-new";
      },
    }),
    service.query(predicate, {
      latestRunResolver: () => Promise.resolve("run-old"),
    }),
  ]);
  assertEquals(runIds(newer), ["run-new"]);
  assertEquals(runIds(older), ["run-old"]);
  catalog.close();
});

Deno.test("DataQueryService.query: the resolver's error for an unknown workflow propagates", async () => {
  const { catalog, service } = setupLatestRunTest();
  await assertRejects(
    () =>
      service.query('workflowRunId == latestRun("nope")', {
        latestRunResolver: resolverOf({}).resolve,
      }),
    UserError,
    "Workflow not found: nope",
  );
  catalog.close();
});

// ============================================================================
// Lazy content hydration in query() (swamp-club#2962): a lazy-hydration
// datastore syncs metadata only, so a matched row's raw file may be absent
// until something downloads it. data get downloads it; query() must too.
// ============================================================================

interface RemoteBody {
  name: string;
  specName?: string;
  body: unknown;
  /** Stored bytes, instead of `body` as JSON. */
  bytes?: Uint8Array;
  /** Defaults to application/json. */
  contentType?: string;
  /** Write the body locally too, as if already hydrated. */
  local?: boolean;
  /** The remote does not have the body either. */
  remoteMissing?: boolean;
  namespace?: string;
}

function setupHydrationTest(bodies: RemoteBody[]): {
  service: DataQueryService;
  hydrated: string[];
  dataRepo: TracingDataRepository;
  cleanup: () => void;
} {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-hydrate-lazy-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  catalog.markPopulated();
  const remote = new Map<string, Uint8Array>();
  const hydrated: string[] = [];
  const names = new Map<string, string>();
  const dataRepo = new TracingDataRepository(
    dir,
    undefined,
    catalog,
    undefined,
    async (absPath: string) => {
      hydrated.push(names.get(absPath) ?? absPath);
      const bytes = remote.get(absPath);
      if (!bytes) return false;
      await Deno.writeFile(absPath, bytes);
      return true;
    },
  );
  for (const entry of bodies) {
    const path = dataRepo.getContentPath(
      ModelType.create("test-model"),
      "model-001",
      entry.name,
      1,
    );
    names.set(path, entry.name);
    const bytes = entry.bytes ??
      new TextEncoder().encode(JSON.stringify(entry.body));
    if (!entry.remoteMissing) remote.set(path, bytes);
    // A lazy pull creates the version directory but skips raw.
    ensureDirSync(dirname(path));
    if (entry.local) Deno.writeFileSync(path, bytes);
    catalog.upsert(
      makeRow({
        data_name: entry.name,
        id: crypto.randomUUID(),
        spec_name: entry.specName ?? "result",
        namespace: entry.namespace ?? "",
        content_type: entry.contentType ?? "application/json",
      }),
    );
  }
  return {
    service: new DataQueryService(catalog, dataRepo),
    hydrated,
    dataRepo,
    cleanup: () => {
      catalog.close();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

Deno.test("DataQueryService.query: select content downloads a lazily-synced body", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
  ]);
  try {
    const results = await service.query(
      'modelName == "ingest" && name == "a"',
      { select: "content" },
    );
    assertEquals(results, [{ value: 1 }]);
    assertEquals(hydrated, ["a"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: select content downloads a lazily-synced binary or text body", async () => {
  // swamp-club#2959 reads projected content after include; the read still
  // downloads a body a lazy pull skipped, as data get does.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "logo", body: null, bytes: png, contentType: "image/png" },
    {
      name: "notes",
      body: null,
      bytes: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    },
  ]);
  try {
    const results = await service.query('modelName == "ingest"', {
      select: '{"content": content, "contentEncoding": contentEncoding}',
    });
    assertEquals(results, [
      { content: png.toBase64(), contentEncoding: "base64" },
      { content: "hello", contentEncoding: "utf-8" },
    ]);
    assertEquals(hydrated.sort(), ["logo", "notes"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: select content never downloads a body include rejects", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    {
      name: "logo",
      body: null,
      bytes: new Uint8Array([0x89, 0x50]),
      contentType: "image/png",
    },
    {
      name: "notes",
      body: null,
      bytes: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    },
  ]);
  try {
    const results = await service.query('modelName == "ingest"', {
      select: "content",
      include: (record) => Promise.resolve(record.name === "notes"),
    });
    assertEquals(results, ["hello"]);
    assertEquals(hydrated, ["notes"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: an attribute predicate matches a lazily-synced row", async () => {
  const { service, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
    { name: "b", body: { value: 2 } },
  ]);
  try {
    const results = await service.query(
      "attributes.value == 2",
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["b"]);
    assertEquals(results[0].attributes, { value: 2 });
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: default results carry downloaded attributes", async () => {
  const { service, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
  ]);
  try {
    const results = await service.query('name == "a"') as DataRecord[];
    assertEquals(results.length, 1);
    assertEquals(results[0].attributes, { value: 1 });
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: rows rejected by a metadata term are never downloaded", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "report-a", specName: "report", body: { value: 10 } },
    { name: "question", specName: "question", body: { value: 1 } },
  ]);
  try {
    const results = await service.query(
      'specName == "question" && attributes.value > 0',
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["question"]);
    assertEquals(hydrated, ["question"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a metadata-only select downloads nothing", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
    { name: "b", body: { value: 2 } },
  ]);
  try {
    const results = await service.query("true", {
      select: "[modelId, name]",
    });
    assertEquals(results, [["model-001", "a"], ["model-001", "b"]]);
    assertEquals(hydrated, []);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a body missing remotely too leaves empty attributes", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 }, remoteMissing: true },
  ]);
  try {
    const results = await service.query('name == "a"', {
      select: "content",
    });
    assertEquals(results, [{}]);
    // Tried once, then no further pass.
    assertEquals(hydrated, ["a"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a foreign-namespace row is never sent to the hydrate hook", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 }, namespace: "infra" },
  ]);
  try {
    const results = await service.query('name == "a"') as DataRecord[];
    assertEquals(results.length, 1);
    assertEquals(results[0].attributes, {});
    assertEquals(hydrated, []);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a row reached only on a later pass is downloaded too", async () => {
  // With an empty body "a" matches and fills the limit; once downloaded it
  // no longer matches, so the next pass reaches "b", also not yet synced.
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { flag: true } },
    { name: "b", body: { value: 2 } },
  ]);
  try {
    const results = await service.query("!has(attributes.flag)", {
      limit: 1,
    }) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["b"]);
    assertEquals(results[0].attributes, { value: 2 });
    assertEquals(hydrated, ["a", "b"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: rows include rejects are never downloaded", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
    { name: "b", body: { value: 2 } },
  ]);
  try {
    const results = await service.query("attributes.value > 0", {
      include: (record) => Promise.resolve(record.name !== "a"),
      limit: 10,
    }) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["b"]);
    assertEquals(results[0].attributes, { value: 2 });
    assertEquals(hydrated, ["b"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: locally present bodies are read without the hook", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 }, local: true },
  ]);
  try {
    const results = await service.query('name == "a"') as DataRecord[];
    assertEquals(results[0].attributes, { value: 1 });
    assertEquals(hydrated, []);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.querySync: does not download lazily-synced bodies", () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "a", body: { value: 1 } },
  ]);
  try {
    const results = service.querySync('name == "a"') as DataRecord[];
    assertEquals(results[0].attributes, {});
    assertEquals(hydrated, []);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: later passes under a limit stay linear in body reads", async () => {
  // Every row matches while empty and stops matching once downloaded, so
  // each pass can only find new rows past what it already downloaded.
  const count = 32;
  const { service, hydrated, dataRepo, cleanup } = setupHydrationTest(
    Array.from({ length: count }, (_, i) => ({
      name: `row-${String(i).padStart(2, "0")}`,
      body: { flag: true },
    })),
  );
  try {
    const results = await service.query("!has(attributes.flag)", {
      limit: 1,
    });
    assertEquals(results, []);
    assertEquals(hydrated.length, count);
    const reads = [...dataRepo.reads.values()].reduce((a, b) => a + b, 0);
    // Doubling passes read about 5 bodies per row (misses and the final
    // pass at the caller's limit included); one rescan per downloaded row
    // would be about count * count / 2.
    assert(reads <= 6 * count, `${reads} body reads for ${count} rows`);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a body missing remotely is requested once across include batches", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest([
    { name: "gone", body: {}, remoteMissing: true },
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `r${i + 1}`,
      body: { v: i + 1 },
      local: true,
    })),
  ]);
  try {
    // The first batch accepts only "gone", so the query grows the batch.
    const results = await service.query(
      'attributes.v > 0 || name == "gone"',
      {
        include: (record) =>
          Promise.resolve(record.name === "gone" || record.name === "r9"),
        limit: 2,
      },
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["gone", "r9"]);
    assertEquals(hydrated, ["gone"]);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: a metadata predicate under a limit downloads only the returned rows", async () => {
  const rows = Array.from({ length: 64 }, (_, i) => ({
    name: `row-${String(i).padStart(2, "0")}`,
    body: { v: i },
  }));
  for (const select of [undefined, "content"]) {
    const { service, hydrated, cleanup } = setupHydrationTest(rows);
    try {
      const results = await service.query('modelName == "ingest"', {
        limit: 2,
        select,
      });
      assertEquals(results.length, 2, `select=${select}`);
      assertEquals(hydrated, ["row-00", "row-01"], `select=${select}`);
    } finally {
      cleanup();
    }
  }
});

Deno.test("DataQueryService.query: with include, a metadata predicate downloads only the first batch", async () => {
  const { service, hydrated, cleanup } = setupHydrationTest(
    Array.from({ length: 64 }, (_, i) => ({
      name: `row-${String(i).padStart(2, "0")}`,
      body: { v: i },
    })),
  );
  try {
    const results = await service.query('modelName == "ingest"', {
      include: () => Promise.resolve(true),
      limit: 2,
    }) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["row-00", "row-01"]);
    // The include path matches in batches of four times the limit.
    assertEquals(hydrated.length, 8);
  } finally {
    cleanup();
  }
});

Deno.test("DataQueryService.query: limit 0 still widens when downloaded rows stop matching", async () => {
  const count = 16;
  const { service, hydrated, dataRepo, cleanup } = setupHydrationTest(
    Array.from({ length: count }, (_, i) => ({
      name: `row-${String(i).padStart(2, "0")}`,
      body: { flag: true },
    })),
  );
  try {
    await service.query("!has(attributes.flag)", { limit: 0 });
    assertEquals(hydrated.length, count);
    const reads = [...dataRepo.reads.values()].reduce((a, b) => a + b, 0);
    assert(reads <= 6 * count, `${reads} body reads for ${count} rows`);
  } finally {
    cleanup();
  }
});

// --- Latest across workflow steps (swamp-club#2520) ---

function writeStepVersions(catalog: CatalogStore, steps: string[]): void {
  steps.forEach((step, i) => {
    catalog.upsertNewVersion(makeRow({
      version: i + 1,
      id: `00000000-0000-1000-8000-00000000010${i}`,
      step_name: step,
    }));
  });
}

Deno.test("DataQueryService: implicit latest returns one version when workflow steps wrote the same name", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2"]);

  const results = service.querySync(
    'modelName == "ingest" && name == "my-data"',
  ) as DataRecord[];
  assertEquals(results.map((r) => [r.version, r.isLatest]), [[2, true]]);
  catalog.close();
});

Deno.test("DataQueryService: three steps across jobs return only the newest version", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2", "s3"]);

  const results = service.querySync('modelName == "ingest"') as DataRecord[];
  assertEquals(results.map((r) => r.version), [3]);
  catalog.close();
});

Deno.test("DataQueryService: history query reports older step versions as not latest", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2"]);

  const results = service.querySync(
    'modelName == "ingest" && version >= 0',
  ) as DataRecord[];
  assertEquals(
    results.map((r) => [r.version, r.isLatest]).sort(),
    [[1, false], [2, true]],
  );
  catalog.close();
});

Deno.test("DataQueryService: latestPerStep returns each step's latest version", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2", "s1"]);

  const results = service.querySync('modelName == "ingest"', {
    latestPerStep: true,
  }) as DataRecord[];
  assertEquals(
    results.map((r) => [r.stepName, r.version, r.isLatest]).sort(),
    [["s1", 3, true], ["s2", 2, false]],
  );
  catalog.close();
});

Deno.test("DataQueryService: latestPerStep with a history predicate returns every version", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2", "s1"]);

  const results = service.querySync('modelName == "ingest" && version >= 0', {
    latestPerStep: true,
  }) as DataRecord[];
  assertEquals(results.map((r) => r.version).sort(), [1, 2, 3]);
  catalog.close();
});

Deno.test("DataQueryService.latestDataNamesForSpec: lists a name once when several steps wrote it", () => {
  const { catalog, service } = setupTest();
  writeStepVersions(catalog, ["s1", "s2"]);

  assertEquals(service.latestDataNamesForSpec("ingest", "result"), [
    "my-data",
  ]);
  catalog.close();
});

// ============================================================================
// Binary content (swamp-club#2959): a projection reads any item's bytes
// without loss, and a predicate reading `content` on a non-text item fails.
// ============================================================================

/** Writes one stored item with raw bytes and indexes it in the catalog. */
function writeContentItem(
  dir: string,
  catalog: CatalogStore,
  item: { name: string; id: string; contentType: string; bytes: Uint8Array },
): void {
  const itemDir = join(dir, ".swamp", "data", "test-model", "model-001");
  const dataDir = join(itemDir, item.name, "1");
  ensureDirSync(dataDir);
  Deno.writeFileSync(join(dataDir, "raw"), item.bytes);
  Deno.writeTextFileSync(
    join(dataDir, "metadata.yaml"),
    stringifyYaml({
      name: item.name,
      id: item.id,
      version: 1,
      contentType: item.contentType,
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(join(itemDir, item.name, "latest"), "1");
  catalog.upsert(makeRow({
    data_name: item.name,
    id: item.id,
    content_type: item.contentType,
  }));
}

// A PNG signature: 0x89 is never a valid leading UTF-8 byte.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
// A UTF-16LE byte-order mark followed by "hi": not valid UTF-8.
const UTF16_BYTES = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);

/**
 * Runs `fn` against a query service over a repo holding, in catalog order,
 * UTF-8 text (`notes`), a binary item (`logo`), text whose bytes are not
 * UTF-8 (`legacy`) and JSON (`info`). `reads` lists the data names whose
 * bytes were read, by either the sync or the async read. The rows carry the empty namespace; `namespace` sets
 * the repository's own. The repo is removed afterwards, pass or fail.
 */
async function withContentItems(
  fn: (
    ctx: {
      dir: string;
      catalog: CatalogStore;
      service: DataQueryService;
      reads: string[];
    },
  ) => void | Promise<void>,
  options: { namespace?: string } = {},
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-binary-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    catalog.markPopulated();
    writeContentItem(dir, catalog, {
      name: "notes",
      id: "00000000-0000-1000-8000-000000000011",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("hello world"),
    });
    writeContentItem(dir, catalog, {
      name: "logo",
      id: "00000000-0000-1000-8000-000000000012",
      contentType: "image/png",
      bytes: PNG_BYTES,
    });
    writeContentItem(dir, catalog, {
      name: "legacy",
      id: "00000000-0000-1000-8000-000000000013",
      contentType: "text/plain",
      bytes: UTF16_BYTES,
    });
    writeContentItem(dir, catalog, {
      name: "info",
      id: "00000000-0000-1000-8000-000000000014",
      contentType: "application/json",
      bytes: new TextEncoder().encode('{"kernel":"6.1"}'),
    });
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
      undefined,
      undefined,
      options.namespace === undefined
        ? undefined
        : createNamespace(options.namespace),
    );
    const reads: string[] = [];
    const getContentSync = dataRepo.getContentSync.bind(dataRepo);
    dataRepo.getContentSync = (type, modelId, dataName, version) => {
      reads.push(dataName);
      return getContentSync(type, modelId, dataName, version);
    };
    // query() reads projected content through the async getContent, which
    // can download a lazily-synced body (swamp-club#2962).
    const getContent = dataRepo.getContent.bind(dataRepo);
    dataRepo.getContent = (type, modelId, dataName, version) => {
      reads.push(dataName);
      return getContent(type, modelId, dataName, version);
    };
    await fn({
      dir,
      catalog,
      service: new DataQueryService(catalog, dataRepo),
      reads,
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const ENCODED_SELECT =
  '{"content": content, "contentEncoding": contentEncoding}';

Deno.test("DataQueryService: select content returns binary bytes base64-encoded", async () => {
  await withContentItems(({ service }) => {
    assertEquals(
      service.querySync('name == "logo"', { select: ENCODED_SELECT }),
      [{ content: PNG_BYTES.toBase64(), contentEncoding: "base64" }],
    );
  });
});

Deno.test("DataQueryService: select content base64-encodes text whose bytes are not UTF-8", async () => {
  await withContentItems(({ service }) => {
    assertEquals(
      service.querySync('name == "legacy"', { select: ENCODED_SELECT }),
      [{ content: UTF16_BYTES.toBase64(), contentEncoding: "base64" }],
    );
  });
});

Deno.test("DataQueryService: select content returns UTF-8 text and JSON attributes as before", async () => {
  await withContentItems(({ service }) => {
    assertEquals(
      service.querySync('name == "notes"', { select: ENCODED_SELECT }),
      [{ content: "hello world", contentEncoding: "utf-8" }],
    );
    assertEquals(
      service.querySync('name == "info"', { select: ENCODED_SELECT }),
      [{ content: { kernel: "6.1" }, contentEncoding: "utf-8" }],
    );
    assertEquals(
      service.querySync('name == "notes"', { select: "content" }),
      ["hello world"],
    );
  });
});

Deno.test("DataQueryService: select contentEncoding alone reads the bytes", async () => {
  await withContentItems(({ service, reads }) => {
    assertEquals(
      service.querySync('name == "logo"', { select: "contentEncoding" }),
      ["base64"],
    );
    assertEquals(reads, ["logo"]);
  });
});

Deno.test("DataQueryService: select content is null when the bytes are not on this host", async () => {
  await withContentItems(({ catalog, service }) => {
    // Indexed, but no stored body: a missing file.
    catalog.upsert(makeRow({
      data_name: "gone",
      id: "00000000-0000-1000-8000-000000000015",
      content_type: "image/png",
    }));
    // Another namespace's items in a shared datastore, JSON included.
    catalog.upsert(makeRow({
      namespace: "other-repo",
      data_name: "theirs",
      id: "00000000-0000-1000-8000-000000000016",
      content_type: "image/png",
    }));
    catalog.upsert(makeRow({
      namespace: "other-repo",
      data_name: "their-state",
      id: "00000000-0000-1000-8000-000000000017",
      content_type: "application/json",
    }));
    assertEquals(
      service.querySync(
        'name == "gone" || name == "theirs" || name == "their-state"',
        { select: ENCODED_SELECT },
      ),
      [
        { content: null, contentEncoding: null },
        { content: null, contentEncoding: null },
        { content: null, contentEncoding: null },
      ],
    );
  });
});

Deno.test("DataQueryService: a predicate reading content on a binary item fails, naming it", async () => {
  await withContentItems(({ service, reads }) => {
    const error = assertThrows(
      () => service.querySync('content.contains("PNG")'),
      BinaryContentPredicateError,
    );
    assertEquals(error.item.name, "logo");
    assertEquals(error.item.contentType, "image/png");
    assertStringIncludes(error.message, "ingest/logo version 1");
    assertStringIncludes(error.message, 'contentType.startsWith("text/")');
    // The guard it suggests covers text/*; it names the other text types.
    assertStringIncludes(error.message, "JSON, YAML, XML or TOML");
    // The check uses the catalog's content type, never the binary's bytes.
    assertEquals(reads.includes("logo"), false);
  });
});

Deno.test("DataQueryService: the async query fails the same way", async () => {
  await withContentItems(async ({ service }) => {
    await assertRejects(
      () => service.query('content == "x"'),
      BinaryContentPredicateError,
    );
  });
});

Deno.test("DataQueryService: a binary content read absorbed by CEL still fails", async () => {
  await withContentItems(({ service }) => {
    assertThrows(
      () => service.querySync('content == "x" || true'),
      BinaryContentPredicateError,
    );
  });
});

Deno.test("DataQueryService: a contentType guard keeps a content predicate off binary items", async () => {
  await withContentItems(({ service, reads }) => {
    const results = service.querySync(
      'contentType.startsWith("text/") && content.contains("hello")',
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["notes"]);
    assertEquals(reads.includes("logo"), false);
  });
});

Deno.test("DataQueryService: a text content predicate still decodes leniently", async () => {
  await withContentItems(({ service }) => {
    const results = service.querySync(
      'name == "legacy" && content.contains("h")',
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["legacy"]);
  });
});

Deno.test("DataQueryService: an unreadable binary item is dropped, not reported", async () => {
  await withContentItems(async ({ service }) => {
    const results = await service.query('content.contains("hello")', {
      include: (record) => Promise.resolve(record.name !== "logo"),
    }) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["notes"]);
  });
});

Deno.test("DataQueryService: a readable binary item fails the query under include", async () => {
  await withContentItems(async ({ service }) => {
    const error = await assertRejects(
      () =>
        service.query('content.contains("hello")', {
          include: () => Promise.resolve(true),
        }),
      BinaryContentPredicateError,
    );
    assertEquals(error.item.name, "logo");
  });
});

Deno.test("DataQueryService: a binary item past the limit fails neither with nor without include", async () => {
  await withContentItems(async ({ service }) => {
    // `notes` matches first and fills the page; `logo` comes after it.
    const predicate = 'content.contains("hello")';
    const local = service.querySync(predicate, { limit: 1 }) as DataRecord[];
    assertEquals(local.map((r) => r.name), ["notes"]);
    // With include, matching runs ahead in batches and reaches `logo`, but
    // the page is already full there, so the outcome is the same.
    const served = await service.query(predicate, {
      limit: 1,
      include: () => Promise.resolve(true),
    }) as DataRecord[];
    assertEquals(served.map((r) => r.name), ["notes"]);
  });
});

Deno.test("DataQueryService: under include, a binary item before the page fills still fails", async () => {
  await withContentItems(async ({ service }) => {
    // `notes` is rejected, so the page is still empty when `logo` is reached.
    await assertRejects(
      () =>
        service.query('content.contains("hello")', {
          limit: 1,
          include: (record) => Promise.resolve(record.name !== "notes"),
        }),
      BinaryContentPredicateError,
    );
  });
});

Deno.test("DataQueryService: include decides before select reads any bytes", async () => {
  await withContentItems(async ({ service, reads }) => {
    const results = await service.query("true", {
      select: ENCODED_SELECT,
      include: (record) => Promise.resolve(record.name === "notes"),
    });
    assertEquals(results, [{
      content: "hello world",
      contentEncoding: "utf-8",
    }]);
    // JSON attributes load while matching, as before; no other body is read
    // for a record include rejects.
    assertEquals(reads.filter((name) => name !== "info"), ["notes"]);
  });
});

Deno.test("DataQueryService: contentEncoding is not a predicate field", async () => {
  await withContentItems(({ service }) => {
    assertThrows(
      () => service.querySync('contentEncoding == "base64"'),
      UserError,
      "contentEncoding",
    );
  });
});

Deno.test("DataQueryService: select content reads a legacy row stamped with the empty namespace", async () => {
  // Rows written before the repository set a namespace keep "", but their
  // bytes are this repository's own.
  await withContentItems(({ service }) => {
    assertEquals(
      service.querySync('name == "notes"', { select: ENCODED_SELECT }),
      [{ content: "hello world", contentEncoding: "utf-8" }],
    );
  }, { namespace: "infra" });
});

Deno.test("DataQueryService: a content predicate reads text types beyond text/*", async () => {
  await withContentItems(({ dir, catalog, service }) => {
    writeContentItem(dir, catalog, {
      name: "manifest",
      id: "00000000-0000-1000-8000-000000000018",
      contentType: "application/xml; charset=utf-8",
      bytes: new TextEncoder().encode("<hello/>"),
    });
    const results = service.querySync(
      'name == "manifest" && content.contains("hello")',
    ) as DataRecord[];
    assertEquals(results.map((r) => r.name), ["manifest"]);
  });
});

// ── model() references (swamp-club#2960) ────────────────────────────────────

const OLD_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";

function setupModelTest(
  definitions: Record<string, ResolvedModelReference> = {
    ingest: { modelType: "test-model", modelId: NEW_ID },
    [NEW_ID]: { modelType: "test-model", modelId: NEW_ID },
  },
) {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-test-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  catalog.markPopulated();
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const lookups: string[] = [];
  const service = new DataQueryService(catalog, dataRepo);
  const modelResolver: ModelReferenceResolver = (idOrName) => {
    lookups.push(idOrName);
    const found = definitions[idOrName];
    return found
      ? Promise.resolve(found)
      : Promise.reject(new UserError(`Model not found: ${idOrName}`));
  };
  const query = (predicate: string, options: DataQueryOptions = {}) =>
    service.query(predicate, { ...options, modelResolver });
  // A model deleted and recreated under the same name: both ids carry the
  // modelName tag "ingest", and only NEW_ID is the current definition.
  catalog.upsert(makeRow({ model_id: OLD_ID, id: "old-data" }));
  catalog.upsert(makeRow({ model_id: NEW_ID, id: "new-data" }));
  return { catalog, service, query, lookups };
}

Deno.test("DataQueryService model(): matches the resolved definition, not every row tagged with its name", async () => {
  const { catalog, query } = setupModelTest();
  const byTag = await query('modelName == "ingest"') as DataRecord[];
  assertEquals(byTag.length, 2);

  const byName = await query(
    'model("ingest") && name == "my-data"',
  ) as DataRecord[];
  assertEquals(byName.map((r) => r.id), ["new-data"]);

  const byId = await query(`model("${NEW_ID}")`) as DataRecord[];
  assertEquals(byId.map((r) => r.id), ["new-data"]);
  catalog.close();
});

Deno.test("DataQueryService model(): matches data whose modelName tag differs or is empty", async () => {
  const { catalog, query } = setupModelTest();
  // Written before a model rename, and before the modelName tag existed.
  catalog.upsert(
    makeRow({ model_id: NEW_ID, data_name: "pre-rename", model_name: "old" }),
  );
  catalog.upsert(
    makeRow({ model_id: NEW_ID, data_name: "untagged", model_name: "" }),
  );
  const results = await query('model("ingest")') as DataRecord[];
  assertEquals(results.map((r) => r.name).sort(), [
    "my-data",
    "pre-rename",
    "untagged",
  ]);
  catalog.close();
});

Deno.test("DataQueryService model(): requires the definition's model type too", async () => {
  const { catalog, query } = setupModelTest();
  catalog.upsert(
    makeRow({ type_normalized: "other-type", model_id: NEW_ID, id: "x" }),
  );
  const results = await query('model("ingest")') as DataRecord[];
  assertEquals(results.map((r) => r.id), ["new-data"]);
  catalog.close();
});

Deno.test("DataQueryService model(): an unknown model fails the query, before the catalog is read", async () => {
  const { catalog, query } = setupModelTest();
  catalog.invalidate();
  await assertRejects(
    () => query('model("missing") || model("ingest")'),
    UserError,
    "Model not found: missing",
  );
  assertEquals(catalog.isPopulated(), false, "no backfill ran");
  catalog.close();
});

Deno.test("DataQueryService model(): resolves each distinct reference once", async () => {
  const { catalog, query, lookups } = setupModelTest({
    ingest: { modelType: "test-model", modelId: NEW_ID },
    x: { modelType: "test-model", modelId: OLD_ID },
  });
  await query('model("ingest") && (model("ingest") || !model("x"))');
  assertEquals(lookups, ["ingest", "x"]);
  catalog.close();
});

Deno.test("DataQueryService model(): an unknown field fails before any model lookup", async () => {
  const { catalog, query, lookups } = setupModelTest();
  await assertRejects(
    () => query('model("ingest") && bogus == 1'),
    UserError,
    "Unknown field",
  );
  assertEquals(lookups, []);
  catalog.close();
});

Deno.test("DataQueryService model(): composes with include and limit", async () => {
  const { catalog, query } = setupModelTest();
  catalog.upsert(makeRow({ model_id: NEW_ID, data_name: "second" }));
  const results = await query('model("ingest")', {
    limit: 1,
    include: (record) => Promise.resolve(record.name === "second"),
  }) as DataRecord[];
  assertEquals(results.map((r) => r.name), ["second"]);
  catalog.close();
});

Deno.test("DataQueryService model(): concurrent queries keep their own resolutions", async () => {
  const { catalog, service, query } = setupModelTest({
    ingest: { modelType: "test-model", modelId: NEW_ID },
    old: { modelType: "test-model", modelId: OLD_ID },
  });
  const [a, b] = await Promise.all([
    query('model("ingest")'),
    query('model("old")'),
  ]) as [DataRecord[], DataRecord[]];
  assertEquals(a.map((r) => r.id), ["new-data"]);
  assertEquals(b.map((r) => r.id), ["old-data"]);
  // Nothing leaks into a later query that uses no model() at all.
  assertEquals(
    (service.querySync('modelName == "ingest"') as DataRecord[]).length,
    2,
  );
  catalog.close();
});

Deno.test("DataQueryService model(): querySync and a query without a resolver reject it", async () => {
  const { catalog, service } = setupModelTest();
  assertThrows(
    () => service.querySync('model("ingest")'),
    UserError,
    "only available in swamp data query",
  );
  await assertRejects(
    () => service.query('model("ingest")'),
    UserError,
    "only available in swamp data query",
  );
  catalog.close();
});

Deno.test("DataQueryService model(): rejected in --select, malformed or not", async () => {
  const { catalog, query } = setupModelTest();
  for (const select of ['model("ingest")', "model(name)"]) {
    await assertRejects(
      () => query('name == "my-data"', { select }),
      UserError,
      "not in --select",
    );
  }
  await assertRejects(
    () => query("model(name)"),
    UserError,
    "one model name or definition id",
  );
  catalog.close();
});

// ── Rename forwards (swamp-club#2968) ───────────────────────────────────────

/**
 * A populated catalog over a real repository, so renames write their markers
 * to disk — data query confirms every forward against them.
 */
function setupRenameTest() {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-forwards-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  catalog.markPopulated();
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);
  const type = ModelType.create("test/model");
  const save = async (name: string, modelId: string) => {
    const data = Data.create({
      name,
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "ingest" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    });
    await dataRepo.save(type, modelId, data, new TextEncoder().encode(name));
    return data;
  };
  const rename = (modelId: string, from: string, to: string) =>
    dataRepo.rename(type, modelId, from, to);
  return { catalog, service, dataRepo, type, save, rename };
}

const names = (records: unknown) =>
  (records as DataRecord[]).map((r) => r.name);

Deno.test("DataQueryService rename forwards: a latest read by the old name returns the renamed item", async () => {
  const { catalog, service, save, rename } = setupRenameTest();
  const modelId = crypto.randomUUID();
  await save("old", modelId);
  await rename(modelId, "old", "new");

  assertEquals(names(service.querySync('name == "old"')), ["new"]);
  assertEquals(
    names(service.querySync('modelName == "ingest" && name == "old"')),
    ["new"],
  );
  catalog.close();
});

Deno.test("DataQueryService rename forwards: follows a chain up to five hops", async () => {
  const { catalog, service, save, rename } = setupRenameTest();
  const modelId = crypto.randomUUID();
  const chain = ["n0", "n1", "n2", "n3", "n4", "n5", "n6"];
  await save(chain[0], modelId);
  for (let i = 0; i < chain.length - 1; i++) {
    await rename(modelId, chain[i], chain[i + 1]);
  }

  // n1 → n6 is five hops; n0 → n6 is six, past the limit, as data get.
  assertEquals(names(service.querySync('name == "n1"')), ["n6"]);
  assertEquals(service.querySync('name == "n0"'), []);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: a forward with no rename marker on disk is not followed", async () => {
  const { catalog, service, type, save } = setupRenameTest();
  const modelId = crypto.randomUUID();
  await save("new", modelId);
  // A forward left behind, e.g. after another machine deleted the old name
  // or wrote it again; the cycle case is the same: no marker confirms it.
  catalog.recordRename({
    namespace: "",
    type_normalized: type.normalized,
    model_id: modelId,
    data_name: "old",
    renamed_to: "new",
  });
  catalog.recordRename({
    namespace: "",
    type_normalized: type.normalized,
    model_id: modelId,
    data_name: "new",
    renamed_to: "old",
  });

  assertEquals(service.querySync('name == "old"'), []);
  assertEquals(names(service.querySync('name == "new"')), ["new"]);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: the old name written again is read as itself", async () => {
  const { catalog, service, save, rename, type } = setupRenameTest();
  const modelId = crypto.randomUUID();
  await save("old", modelId);
  await rename(modelId, "old", "new");
  const rewritten = await save("old", modelId);
  // Even a forward the write did not clear is refuted by the marker on disk.
  catalog.recordRename({
    namespace: "",
    type_normalized: type.normalized,
    model_id: modelId,
    data_name: "old",
    renamed_to: "new",
  });

  const results = service.querySync('name == "old"') as DataRecord[];
  assertEquals(results.map((r) => r.id), [rewritten.id]);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: only the renamed model's target row matches", async () => {
  const { catalog, service, save, rename } = setupRenameTest();
  const renamedModel = crypto.randomUUID();
  const otherModel = crypto.randomUUID();
  await save("old", renamedModel);
  await rename(renamedModel, "old", "new");
  await save("new", otherModel);

  const results = service.querySync('name == "old"') as DataRecord[];
  assertEquals(results.map((r) => r.modelId), [renamedModel]);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: versioned and non-equality name terms do not follow", async () => {
  const { catalog, service, save, rename } = setupRenameTest();
  const modelId = crypto.randomUUID();
  await save("old", modelId);
  await rename(modelId, "old", "new");

  assertEquals(service.querySync('name == "old" && version >= 0'), []);
  assertEquals(service.querySync('name == "old" && isLatest == true'), []);
  assertEquals(service.querySync('name in ["old"]'), []);
  assertEquals(service.querySync('name == "old" || name == "zzz"'), []);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: an unreadable marker skips that model instead of failing the query", async () => {
  const { catalog, service, dataRepo, type, save, rename } = setupRenameTest();
  const corruptModel = crypto.randomUUID();
  const otherModel = crypto.randomUUID();
  await save("old", corruptModel);
  await rename(corruptModel, "old", "new");
  await save("old", otherModel);
  const latest = dataRepo.getLatestVersionSync(type, corruptModel, "old")!;
  Deno.writeTextFileSync(
    dataRepo.getMetadataPath(type, corruptModel, "old", latest),
    "lifecycle: [unclosed",
  );

  const results = service.querySync('name == "old"') as DataRecord[];
  assertEquals(results.map((r) => r.modelId), [otherModel]);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: --select sees the item's current name", async () => {
  const { catalog, service, save, rename } = setupRenameTest();
  const modelId = crypto.randomUUID();
  await save("old", modelId);
  await rename(modelId, "old", "new");
  assertEquals(
    await service.query('name == "old"', { select: "name" }),
    ["new"],
  );
  catalog.close();
});

Deno.test("DataQueryService rename forwards: backfill restores forwards from disk and keeps ones its walk cannot see, async and sync", async () => {
  for (const sync of [false, true]) {
    const dir = Deno.makeTempDirSync({ prefix: "swamp-query-forwards-" });
    const catalog = new CatalogStore(
      join(dir, ".swamp", "data", "_catalog.db"),
    );
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    await dataRepo.save(
      type,
      modelId,
      Data.create({
        name: "old",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", modelName: "ingest" },
        ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      }),
      new TextEncoder().encode("hello"),
    );
    await dataRepo.rename(type, modelId, "old", "new");

    // Lose the rename's write-through, and record a forward for a model whose
    // directory is not on disk, as a lazily hydrated walk would miss it.
    catalog.removeRename("", type.normalized, modelId, "old");
    const unseenModel = crypto.randomUUID();
    catalog.recordRename({
      namespace: "",
      type_normalized: type.normalized,
      model_id: unseenModel,
      data_name: "elsewhere",
      renamed_to: "there",
    });
    catalog.invalidate();

    const results = sync
      ? service.querySync('name == "old"') as DataRecord[]
      : await service.query('name == "old"') as DataRecord[];
    assertEquals(results.map((r) => r.name), ["new"]);
    assertEquals(
      catalog.findRenameTarget("", type.normalized, unseenModel, "elsewhere"),
      "there",
    );
    catalog.close();
  }
});

Deno.test("DataQueryService rename forwards: a model() scope reads no other model's markers", async () => {
  const { catalog, service, dataRepo, type, save, rename } = setupRenameTest();
  const scoped = crypto.randomUUID();
  const other = crypto.randomUUID();
  await save("old", scoped);
  await rename(scoped, "old", "new");
  await save("old", other);
  await rename(other, "old", "renamed-elsewhere");
  // Corrupt the other model's marker: a scoped query must not even read it.
  const latest = dataRepo.getLatestVersionSync(type, other, "old")!;
  Deno.writeTextFileSync(
    dataRepo.getMetadataPath(type, other, "old", latest),
    "lifecycle: [unclosed",
  );
  const reads: string[] = [];
  const findByNameSync = dataRepo.findByNameSync.bind(dataRepo);
  dataRepo.findByNameSync = (t, modelId, name, version) => {
    reads.push(modelId);
    return findByNameSync(t, modelId, name, version);
  };

  const results = await service.query('model("m") && name == "old"', {
    modelResolver: () =>
      Promise.resolve({ modelType: type.normalized, modelId: scoped }),
  }) as DataRecord[];

  assertEquals(results.map((r) => r.name), ["new"]);
  assertEquals(reads.includes(other), false);
  catalog.close();
});

Deno.test("DataQueryService rename forwards: a stale catalog row under the old name is not returned beside the forwarded item", async () => {
  const { catalog, service, type, save, rename } = setupRenameTest();
  const modelId = crypto.randomUUID();
  const original = await save("old", modelId);
  await rename(modelId, "old", "new");
  // As a rename synced from another machine leaves it: the old name's row is
  // still latest in this catalog, though the marker on disk forwards it.
  catalog.upsert({
    namespace: "",
    type_normalized: type.normalized,
    model_id: modelId,
    data_name: "old",
    id: original.id,
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "ingest",
    spec_name: "",
    data_type: "resource",
    content_type: "text/plain",
    lifetime: "infinite",
    garbage_collection: "10",
    owner_type: "model-method",
    streaming: 0,
    size: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "test",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  });

  assertEquals(names(service.querySync('name == "old"')), ["new"]);
  catalog.close();
});

// ── modelType / modelId pushdown (swamp-club#3011) ──────────────────────

function seedModelIdentities(catalog: CatalogStore): void {
  catalog.upsert(makeRow({
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "a",
    id: "data-a",
  }));
  catalog.upsert(makeRow({
    type_normalized: "test-model",
    model_id: "model-002",
    data_name: "b",
    id: "data-b",
    model_name: "other",
  }));
  catalog.upsert(makeRow({
    type_normalized: "other-model",
    model_id: "model-001",
    data_name: "c",
    id: "data-c",
  }));
}

function recordedFilters(catalog: CatalogStore): string[] {
  const filters: string[] = [];
  const original = catalog.iterateFiltered.bind(catalog);
  catalog.iterateFiltered = (where, params) => {
    filters.push(where);
    return original(where, params);
  };
  return filters;
}

function sortedNames(results: unknown[]): string[] {
  return (results as DataRecord[]).map((r) => r.name).sort();
}

Deno.test("DataQueryService: pushes modelType and modelId literal equalities down to SQL", () => {
  const { catalog, service } = setupTest();
  seedModelIdentities(catalog);
  const filters = recordedFilters(catalog);

  const results = service.querySync(
    'modelType == "test-model" && modelId == "model-001"',
  );
  assertEquals(sortedNames(results), ["a"]);
  assertEquals(filters.length, 1);
  assertStringIncludes(filters[0], "type_normalized = ?");
  assertStringIncludes(filters[0], "model_id = ?");
  catalog.close();
});

Deno.test("DataQueryService: modelType and modelId pushdown matches the unpushed predicate", () => {
  const { catalog, service } = setupTest();
  seedModelIdentities(catalog);

  const cases: Array<[string, string]> = [
    ['modelId == "model-001"', 'modelId in ["model-001"]'],
    ['modelType == "test-model"', 'modelType in ["test-model"]'],
    [
      'modelType == "test-model" && modelId == "model-002"',
      'modelType in ["test-model"] && modelId in ["model-002"]',
    ],
    [
      'modelId == "model-002" || modelType == "other-model"',
      'modelId in ["model-002"] || modelType in ["other-model"]',
    ],
    ['modelId != "model-001"', '!(modelId in ["model-001"])'],
  ];
  for (const [pushed, unpushed] of cases) {
    assertEquals(
      sortedNames(service.querySync(pushed)),
      sortedNames(service.querySync(unpushed)),
      pushed,
    );
  }
  catalog.close();
});

Deno.test("DataQueryService: does not push modelId down from an OR branch", () => {
  const { catalog, service } = setupTest();
  seedModelIdentities(catalog);
  const filters = recordedFilters(catalog);

  service.querySync('modelId == "model-002" || name == "a"');
  assertEquals(filters.length, 1);
  assertEquals(filters[0].includes("model_id = ?"), false);
  catalog.close();
});
