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

import { assertEquals, assertNotEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { ExtensionLoader } from "../extensions/extension_loader.ts";
import { driverKindAdapter } from "../extensions/driver_kind_adapter.ts";
import { driverTypeRegistry } from "./driver_type_registry.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

/** W1b/(a-2): construct an ExtensionRepository wrapping a test catalog. */
function makeRepoForCatalog(
  catalog: ExtensionCatalogStore,
  repoRoot: string,
): ExtensionRepository {
  return new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      {},
    ),
    repoRoot,
  });
}

Deno.test("UserDriverLoader buildIndex rebundles when source content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const driverType = `@user/preserved-mtime-driver-${ts}`;
  const v1 = `
export const driver = {
  type: "${driverType}",
  name: "V1_MARKER",
  description: "V1_MARKER",
  createDriver: (_config) => ({
    async executeMethod() {
      return { dataHandles: [], ok: "V1_MARKER" };
    },
  }),
};
`;
  const v2 = `
export const driver = {
  type: "${driverType}",
  name: "V2_MARKER",
  description: "V2_MARKER",
  createDriver: (_config) => ({
    async executeMethod() {
      return { dataHandles: [], ok: "V2_MARKER" };
    },
  }),
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_driver_repo_",
  });
  const driversDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_drivers_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const sourcePath = join(driversDir, "driver.ts");
    await Deno.writeTextFile(sourcePath, v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(driversDir);
    catalog1.close();

    const ns = bundleNamespace(driversDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "driver-bundles",
      ns,
      "driver.js",
    );
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(v1Bundle.includes("V1_MARKER"), true);

    const origMtime = (await Deno.stat(sourcePath)).mtime!;

    await new Promise((r) => setTimeout(r, 1100));

    await Deno.writeTextFile(sourcePath, v2);
    await Deno.utime(sourcePath, origMtime, origMtime);

    const srcStat = await Deno.stat(sourcePath);
    const bundleStat = await Deno.stat(bundlePath);
    assertEquals(
      srcStat.mtime!.getTime() <= bundleStat.mtime!.getTime(),
      true,
      "Precondition — source mtime must be <= bundle mtime to exercise the bug",
    );

    const catalog2 = new ExtensionCatalogStore(dbPath);

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(driversDir);
    catalog2.close();

    const v2Bundle = await Deno.readTextFile(bundlePath);
    assertNotEquals(v1Bundle, v2Bundle);
    assertEquals(
      v2Bundle.includes("V2_MARKER"),
      true,
      "V2 marker must be present in the regenerated bundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(driversDir, { recursive: true });
  }
});

Deno.test("UserDriverLoader buildIndex rebundles when transitive dep content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const driverType = `@user/preserved-mtime-driver-dep-${ts}`;
  const entry = `
import { marker } from "./_lib/marker.ts";

export const driver = {
  type: "${driverType}",
  name: "dep-transitive",
  description: "dep-transitive",
  createDriver: (_config) => ({
    async executeMethod() {
      return { dataHandles: [], ok: marker() };
    },
  }),
};
`;
  const libV1 = `export const marker = () => "V1_DEP_MARKER";\n`;
  const libV2 = `export const marker = () => "V2_DEP_MARKER";\n`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_driver_dep_repo_",
  });
  const driversDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_driver_dep_src_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.mkdir(join(driversDir, "_lib"), { recursive: true });
    const entryPath = join(driversDir, "driver.ts");
    const libPath = join(driversDir, "_lib", "marker.ts");
    await Deno.writeTextFile(entryPath, entry);
    await Deno.writeTextFile(libPath, libV1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(driversDir);
    catalog1.close();

    const ns = bundleNamespace(driversDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "driver-bundles",
      ns,
      "driver.js",
    );
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(v1Bundle.includes("V1_DEP_MARKER"), true);

    const entryMtime = (await Deno.stat(entryPath)).mtime!;
    const libMtime = (await Deno.stat(libPath)).mtime!;

    await new Promise((r) => setTimeout(r, 1100));

    await Deno.writeTextFile(libPath, libV2);
    await Deno.utime(libPath, libMtime, libMtime);
    await Deno.utime(entryPath, entryMtime, entryMtime);

    const catalog2 = new ExtensionCatalogStore(dbPath);

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(driversDir);
    catalog2.close();

    const v2Bundle = await Deno.readTextFile(bundlePath);
    assertNotEquals(v1Bundle, v2Bundle);
    assertEquals(
      v2Bundle.includes("V2_DEP_MARKER"),
      true,
      "V2 dep marker must be present in the regenerated bundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(driversDir, { recursive: true });
  }
});

Deno.test("UserDriverLoader: registerLazyFromCatalog skips validation_failed rows (swamp-club#209)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_driver_repo_",
  });
  const driversDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_driver_dir_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const ts = Date.now();
    const validDriver = `
export const driver = {
  type: "@test/issue209-driver-${ts}",
  name: "Test Driver",
  description: "Healthy driver",
  createDriver: (_config) => ({
    async executeMethod() {
      return { dataHandles: [] };
    },
  }),
};
`;
    await Deno.writeTextFile(join(driversDir, "valid.ts"), validDriver);

    const catalog = new ExtensionCatalogStore(dbPath);

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(driversDir);

    catalog.upsert({
      source_path: join(driversDir, "broken.ts"),
      type_normalized: "",
      kind: "driver",
      bundle_path: join(repoDir, ".swamp", "driver-bundles", "broken.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "2026-05-01T12:00:00.000Z",
      source_fingerprint: "deadbeef-broken",
      // W1b: validation_failed dropped — state="ValidationFailed" is the signal.
    });

    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      driverKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader2.buildIndex(driversDir);

    assertEquals(driverTypeRegistry.has(`@test/issue209-driver-${ts}`), true);
    assertEquals(driverTypeRegistry.has(""), false);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(driversDir, { recursive: true });
  }
});

// ===== Pin 1 (W2) =====
//
// `bundleAndIndexOne` is the public per-file entry point that
// InstallExtensionService calls during install. The lifecycle service
// owns the catalog write via `repository.save()`; the loader's per-file
// method MUST NOT write directly. If a future refactor sneaks a
// `catalog.upsert` back into this path, I-Repo-1 silently stops firing
// at install time. This test is the regression net.

Deno.test(
  "UserDriverLoader.bundleAndIndexOne: returns driver metadata without writing catalog rows (Pin 1)",
  async () => {
    const ts = Date.now();
    const driverType = `@user/pin1-driver-${ts}`;
    const driverCode = `
export const driver = {
  type: "${driverType}",
  name: "Pin1Driver",
  description: "pin1",
  createDriver: (_config) => ({
    async executeMethod() {
      return { dataHandles: [], ok: true };
    },
  }),
};
`;

    const repoDir = await Deno.makeTempDir({ prefix: "swamp_pin1_driver_r_" });
    const driversDir = await Deno.makeTempDir({
      prefix: "swamp_pin1_driver_d_",
    });
    const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
    await Deno.mkdir(dirname(dbPath), { recursive: true });

    try {
      await Deno.writeTextFile(join(driversDir, "driver.ts"), driverCode);

      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);
      const loader = new ExtensionLoader(
        testDenoRuntime,
        driverKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const before = catalog.findAll().length;
      assertEquals(before, 0, "test pre-condition: catalog empty");

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(driversDir, "driver.ts"),
        relativePath: "driver.ts",
        baseDir: driversDir,
      });

      // Pin 1: catalog row count must be unchanged.
      assertEquals(
        catalog.findAll().length,
        before,
        "Pin 1: bundleAndIndexOne must NOT write catalog rows",
      );

      assertNotEquals(result, null);
      assertEquals(result?.kind, "driver");
      assertEquals(result?.typeNormalized, driverType.toLowerCase());

      catalog.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(driversDir, { recursive: true });
    }
  },
);

Deno.test("driverKindAdapter.extractTypeFromSource: ignores type in helper objects above the export", () => {
  const source = `
const cfg = { type: "wrong/type" };
export const driver = {
  type: "@org/correct-driver",
  execute: async () => ({}),
};`;
  const result = driverKindAdapter.extractTypeFromSource(source);
  assertNotEquals(result, null);
  assertEquals(result?.typeNormalized, "@org/correct-driver");
});
