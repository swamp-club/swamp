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

import { assertEquals } from "@std/assert";
import { CompositeDataQueryService } from "./composite_data_query_service.ts";
import { DataQueryService } from "./data_query_service.ts";
import { InMemoryUnifiedDataRepository } from "../../infrastructure/persistence/in_memory_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { DataRecord } from "./data_record.ts";

function createTestData(overrides: Partial<{
  name: string;
  lifetime: string;
  ownerRef: string;
}> = {}): Data {
  return Data.create({
    name: overrides.name ?? "test-data",
    contentType: "application/json",
    lifetime: overrides.lifetime ?? "ephemeral",
    garbageCollection: 5,
    streaming: false,
    tags: { type: "resource", specName: "test", modelName: "test-model" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: overrides.ownerRef ?? "test-ref",
    },
  });
}

const TEST_TYPE = ModelType.create("test/type");
const TEST_MODEL_ID = "test-model-id";

function createCompositeQueryService(): {
  composite: CompositeDataQueryService;
  persistentRepo: InMemoryUnifiedDataRepository;
  ephemeralRepo: InMemoryUnifiedDataRepository;
} {
  const persistentCatalog = new CatalogStore(":memory:");
  const ephemeralCatalog = new CatalogStore(":memory:");
  const persistentRepo = new InMemoryUnifiedDataRepository(persistentCatalog);
  const ephemeralRepo = new InMemoryUnifiedDataRepository(ephemeralCatalog);
  const ephemeralQueryService = new DataQueryService(
    ephemeralCatalog,
    ephemeralRepo,
  );
  const composite = new CompositeDataQueryService(
    persistentCatalog,
    persistentRepo,
    ephemeralQueryService,
  );
  return { composite, persistentRepo, ephemeralRepo };
}

Deno.test("CompositeDataQueryService: query returns results from both stores merged", async () => {
  const { composite, persistentRepo, ephemeralRepo } =
    createCompositeQueryService();

  const ephData = createTestData({ name: "eph-data", ownerRef: "eph" });
  const persData = createTestData({ name: "pers-data", ownerRef: "pers" });

  await ephemeralRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    ephData,
    new TextEncoder().encode('{"source": "ephemeral"}'),
  );
  await persistentRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    persData,
    new TextEncoder().encode('{"source": "persistent"}'),
  );

  const results = (await composite.query("true")) as DataRecord[];

  assertEquals(results.length, 2);
  const names = results.map((r) => r.name).sort();
  assertEquals(names, ["eph-data", "pers-data"]);
});

Deno.test("CompositeDataQueryService: query deduplicates when same record exists in both stores", async () => {
  const { composite, persistentRepo, ephemeralRepo } =
    createCompositeQueryService();

  // Same name saved to both stores — ephemeral should win
  const ephData = createTestData({ name: "shared", ownerRef: "eph" });
  const persData = createTestData({ name: "shared", ownerRef: "pers" });

  await ephemeralRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    ephData,
    new TextEncoder().encode('{"source": "ephemeral"}'),
  );
  await persistentRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    persData,
    new TextEncoder().encode('{"source": "persistent"}'),
  );

  const results = (await composite.query("true")) as DataRecord[];

  assertEquals(results.length, 1);
  assertEquals(results[0].name, "shared");
  assertEquals(results[0].ownerRef, "eph");
});

Deno.test("CompositeDataQueryService: querySync returns merged and deduplicated results", () => {
  const { composite, persistentRepo, ephemeralRepo } =
    createCompositeQueryService();

  // Use synchronous save by calling the sync-populated repos directly.
  // InMemoryUnifiedDataRepository.save is async, but the catalog is already
  // populated after construction, so querySync works once data is present.
  // We need to save data first, then query synchronously.
  const ephData = createTestData({ name: "shared", ownerRef: "eph" });
  const persData = createTestData({ name: "shared", ownerRef: "pers" });
  const persOnly = createTestData({ name: "pers-only", ownerRef: "pers" });

  // Save all data then query synchronously
  const setup = Promise.all([
    ephemeralRepo.save(
      TEST_TYPE,
      TEST_MODEL_ID,
      ephData,
      new TextEncoder().encode('{"source": "ephemeral"}'),
    ),
    persistentRepo.save(
      TEST_TYPE,
      TEST_MODEL_ID,
      persData,
      new TextEncoder().encode('{"source": "persistent"}'),
    ),
    persistentRepo.save(
      TEST_TYPE,
      TEST_MODEL_ID,
      persOnly,
      new TextEncoder().encode('{"source": "persistent-only"}'),
    ),
  ]);

  return setup.then(() => {
    const results = composite.querySync("true") as DataRecord[];

    assertEquals(results.length, 2);
    const names = results.map((r) => r.name).sort();
    assertEquals(names, ["pers-only", "shared"]);

    // "shared" should come from the ephemeral store
    const shared = results.find((r) => r.name === "shared");
    assertEquals(shared?.ownerRef, "eph");
  });
});

Deno.test("CompositeDataQueryService: query with select concatenates without deduplication", async () => {
  const { composite, persistentRepo, ephemeralRepo } =
    createCompositeQueryService();

  // Same name in both stores. When using `select`, the results are opaque
  // projected values (not DataRecords), so deduplication by composite key
  // is not possible — both projected values are returned as-is.
  const ephData = createTestData({ name: "shared", ownerRef: "eph" });
  const persData = createTestData({ name: "shared", ownerRef: "pers" });

  await ephemeralRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    ephData,
    new TextEncoder().encode('{"source": "ephemeral"}'),
  );
  await persistentRepo.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    persData,
    new TextEncoder().encode('{"source": "persistent"}'),
  );

  const results = await composite.query("true", { select: "name" });

  // Both projected values are included — no dedup on projections
  assertEquals(results.length, 2);
  assertEquals(results[0], "shared");
  assertEquals(results[1], "shared");
});
