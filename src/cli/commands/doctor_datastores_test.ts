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
import { join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { compareCatalogToDisk } from "./doctor_datastores.ts";

/**
 * Writes a data item to disk the way the repository lays it out:
 * `{type-segments}/{model-id}/{data-name}/{version}/metadata.yaml`.
 */
function writeDataItem(
  repoDir: string,
  typeSegments: string[],
  modelId: string,
  dataName: string,
  index: number,
): void {
  const nameDir = join(
    repoDir,
    ".swamp",
    "data",
    ...typeSegments,
    modelId,
    dataName,
  );
  const versionDir = join(nameDir, "1");
  ensureDirSync(versionDir);
  Deno.writeTextFileSync(
    join(versionDir, "raw"),
    JSON.stringify({ hello: "world" }),
  );
  Deno.writeTextFileSync(
    join(versionDir, "metadata.yaml"),
    stringifyYaml({
      name: dataName,
      id: `00000000-0000-1000-8000-0000000002${String(index).padStart(2, "0")}`,
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
  Deno.writeTextFileSync(join(nameDir, "latest"), "1");
}

function withFixture(
  fn: (repoDir: string, catalog: CatalogStore) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const repoDir = Deno.makeTempDirSync({ prefix: "swamp-doctor-catalog-" });
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      await fn(repoDir, catalog);
    } finally {
      catalog.close();
      try {
        Deno.removeSync(repoDir, { recursive: true });
      } catch {
        // Windows may still hold the SQLite handle; the temp dir is disposable.
      }
    }
  };
}

Deno.test(
  "compareCatalogToDisk: reports the shortfall for a model missing from the index",
  withFixture(async (repoDir, catalog) => {
    // The exact shape from swamp-club#1580: a scoped type whose data names are
    // bare integers, present on disk, absent from the catalog.
    for (const [i, name] of ["207333", "124364", "289324"].entries()) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, i);
    }
    // Catalog claims to be fully built and holds nothing.
    catalog.markPopulated();

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    const summary = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );

    assertEquals(summary.diskRecords, 3);
    assertEquals(summary.catalogRecords, 0);
    assertEquals(summary.shortfalls.length, 1);
    assertEquals(summary.shortfalls[0].typeNormalized, "@scope/shows");
    assertEquals(summary.shortfalls[0].diskRecords, 3);
    assertEquals(summary.shortfalls[0].catalogRecords, 0);
  }),
);

Deno.test(
  "compareCatalogToDisk: does not modify the catalog it is measuring",
  withFixture(async (repoDir, catalog) => {
    for (const [i, name] of ["207333", "124364"].entries()) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, i);
    }
    catalog.markPopulated();

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    const rowsBefore = catalog.count();
    const populatedBefore = catalog.isPopulated();

    await compareCatalogToDisk(catalog, dataRepo, SOLO_NAMESPACE);

    // A diagnostic that triggers backfill repairs what it measures and then
    // reports health — the damaged state must survive being looked at.
    assertEquals(catalog.count(), rowsBefore);
    assertEquals(catalog.isPopulated(), populatedBefore);

    // And it is still detectable on a second run.
    const second = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );
    assertEquals(second.shortfalls.length, 1);
  }),
);

Deno.test(
  "compareCatalogToDisk: a fully indexed catalog reports no shortfall",
  withFixture(async (repoDir, catalog) => {
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    // Saving through the repository writes disk and catalog together, which is
    // what a healthy repo looks like.
    for (const name of ["207333", "recommendations"]) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, 0);
    }
    for (const record of await dataRepo.findAllGlobal()) {
      catalog.upsert({
        id: record.data.id,
        namespace: SOLO_NAMESPACE,
        type_normalized: record.modelType.normalized,
        model_id: record.modelId,
        model_name: "shows",
        data_name: record.data.name,
        version: 1,
        is_latest: 1,
        spec_name: "result",
        data_type: "resource",
        content_type: "application/json",
        lifetime: "infinite",
        owner_type: "model-method",
        owner_ref: "test",
        streaming: 0,
        size: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        tags: "{}",
        workflow_run_id: "",
        workflow_name: "",
        job_name: "",
        step_name: "",
        source: "",
      });
    }

    const summary = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );

    assertEquals(summary.diskRecords, 2);
    assertEquals(summary.catalogRecords, 2);
    assertEquals(summary.shortfalls.length, 0);
  }),
);
