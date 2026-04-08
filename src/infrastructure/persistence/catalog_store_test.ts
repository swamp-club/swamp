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
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
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
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
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

Deno.test("CatalogStore: distinctValues returns unique non-empty values", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(
    makeRow({ model_id: "m1", data_name: "a", model_name: "scanner" }),
  );
  store.upsert(
    makeRow({ model_id: "m2", data_name: "b", model_name: "ingest" }),
  );
  store.upsert(
    makeRow({ model_id: "m3", data_name: "c", model_name: "scanner" }),
  );
  store.upsert(makeRow({ model_id: "m4", data_name: "d", model_name: "" }));

  const names = store.distinctValues("model_name");
  assertEquals(names, ["ingest", "scanner"]);

  const types = store.distinctValues("data_type");
  assertEquals(types, ["resource"]);

  store.close();
});

Deno.test("CatalogStore: distinctValues returns empty for empty catalog", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);
  assertEquals(store.distinctValues("model_name"), []);
  store.close();
});

Deno.test("CatalogStore: distinctTagKeys collects keys from all rows", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(
    makeRow({
      model_id: "m1",
      data_name: "a",
      tags: '{"env":"prod","team":"infra"}',
    }),
  );
  store.upsert(
    makeRow({
      model_id: "m2",
      data_name: "b",
      tags: '{"env":"staging","region":"us-east-1"}',
    }),
  );
  store.upsert(
    makeRow({ model_id: "m3", data_name: "c", tags: "{}" }),
  );

  const keys = store.distinctTagKeys();
  assertEquals(keys, ["env", "region", "team"]);
  store.close();
});

Deno.test("CatalogStore: distinctTagKeys handles invalid JSON gracefully", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(
    makeRow({ model_id: "m1", data_name: "a", tags: "not-json" }),
  );
  store.upsert(
    makeRow({
      model_id: "m2",
      data_name: "b",
      tags: '{"env":"prod"}',
    }),
  );

  const keys = store.distinctTagKeys();
  assertEquals(keys, ["env"]);
  store.close();
});

Deno.test("CatalogStore: distinctTagValues returns values for a key", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(
    makeRow({
      model_id: "m1",
      data_name: "a",
      tags: '{"env":"prod"}',
    }),
  );
  store.upsert(
    makeRow({
      model_id: "m2",
      data_name: "b",
      tags: '{"env":"staging"}',
    }),
  );
  store.upsert(
    makeRow({
      model_id: "m3",
      data_name: "c",
      tags: '{"env":"prod"}',
    }),
  );
  store.upsert(
    makeRow({
      model_id: "m4",
      data_name: "d",
      tags: '{"team":"infra"}',
    }),
  );

  const values = store.distinctTagValues("env");
  assertEquals(values, ["prod", "staging"]);

  const teamValues = store.distinctTagValues("team");
  assertEquals(teamValues, ["infra"]);

  const missing = store.distinctTagValues("nonexistent");
  assertEquals(missing, []);
  store.close();
});

Deno.test("CatalogStore: constructor retries under write lock contention", async () => {
  const dbPath = makeTempDbPath();
  const dir = dirname(dbPath);

  // Pre-create the database with WAL mode so it exists on disk
  const setup = new DatabaseSync(dbPath);
  setup.exec("PRAGMA journal_mode=WAL");
  setup.close();

  // Reopen and hold an exclusive write lock from this process
  const holder = new DatabaseSync(dbPath);
  holder.exec("BEGIN EXCLUSIVE");
  holder.exec("CREATE TABLE IF NOT EXISTS _lock (x INTEGER)");

  // Write a helper script that constructs a CatalogStore on the same DB.
  // If busy_timeout is not set before journal_mode=WAL, this will throw
  // "database is locked" because the PRAGMA needs a lock we're holding.
  const catalogStoreUrl = new URL("./catalog_store.ts", import.meta.url).href;
  const scriptPath = join(dir, "open_catalog.ts");
  Deno.writeTextFileSync(
    scriptPath,
    [
      `import { CatalogStore } from "${catalogStoreUrl}";`,
      `const store = new CatalogStore(Deno.args[0]);`,
      `store.close();`,
    ].join("\n"),
  );

  // Start a subprocess — it will block in busy_timeout waiting for our lock.
  // Pass --config so the subprocess can resolve @std/fs and other imports.
  const denoJsonPath = new URL("../../../deno.json", import.meta.url).pathname;
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--config",
      denoJsonPath,
      scriptPath,
      dbPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Release the lock after 200ms so the subprocess can proceed
  await new Promise((r) => setTimeout(r, 200));
  holder.exec("COMMIT");
  holder.close();

  // The subprocess should succeed — busy_timeout let it wait for our lock
  const output = await proc.output();
  assertEquals(
    output.code,
    0,
    `CatalogStore constructor failed under lock contention: ${
      new TextDecoder().decode(output.stderr)
    }`,
  );
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
