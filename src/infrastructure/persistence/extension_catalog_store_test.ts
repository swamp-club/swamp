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
  ExtensionCatalogStore,
  type ExtensionTypeRow,
} from "./extension_catalog_store.ts";

function makeTempDbPath(): string {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-ext-catalog-test-" });
  return join(dir, "_extension_catalog.db");
}

function makeRow(overrides: Partial<ExtensionTypeRow> = {}): ExtensionTypeRow {
  return {
    type_normalized: "@myorg/echo",
    kind: "model",
    bundle_path: "/repo/.swamp/bundles/echo.js",
    source_path: "/repo/extensions/models/echo.ts",
    version: "2026.01.15.1",
    description: "Echo model for testing",
    extends_type: "",
    source_mtime: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

Deno.test("ExtensionCatalogStore: creates schema on construction", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);
  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert and findByType round-trip", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  const row = makeRow();
  store.upsert(row);

  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.type_normalized, "@myorg/echo");
  assertEquals(found?.kind, "model");
  assertEquals(found?.bundle_path, "/repo/.swamp/bundles/echo.js");
  assertEquals(found?.version, "2026.01.15.1");
  assertEquals(found?.source_mtime, "2026-01-15T10:00:00.000Z");
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert overwrites existing row", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ version: "2026.01.15.1" }));
  store.upsert(makeRow({ version: "2026.01.16.1" }));

  assertEquals(store.count(), 1);
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.version, "2026.01.16.1");
  store.close();
});

Deno.test("ExtensionCatalogStore: removeBySourcePath deletes row", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow());
  assertEquals(store.count(), 1);

  store.removeBySourcePath("/repo/extensions/models/echo.ts");
  assertEquals(store.count(), 0);
  assertEquals(store.findByType("@myorg/echo", "model"), undefined);
  store.close();
});

Deno.test("ExtensionCatalogStore: removeBySourcePath nonexistent is a no-op", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);
  store.removeBySourcePath("/nonexistent");
  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: findByKind returns only matching kind", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({
    type_normalized: "@org/model-a",
    kind: "model",
    source_path: "/repo/models/a.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@org/model-b",
    kind: "model",
    source_path: "/repo/models/b.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@org/my-vault",
    kind: "vault",
    source_path: "/repo/vaults/v.ts",
  }));

  const models = store.findByKind("model");
  assertEquals(models.length, 2);
  assertEquals(models[0].type_normalized, "@org/model-a");
  assertEquals(models[1].type_normalized, "@org/model-b");

  const vaults = store.findByKind("vault");
  assertEquals(vaults.length, 1);
  assertEquals(vaults[0].type_normalized, "@org/my-vault");

  const drivers = store.findByKind("driver");
  assertEquals(drivers.length, 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: findExtensionsForType returns targeting extensions", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  // Base model
  store.upsert(makeRow({
    type_normalized: "@swamp/aws/ec2/instance",
    kind: "model",
    source_path: "/repo/models/instance.ts",
  }));

  // Extension targeting the base model
  store.upsert(makeRow({
    type_normalized: "@swamp/aws/ec2/instance",
    kind: "extension",
    extends_type: "@swamp/aws/ec2/instance",
    source_path: "/repo/models/instance_terminate.ts",
  }));

  // Extension targeting a different model
  store.upsert(makeRow({
    type_normalized: "@swamp/aws/ec2/vpc",
    kind: "extension",
    extends_type: "@swamp/aws/ec2/vpc",
    source_path: "/repo/models/vpc_audit.ts",
  }));

  const exts = store.findExtensionsForType("@swamp/aws/ec2/instance");
  assertEquals(exts.length, 1);
  assertEquals(exts[0].source_path, "/repo/models/instance_terminate.ts");

  const noExts = store.findExtensionsForType("@swamp/aws/s3/bucket");
  assertEquals(noExts.length, 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: count filters by kind", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({
    type_normalized: "@org/a",
    kind: "model",
    source_path: "/repo/a.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@org/b",
    kind: "model",
    source_path: "/repo/b.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@org/c",
    kind: "vault",
    source_path: "/repo/c.ts",
  }));

  assertEquals(store.count(), 3);
  assertEquals(store.count("model"), 2);
  assertEquals(store.count("vault"), 1);
  assertEquals(store.count("driver"), 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: isPopulated and markPopulated per kind", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  assertEquals(store.isPopulated("model"), false);
  assertEquals(store.isPopulated("vault"), false);

  store.markPopulated("model");
  assertEquals(store.isPopulated("model"), true);
  assertEquals(store.isPopulated("vault"), false);

  store.markPopulated("vault");
  assertEquals(store.isPopulated("vault"), true);
  store.close();
});

Deno.test("ExtensionCatalogStore: invalidate clears populated flag for one kind", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.markPopulated("model");
  store.markPopulated("vault");
  assertEquals(store.isPopulated("model"), true);
  assertEquals(store.isPopulated("vault"), true);

  store.invalidate("model");
  assertEquals(store.isPopulated("model"), false);
  assertEquals(store.isPopulated("vault"), true);
  store.close();
});

Deno.test("ExtensionCatalogStore: reopen preserves data", () => {
  const dbPath = makeTempDbPath();

  const store1 = new ExtensionCatalogStore(dbPath);
  store1.upsert(makeRow());
  store1.markPopulated("model");
  store1.close();

  const store2 = new ExtensionCatalogStore(dbPath);
  assertEquals(store2.count(), 1);
  assertEquals(store2.isPopulated("model"), true);
  const found = store2.findByType("@myorg/echo", "model");
  assertEquals(found?.version, "2026.01.15.1");
  store2.close();
});

Deno.test("ExtensionCatalogStore: removeBySourcePrefix removes matching entries", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({
    type_normalized: "@swamp/aws/ec2/instance",
    source_path:
      "/repo/.swamp/pulled-extensions/models/@swamp/aws/ec2/instance.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@swamp/aws/ec2/vpc",
    source_path: "/repo/.swamp/pulled-extensions/models/@swamp/aws/ec2/vpc.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@myorg/echo",
    source_path: "/repo/extensions/models/echo.ts",
  }));

  assertEquals(store.count(), 3);

  const removed = store.removeBySourcePrefix(
    "/repo/.swamp/pulled-extensions/models/@swamp/aws/ec2/",
  );
  assertEquals(removed, 2);
  assertEquals(store.count(), 1);
  assertEquals(
    store.findByType("@myorg/echo", "model")?.source_path,
    "/repo/extensions/models/echo.ts",
  );
  store.close();
});

Deno.test("ExtensionCatalogStore: same type different kinds are separate entries", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  // Hypothetical: same name used as both model and vault (different source files)
  store.upsert(makeRow({
    type_normalized: "@org/thing",
    kind: "model",
    version: "1.0.0",
    source_path: "/repo/models/thing.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@org/thing",
    kind: "vault",
    version: "2.0.0",
    source_path: "/repo/vaults/thing.ts",
  }));

  assertEquals(store.count(), 2);
  assertEquals(
    store.findByType("@org/thing", "model")?.version,
    "1.0.0",
  );
  assertEquals(
    store.findByType("@org/thing", "vault")?.version,
    "2.0.0",
  );
  store.close();
});

Deno.test("ExtensionCatalogStore: concurrent opens do not throw database is locked", () => {
  const dbPath = makeTempDbPath();

  // Simulate two processes opening the same DB simultaneously
  const store1 = new ExtensionCatalogStore(dbPath);
  const store2 = new ExtensionCatalogStore(dbPath);

  // Write from both — WAL + busy_timeout should handle contention
  store1.upsert(makeRow({
    type_normalized: "@org/from-store1",
    source_path: "/repo/s1.ts",
  }));
  store2.upsert(makeRow({
    type_normalized: "@org/from-store2",
    source_path: "/repo/s2.ts",
  }));

  // Both writes visible from either handle
  assertEquals(
    store1.findByType("@org/from-store2", "model")?.type_normalized,
    "@org/from-store2",
  );
  assertEquals(
    store2.findByType("@org/from-store1", "model")?.type_normalized,
    "@org/from-store1",
  );

  store1.close();
  store2.close();
});

Deno.test("ExtensionCatalogStore: multiple extensions targeting same base type coexist", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  // Base model
  store.upsert(makeRow({
    type_normalized: "@myorg/server",
    kind: "model",
    source_path: "/repo/models/server.ts",
  }));

  // Two extensions targeting the same base type
  store.upsert(makeRow({
    type_normalized: "@myorg/server",
    kind: "extension",
    extends_type: "@myorg/server",
    source_path: "/repo/models/server_terminate.ts",
  }));
  store.upsert(makeRow({
    type_normalized: "@myorg/server",
    kind: "extension",
    extends_type: "@myorg/server",
    source_path: "/repo/models/server_backup.ts",
  }));

  // Both extensions survive — not overwritten
  const exts = store.findExtensionsForType("@myorg/server");
  assertEquals(exts.length, 2);
  const paths = exts.map((e) => e.source_path).sort();
  assertEquals(paths, [
    "/repo/models/server_backup.ts",
    "/repo/models/server_terminate.ts",
  ]);

  // Total: 1 model + 2 extensions
  assertEquals(store.count(), 3);
  store.close();
});
