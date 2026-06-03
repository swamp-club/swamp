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

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { canonicalizePath, canonicalizePathFor } from "./canonicalize_path.ts";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";
import {
  ExtensionCatalogStore,
  type ExtensionTypeRow,
} from "./extension_catalog_store.ts";

/**
 * Returns a dbPath at `<tmpRepo>/.swamp/_extension_catalog.db` so the
 * catalog's `inferRepoRootFromDbPath()` (which expects a real swamp
 * layout) produces `<tmpRepo>` — letting tests seed rows whose
 * source_paths actually match the W1a migration's path heuristic
 * (`<repoRoot>/extensions/<kind>/...` or
 * `<repoRoot>/.swamp/pulled-extensions/<name>/<kind>/...`).
 */
function makeTempDbPath(): string {
  const repoRoot = Deno.makeTempDirSync({
    prefix: "swamp-ext-catalog-test-",
  });
  ensureDirSync(join(repoRoot, ".swamp"));
  return join(repoRoot, ".swamp", "_extension_catalog.db");
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

Deno.test("ExtensionCatalogStore: getLayoutVersion returns undefined when not set", () => {
  const store = new ExtensionCatalogStore(makeTempDbPath());
  assertEquals(store.getLayoutVersion(), undefined);
  store.close();
});

Deno.test("ExtensionCatalogStore: setLayoutVersion and getLayoutVersion round-trip", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);
  store.setLayoutVersion("namespaced-v1");
  assertEquals(store.getLayoutVersion(), "namespaced-v1");
  store.close();

  // Verify it persists across reopen
  const store2 = new ExtensionCatalogStore(dbPath);
  assertEquals(store2.getLayoutVersion(), "namespaced-v1");
  store2.close();
});

Deno.test("ExtensionCatalogStore: setLayoutVersion overwrites previous value", () => {
  const store = new ExtensionCatalogStore(makeTempDbPath());
  store.setLayoutVersion("v1");
  store.setLayoutVersion("v2");
  assertEquals(store.getLayoutVersion(), "v2");
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert and findByType round-trip source_fingerprint", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ source_fingerprint: "abc123deadbeef" }));
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.source_fingerprint, "abc123deadbeef");
  store.close();
});

Deno.test("ExtensionCatalogStore: source_fingerprint defaults to empty string when omitted from upsert", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  // Row built without source_fingerprint — sibling loaders (reports,
  // drivers, datastores, vaults) still omit it today.
  store.upsert(makeRow());
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.source_fingerprint, "");
  store.close();
});

Deno.test("ExtensionCatalogStore: migrates pre-#125 schema by adding source_fingerprint column", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));

  // Seed a DB with the pre-#125 schema — no source_fingerprint column.
  // Source path lives under <repoRoot>/.swamp/pulled-extensions/... so
  // the W1a data-migration backfills extension_name and the row
  // survives the post-condition verify. Without a layout-matching path
  // the row would be dropped (correct W1a behaviour, but defeats this
  // test's purpose of checking source_fingerprint is added).
  const repoRoot = dirname(dirname(dbPath));
  const sourcePath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@legacy",
    "pre-125",
    "models",
    "row.ts",
  );
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path     TEXT NOT NULL PRIMARY KEY,
      type_normalized TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'model',
      bundle_path     TEXT NOT NULL,
      version         TEXT NOT NULL DEFAULT '',
      description     TEXT NOT NULL DEFAULT '',
      extends_type    TEXT NOT NULL DEFAULT '',
      source_mtime    TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path, version,
      description, extends_type, source_mtime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourcePath,
    "@legacy/row",
    "model",
    "/old/bundle.js",
    "2026.01.01.1",
    "",
    "",
    "2026-01-01T00:00:00.000Z",
  );
  seed.close();

  // Opening through ExtensionCatalogStore must run the migration.
  const store = new ExtensionCatalogStore(dbPath);

  // Legacy row survives with empty source_fingerprint — forces a
  // rebundle on the next findStaleFiles pass.
  const legacy = store.findByType("@legacy/row", "model");
  assertEquals(legacy?.source_fingerprint, "");

  // Re-opening is a no-op — migration is idempotent.
  store.close();
  const store2 = new ExtensionCatalogStore(dbPath);
  const again = store2.findByType("@legacy/row", "model");
  assertEquals(again?.source_fingerprint, "");
  store2.close();
});

// --- per-kind migration tests (#128) ---
//
// The sibling loaders (report/driver/datastore/vault) ported to the
// shared freshness helper in #128. Legacy catalog rows written by the
// pre-port binary have `source_fingerprint = ""`; they must survive the
// migration so the next findStaleFiles pass sees fingerprint mismatch
// and rebundles exactly once. This matches the PR #1188 precedent for
// the models loader above — accept+document one-time rebundle on
// upgrade rather than silently backfill.

for (
  const kind of ["report", "driver", "datastore", "vault"] as const
) {
  Deno.test(
    `ExtensionCatalogStore: migrates pre-#128 ${kind} row by adding empty source_fingerprint (#128)`,
    () => {
      const dbPath = makeTempDbPath();
      ensureDirSync(dirname(dbPath));

      // Source path under <repoRoot>/.swamp/pulled-extensions/... so the
      // W1a backfill produces a non-empty extension_name and the row
      // survives.
      const repoRoot = dirname(dirname(dbPath));
      const sourcePath = join(
        repoRoot,
        ".swamp",
        "pulled-extensions",
        "@legacy",
        `${kind}-row`,
        `${kind}s`,
        `${kind}.ts`,
      );

      // Seed a DB with the pre-#125 schema — no source_fingerprint
      // column — carrying a row of the target kind.
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE bundle_types (
          source_path     TEXT NOT NULL PRIMARY KEY,
          type_normalized TEXT NOT NULL,
          kind            TEXT NOT NULL DEFAULT 'model',
          bundle_path     TEXT NOT NULL,
          version         TEXT NOT NULL DEFAULT '',
          description     TEXT NOT NULL DEFAULT '',
          extends_type    TEXT NOT NULL DEFAULT '',
          source_mtime    TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      seed.prepare(
        `INSERT INTO bundle_types (
          source_path, type_normalized, kind, bundle_path, version,
          description, extends_type, source_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourcePath,
        `@legacy/${kind}-row`,
        kind,
        `/old/${kind}.js`,
        "",
        "",
        "",
        "2026-01-01T00:00:00.000Z",
      );
      seed.close();

      // Opening through ExtensionCatalogStore must run the migration.
      const store = new ExtensionCatalogStore(dbPath);

      // Legacy row of the target kind survives with empty
      // source_fingerprint — forces a rebundle on the next
      // findStaleFiles pass when this kind's loader delegates to the
      // shared helper.
      const legacy = store.findByType(`@legacy/${kind}-row`, kind);
      assertEquals(legacy?.source_fingerprint, "");
      assertEquals(legacy?.kind, kind);

      // Re-opening is a no-op — migration is idempotent.
      store.close();
      const store2 = new ExtensionCatalogStore(dbPath);
      const again = store2.findByType(`@legacy/${kind}-row`, kind);
      assertEquals(again?.source_fingerprint, "");
      store2.close();
    },
  );
}

// --- RowState column tests (swamp-club#211, W1a) ---
//
// The state column subsumes the legacy validation_failed boolean and
// will eventually carry the full 7-tag RowState discriminant from W1b.
// W1a writes 'Indexed' (default for healthy rows) and 'ValidationFailed'
// (set by markCatalogValidationFailed). Registration paths filter on
// state === 'ValidationFailed'.

Deno.test("ExtensionCatalogStore: upsert and findByType round-trip state", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ state: "ValidationFailed" }));
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "ValidationFailed");
  store.close();
});

Deno.test("ExtensionCatalogStore: state defaults to 'Indexed' when omitted from upsert", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow());
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "Indexed");
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert without state preserves existing non-default state", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ state: "ValidationFailed" }));
  store.upsert(makeRow());
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "ValidationFailed");
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert with explicit state overwrites existing state", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ state: "ValidationFailed" }));
  store.upsert(makeRow({ state: "Indexed" }));
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "Indexed");
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert without state preserves existing last_error", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ state: "BundleBuildFailed", last_error: "boom" }));
  store.upsert(makeRow());
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "BundleBuildFailed");
  assertEquals(found?.last_error, "boom");
  store.close();
});

Deno.test("ExtensionCatalogStore: canonicalized source_path resolves via deriveExtensionIdentity", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  const windowsPath = "C:\\Users\\runner\\repo\\extensions\\models\\echo.ts";
  const canonicalized = canonicalizePathFor(windowsPath, true);

  store.upsert(makeRow({ source_path: canonicalized }));
  const found = store.findBySourcePath(canonicalized);
  assertEquals(found !== undefined, true, "row must be retrievable");

  const identity = deriveExtensionIdentity(
    canonicalized,
    "c:/users/runner/repo",
  );
  assertEquals(
    identity !== null,
    true,
    "canonicalized path must resolve to a valid identity",
  );
  assertEquals(identity?.name, "@local/repo");
  store.close();
});

Deno.test("ExtensionCatalogStore: findBySourcePath canonicalizes input before lookup", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  const canonical = canonicalizePathFor(
    "C:\\Users\\runner\\repo\\extensions\\models\\echo.ts",
    true,
  );
  store.upsert(makeRow({ source_path: canonical }));

  const foundViaCanonical = store.findBySourcePath(canonical);
  assertEquals(
    foundViaCanonical !== undefined,
    true,
    "lookup via canonical path must find the row",
  );

  const foundViaNative = store.findBySourcePath(
    canonicalizePathFor(
      "C:\\Users\\Runner\\Repo\\extensions\\models\\echo.ts",
      true,
    ),
  );
  assertEquals(
    foundViaNative !== undefined,
    true,
    "lookup via differently-cased Windows path must find the same row after canonicalization",
  );
  store.close();
});

Deno.test("ExtensionCatalogStore: removeBySourcePath deletes by exact stored path", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  const canonical = canonicalizePathFor(
    "C:\\Users\\runner\\repo\\extensions\\models\\echo.ts",
    true,
  );
  store.upsert(makeRow({ source_path: canonical }));
  assertEquals(store.count(), 1);

  store.removeBySourcePath(canonical);
  assertEquals(store.count(), 0);
  store.close();
});

Deno.test("ExtensionCatalogStore: upsert with explicit state overwrites both state and last_error", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  store.upsert(makeRow({ state: "BundleBuildFailed", last_error: "boom" }));
  store.upsert(makeRow({ state: "Indexed", last_error: "" }));
  const found = store.findByType("@myorg/echo", "model");
  assertEquals(found?.state, "Indexed");
  assertEquals(found?.last_error, "");
  store.close();
});

Deno.test("ExtensionCatalogStore: findByKind returns rows regardless of state", () => {
  // ADV-1 invariant guard: findStaleFiles relies on findByKind seeing
  // ValidationFailed rows so the stable broken fingerprint terminates
  // the rebundle loop (swamp-club#209). Filtering must NOT happen at
  // the store layer — only at registration call sites.
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  const repoRoot = dirname(dirname(dbPath));
  const healthyPath = join(repoRoot, "extensions", "models", "healthy.ts");
  const brokenPath = join(repoRoot, "extensions", "models", "broken.ts");

  store.upsert(makeRow({
    type_normalized: "@myorg/healthy",
    source_path: healthyPath,
    state: "Indexed",
  }));
  store.upsert(makeRow({
    type_normalized: "",
    source_path: brokenPath,
    state: "ValidationFailed",
  }));

  const rows = store.findByKind("model");
  assertEquals(rows.length, 2);
  const failed = rows.find((r) => r.source_path === brokenPath);
  const healthy = rows.find((r) => r.source_path === healthyPath);
  assertEquals(failed?.state, "ValidationFailed");
  assertEquals(healthy?.state, "Indexed");
  store.close();
});

Deno.test("ExtensionCatalogStore: migrates pre-#209 schema by adding validation_failed column", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));

  // Source path under <repoRoot>/.swamp/pulled-extensions/... so the
  // W1a data-migration backfill produces a non-empty extension_name
  // and the row survives. Pre-#209 schema has source_fingerprint but
  // no validation_failed column; the migration adds both validation_failed
  // (vestigial after W1a) and the W1a state/extension_name/extension_version
  // columns.
  const repoRoot = dirname(dirname(dbPath));
  const sourcePath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@legacy",
    "pre-209",
    "models",
    "row.ts",
  );
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path, version,
      description, extends_type, source_mtime, source_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourcePath,
    "@legacy/row",
    "model",
    "/old/bundle.js",
    "2026.01.01.1",
    "",
    "",
    "2026-01-01T00:00:00.000Z",
    "deadbeef",
  );
  seed.close();

  // Opening through ExtensionCatalogStore must run the migration.
  const store = new ExtensionCatalogStore(dbPath);

  const legacy = store.findByType("@legacy/row", "model");
  // Pre-#209 row didn't have validation_failed; W1a's ALTER TABLE
  // added the column with DEFAULT 0, then W1b's recreate-table dance
  // dropped it again. The state column survives at its 'Indexed'
  // default for rows that weren't validation_failed=1.
  assertEquals(legacy?.source_fingerprint, "deadbeef");
  assertEquals(legacy?.state, "Indexed");

  // Re-opening is a no-op — migration is idempotent.
  store.close();
  const store2 = new ExtensionCatalogStore(dbPath);
  const again = store2.findByType("@legacy/row", "model");
  assertEquals(again?.state, "Indexed");
  store2.close();
});

// --- per-extension-aggregate-v3 migration tests (swamp-club#211, W1a) ---
//
// Cover the W1a data-migration: state backfill from validation_failed,
// extension_name backfill via deriveExtensionIdentity, post-condition
// verify with cold-start rebuild fallback, ON CONFLICT preservation
// canary (the load-bearing test the architect specified for the v6
// post-bump rescan story).

Deno.test("ExtensionCatalogStore: migrates post-#1286 schema by backfilling state from validation_failed", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));

  // Source paths under <repoRoot>/.swamp/pulled-extensions/... so the
  // W1a backfill produces non-empty extension_name and the rows survive.
  const repoRoot = dirname(dirname(dbPath));
  const healthyPath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@legacy",
    "post-1286",
    "models",
    "healthy.ts",
  );
  const brokenPath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@legacy",
    "post-1286",
    "models",
    "broken.ts",
  );

  // Seed a DB with the post-#1286 schema (has source_fingerprint AND
  // validation_failed) carrying one healthy row + one row marked broken
  // by the legacy markCatalogValidationFailed flow.
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path, version,
      description, extends_type, source_mtime, source_fingerprint,
      validation_failed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    healthyPath,
    "@legacy/healthy",
    "model",
    "/old/healthy.js",
    "2026.01.01.1",
    "",
    "",
    "2026-01-01T00:00:00.000Z",
    "feedface",
    0,
  );
  insert.run(
    brokenPath,
    "",
    "model",
    "/old/broken.js",
    "",
    "",
    "",
    "2026-01-01T00:00:00.000Z",
    "cafebabe",
    1,
  );
  seed.close();

  const store = new ExtensionCatalogStore(dbPath);
  const rows = store.findByKind("model");
  assertEquals(rows.length, 2);
  // Match against the canonical form — the W1a migration's sub-step 4
  // canonicalized every row's source_path. On Windows the seeded
  // healthy/brokenPath are backslash-form; the stored row is
  // lowercase + forward-slash.
  const healthy = rows.find((r) =>
    r.source_path === canonicalizePath(healthyPath)
  );
  const broken = rows.find((r) =>
    r.source_path === canonicalizePath(brokenPath)
  );
  assertEquals(healthy?.state, "Indexed");
  assertEquals(broken?.state, "ValidationFailed");
  store.close();
});

Deno.test("ExtensionCatalogStore: W1a migration backfills extension_name for pulled rows (extension_version intentionally empty per Option A)", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));
  const repoRoot = dirname(dirname(dbPath));
  const sourcePath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@scope",
    "foo",
    "models",
    "x.ts",
  );

  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path
    ) VALUES (?, ?, ?, ?)`,
  ).run(sourcePath, "@scope/foo/x", "model", "/bundle/x.js");
  seed.close();

  const store = new ExtensionCatalogStore(dbPath);
  // Read identity columns directly via SQL — the catalog deliberately
  // does not surface extension_name/extension_version on
  // ExtensionTypeRow per W1a Option A; W1b's ExtensionRepository owns
  // the read path. Look up by canonical source_path because the W1a
  // migration's sub-step 4 canonicalized every row's path; on Windows
  // the seeded `sourcePath` is backslash-form and won't match the
  // stored canonical (lowercase + forward-slash) form.
  const probe = (store as unknown as {
    db: DatabaseSync;
  }).db.prepare(
    "SELECT extension_name, extension_version FROM bundle_types WHERE source_path = ?",
  ).get(canonicalizePath(sourcePath)) as {
    extension_name: string;
    extension_version: string;
  };
  assertEquals(probe.extension_name, "@scope/foo");
  assertEquals(probe.extension_version, "");
  store.close();
});

Deno.test("ExtensionCatalogStore: W1a migration backfills @local/<repo> for rows under extensions/<kind>/ (version 0.0.0)", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));
  const repoRoot = dirname(dirname(dbPath));
  const sourcePath = join(repoRoot, "extensions", "models", "echo.ts");

  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path
    ) VALUES (?, ?, ?, ?)`,
  ).run(sourcePath, "@org/echo", "model", "/bundle/echo.js");
  seed.close();

  const store = new ExtensionCatalogStore(dbPath);
  const probe = (store as unknown as {
    db: DatabaseSync;
  }).db.prepare(
    "SELECT extension_name, extension_version FROM bundle_types WHERE source_path = ?",
  ).get(canonicalizePath(sourcePath)) as {
    extension_name: string;
    extension_version: string;
  };
  // basename(repoRoot) is the temp dir's basename — we only assert the
  // @local/ prefix and the literal "0.0.0" version since the dir name
  // varies across runs.
  assertEquals(probe.extension_name.startsWith("@local/"), true);
  assertEquals(probe.extension_version, "0.0.0");
  store.close();
});

Deno.test("ExtensionCatalogStore: W1a migration drops rows whose path doesn't match the heuristic (and post-condition verify rebuild path)", () => {
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));

  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO bundle_meta (key, value) VALUES ('populated:model', 'true');
  `);
  // Seed with an unrecognized path layout — neither pulled nor local.
  seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path
    ) VALUES (?, ?, ?, ?)`,
  ).run("/some/random/path/x.ts", "@unknown/x", "model", "/bundle/x.js");
  seed.close();

  const store = new ExtensionCatalogStore(dbPath);
  // Migration's data-phase: row had unrecognized layout → backfill
  // returns null → row left with empty extension_name → DELETE step
  // drops it → post-condition passes (no rows with empty
  // extension_name remain). The cold-start rebuild path (which
  // would also clear bundle_meta `populated:*` keys) does NOT fire
  // here because the post-condition succeeds.
  assertEquals(store.count(), 0);
  // populated:model survives — only the cold-start rebuild path
  // clears it, and the post-condition succeeded.
  assertEquals(store.isPopulated("model"), true);
  store.close();
});

Deno.test("ExtensionCatalogStore: W1a migration backfills mixed pulled + local + unmatched rows in a single pass", () => {
  // The whole-pipeline test: a pre-#1286 catalog containing every
  // origin type the W1a heuristic must classify simultaneously. Pulled
  // rows get extension_name backfilled with version='' (Option A);
  // local rows get @local/<repo>/0.0.0; unmatched rows are dropped at
  // the DELETE step. validation_failed=1 → state='ValidationFailed' on
  // the broken pulled row. Verifies all branches of
  // deriveExtensionIdentity compose correctly inside one transaction.
  const dbPath = makeTempDbPath();
  ensureDirSync(dirname(dbPath));
  const repoRoot = dirname(dirname(dbPath));

  const pulledHealthy = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@scope",
    "alpha",
    "models",
    "ok.ts",
  );
  const pulledBroken = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@scope",
    "alpha",
    "models",
    "broken.ts",
  );
  const pulledOtherExt = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@scope",
    "beta",
    "vaults",
    "secret.ts",
  );
  const localPath = join(repoRoot, "extensions", "models", "echo.ts");
  const sourceMountedPath = "/external/srcdir/extensions/drivers/raw.ts";
  const unmatchedPath = "/some/legacy/path/orphan.ts";

  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = seed.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path,
      validation_failed
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(pulledHealthy, "@scope/alpha/ok", "model", "/b/ok.js", 0);
  insert.run(pulledBroken, "", "model", "/b/broken.js", 1);
  insert.run(
    pulledOtherExt,
    "@scope/beta/secret",
    "vault",
    "/b/secret.js",
    0,
  );
  insert.run(localPath, "@org/echo", "model", "/b/echo.js", 0);
  insert.run(sourceMountedPath, "@org/raw", "driver", "/b/raw.js", 0);
  insert.run(unmatchedPath, "@legacy/orphan", "model", "/b/orphan.js", 0);
  seed.close();

  const store = new ExtensionCatalogStore(dbPath);
  // Read identity columns directly via SQL — ExtensionTypeRow doesn't
  // surface extension_name/extension_version per W1a Option A.
  const rows = (store as unknown as { db: DatabaseSync }).db.prepare(
    `SELECT source_path, extension_name, extension_version, state
       FROM bundle_types ORDER BY source_path`,
  ).all() as Array<{
    source_path: string;
    extension_name: string;
    extension_version: string;
    state: string;
  }>;

  // The W1a migration's sub-step 4 canonicalized every row's
  // source_path. On Windows the seeded paths above are backslash-form;
  // the stored rows are lowercase + forward-slash. Look up against the
  // canonical form so this test passes on both platforms.
  const cPulledHealthy = canonicalizePath(pulledHealthy);
  const cPulledBroken = canonicalizePath(pulledBroken);
  const cPulledOtherExt = canonicalizePath(pulledOtherExt);
  const cLocalPath = canonicalizePath(localPath);
  const cSourceMountedPath = canonicalizePath(sourceMountedPath);
  const cUnmatchedPath = canonicalizePath(unmatchedPath);

  // Unmatched row was dropped at sub-step 7. Five remain.
  assertEquals(rows.length, 5);
  assertEquals(
    rows.find((r) => r.source_path === cUnmatchedPath),
    undefined,
    "unmatched-path row must be dropped by the DELETE step",
  );

  const byPath = new Map(rows.map((r) => [r.source_path, r]));

  // Pulled rows: extension_name parsed from path, version intentionally ''.
  assertEquals(byPath.get(cPulledHealthy)?.extension_name, "@scope/alpha");
  assertEquals(byPath.get(cPulledHealthy)?.extension_version, "");
  assertEquals(byPath.get(cPulledHealthy)?.state, "Indexed");

  assertEquals(byPath.get(cPulledBroken)?.extension_name, "@scope/alpha");
  assertEquals(byPath.get(cPulledBroken)?.extension_version, "");
  // validation_failed=1 backfilled to state='ValidationFailed'.
  assertEquals(byPath.get(cPulledBroken)?.state, "ValidationFailed");

  assertEquals(byPath.get(cPulledOtherExt)?.extension_name, "@scope/beta");
  assertEquals(byPath.get(cPulledOtherExt)?.extension_version, "");
  assertEquals(byPath.get(cPulledOtherExt)?.state, "Indexed");

  // Local row: @local/<basename(repoRoot)> at 0.0.0. Use @std/path
  // basename so this works on both POSIX and Windows native repoRoot
  // values. The migration's deriveExtensionIdentity uses basename on
  // a canonicalized repoRoot internally — same semantic.
  const expectedLocalName = `@local/${
    canonicalizePath(repoRoot).split("/").filter((s) => s.length > 0).pop()
  }`;
  assertEquals(byPath.get(cLocalPath)?.extension_name, expectedLocalName);
  assertEquals(byPath.get(cLocalPath)?.extension_version, "0.0.0");
  assertEquals(byPath.get(cLocalPath)?.state, "Indexed");

  // Source-mounted row: same @local/<repoRoot> aggregate as locals
  // (per the design doc — "@local/<repo-name> covers every Source
  // under every extensions/<kind>/ tree" regardless of where the
  // source dir lives).
  assertEquals(
    byPath.get(cSourceMountedPath)?.extension_name,
    expectedLocalName,
  );
  assertEquals(byPath.get(cSourceMountedPath)?.extension_version, "0.0.0");
  assertEquals(byPath.get(cSourceMountedPath)?.state, "Indexed");

  store.close();
});

// --- Cold-start rebuild path ---
//
// The recovery path that fires when the data-migration's post-condition
// verify throws (e.g. a backfill heuristic gap that leaves rows with
// empty extension_name AFTER sub-step 7's DELETE — a bug class the
// current heuristic doesn't produce, but which a future migration
// change could). The path is the only line of defense against a silent
// backfill bug; we test the rebuild's own contract directly via the
// private-method cast pattern already used elsewhere in this file.
// The catch-handler in `runDataMigrationTransaction` that triggers the
// rebuild is three trivial lines (try/catch around verify; log; call
// runColdStartRebuild) — testing the rebuild itself + reading the
// catch handler is sufficient.

Deno.test("ExtensionCatalogStore: runColdStartRebuild empties bundle_types, clears populated:* keys, marks migration applied", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);
  const repoRoot = dirname(dirname(dbPath));

  // Seed the catalog with rows + populated flags so the rebuild has
  // something to clear. Use realistic paths so the construction-time
  // migration accepted them; this is the post-W1a steady state.
  const sourcePath = join(
    repoRoot,
    ".swamp",
    "pulled-extensions",
    "@scope",
    "foo",
    "models",
    "x.ts",
  );
  store.upsert({
    source_path: sourcePath,
    type_normalized: "@scope/foo/x",
    kind: "model",
    bundle_path: "/b/x.js",
    version: "1.0.0",
    description: "",
    extends_type: "",
    source_mtime: "",
  });
  store.markPopulated("model");
  store.markPopulated("vault");
  assertEquals(store.count(), 1);
  assertEquals(store.isPopulated("model"), true);
  assertEquals(store.isPopulated("vault"), true);

  // Drive the rebuild directly. The catch-handler in
  // runDataMigrationTransaction wraps this in
  //   try { ... } catch (error) { ROLLBACK; logger.warn; rebuild(); }
  // — a trivial three-liner. Testing the rebuild's own contract is
  // what catches a regression in the recovery semantics.
  (store as unknown as { runColdStartRebuild: () => void })
    .runColdStartRebuild();

  // Post-rebuild invariants:
  //   1. bundle_types is empty (DELETE FROM bundle_types).
  //   2. populated:* keys cleared (so loaders re-discover from disk).
  //   3. migration_applied marker set (so subsequent restarts skip
  //      the data-migration phase — the catalog is at v3 even though
  //      it's empty).
  assertEquals(store.count(), 0);
  assertEquals(store.isPopulated("model"), false);
  assertEquals(store.isPopulated("vault"), false);
  const markerProbe = (store as unknown as { db: DatabaseSync }).db.prepare(
    `SELECT value FROM bundle_meta
         WHERE key = 'migration_applied:per-extension-aggregate-v3'`,
  ).get() as { value: string } | undefined;
  assertEquals(markerProbe?.value, "true");

  store.close();

  // Re-opening must be a no-op: marker is set, data-phase is skipped,
  // catalog stays empty. Loaders re-populate from disk on first access
  // (out of scope for this unit test).
  const store2 = new ExtensionCatalogStore(dbPath);
  assertEquals(store2.count(), 0);
  assertEquals(store2.isPopulated("model"), false);
  store2.close();
});

// --- ON CONFLICT preservation canary (resolves ADV-V3-1) ---
//
// The load-bearing test the architect called out: after the W1a
// migration backfills extension_name/extension_version, the model
// loader's BUNDLE_LAYOUT_VERSION-bump-triggered rescan upserts every
// row. Under the previous INSERT OR REPLACE pattern, the upsert reset
// extension_name/extension_version to DEFAULT '' on every row,
// silently undoing the migration on first run after deploy. The new
// ON CONFLICT(source_path) DO UPDATE SET pattern intentionally
// excludes the identity columns from the SET list. This test fails
// loudly if a future change reverts to INSERT OR REPLACE or adds the
// identity columns to the SET list.

Deno.test("ExtensionCatalogStore: upsert preserves migration-backfilled extension_name/extension_version on UPDATE (ADV-V3-1 canary)", () => {
  const dbPath = makeTempDbPath();
  const store = new ExtensionCatalogStore(dbPath);

  // Manually INSERT a row with backfilled identity, simulating the
  // post-W1a-migration state.
  const sourcePath = "/test/repo/extensions/models/echo.ts";
  (store as unknown as { db: DatabaseSync }).db.prepare(
    `INSERT INTO bundle_types (
      source_path, type_normalized, kind, bundle_path,
      extension_name, extension_version, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourcePath,
    "@myorg/echo",
    "model",
    "/bundle/echo-v1.js",
    "@scope/echo",
    "1.2.3",
    "Indexed",
  );

  // Simulate a loader rescan upserting the same source_path with new
  // bundle_path, version, etc. (the model loader re-bundles after a
  // BUNDLE_LAYOUT_VERSION bump and upserts every row).
  store.upsert(makeRow({
    source_path: sourcePath,
    type_normalized: "@myorg/echo",
    kind: "model",
    bundle_path: "/bundle/echo-v2.js",
    version: "2026.05.04.1",
  }));

  // Identity columns: UNCHANGED. This is the canary — under
  // INSERT OR REPLACE these would have been reset to ''.
  const probe = (store as unknown as { db: DatabaseSync }).db.prepare(
    `SELECT extension_name, extension_version, state, bundle_path, version
       FROM bundle_types WHERE source_path = ?`,
  ).get(sourcePath) as {
    extension_name: string;
    extension_version: string;
    state: string;
    bundle_path: string;
    version: string;
  };
  assertEquals(probe.extension_name, "@scope/echo");
  assertEquals(probe.extension_version, "1.2.3");
  // Legacy columns DO change on UPDATE — these are in the SET list.
  assertEquals(probe.bundle_path, "/bundle/echo-v2.js");
  assertEquals(probe.version, "2026.05.04.1");
  // state is in the SET list and defaults to 'Indexed' when callers
  // omit it (which the loader's upsert always does — only
  // markCatalogValidationFailed sets state explicitly).
  assertEquals(probe.state, "Indexed");
  store.close();
});

// --- W1b drop-validation_failed migration tests (issue #223) ---

Deno.test("ExtensionCatalogStore: W1b drop-validation_failed migration removes the column and preserves all rows + indexes", () => {
  // Set up a pre-W1b shape on disk: bundle_types includes the
  // validation_failed column, has a real row with a value, and the W1a
  // marker keys are absent so the data migration also runs.
  const dbPath = makeTempDbPath();
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE bundle_types (
      source_path        TEXT NOT NULL PRIMARY KEY,
      type_normalized    TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'model',
      bundle_path        TEXT NOT NULL,
      version            TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      extends_type       TEXT NOT NULL DEFAULT '',
      source_mtime       TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      validation_failed  INTEGER NOT NULL DEFAULT 0,
      state              TEXT NOT NULL DEFAULT 'Indexed',
      extension_name     TEXT NOT NULL DEFAULT '',
      extension_version  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_bundle_types_kind ON bundle_types(kind);
    CREATE INDEX idx_bundle_types_extends ON bundle_types(extends_type);
    CREATE INDEX idx_bundle_types_type ON bundle_types(type_normalized, kind);
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Seed some rows with the validation_failed column populated. After
  // migration: rows with vf=1 are surfaced as state='ValidationFailed'
  // by the W1a phase; the W1b phase drops the column itself.
  const repoRoot = canonicalizePath(dirname(dirname(dbPath)));
  const insert = seed.prepare(
    `INSERT INTO bundle_types (source_path, type_normalized, kind, bundle_path, validation_failed, state, extension_name, extension_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    `${repoRoot}/extensions/models/healthy.ts`,
    "@local/healthy",
    "model",
    "/bundle/healthy.js",
    0,
    "Indexed",
    "@local/" + dirname(dbPath).split("/").pop(),
    "0.0.0",
  );
  insert.run(
    `${repoRoot}/extensions/models/broken.ts`,
    "",
    "model",
    "/bundle/broken.js",
    1, // validation_failed=1
    "ValidationFailed",
    "@local/" + dirname(dbPath).split("/").pop(),
    "0.0.0",
  );
  seed.close();

  // Open the catalog — migrateSchema runs (data migration + W1b drop).
  const store = new ExtensionCatalogStore(dbPath);

  // Post-condition (a): pragma_table_info no longer reports the column.
  const pragmaProbe = new DatabaseSync(dbPath);
  const cols = pragmaProbe.prepare(
    "SELECT name FROM pragma_table_info('bundle_types')",
  ).all() as Array<{ name: string }>;
  assertEquals(
    cols.some((c) => c.name === "validation_failed"),
    false,
    "validation_failed column must be dropped",
  );

  // Post-condition (b): all 3 indexes survive the recreate-table dance.
  const indexes = pragmaProbe.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bundle_types' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  const indexNames = indexes.map((i) => i.name).sort();
  assertEquals(
    indexNames,
    [
      "idx_bundle_types_extends",
      "idx_bundle_types_kind",
      "idx_bundle_types_type",
    ],
  );

  // Post-condition (c): rows preserved (count + content match).
  const rowCount =
    (pragmaProbe.prepare("SELECT COUNT(*) AS cnt FROM bundle_types").get() as
      | { cnt: number }
      | undefined)?.cnt ?? 0;
  assertEquals(rowCount, 2);
  const healthy = store.findByType("@local/healthy", "model");
  assertEquals(healthy?.state, "Indexed");
  // The broken row was migrated by W1a to state='ValidationFailed' and
  // its type_normalized is empty (loader filters those at registration).
  const broken = store.findAll().find((r) =>
    r.source_path.endsWith("broken.ts")
  );
  assertEquals(broken?.state, "ValidationFailed");

  // Post-condition (d): bundle_meta marker for the drop is set.
  const marker = pragmaProbe.prepare(
    "SELECT value FROM bundle_meta WHERE key = ?",
  ).get("migration_applied:validation-failed-dropped-v1") as
    | { value: string }
    | undefined;
  assertEquals(marker?.value, "true");

  pragmaProbe.close();
  store.close();
});

Deno.test("ExtensionCatalogStore: W1b drop-validation_failed migration is idempotent (second run is a no-op)", () => {
  // Run migrateSchema twice; second run finds the marker and short-
  // circuits without touching the schema.
  const dbPath = makeTempDbPath();
  // First open: creates fresh schema (no validation_failed column),
  // then migrateSchema marks the migration as applied.
  const store1 = new ExtensionCatalogStore(dbPath);
  store1.close();

  // Second open: same db. migrateSchema runs again. The drop helper
  // sees the marker is set and returns immediately.
  const store2 = new ExtensionCatalogStore(dbPath);
  // The column is still absent.
  const probe = new DatabaseSync(dbPath);
  const cols = probe.prepare(
    "SELECT name FROM pragma_table_info('bundle_types')",
  ).all() as Array<{ name: string }>;
  assertEquals(
    cols.some((c) => c.name === "validation_failed"),
    false,
  );
  // Marker is still set.
  const marker = probe.prepare(
    "SELECT value FROM bundle_meta WHERE key = ?",
  ).get("migration_applied:validation-failed-dropped-v1") as
    | { value: string }
    | undefined;
  assertEquals(marker?.value, "true");
  probe.close();
  store2.close();
});

Deno.test("ExtensionCatalogStore: W1b drop-validation_failed migration ROLLBACKs cleanly on mid-dance failure", () => {
  // Architecture-review ask: prove the recreate-table dance's atomicity
  // contract against Deno's node:sqlite. Seed a catalog into the
  // pre-W1b shape (validation_failed column + rows + marker absent),
  // monkey-patch the db.exec to throw on the second CREATE INDEX, then
  // call the drop migration via reflection. Post-condition: the
  // ROLLBACK fired, the original schema and rows survive, the
  // bundle_meta marker was NOT set (so the next migrateSchema run
  // retries cleanly).
  const dbPath = makeTempDbPath();

  // Step 1: open a fresh catalog so the schema is created and the
  // drop-migration marker is set (for a fresh DB the column is already
  // absent — the migration short-circuits via the pragma probe and
  // marks itself applied). We then reset to a pre-W1b shape.
  const store = new ExtensionCatalogStore(dbPath);
  // deno-lint-ignore no-explicit-any
  const internal = store as any;
  // Reset state: re-add the validation_failed column, seed rows, clear
  // the dropped marker so the migration would actually run again.
  internal.db.exec(
    "ALTER TABLE bundle_types ADD COLUMN validation_failed INTEGER NOT NULL DEFAULT 0",
  );
  internal.db.exec(
    "DELETE FROM bundle_meta WHERE key = 'migration_applied:validation-failed-dropped-v1'",
  );
  // Seed two rows so we can verify they survive the rollback.
  const seedRow = (suffix: string, vf: number) =>
    internal.db.exec(
      `INSERT INTO bundle_types (
        source_path, type_normalized, kind, bundle_path, validation_failed
      ) VALUES (
        '/repo/extensions/models/${suffix}.ts',
        '@local/test/${suffix}',
        'model',
        '/bundle/${suffix}.js',
        ${vf}
      )`,
    );
  seedRow("alpha", 0);
  seedRow("beta", 1);

  // Pre-condition snapshot.
  const colsBefore = (internal.db.prepare(
    "SELECT name FROM pragma_table_info('bundle_types')",
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
  const rowCountBefore = (internal.db.prepare(
    "SELECT COUNT(*) AS cnt FROM bundle_types",
  ).get() as { cnt: number }).cnt;

  // Step 2: monkey-patch db.exec to throw on the second CREATE INDEX
  // (idx_bundle_types_extends — the second index recreated inside the
  // dance). The dance has already DROPped + RENAMEd by that point, so
  // a successful ROLLBACK must restore the original bundle_types table
  // along with its three indexes.
  const realExec = internal.db.exec.bind(internal.db);
  let createIndexCount = 0;
  internal.db.exec = (sql: string) => {
    if (/^\s*CREATE\s+INDEX/i.test(sql)) {
      createIndexCount++;
      if (createIndexCount === 2) {
        throw new Error("FAULT INJECTED: second CREATE INDEX failed");
      }
    }
    return realExec(sql);
  };

  // Step 3: invoke the drop migration. The exception inside the dance
  // should ROLLBACK and re-throw.
  let thrown: unknown;
  try {
    internal.dropValidationFailedColumn();
  } catch (e) {
    thrown = e;
  }
  assert(
    thrown instanceof Error &&
      thrown.message.includes("FAULT INJECTED"),
    "expected the injected fault to propagate after ROLLBACK",
  );

  // Step 4: restore the real exec and verify post-conditions.
  internal.db.exec = realExec;

  // (a) The schema is intact (validation_failed column survives).
  const colsAfter = (internal.db.prepare(
    "SELECT name FROM pragma_table_info('bundle_types')",
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
  assertEquals(colsAfter, colsBefore);

  // (b) Rows are unchanged (count + content).
  const rowCountAfter = (internal.db.prepare(
    "SELECT COUNT(*) AS cnt FROM bundle_types",
  ).get() as { cnt: number }).cnt;
  assertEquals(rowCountAfter, rowCountBefore);
  const beta = internal.db.prepare(
    "SELECT validation_failed FROM bundle_types WHERE source_path LIKE '%beta.ts'",
  ).get() as { validation_failed: number } | undefined;
  assertEquals(beta?.validation_failed, 1);

  // (c) All 3 original indexes still present (DROP TABLE inside the
  // failed transaction was rolled back, so the original indexes
  // attached to the original table survive).
  const indexes = (internal.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bundle_types' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
  assertEquals(
    indexes,
    [
      "idx_bundle_types_extends",
      "idx_bundle_types_kind",
      "idx_bundle_types_type",
    ],
  );

  // (d) Marker NOT set — the next migrateSchema run will retry the
  // dance from scratch instead of falsely short-circuiting.
  const marker = internal.db.prepare(
    "SELECT value FROM bundle_meta WHERE key = ?",
  ).get("migration_applied:validation-failed-dropped-v1") as
    | { value: string }
    | undefined;
  assertEquals(marker, undefined);

  store.close();
});

Deno.test({
  name:
    "ExtensionCatalogStore: recovers from read-only catalog by deleting and recreating",
  ignore: Deno.build.os === "windows",
  fn() {
    const dbPath = makeTempDbPath();

    // Seed an old-schema catalog missing the 'last_error' column.
    const seed = new DatabaseSync(dbPath);
    seed.exec("PRAGMA journal_mode=WAL");
    seed.exec(`
      CREATE TABLE bundle_types (
        source_path        TEXT NOT NULL PRIMARY KEY,
        type_normalized    TEXT NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'model',
        bundle_path        TEXT NOT NULL,
        version            TEXT NOT NULL DEFAULT '',
        description        TEXT NOT NULL DEFAULT '',
        extends_type       TEXT NOT NULL DEFAULT '',
        source_mtime       TEXT NOT NULL DEFAULT '',
        source_fingerprint TEXT NOT NULL DEFAULT '',
        state              TEXT NOT NULL DEFAULT 'Indexed',
        extension_name     TEXT NOT NULL DEFAULT '',
        extension_version  TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE bundle_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    seed.exec(
      "INSERT INTO bundle_meta (key, value) VALUES ('migration_applied:per-extension-aggregate-v3', 'true')",
    );
    seed.exec(
      "INSERT INTO bundle_meta (key, value) VALUES ('migration_applied:validation-failed-dropped-v1', 'true')",
    );
    seed.close();

    // Make the file read-only so schema migration fails.
    Deno.chmodSync(dbPath, 0o444);

    // Construction should recover: delete the stale file, recreate.
    const store = new ExtensionCatalogStore(dbPath);

    // The recovered store should be fully functional.
    store.upsert(makeRow({ source_path: "/test/echo.ts" }));
    const rows = store.findByKind("model");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].source_path, "/test/echo.ts");

    store.close();

    // Restore permissions for cleanup.
    try {
      Deno.removeSync(dbPath);
    } catch { /* withTempDir handles cleanup */ }
  },
});
