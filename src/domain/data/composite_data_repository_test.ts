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
import { CompositeUnifiedDataRepository } from "./composite_data_repository.ts";
import { InMemoryUnifiedDataRepository } from "../../infrastructure/persistence/in_memory_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";

function createTestData(overrides: Partial<{
  name: string;
  lifetime: string;
  streaming: boolean;
  ownerRef: string;
}> = {}): Data {
  return Data.create({
    name: overrides.name ?? "test-data",
    contentType: "application/json",
    lifetime: overrides.lifetime ?? "ephemeral",
    garbageCollection: 5,
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

function createCompositeRepo(): {
  composite: CompositeUnifiedDataRepository;
  persistent: InMemoryUnifiedDataRepository;
  ephemeral: InMemoryUnifiedDataRepository;
} {
  const persistentCatalog = new CatalogStore(":memory:");
  const ephemeralCatalog = new CatalogStore(":memory:");
  const persistent = new InMemoryUnifiedDataRepository(persistentCatalog);
  const ephemeral = new InMemoryUnifiedDataRepository(ephemeralCatalog);
  const composite = new CompositeUnifiedDataRepository(persistent, ephemeral);
  return { composite, persistent, ephemeral };
}

Deno.test("CompositeUnifiedDataRepository: save routes ephemeral lifetime to ephemeral repo", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const data = createTestData({ lifetime: "ephemeral" });

  await composite.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const ephResult = await ephemeral.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  const persResult = await persistent.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(ephResult?.name, "test-data");
  assertEquals(persResult, null);
});

Deno.test("CompositeUnifiedDataRepository: save routes non-ephemeral lifetime to persistent repo", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const data = createTestData({ lifetime: "infinite" });

  await composite.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  const persResult = await persistent.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  const ephResult = await ephemeral.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(persResult?.name, "test-data");
  assertEquals(ephResult, null);
});

Deno.test("CompositeUnifiedDataRepository: findByName returns ephemeral data when it exists", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const ephData = createTestData({ lifetime: "ephemeral", ownerRef: "eph" });
  const persData = createTestData({ lifetime: "infinite", ownerRef: "pers" });

  // Save to both stores with different owner refs so content differs
  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, ephData, TEST_CONTENT);
  await persistent.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    persData,
    new TextEncoder().encode('{"key": "persistent"}'),
  );

  const found = await composite.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  // Ephemeral shadows persistent — the result should come from the ephemeral store
  assertEquals(found?.ownerDefinition.ownerRef, "eph");
});

Deno.test("CompositeUnifiedDataRepository: findByName falls back to persistent when ephemeral has no match", async () => {
  const { composite, persistent } = createCompositeRepo();
  const persData = createTestData({ lifetime: "infinite" });

  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persData, TEST_CONTENT);

  const found = await composite.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(found?.name, "test-data");
});

Deno.test("CompositeUnifiedDataRepository: findAllForModel merges results, ephemeral shadows persistent by name", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  // "shared" exists in both stores — ephemeral should win
  const sharedEph = createTestData({
    name: "shared",
    lifetime: "ephemeral",
    ownerRef: "eph",
  });
  const sharedPers = createTestData({
    name: "shared",
    lifetime: "infinite",
    ownerRef: "pers",
  });
  const onlyPers = createTestData({
    name: "only-persistent",
    lifetime: "infinite",
  });
  const onlyEph = createTestData({
    name: "only-ephemeral",
    lifetime: "ephemeral",
  });

  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, sharedEph, TEST_CONTENT);
  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, onlyEph, TEST_CONTENT);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, sharedPers, TEST_CONTENT);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, onlyPers, TEST_CONTENT);

  const results = await composite.findAllForModel(TEST_TYPE, TEST_MODEL_ID);

  assertEquals(results.length, 3);
  const names = results.map((d) => d.name).sort();
  assertEquals(names, ["only-ephemeral", "only-persistent", "shared"]);

  // The "shared" entry should be from ephemeral
  const shared = results.find((d) => d.name === "shared");
  assertEquals(shared?.ownerDefinition.ownerRef, "eph");
});

Deno.test("CompositeUnifiedDataRepository: findAllGlobal merges results with deduplication", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  const ephData = createTestData({
    name: "global-data",
    lifetime: "ephemeral",
    ownerRef: "eph",
  });
  const persData = createTestData({
    name: "global-data",
    lifetime: "infinite",
    ownerRef: "pers",
  });
  const persOnly = createTestData({
    name: "pers-only",
    lifetime: "infinite",
  });

  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, ephData, TEST_CONTENT);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persData, TEST_CONTENT);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persOnly, TEST_CONTENT);

  const results = await composite.findAllGlobal();

  assertEquals(results.length, 2);
  const names = results.map((r) => r.data.name).sort();
  assertEquals(names, ["global-data", "pers-only"]);

  // The "global-data" entry should be from ephemeral
  const globalData = results.find((r) => r.data.name === "global-data");
  assertEquals(globalData?.data.ownerDefinition.ownerRef, "eph");
});

Deno.test("CompositeUnifiedDataRepository: getContent returns ephemeral content when available", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  const ephContent = new TextEncoder().encode('{"from": "ephemeral"}');
  const persContent = new TextEncoder().encode('{"from": "persistent"}');

  const ephData = createTestData({ ownerRef: "eph" });
  const persData = createTestData({ ownerRef: "pers" });

  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, ephData, ephContent);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persData, persContent);

  const content = await composite.getContent(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(new TextDecoder().decode(content!), '{"from": "ephemeral"}');
});

Deno.test("CompositeUnifiedDataRepository: getContentSync returns ephemeral content with fallback", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  const ephContent = new TextEncoder().encode('{"from": "ephemeral"}');
  const persContent = new TextEncoder().encode('{"from": "persistent"}');

  // Both stores have the same data name
  const ephData = createTestData({ name: "both", ownerRef: "eph" });
  const persData = createTestData({ name: "both", ownerRef: "pers" });
  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, ephData, ephContent);
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persData, persContent);

  const content = composite.getContentSync(
    TEST_TYPE,
    TEST_MODEL_ID,
    "both",
  );
  assertEquals(new TextDecoder().decode(content!), '{"from": "ephemeral"}');

  // Only persistent has "pers-only"
  const persOnly = createTestData({ name: "pers-only" });
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, persOnly, persContent);

  const fallbackContent = composite.getContentSync(
    TEST_TYPE,
    TEST_MODEL_ID,
    "pers-only",
  );
  assertEquals(
    new TextDecoder().decode(fallbackContent!),
    '{"from": "persistent"}',
  );
});

Deno.test("CompositeUnifiedDataRepository: delete deletes from ephemeral when data exists there", async () => {
  const { composite, ephemeral } = createCompositeRepo();

  const data = createTestData({ lifetime: "ephemeral" });
  await ephemeral.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  await composite.delete(TEST_TYPE, TEST_MODEL_ID, "test-data");

  const found = await ephemeral.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(found, null);
});

Deno.test("CompositeUnifiedDataRepository: delete deletes from persistent when data only exists there", async () => {
  const { composite, persistent } = createCompositeRepo();

  const data = createTestData({ lifetime: "infinite" });
  await persistent.save(TEST_TYPE, TEST_MODEL_ID, data, TEST_CONTENT);

  await composite.delete(TEST_TYPE, TEST_MODEL_ID, "test-data");

  const found = await persistent.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(found, null);
});
