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

import { assert, assertEquals, assertLess } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: "data-uuid-001",
    version: 1,
    is_latest: 1,
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

Deno.test("CatalogStore: upsert keeps separate rows for distinct versions", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ version: 1, size: 100, is_latest: 0 }));
  store.upsert(makeRow({ version: 2, size: 200, is_latest: 1 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 2);
  assertEquals(rows.map((r) => r.version).sort(), [1, 2]);
  const latest = rows.find((r) => r.is_latest === 1)!;
  assertEquals(latest.version, 2);
  assertEquals(latest.size, 200);
  store.close();
});

Deno.test("CatalogStore: upsert replaces row at same (type, model, name, version)", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ version: 1, size: 100 }));
  store.upsert(makeRow({ version: 1, size: 999 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].size, 999);
  store.close();
});

Deno.test("CatalogStore: upsertNewVersion clears is_latest on prior rows", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ version: 1 }));
  store.upsertNewVersion(makeRow({ version: 2 }));
  store.upsertNewVersion(makeRow({ version: 3 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 3);
  const latestRows = rows.filter((r) => r.is_latest === 1);
  assertEquals(latestRows.length, 1);
  assertEquals(latestRows[0].version, 3);
  store.close();
});

Deno.test("CatalogStore: upsertNewVersion ignores is_latest on input row", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  // Caller passes is_latest: 0 but the method always records the incoming
  // row as latest and clears any prior latest.
  store.upsertNewVersion(makeRow({ version: 1, is_latest: 0 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].is_latest, 1);
  store.close();
});

Deno.test("CatalogStore: upsertNewVersion does not touch unrelated data names", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ data_name: "alpha", version: 1 }));
  store.upsertNewVersion(makeRow({ data_name: "beta", version: 1 }));
  store.upsertNewVersion(makeRow({ data_name: "alpha", version: 2 }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 3);
  const alphaLatest = rows.find(
    (r) => r.data_name === "alpha" && r.is_latest === 1,
  );
  const betaLatest = rows.find(
    (r) => r.data_name === "beta" && r.is_latest === 1,
  );
  assertEquals(alphaLatest?.version, 2);
  assertEquals(betaLatest?.version, 1);
  store.close();
});

Deno.test("CatalogStore: removeVersion deletes a single version row", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ version: 1 }));
  store.upsertNewVersion(makeRow({ version: 2 }));
  store.upsertNewVersion(makeRow({ version: 3 }));

  store.removeVersion("", "test-model", "model-001", "my-data", 2);

  const rows = [...store.iterate()];
  assertEquals(rows.length, 2);
  assertEquals(rows.map((r) => r.version).sort(), [1, 3]);
  store.close();
});

Deno.test("CatalogStore: remove deletes every version of a data name", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ version: 1 }));
  store.upsertNewVersion(makeRow({ version: 2 }));
  store.upsertNewVersion(makeRow({ version: 3 }));

  store.remove("", "test-model", "model-001", "my-data");

  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("CatalogStore: remove deletes row", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow());
  assertEquals(store.count(), 1);

  store.remove("", "test-model", "model-001", "my-data");
  assertEquals(store.count(), 0);
  assertEquals([...store.iterate()].length, 0);
  store.close();
});

Deno.test("CatalogStore: remove nonexistent row is a no-op", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.remove("", "nonexistent", "nope", "nothing");
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

  store.remove("", "test-model", "m1", "alpha");
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
  // Use fromFileUrl so Windows produces "D:\\..." instead of URL-pathname
  // "/D:/..." which Deno.Command cannot resolve as --config on Windows.
  const denoJsonPath = fromFileUrl(
    new URL("../../../deno.json", import.meta.url),
  );
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

Deno.test("CatalogStore: migrates v1 catalog DB to v2 without throwing", () => {
  const dbPath = makeTempDbPath();

  // Pre-create a v1 catalog DB: no provenance columns, schema_version=1
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
      type_normalized TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      data_name       TEXT NOT NULL,
      id              TEXT NOT NULL,
      version         INTEGER NOT NULL,
      model_name      TEXT NOT NULL,
      spec_name       TEXT NOT NULL DEFAULT '',
      data_type       TEXT NOT NULL DEFAULT '',
      content_type    TEXT NOT NULL DEFAULT '',
      lifetime        TEXT NOT NULL DEFAULT '',
      owner_type      TEXT NOT NULL DEFAULT '',
      streaming       INTEGER NOT NULL DEFAULT 0,
      size            INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      tags            TEXT NOT NULL DEFAULT '{}',
      owner_ref       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (type_normalized, model_id, data_name)
    );
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('schema_version', '1');
    INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('populated', 'true');
  `);
  db.close();

  // Opening with CatalogStore should migrate to v2 (not throw)
  const store = new CatalogStore(dbPath);
  assertEquals(store.count(), 0); // migration drops and recreates the table
  assertEquals(store.isPopulated(), false); // populated cleared for backfill
  store.close();
});

Deno.test("CatalogStore: bulkRemoveVersions deletes all specified versions atomically", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ version: 1 }));
  store.upsertNewVersion(makeRow({ version: 2 }));
  store.upsertNewVersion(makeRow({ version: 3 }));
  store.upsertNewVersion(makeRow({ version: 4 }));

  store.bulkRemoveVersions("", "test-model", "model-001", "my-data", [1, 2, 3]);

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].version, 4);
  store.close();
});

Deno.test("CatalogStore: bulkRemoveVersions is a no-op for empty array", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsertNewVersion(makeRow({ version: 1 }));
  store.bulkRemoveVersions("", "test-model", "model-001", "my-data", []);

  assertEquals(store.count(), 1);
  store.close();
});

Deno.test("CatalogStore: checkpoint returns WAL page counts and truncates WAL", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  // Write enough rows to force WAL pages to accumulate
  for (let i = 0; i < 50; i++) {
    store.upsertNewVersion(
      makeRow({ model_id: `m-${i}`, data_name: `d-${i}`, version: 1 }),
    );
  }

  const stats = store.checkpoint();

  // WAL must have been checkpointed (all pages written to main db)
  assertEquals(
    stats.walPagesCheckpointed,
    stats.walPagesTotal,
    "Expected full checkpoint — all WAL pages should be written to main db",
  );

  // WAL file should be gone or empty after TRUNCATE
  try {
    const walStat = Deno.statSync(dbPath + "-wal");
    assertEquals(walStat.size, 0, "WAL file should be truncated to zero bytes");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    // WAL file not present — also correct after TRUNCATE
  }

  store.close();
});

Deno.test("CatalogStore: vacuum returns boolean and does not throw", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);
  store.upsert(makeRow());

  const result = store.vacuum();
  assertEquals(typeof result, "boolean");

  store.close();
});

Deno.test("CatalogStore: vacuum reclaims space and preserves rows", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  // Insert enough fragmentation that the rebuild measurably shrinks the file,
  // and enough rows to span multiple ITERATE_PAGE_SIZE batches.
  const bloat = "x".repeat(400);
  const total = ITERATE_PAGE_SIZE * 3 + 7;
  for (let version = 1; version <= total; version++) {
    store.upsert(makeRow({ version, id: `id-${version}`, tags: bloat }));
  }
  // Delete the even versions to free pages and fragment the file.
  for (let version = 2; version <= total; version += 2) {
    store.removeVersion("", "test-model", "model-001", "my-data", version);
  }
  store.checkpoint();

  const before = Deno.statSync(dbPath).size;
  const survivors = store.count();

  assertEquals(store.vacuum(), true);

  const after = Deno.statSync(dbPath).size;
  assertLess(after, before);
  // No data lost: the same rows remain and are still queryable.
  assertEquals(store.count(), survivors);
  store.close();

  // The swapped-in file is intact: a fresh store sees identical data.
  const reopened = new CatalogStore(dbPath);
  assertEquals(reopened.count(), survivors);
  const versions = [...reopened.iterate()].map((r) => r.version).sort((a, b) =>
    a - b
  );
  assertEquals(versions[0], 1);
  assert(versions.every((v) => v % 2 === 1));
  reopened.close();
});

Deno.test("CatalogStore: vacuum on an empty catalog returns true and keeps schema", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  assertEquals(store.vacuum(), true);

  // Schema survived the rebuild — the store is still writable and readable.
  store.upsert(makeRow());
  assertEquals(store.count(), 1);
  store.close();
});

Deno.test("CatalogStore: store is usable after vacuum and close is idempotent", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);
  store.upsert(makeRow({ version: 1 }));

  assertEquals(store.vacuum(), true);

  // The reopened connection accepts further writes and reads.
  store.upsert(makeRow({ version: 2 }));
  assertEquals(store.count(), 2);

  store.close();
  // A second close must not throw (node:sqlite errors on double-close).
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

Deno.test("CatalogStore: namespace round-trips through upsert and iterate", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ namespace: "infra" }));

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].namespace, "infra");
  store.close();
});

Deno.test("CatalogStore: namespace is part of the primary key", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  // Same (type, model, name, version) in two namespaces must coexist as
  // distinct rows — namespace is the outermost PK dimension.
  store.upsert(makeRow({ namespace: "infra" }));
  store.upsert(makeRow({ namespace: "security" }));

  assertEquals(store.count(), 2);
  store.close();
});

Deno.test("CatalogStore: upsertNewVersion does not clear is_latest across namespaces", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  // infra's latest must survive when security promotes a new latest for the
  // same (type, model, name) — the is_latest-clearing UPDATE is namespace-scoped.
  store.upsertNewVersion(makeRow({ namespace: "infra", version: 1 }));
  store.upsertNewVersion(makeRow({ namespace: "security", version: 1 }));
  store.upsertNewVersion(makeRow({ namespace: "security", version: 2 }));

  const rows = [...store.iterate()];
  const infra = rows.filter((r) => r.namespace === "infra");
  assertEquals(infra.length, 1);
  assertEquals(infra[0].is_latest, 1, "infra latest must be untouched");

  const security = rows.filter((r) => r.namespace === "security");
  const securityLatest = security.filter((r) => r.is_latest === 1);
  assertEquals(securityLatest.length, 1);
  assertEquals(securityLatest[0].version, 2);
  store.close();
});

Deno.test("CatalogStore: removeVersion is scoped to a namespace", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.upsert(makeRow({ namespace: "infra", version: 1 }));
  store.upsert(makeRow({ namespace: "security", version: 1 }));

  store.removeVersion("infra", "test-model", "model-001", "my-data", 1);

  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].namespace, "security");
  store.close();
});

Deno.test("CatalogStore: migrates v3 catalog DB to v4 with namespace column", () => {
  const dbPath = makeTempDbPath();

  // Pre-create a v3 catalog DB: no namespace column, schema_version=3, with a
  // pre-existing row and the populated flag set. This mirrors every existing
  // repo at the moment it is first opened by a v4 build.
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
      type_normalized TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      data_name       TEXT NOT NULL,
      id              TEXT NOT NULL,
      version         INTEGER NOT NULL,
      is_latest       INTEGER NOT NULL DEFAULT 1,
      model_name      TEXT NOT NULL,
      spec_name       TEXT NOT NULL DEFAULT '',
      data_type       TEXT NOT NULL DEFAULT '',
      content_type    TEXT NOT NULL DEFAULT '',
      lifetime        TEXT NOT NULL DEFAULT '',
      owner_type      TEXT NOT NULL DEFAULT '',
      streaming       INTEGER NOT NULL DEFAULT 0,
      size            INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      tags            TEXT NOT NULL DEFAULT '{}',
      owner_ref       TEXT NOT NULL DEFAULT '',
      workflow_run_id TEXT NOT NULL DEFAULT '',
      workflow_name   TEXT NOT NULL DEFAULT '',
      job_name        TEXT NOT NULL DEFAULT '',
      step_name       TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (type_normalized, model_id, data_name, version)
    );
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO catalog (type_normalized, model_id, data_name, id, version, model_name, created_at)
      VALUES ('test-model', 'm1', 'd1', 'id1', 1, 'name', '2026-01-01T00:00:00.000Z');
    INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('schema_version', '3');
    INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('populated', 'true');
  `);
  db.close();

  // Opening with CatalogStore drops and recreates the table for v4 and clears
  // the populated flag so the next query triggers a backfill.
  const store = new CatalogStore(dbPath);
  assertEquals(store.count(), 0, "migration drops and recreates the table");
  assertEquals(store.isPopulated(), false, "populated cleared for backfill");

  // The rebuilt table accepts namespace-stamped rows.
  store.upsert(makeRow({ namespace: "infra" }));
  const rows = [...store.iterate()];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].namespace, "infra");
  store.close();
});

// ── Phase 6c: namespace-scoped backfill and foreign upsert ──────────────────

Deno.test("bulkReplaceNamespace: replaces only own namespace, preserves foreign", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  const infraRow = makeRow({
    namespace: "infra",
    model_name: "infra-model",
    data_name: "infra-data",
  });
  const securityRow = makeRow({
    namespace: "security",
    model_name: "security-model",
    data_name: "security-data",
  });

  store.bulkReplaceAll([infraRow, securityRow]);
  assertEquals(store.count(), 2);

  const updatedInfraRow = makeRow({
    namespace: "infra",
    model_name: "infra-model-v2",
    data_name: "infra-data-v2",
  });
  store.bulkReplaceNamespace("infra", [updatedInfraRow]);

  const all = [...store.iterate()];
  assertEquals(all.length, 2);

  const infra = all.filter((r) => r.namespace === "infra");
  assertEquals(infra.length, 1);
  assertEquals(infra[0].model_name, "infra-model-v2");

  const security = all.filter((r) => r.namespace === "security");
  assertEquals(security.length, 1);
  assertEquals(security[0].model_name, "security-model");

  store.close();
});

Deno.test("bulkReplaceNamespace: does not touch global populated flag", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.markPopulated();
  assertEquals(store.isPopulated(), true);

  store.bulkReplaceNamespace("infra", [
    makeRow({ namespace: "infra" }),
  ]);

  assertEquals(store.isPopulated(), true);
  store.close();
});

Deno.test("bulkUpsertForeign: upserts foreign rows and records lastSynced", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.bulkReplaceAll([makeRow({ namespace: "own" })]);
  assertEquals(store.count(), 1);

  const foreignRow = makeRow({
    namespace: "security",
    model_name: "scanner",
    data_name: "results",
  });
  store.bulkUpsertForeign("security", [foreignRow]);

  assertEquals(store.count(), 2);

  const synced = store.foreignSyncedAt("security");
  assert(synced !== null, "foreignSyncedAt should return a timestamp");
  assert(synced!.startsWith("20"), "timestamp should be ISO format");

  assertEquals(store.foreignSyncedAt("unknown"), null);

  store.close();
});

Deno.test("bulkUpsertForeign: does not touch global populated flag", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  store.markPopulated();
  assertEquals(store.isPopulated(), true);

  store.bulkUpsertForeign("foreign", [
    makeRow({ namespace: "foreign" }),
  ]);

  assertEquals(store.isPopulated(), true);
  store.close();
});

Deno.test("bulkUpsertForeign: updates existing foreign rows in place", () => {
  const dbPath = makeTempDbPath();
  const store = new CatalogStore(dbPath);

  const row1 = makeRow({
    namespace: "foreign",
    model_name: "model-a",
    data_name: "data-a",
    size: 100,
  });
  store.bulkUpsertForeign("foreign", [row1]);
  assertEquals(store.count(), 1);

  const row2 = makeRow({
    namespace: "foreign",
    model_name: "model-a",
    data_name: "data-a",
    size: 200,
  });
  store.bulkUpsertForeign("foreign", [row2]);

  assertEquals(store.count(), 1);
  const all = [...store.iterate()];
  assertEquals(all[0].size, 200);

  store.close();
});
