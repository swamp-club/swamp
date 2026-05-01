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
import { join } from "@std/path";
import { UserDriverLoader } from "./user_driver_loader.ts";
import { driverTypeRegistry } from "./driver_type_registry.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

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
    const loader1 = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(driversDir, catalog1);
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
    const loader2 = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader2.buildIndex(driversDir, catalog2);
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
    const loader1 = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader1.buildIndex(driversDir, catalog1);
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
    const loader2 = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader2.buildIndex(driversDir, catalog2);
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
    const loader = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader.buildIndex(driversDir, catalog);

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
      validation_failed: true,
    });

    const loader2 = new UserDriverLoader(testDenoRuntime, repoDir);
    await loader2.buildIndex(driversDir, catalog);

    assertEquals(driverTypeRegistry.has(`@test/issue209-driver-${ts}`), true);
    assertEquals(driverTypeRegistry.has(""), false);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(driversDir, { recursive: true });
  }
});
