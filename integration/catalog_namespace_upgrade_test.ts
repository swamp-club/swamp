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
 * Integration test for the giga-swamp Phase 2 catalog schema v4 upgrade path.
 *
 * Bumping CATALOG_SCHEMA_VERSION from "3" to "4" makes the self-healing backfill
 * drop and rebuild the catalog on the first command after upgrade. EVERY existing
 * repo hits this. This test verifies that rebuilding the catalog from disk
 * produces identical query results, with every row carrying the solo namespace
 * (""), since Phase 2 does not change the filesystem layout (that is Phase 3).
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, existsSync } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-catalog-upgrade-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const type = ModelType.create("test/model");
const owner = { ownerType: "model-method" as const, ownerRef: "test/model:m" };

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: "ingest", specName: "result" },
    ownerDefinition: owner,
  });
}

/** Runs a query against a freshly-opened catalog/repo/service over `repoDir`. */
async function queryFresh(
  repoDir: string,
  predicate: string,
): Promise<DataRecord[]> {
  const catalog = new CatalogStore(
    join(repoDir, ".swamp", "data", "_catalog.db"),
  );
  try {
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, repo);
    return await service.query(predicate) as DataRecord[];
  } finally {
    catalog.close();
  }
}

/** Deletes the catalog db and its WAL/SHM sidecars, forcing a rebuild on reopen. */
function deleteCatalog(repoDir: string): void {
  const dbPath = join(repoDir, ".swamp", "data", "_catalog.db");
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) Deno.removeSync(path);
  }
}

Deno.test("Catalog upgrade: rebuilding from disk preserves query results with namespace=''", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, ".swamp", "data"));
    const modelId = crypto.randomUUID();

    // 1. Write two data items through a repo (solo mode — no namespace).
    {
      const catalog = new CatalogStore(
        join(repoDir, ".swamp", "data", "_catalog.db"),
      );
      const repo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
      );
      await repo.save(
        type,
        modelId,
        makeData("alpha"),
        new TextEncoder().encode('{"k":1}'),
      );
      await repo.save(
        type,
        modelId,
        makeData("beta"),
        new TextEncoder().encode('{"k":2}'),
      );
      catalog.close();
    }

    // 2. Baseline query before the simulated upgrade.
    const baseline = (await queryFresh(repoDir, 'modelName == "ingest"'))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    assertEquals(baseline.length, 2);
    assertEquals(baseline.map((r) => r.namespace), ["", ""]);

    // 3. Simulate the v3 -> v4 upgrade: delete the catalog so the next open
    //    rebuilds it from disk via the self-healing backfill.
    deleteCatalog(repoDir);

    // 4. Re-query after the rebuild.
    const rebuilt = (await queryFresh(repoDir, 'modelName == "ingest"'))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    // 5. Results must be identical, and every row carries the solo namespace.
    assertEquals(rebuilt.length, baseline.length);
    for (let i = 0; i < rebuilt.length; i++) {
      assertEquals(rebuilt[i].id, baseline[i].id);
      assertEquals(rebuilt[i].name, baseline[i].name);
      assertEquals(rebuilt[i].version, baseline[i].version);
      assertEquals(rebuilt[i].modelName, baseline[i].modelName);
      assertEquals(rebuilt[i].namespace, "");
    }
  });
});
