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
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";
import { scanMixedKindNames } from "./mixed_kind_data_names.ts";

function row(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    namespace: "",
    type_normalized: "t/m",
    model_id: "m-1",
    data_name: "x",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 0,
    model_name: "fwd",
    spec_name: "meta",
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
    size: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    ...overrides,
    is_step_latest: overrides.is_latest ?? 0,
  };
}

Deno.test("scanMixedKindNames: reports published mixed names of the namespace, never pending or foreign rows (swamp-club#4302)", () => {
  const store = new CatalogStore(":memory:");
  try {
    store.upsert(row({ version: 1, data_type: "file", spec_name: "blob" }));
    store.upsert(row({ version: 2, is_latest: 1 }));
    store.upsert(row({ data_name: "clean", is_latest: 1 }));
    store.upsert(
      row({
        data_name: "session",
        data_type: "agent-session",
        tags: '{"_swamp.kind":"file"}',
      }),
    );
    store.upsert(
      row({
        data_name: "session",
        version: 2,
        data_type: "agent-session",
        tags: '{"_swamp.kind":"resource"}',
      }),
    );
    store.upsert(
      row({
        data_name: "pending",
        version: 1,
        data_type: "file",
      }),
    );
    store.upsert(
      row({
        data_name: "pending",
        version: 2,
        is_pending: 1,
        pending_pid: 1,
        pending_host: "h",
      }),
    );
    store.upsert(row({ namespace: "other", version: 1, data_type: "file" }));
    store.upsert(row({ namespace: "other", version: 2 }));

    const found = scanMixedKindNames(store, "");

    assertEquals(found.map((f) => f.dataName), ["session", "x"]);
    assertEquals(found[1].modelName, "fwd");
    assertEquals(found[1].versions, [
      { version: 1, kind: "file", specName: "blob" },
      { version: 2, kind: "resource", specName: "meta" },
    ]);
  } finally {
    store.close();
  }
});
