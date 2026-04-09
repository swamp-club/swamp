// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { UserError } from "../errors.ts";

function makeRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: "00000000-0000-1000-8000-000000000001",
    version: 1,
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
