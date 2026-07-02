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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { InMemoryUnifiedDataRepository } from "./in_memory_data_repository.ts";
import { CatalogStore } from "./catalog_store.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { OwnershipValidationError } from "../../domain/data/repositories.ts";

function createTestData(overrides: Partial<{
  name: string;
  lifetime: string;
  streaming: boolean;
  garbageCollection: number;
  ownerRef: string;
}> = {}): Data {
  return Data.create({
    name: overrides.name ?? "test-data",
    contentType: "application/json",
    lifetime: overrides.lifetime ?? "ephemeral",
    garbageCollection: overrides.garbageCollection ?? 5,
    streaming: overrides.streaming ?? false,
    tags: { type: "resource", specName: "test", modelName: "test-model" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: overrides.ownerRef ?? "test-ref",
    },
  });
}

const TEST_TYPE = ModelType.create("test/type");
const TEST_MODEL_ID = "test-model-id";
const TEST_CONTENT = new TextEncoder().encode('{"key": "value"}');

function createRepo(): {
  repo: InMemoryUnifiedDataRepository;
  catalog: CatalogStore;
} {
  const catalog = new CatalogStore(":memory:");
  const repo = new InMemoryUnifiedDataRepository(catalog);
  return { repo, catalog };
}

Deno.test("save: stores data and returns version", async () => {
  const { repo } = createRepo();
  const data = createTestData();

  const result = await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  assertEquals(result.version, 1);
});

Deno.test("save: increments version on subsequent saves", async () => {
  const { repo } = createRepo();
  const data = createTestData();

  const r1 = await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  const r2 = await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  assertEquals(r1.version, 1);
  assertEquals(r2.version, 2);
});

Deno.test("save: rejects reserved data names", async () => {
  const { repo } = createRepo();
  const data = createTestData({ name: "latest" });

  await assertRejects(
    () => repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT),
    Error,
    "reserved for internal use",
  );
});

Deno.test("save: validates ownership", async () => {
  const { repo } = createRepo();
  const data1 = createTestData({ ownerRef: "owner-1" });
  const data2 = createTestData({ ownerRef: "owner-2" });

  await repo.save(TEST_TYPE, TEST_MODEL_ID, data1, TEST_CONTENT);

  await assertRejects(
    () => repo.save(TEST_TYPE, TEST_MODEL_ID, data2, TEST_CONTENT),
    OwnershipValidationError,
  );
});

Deno.test("findByName: retrieves saved data", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const found = await repo.findByName(TEST_TYPE, TEST_MODEL_ID, "test-data");

  assertEquals(found?.name, "test-data");
  assertEquals(found?.version, 1);
});

Deno.test("findByName: returns null for missing data", async () => {
  const { repo } = createRepo();

  const found = await repo.findByName(TEST_TYPE, TEST_MODEL_ID, "missing");

  assertEquals(found, null);
});

Deno.test("findByName: retrieves specific version", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  await repo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    new TextEncoder().encode("v2"),
  );

  const found = await repo.findByName(TEST_TYPE, TEST_MODEL_ID, "test-data", 1);

  assertEquals(found?.version, 1);
});

Deno.test("getContent: retrieves saved content", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const content = await repo.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );

  assertEquals(content, TEST_CONTENT);
});

Deno.test("getContent: returns null for missing data", async () => {
  const { repo } = createRepo();

  const content = await repo.getContent(TEST_TYPE, TEST_MODEL_ID, "missing");

  assertEquals(content, null);
});

Deno.test("listVersions: returns sorted versions", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const versions = await repo.listVersions(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );

  assertEquals(versions, [1, 2, 3]);
});

Deno.test("delete: removes all versions", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  await repo.delete(TEST_TYPE, TEST_MODEL_ID, "test-data");

  const found = await repo.findByName(TEST_TYPE, TEST_MODEL_ID, "test-data");
  assertEquals(found, null);
  const versions = await repo.listVersions(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(versions, []);
});

Deno.test("delete: removes specific version", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  await repo.delete(TEST_TYPE, TEST_MODEL_ID, "test-data", 1);

  const versions = await repo.listVersions(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(versions, [2]);
});

Deno.test("append: appends to streaming data", async () => {
  const { repo } = createRepo();
  const data = createTestData({ streaming: true });
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const appendContent = new TextEncoder().encode("\nmore data");
  await repo.append(TEST_TYPE, TEST_MODEL_ID, "test-data", appendContent);

  const content = await repo.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(content?.length, TEST_CONTENT.length + appendContent.length);
});

Deno.test("append: rejects non-streaming data", async () => {
  const { repo } = createRepo();
  const data = createTestData({ streaming: false });
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  await assertRejects(
    () =>
      repo.append(
        TEST_TYPE,
        TEST_MODEL_ID,
        "test-data",
        new TextEncoder().encode("more"),
      ),
    Error,
    "not configured for streaming",
  );
});

Deno.test("allocateVersion: creates temp file and finalizeVersion reads it into memory", async () => {
  const { repo } = createRepo();
  const data = createTestData();

  const alloc = await repo.allocateVersion(TEST_TYPE, TEST_MODEL_ID, data);
  assertEquals(typeof alloc.version, "number");
  assertEquals(typeof alloc.contentPath, "string");

  await Deno.writeFile(alloc.contentPath, TEST_CONTENT);

  const result = await repo.finalizeVersion(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    alloc.version,
  );

  assertEquals(result.size, TEST_CONTENT.length);
  assertEquals(typeof result.checksum, "string");

  const content = await repo.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(content, TEST_CONTENT);

  // Temp file should be cleaned up
  await assertRejects(
    () => Deno.stat(alloc.contentPath),
    Deno.errors.NotFound,
  );
});

Deno.test("findAllForModel: returns latest versions", async () => {
  const { repo } = createRepo();
  const data1 = createTestData({ name: "data-1" });
  const data2 = createTestData({ name: "data-2" });
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data1, TEST_CONTENT);
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data2, TEST_CONTENT);

  const results = await repo.findAllForModel(TEST_TYPE, TEST_MODEL_ID);

  assertEquals(results.length, 2);
  const names = results.map((d) => d.name).sort();
  assertEquals(names, ["data-1", "data-2"]);
});

Deno.test("findAllGlobal: returns all data across models", async () => {
  const { repo } = createRepo();
  const data1 = createTestData({ name: "data-1" });
  const data2 = createTestData({ name: "data-2" });
  await repo.save(TEST_TYPE, "model-a", data1, TEST_CONTENT);
  await repo.save(TEST_TYPE, "model-b", data2, TEST_CONTENT);

  const results = await repo.findAllGlobal();

  assertEquals(results.length, 2);
});

Deno.test("rename: creates new entry and tombstones old", async () => {
  const { repo } = createRepo();
  const data = createTestData({ name: "old-name" });
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const result = await repo.rename(
    TEST_TYPE,
    TEST_MODEL_ID,
    "old-name",
    "new-name",
  );

  assertEquals(result.oldName, "old-name");
  assertEquals(result.newName, "new-name");

  const newData = await repo.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "new-name",
  );
  assertEquals(newData?.name, "new-name");

  const content = await repo.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "new-name",
  );
  assertEquals(content, TEST_CONTENT);
});

Deno.test("getPath: returns synthetic ephemeral path", () => {
  const { repo } = createRepo();

  const path = repo.getPath(TEST_TYPE, TEST_MODEL_ID, "data-1", 1);

  assertEquals(path, "ephemeral://test/type/test-model-id/data-1/1");
});

Deno.test("getContentPath: returns synthetic ephemeral path", () => {
  const { repo } = createRepo();

  const path = repo.getContentPath(TEST_TYPE, TEST_MODEL_ID, "data-1", 1);

  assertEquals(path, "ephemeral://test/type/test-model-id/data-1/1/raw");
});

Deno.test("dispose: clears all data and prevents further operations", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  repo.dispose();

  assertThrows(
    () => repo.findByNameSync(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    Error,
    "disposed",
  );
});

Deno.test("sync methods: match async counterparts", async () => {
  const { repo } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const syncData = repo.findByNameSync(TEST_TYPE, TEST_MODEL_ID, "test-data");
  const asyncData = await repo.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(syncData?.id, asyncData?.id);

  const syncContent = repo.getContentSync(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  const asyncContent = await repo.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(syncContent, asyncContent);

  const syncLatest = repo.getLatestVersionSync(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(syncLatest, 1);
});

Deno.test("catalog integration: indexes data for search", async () => {
  const { repo, catalog } = createRepo();
  const data = createTestData();
  await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  let rowCount = 0;
  for (const _row of catalog.iterate()) {
    rowCount++;
  }

  assertEquals(rowCount, 1);
});

Deno.test("collectGarbage: removes excess versions", async () => {
  const { repo } = createRepo();
  const data = createTestData({ garbageCollection: 2 });

  for (let i = 0; i < 5; i++) {
    await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  }

  const result = await repo.collectGarbage(TEST_TYPE, TEST_MODEL_ID);

  assertEquals(result.versionsRemoved, 3);

  const versions = await repo.listVersions(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(versions, [4, 5]);
});

Deno.test("collectGarbage: dryRun does not remove versions", async () => {
  const { repo } = createRepo();
  const data = createTestData({ garbageCollection: 2 });

  for (let i = 0; i < 5; i++) {
    await repo.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);
  }

  const result = await repo.collectGarbage(TEST_TYPE, TEST_MODEL_ID, {
    dryRun: true,
  });

  assertEquals(result.versionsRemoved, 3);

  const versions = await repo.listVersions(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(versions, [1, 2, 3, 4, 5]);
});
