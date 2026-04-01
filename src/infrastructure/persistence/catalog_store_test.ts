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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type CatalogRow,
  CatalogStore,
  ITERATE_PAGE_SIZE,
} from "./catalog_store.ts";

function makeTempDbPath(): string {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-catalog-test-" });
  return join(dir, "_catalog.db");
}

function makeRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: "data-uuid-001",
    version: 1,
    model_name: "test-model-name",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 256,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: '{"type":"resource","specName":"result"}',
    ...overrides,
  };
}

Deno.test("CatalogStore: creates schema on construction", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);
  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("CatalogStore: upsert and iterate round-trip", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  const row = makeRow();
  store.upsert(row);

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].data_name, "my-data");
  assertEquals(rows[0].model_name, "test-model-name");
  assertEquals(rows[0].version, 1);
  assertEquals(rows[0].size, 256);
  store.close();
});

Deno.test("CatalogStore: upsert overwrites existing row", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ version: 1, size: 100 }));
  store.upsert(makeRow({ version: 2, size: 200 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].version, 2);
  assertEquals(rows[0].size, 200);
  store.close();
});

Deno.test("CatalogStore: remove deletes row", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow());
  assertEquals(store.count(), 1);

  store.remove("test-model", "model-001", "my-data");
  assertEquals(store.count(), 0);
  assertEquals([...store.iterate()].length, 0);
  store.close();
});

Deno.test("CatalogStore: remove nonexistent row is a no-op", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.remove("nonexistent", "nope", "nothing");
  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("CatalogStore: isPopulated and markPopulated lifecycle", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  assertEquals(store.isPopulated(), false);
  store.markPopulated();
  assertEquals(store.isPopulated(), true);
  store.close();
});

Deno.test("CatalogStore: reopen preserves data", () => {
  const dbPath = makeTempDbPath();

  const store1 = new CatalogStore(dbPath);
  store1.upsert(makeRow());
  store1.markPopulated();
  store1.close();

  const store2 = new CatalogStore(dbPath);
  assertEquals(store2.count(), 1);
  assertEquals(store2.isPopulated(), true);
  const rows = [...store2.iterate()];
  assertEquals(rows[0].data_name, "my-data");
  store2.close();
});

Deno.test("CatalogStore: multiple rows with different keys", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ data_name: "alpha", model_id: "m1" }));
  store.upsert(makeRow({ data_name: "beta", model_id: "m1" }));
  store.upsert(makeRow({ data_name: "alpha", model_id: "m2" }));

  assertEquals(store.count(), 3);

  store.remove("test-model", "m1", "alpha");
  assertEquals(store.count(), 2);

  store.close();
});

Deno.test("CatalogStore: empty catalog iterates zero rows", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);
  const rows = [...store.iterate()];
  assertEquals(rows.length, 0);
  store.close();
});

Deno.test("CatalogStore: iterate paginates across page boundaries", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  const totalRows = ITERATE_PAGE_SIZE + 1;
  for (let i = 0; i < totalRows; i++) {
    store.upsert(
      makeRow({
        model_id: `model-${String(i).padStart(5, "0")}`,
        data_name: `data-${String(i).padStart(5, "0")}`,
      }),
    );
  }

  assertEquals(store.count(), totalRows);

  const rows = [...store.iterate()];
  assertEquals(rows.length, totalRows);

  // Verify deterministic ordering — rows come back in rowid order
  for (let i = 0; i < totalRows; i++) {
    assertEquals(rows[i].model_id, `model-${String(i).padStart(5, "0")}`);
  }

  store.close();
});

Deno.test("CatalogStore: invalidate clears populated flag but keeps data", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow());
  store.markPopulated();
  assertEquals(store.isPopulated(), true);
  assertEquals(store.count(), 1);

  store.invalidate();
  assertEquals(store.isPopulated(), false);
  // Data rows are preserved — backfill will replace them
  assertEquals(store.count(), 1);
  store.close();
});
