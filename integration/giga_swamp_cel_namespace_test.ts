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

/**
 * Integration test for giga-swamp Phase 4: CEL cross-namespace queries.
 *
 * Verifies namespace routing in point-lookup helpers, wildcard ambiguity
 * checks, data.query() namespace predicates, and the solo-mode byte-identical
 * invariant.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  type CatalogRow,
  CatalogStore,
} from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  catalogDbPath,
  namespaceFromResolver,
} from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-giga-cel-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const modelType = ModelType.create("test/model");

function makeData(
  name: string,
  modelName: string,
  specName = "result",
): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName, specName },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `test/model:${modelName}`,
    },
  });
}

interface SetupResult {
  catalog: CatalogStore;
  queryService: DataQueryService;
  dataRepo: FileSystemUnifiedDataRepository;
  repoDir: string;
}

function setupRepo(
  repoDir: string,
  dsDir: string,
  namespace?: string,
): SetupResult {
  const config: DatastoreConfig = namespace
    ? { type: "filesystem", path: dsDir, namespace }
    : { type: "filesystem", path: dsDir };
  const resolver = new DefaultDatastorePathResolver(repoDir, config);
  const dataBaseDir = resolver.resolvePath("data");
  const catalogPath = catalogDbPath(repoDir, resolver);
  const ns = namespaceFromResolver(resolver);
  const catalog = new CatalogStore(catalogPath);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dataBaseDir,
    catalog,
    undefined,
    undefined,
    ns,
  );
  const queryService = new DataQueryService(catalog, dataRepo);
  return { catalog, queryService, dataRepo, repoDir };
}

function makeCrossNamespaceRow(
  namespace: string,
  modelName: string,
  dataName: string,
): CatalogRow {
  return {
    namespace,
    type_normalized: modelType.normalized,
    model_id: crypto.randomUUID(),
    data_name: dataName,
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    model_name: modelName,
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 2,
    created_at: new Date().toISOString(),
    tags: JSON.stringify({
      type: "resource",
      modelName,
      specName: "result",
    }),
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

async function buildDataContext(
  setup: SetupResult,
): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const defRepo = new YamlDefinitionRepository(
    join(setup.repoDir, ".swamp", "models"),
  );
  const outputRepo = new YamlOutputRepository(
    join(setup.repoDir, ".swamp", "outputs"),
  );
  const resolver = new ModelResolver(defRepo, {
    outputRepo,
    repoDir: setup.repoDir,
    dataRepo: setup.dataRepo,
    dataQueryService: setup.queryService,
  });
  const context = await resolver.buildContext();
  return context.data as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

// --- Test 1: Solo mode byte-identical gate ---

Deno.test("giga-swamp CEL Phase 4: solo mode produces byte-identical results", async () => {
  await withTempDir(async (root) => {
    const repoDir = join(root, "solo-repo");
    const dsDir = join(root, "datastore");
    const setup = setupRepo(repoDir, dsDir);
    const modelId = crypto.randomUUID();

    try {
      await setup.dataRepo.save(
        modelType,
        modelId,
        makeData("output", "scanner"),
        new TextEncoder().encode('{"found":42}'),
      );

      assertEquals(setup.dataRepo.namespace, SOLO_NAMESPACE);

      const rawResults = await setup.queryService.query(
        'modelName == "scanner" && name == "output"',
      ) as DataRecord[];
      assertEquals(rawResults.length, 1);
      assertEquals(rawResults[0].namespace, "");

      const data = await buildDataContext(setup);
      const latest = await (data as {
        latest: (m: string, n: string) => Promise<DataRecord | null>;
      })
        .latest("scanner", "output");
      assertEquals(latest !== null, true);
      assertEquals(latest!.name, "output");
      assertEquals(latest!.namespace, "");
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 2: Cross-namespace point lookup ---
// Uses a single repo/catalog with rows from multiple namespaces inserted
// directly. In production, multi-namespace catalogs are built via datastore
// sync; here we simulate by upserting rows for the "security" namespace.

Deno.test("giga-swamp CEL Phase 4: cross-namespace point lookup with ns:model syntax", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo-infra");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "scanner"),
        new TextEncoder().encode('{"source":"infra"}'),
      );

      // Mark populated before inserting cross-namespace rows to prevent
      // backfill from overwriting them with disk-only (own-namespace) data.
      setup.catalog.markPopulated();

      setup.catalog.upsert(makeCrossNamespaceRow(
        "security",
        "scanner",
        "output",
      ));

      const data = await buildDataContext(setup);
      const latestFn = data.latest as (
        m: string,
        n: string,
      ) => Promise<DataRecord | null>;

      // Default: own namespace only
      const ownResult = await latestFn("scanner", "output");
      assertEquals(ownResult !== null, true);
      assertEquals(ownResult!.namespace, "infra");

      // Explicit cross-namespace
      const crossResult = await latestFn("security:scanner", "output");
      assertEquals(crossResult !== null, true);
      assertEquals(crossResult!.namespace, "security");
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 3: Wildcard ambiguity check ---

Deno.test("giga-swamp CEL Phase 4: wildcard ambiguity errors when model exists in multiple namespaces", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo-all");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "scanner"),
        new TextEncoder().encode('{"ns":"infra"}'),
      );

      setup.catalog.markPopulated();

      setup.catalog.upsert(makeCrossNamespaceRow(
        "security",
        "scanner",
        "output",
      ));

      const data = await buildDataContext(setup);
      const latestFn = data.latest as (
        m: string,
        n: string,
      ) => Promise<DataRecord | null>;

      // Wildcard with ambiguity should throw
      await assertRejects(
        async () => await latestFn("*:scanner", "output"),
        Error,
        "Ambiguous",
      );

      // Specific namespace should NOT throw
      const specific = await latestFn("infra:scanner", "output");
      assertEquals(specific !== null, true);
      assertEquals(specific!.namespace, "infra");
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 4: data.query() namespace predicate filtering ---

Deno.test("giga-swamp CEL Phase 4: data.query() with ns predicate filters by namespace", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "infra-model"),
        new TextEncoder().encode("{}"),
      );

      setup.catalog.markPopulated();

      setup.catalog.upsert(makeCrossNamespaceRow(
        "security",
        "sec-model",
        "output",
      ));

      const data = await buildDataContext(setup);
      const queryFn = data.query as (p: string) => Promise<DataRecord[]>;

      const secResults = await queryFn('ns == "security"');
      assertEquals(secResults.length, 1);
      assertEquals(secResults[0].namespace, "security");

      const infraResults = await queryFn('ns == "infra"');
      assertEquals(infraResults.length, 1);
      assertEquals(infraResults[0].namespace, "infra");
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 5: data.query() without namespace predicate spans all namespaces ---

Deno.test("giga-swamp CEL Phase 4: data.query() without ns predicate spans all namespaces", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "infra-model"),
        new TextEncoder().encode("{}"),
      );

      setup.catalog.markPopulated();

      setup.catalog.upsert(makeCrossNamespaceRow(
        "security",
        "sec-model",
        "output",
      ));

      const data = await buildDataContext(setup);
      const queryFn = data.query as (p: string) => Promise<DataRecord[]>;

      // No namespace predicate — should return data from ALL namespaces
      const allResults = await queryFn('dataType == "resource"');
      assertEquals(allResults.length, 2);
      const namespaces = allResults.map((r) => r.namespace).sort();
      assertEquals(namespaces, ["infra", "security"]);
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 6: Solo mode namespace predicate ---

Deno.test("giga-swamp CEL Phase 4: data.query('ns == \"\"') in solo mode returns all data", async () => {
  await withTempDir(async (root) => {
    const repoDir = join(root, "solo-repo");
    const dsDir = join(root, "datastore");
    const setup = setupRepo(repoDir, dsDir);

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("out-a", "model-a"),
        new TextEncoder().encode("{}"),
      );
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("out-b", "model-b"),
        new TextEncoder().encode("{}"),
      );

      const data = await buildDataContext(setup);
      const queryFn = data.query as (p: string) => Promise<DataRecord[]>;

      // Explicit empty-namespace predicate should match all solo-mode data
      const soloResults = await queryFn('ns == ""');
      assertEquals(soloResults.length, 2);
      for (const r of soloResults) {
        assertEquals(r.namespace, "");
      }
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 7: Wildcard with unambiguous result succeeds ---

Deno.test("giga-swamp CEL Phase 4: wildcard returns result when model exists in one namespace only", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "unique-scanner"),
        new TextEncoder().encode('{"val":1}'),
      );

      const data = await buildDataContext(setup);
      const latestFn = data.latest as (
        m: string,
        n: string,
      ) => Promise<DataRecord | null>;

      // Wildcard with only one namespace should succeed
      const result = await latestFn("*:unique-scanner", "output");
      assertEquals(result !== null, true);
      assertEquals(result!.namespace, "infra");
      assertEquals(result!.modelName, "unique-scanner");
    } finally {
      setup.catalog.close();
    }
  });
});

// --- Test 8: listVersions wildcard ambiguity ---

Deno.test("giga-swamp CEL Phase 4: listVersions wildcard errors when ambiguous", async () => {
  await withTempDir(async (root) => {
    const dsDir = join(root, "shared-ds");
    const repoDir = join(root, "repo");
    const setup = setupRepo(repoDir, dsDir, "infra");

    try {
      await setup.dataRepo.save(
        modelType,
        crypto.randomUUID(),
        makeData("output", "scanner"),
        new TextEncoder().encode("{}"),
      );

      setup.catalog.markPopulated();

      setup.catalog.upsert(makeCrossNamespaceRow(
        "security",
        "scanner",
        "output",
      ));

      const data = await buildDataContext(setup);
      const listVersionsFn = data.listVersions as (
        m: string,
        n: string,
      ) => number[];

      // Wildcard with ambiguity should throw synchronously
      let threw = false;
      try {
        listVersionsFn("*:scanner", "output");
      } catch (e) {
        threw = true;
        assertEquals((e as Error).message.includes("Ambiguous"), true);
      }
      assertEquals(threw, true);

      // Specific namespace should work fine
      const versions = listVersionsFn("infra:scanner", "output");
      assertEquals(versions.length, 1);
      assertEquals(versions[0], 1);
    } finally {
      setup.catalog.close();
    }
  });
});
