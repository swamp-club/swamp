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

import { join } from "@std/path";
import {
  type CatalogRow,
  CatalogStore,
} from "../src/infrastructure/persistence/catalog_store.ts";
import { writeCatalogExport } from "../src/infrastructure/persistence/repository_factory.ts";

const ROWS = 100_000;

function rowAt(i: number): CatalogRow {
  return {
    namespace: "bench-ns",
    type_normalized: "bench-model",
    model_id: "model-001",
    data_name: `data-${i}`,
    id: `uuid-${i}`,
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "bench-model-name",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: "model-method",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    streaming: 0,
    size: i * 10,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: `{"type":"resource","specName":"result","index":"${i}"}`,
  };
}

const dir = await Deno.makeTempDir({ prefix: "swamp-catalog-export-bench-" });
const cachePath = join(dir, "cache");
await Deno.mkdir(join(cachePath, "bench-ns"), { recursive: true });
const store = new CatalogStore(join(dir, "_catalog.db"));
for (let i = 0; i < ROWS; i++) store.upsert(rowAt(i));

globalThis.addEventListener("unload", () => {
  store.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.bench({
  name: "writeCatalogExport: 100k rows",
  n: 5,
  warmup: 1,
  async fn() {
    const count = await writeCatalogExport(store, cachePath, "bench-ns");
    if (count !== ROWS) throw new Error(`exported ${count} of ${ROWS} rows`);
  },
});
