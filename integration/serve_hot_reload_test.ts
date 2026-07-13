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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { toFileUrl } from "@std/path/to-file-url";
import { ensureDirSync } from "@std/fs";
import {
  ExtensionCatalogStore,
  type ExtensionTypeRow,
} from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ModelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";

function makeRow(overrides: Partial<ExtensionTypeRow> = {}): ExtensionTypeRow {
  return {
    type_normalized: "@test/widget",
    kind: "model",
    bundle_path: "/repo/.swamp/bundles/widget.js",
    source_path: "/repo/extensions/models/widget.ts",
    version: "2026.01.15.1",
    description: "Test widget",
    extends_type: "",
    source_mtime: "2026-01-15T10:00:00.000Z",
    source_fingerprint: "fp-v1",
    ...overrides,
  };
}

Deno.test("SQLite WAL: second connection sees writes from first connection", () => {
  const repoRoot = Deno.makeTempDirSync({ prefix: "swamp-wal-test-" });
  try {
    ensureDirSync(join(repoRoot, ".swamp"));
    const dbPath = join(repoRoot, ".swamp", "_extension_catalog.db");

    const storeA = new ExtensionCatalogStore(dbPath);
    storeA.upsert(
      makeRow({ type_normalized: "@test/alpha", version: "1.0.0" }),
    );
    storeA.markPopulated("model");

    const storeB = new ExtensionCatalogStore(dbPath);
    const found = storeB.findByType("@test/alpha", "model");
    assertEquals(found?.type_normalized, "@test/alpha");
    assertEquals(found?.version, "1.0.0");

    storeA.upsert(
      makeRow({ type_normalized: "@test/alpha", version: "2.0.0" }),
    );

    const updated = storeB.findByType("@test/alpha", "model");
    assertEquals(updated?.version, "2.0.0");

    storeA.close();
    storeB.close();
  } finally {
    Deno.removeSync(repoRoot, { recursive: true });
  }
});

Deno.test("SQLite WAL: findByExtension on second connection sees first connection's writes", () => {
  const repoRoot = Deno.makeTempDirSync({ prefix: "swamp-wal-ext-test-" });
  try {
    ensureDirSync(join(repoRoot, ".swamp"));
    const dbPath = join(repoRoot, ".swamp", "_extension_catalog.db");

    const storeA = new ExtensionCatalogStore(dbPath);
    const sourcePath = "/repo/extensions/models/runner.ts";
    storeA.upsert(
      makeRow({
        type_normalized: "@acme/deploy/runner",
        source_path: sourcePath,
        source_fingerprint: "fp-new",
      }),
    );
    storeA.updateExtensionIdentity(
      sourcePath,
      "@acme/deploy",
      "2026.07.11.1",
    );

    const storeB = new ExtensionCatalogStore(dbPath);
    const rows = storeB.findByExtension("@acme/deploy", "2026.07.11.1");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].type_normalized, "@acme/deploy/runner");
    assertEquals(rows[0].source_fingerprint, "fp-new");

    storeA.close();
    storeB.close();
  } finally {
    Deno.removeSync(repoRoot, { recursive: true });
  }
});

Deno.test("invalidateType + registerLazy + ensureTypeLoaded: full reload cycle with fingerprint change", async () => {
  const registry = new ModelRegistry();

  const calls: string[] = [];
  registry.setTypeLoader((_type, lazyEntry) => {
    calls.push(lazyEntry?.sourceFingerprint ?? "none");
    return Promise.resolve();
  });

  registry.registerLazy({
    type: ModelType.create("@test/widget"),
    bundlePath: "/bundles/v1/widget.js",
    sourcePath: "/extensions/widget.ts",
    version: "1.0.0",
    sourceFingerprint: "fp-v1",
  });

  await registry.ensureTypeLoaded("@test/widget");
  assertEquals(calls, ["fp-v1"]);

  registry.invalidateType("@test/widget");
  assertEquals(registry.has("@test/widget"), false);

  registry.registerLazy({
    type: ModelType.create("@test/widget"),
    bundlePath: "/bundles/v2/widget.js",
    sourcePath: "/extensions/widget.ts",
    version: "2.0.0",
    sourceFingerprint: "fp-v2",
  });

  await registry.ensureTypeLoaded("@test/widget");
  assertEquals(calls, ["fp-v1", "fp-v2"]);
});

Deno.test("?fp= cache busting: different fingerprints import different module content", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-fp-cache-bust-" });
  try {
    const bundlePath = join(dir, "cache_bust_target.js");

    await Deno.writeTextFile(
      bundlePath,
      'export const version = "v1";\n',
    );
    const baseUrl = toFileUrl(bundlePath).href;

    const mod1 = await import(`${baseUrl}?fp=fingerprint-aaa`);
    assertEquals(mod1.version, "v1");

    await Deno.writeTextFile(
      bundlePath,
      'export const version = "v2";\n',
    );

    const mod2 = await import(`${baseUrl}?fp=fingerprint-bbb`);
    assertEquals(mod2.version, "v2");

    assertNotEquals(mod1.version, mod2.version);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
