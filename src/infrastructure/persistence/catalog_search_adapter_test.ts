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
import { findLatestItemsFromCatalog } from "./catalog_search_adapter.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";

function makeRow(version: number, stepName: string): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "item-b",
    id: crypto.randomUUID(),
    version,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "c1",
    spec_name: "item",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: stepName,
    source: "",
  };
}

Deno.test("findLatestItemsFromCatalog: lists a data name once when several workflow steps wrote it (swamp-club#2520)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-search-adapter-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  try {
    catalog.markPopulated();
    catalog.upsertNewVersion(makeRow(1, "s1"));
    catalog.upsertNewVersion(makeRow(2, "s2"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const service = new DataQueryService(catalog, dataRepo);

    const items = await findLatestItemsFromCatalog(service, catalog);
    assertEquals(items.map((i) => [i.name, i.version]), [["item-b", 2]]);
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
