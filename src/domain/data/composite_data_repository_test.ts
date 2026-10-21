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

import { assertEquals, assertRejects } from "@std/assert";
import { CompositeUnifiedDataRepository } from "./composite_data_repository.ts";
import { InMemoryUnifiedDataRepository } from "../../infrastructure/persistence/in_memory_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { RenameForward, UnreadableModelRecord } from "./repositories.ts";

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

Deno.test("CompositeUnifiedDataRepository: iterateForModel yields what findAllForModel returns, ephemeral first", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  await ephemeral.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "shared", lifetime: "ephemeral", ownerRef: "eph" }),
    TEST_CONTENT,
  );
  await persistent.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "shared", lifetime: "infinite", ownerRef: "pers" }),
    TEST_CONTENT,
  );
  await persistent.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "only-persistent", lifetime: "infinite" }),
    TEST_CONTENT,
  );

  const iterated = await Array.fromAsync(
    composite.iterateForModel(TEST_TYPE, TEST_MODEL_ID),
  );
  const all = await composite.findAllForModel(TEST_TYPE, TEST_MODEL_ID);

  assertEquals(
    iterated.map((d) => [d.name, d.ownerDefinition.ownerRef]),
    all.map((d) => [d.name, d.ownerDefinition.ownerRef]),
  );
  assertEquals(iterated[0].ownerDefinition.ownerRef, "eph");
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

Deno.test("CompositeUnifiedDataRepository: findAllGlobal reports rename markers from both repos", async () => {
  const { composite, persistent } = createCompositeRepo();
  await persistent.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "old", lifetime: "infinite" }),
    TEST_CONTENT,
  );
  await persistent.rename(TEST_TYPE, TEST_MODEL_ID, "old", "new");

  for (const sync of [false, true]) {
    const renames: RenameForward[] = [];
    if (sync) composite.findAllGlobalSync({ renames });
    else await composite.findAllGlobal({ renames });
    assertEquals(
      renames.map((r) => [r.dataName, r.renamedTo]),
      [["old", "new"]],
    );
  }
});

Deno.test("CompositeUnifiedDataRepository: findAllForType passes the unreadable collector to both repos", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  for (
    const [repo, modelId] of [[persistent, "p"], [ephemeral, "e"]] as const
  ) {
    repo.findAllForType = (type, options) => {
      options?.unreadable?.push({
        modelType: ModelType.create(String(type)),
        modelId,
        error: new Deno.errors.PermissionDenied(),
      });
      return Promise.resolve([]);
    };
  }

  const unreadable: UnreadableModelRecord[] = [];
  await composite.findAllForType(TEST_TYPE, { unreadable });
  assertEquals(unreadable.map((r) => r.modelId).sort(), ["e", "p"]);
});

// --- Content-ensuring step routing (swamp-club#3178) ---

/** A composite whose stores record which one ensureContentLocal reached. */
async function compositeWithSameNameInBothStores() {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  // Ephemeral holds version 1; persistent holds versions 1 and 2.
  await ephemeral.save(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData(),
    TEST_CONTENT,
  );
  for (let i = 0; i < 2; i++) {
    await persistent.save(
      TEST_TYPE,
      TEST_MODEL_ID,
      createTestData({ lifetime: "infinite" }),
      TEST_CONTENT,
    );
  }
  const reached: string[] = [];
  for (
    const [name, repo] of [["ephemeral", ephemeral], [
      "persistent",
      persistent,
    ]] as const
  ) {
    const ensure = repo.ensureContentLocal.bind(repo);
    repo.ensureContentLocal = (...args) => {
      reached.push(name);
      return ensure(...args);
    };
    const accepted = repo.isContentAcceptedSync.bind(repo);
    repo.isContentAcceptedSync = (...args) => {
      reached.push(name);
      return accepted(...args);
    };
  }
  return { composite, reached };
}

Deno.test("CompositeUnifiedDataRepository.ensureContentLocal: reaches the store that holds the requested version", async () => {
  const { composite, reached } = await compositeWithSameNameInBothStores();
  await composite.ensureContentLocal(TEST_TYPE, TEST_MODEL_ID, "test-data");
  await composite.ensureContentLocal(TEST_TYPE, TEST_MODEL_ID, "test-data", 1);
  await composite.ensureContentLocal(TEST_TYPE, TEST_MODEL_ID, "test-data", 2);
  assertEquals(reached, ["ephemeral", "ephemeral", "persistent"]);
});

Deno.test("CompositeUnifiedDataRepository.isContentAcceptedSync: reaches the store that holds the requested version", async () => {
  const { composite, reached } = await compositeWithSameNameInBothStores();
  composite.isContentAcceptedSync(TEST_TYPE, TEST_MODEL_ID, "test-data", 1, 0);
  composite.isContentAcceptedSync(TEST_TYPE, TEST_MODEL_ID, "test-data", 2, 0);
  assertEquals(reached, ["ephemeral", "persistent"]);
});

class FailingSettleRepository extends InMemoryUnifiedDataRepository {
  override advanceLatestMarkers(): Promise<void> {
    return Promise.reject(new Error("advance failed"));
  }

  override rollbackVersions(): Promise<void> {
    return Promise.reject(new Error("rollback failed"));
  }
}

function createCompositeWithFailingPersistent(): {
  composite: CompositeUnifiedDataRepository;
  ephemeral: InMemoryUnifiedDataRepository;
} {
  const persistent = new FailingSettleRepository(new CatalogStore(":memory:"));
  const ephemeral = new InMemoryUnifiedDataRepository(
    new CatalogStore(":memory:"),
  );
  return {
    composite: new CompositeUnifiedDataRepository(persistent, ephemeral),
    ephemeral,
  };
}

Deno.test("CompositeUnifiedDataRepository.saveDeferred: a persistent write is latest only once advanced (swamp-club#3255)", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const data = createTestData({ lifetime: "infinite" });

  const receipt = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    TEST_CONTENT,
  );
  assertEquals(
    await composite.findByName(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    null,
  );

  await composite.advanceLatestMarkers([receipt]);

  const promoted = await persistent.findByName(
    TEST_TYPE,
    TEST_MODEL_ID,
    "test-data",
  );
  assertEquals(promoted?.version, receipt.version);
  assertEquals(
    await ephemeral.listVersions(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    [],
  );
});

Deno.test("CompositeUnifiedDataRepository.rollbackVersions: removes an ephemeral deferred write from the ephemeral repo (swamp-club#3255)", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const data = createTestData({ lifetime: "ephemeral" });

  const receipt = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    TEST_CONTENT,
  );
  assertEquals(
    await ephemeral.listVersions(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    [receipt.version],
  );

  await composite.rollbackVersions([receipt]);

  assertEquals(
    await ephemeral.listVersions(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    [],
  );
  assertEquals(
    await persistent.listVersions(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    [],
  );
});

Deno.test("CompositeUnifiedDataRepository.advanceLatestMarkers: settles a mixed batch in each owning repo (swamp-club#3255)", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();

  const durable = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "durable", lifetime: "infinite" }),
    TEST_CONTENT,
  );
  const scratch = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "scratch", lifetime: "ephemeral" }),
    TEST_CONTENT,
  );

  await composite.advanceLatestMarkers([durable, scratch]);

  assertEquals(
    persistent.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "durable"),
    durable.version,
  );
  assertEquals(
    persistent.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "scratch"),
    null,
  );
  assertEquals(
    ephemeral.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "scratch"),
    scratch.version,
  );
  assertEquals(
    ephemeral.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "durable"),
    null,
  );
});

Deno.test("CompositeUnifiedDataRepository.advanceLatestMarkers: routes a streamed deferred write finalized through the composite (swamp-club#3255)", async () => {
  const { composite, persistent, ephemeral } = createCompositeRepo();
  const data = createTestData({ lifetime: "ephemeral", streaming: true });

  const allocated = await composite.allocateVersion(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    { deferred: true },
  );
  await Deno.writeFile(allocated.contentPath, TEST_CONTENT);
  const { receipt } = await composite.finalizeVersionDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    allocated.version,
    allocated.priorVersions,
  );
  await composite.advanceLatestMarkers([receipt]);

  assertEquals(
    ephemeral.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    allocated.version,
  );
  assertEquals(
    persistent.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "test-data"),
    null,
  );
});

Deno.test("CompositeUnifiedDataRepository.rollbackVersions: releases a pending allocation in the repo that made it (swamp-club#3255)", async () => {
  const { composite } = createCompositeRepo();
  const data = createTestData({ lifetime: "ephemeral", streaming: true });

  const allocated = await composite.allocateVersion(
    TEST_TYPE,
    TEST_MODEL_ID,
    data,
    { deferred: true },
  );
  await Deno.writeFile(allocated.contentPath, TEST_CONTENT);

  // The receipt a writer builds for a version it never finalized.
  await composite.rollbackVersions([{
    type: TEST_TYPE,
    modelId: TEST_MODEL_ID,
    dataName: data.name,
    version: allocated.version,
  }]);

  await assertRejects(
    () => Deno.stat(allocated.contentPath),
    Deno.errors.NotFound,
  );
});

Deno.test("CompositeUnifiedDataRepository: settling no receipts does nothing (swamp-club#3255)", async () => {
  const { composite } = createCompositeWithFailingPersistent();

  await composite.advanceLatestMarkers([]);
  await composite.rollbackVersions([]);
});

Deno.test("CompositeUnifiedDataRepository.rollbackVersions: a failing repo does not strand the other's writes (swamp-club#3255)", async () => {
  const { composite, ephemeral } = createCompositeWithFailingPersistent();

  const durable = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "durable", lifetime: "infinite" }),
    TEST_CONTENT,
  );
  const scratch = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "scratch", lifetime: "ephemeral" }),
    TEST_CONTENT,
  );

  await assertRejects(
    () => composite.rollbackVersions([durable, scratch]),
    Error,
    "rollback failed",
  );

  assertEquals(
    await ephemeral.listVersions(TEST_TYPE, TEST_MODEL_ID, "scratch"),
    [],
  );
});

Deno.test("CompositeUnifiedDataRepository.rollbackVersions: reaches the owning repo after a failed advance (swamp-club#3255)", async () => {
  const { composite, ephemeral } = createCompositeWithFailingPersistent();

  const durable = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "durable", lifetime: "infinite" }),
    TEST_CONTENT,
  );
  const scratch = await composite.saveDeferred(
    TEST_TYPE,
    TEST_MODEL_ID,
    createTestData({ name: "scratch", lifetime: "ephemeral" }),
    TEST_CONTENT,
  );

  await assertRejects(
    () => composite.advanceLatestMarkers([durable, scratch]),
    Error,
    "advance failed",
  );
  // The persistent promotion failed first, so nothing ephemeral was promoted.
  assertEquals(
    ephemeral.getLatestVersionSync(TEST_TYPE, TEST_MODEL_ID, "scratch"),
    null,
  );

  await assertRejects(() => composite.rollbackVersions([durable, scratch]));

  assertEquals(
    await ephemeral.listVersions(TEST_TYPE, TEST_MODEL_ID, "scratch"),
    [],
  );
});
