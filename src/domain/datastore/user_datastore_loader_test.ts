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
import { UserDatastoreLoader } from "./user_datastore_loader.ts";
import {
  DatastoreTypeRegistry,
  datastoreTypeRegistry,
} from "./datastore_type_registry.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

/** Stub runtime that returns "deno" as the binary path. */
class StubDenoRuntime implements DenoRuntime {
  ensureDeno(): Promise<string> {
    return Promise.resolve("deno");
  }
}

Deno.test("UserDatastoreLoader - returns empty result for nonexistent directory", async () => {
  const loader = new UserDatastoreLoader(new StubDenoRuntime());
  const result = await loader.loadDatastores("/nonexistent/path");
  assertEquals(result.loaded, []);
  assertEquals(result.failed, []);
});

Deno.test("UserDatastoreLoader - loads valid datastore from temp directory", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "datastore_loader_test_",
  });
  try {
    const datastoreFile = join(tmpDir, "custom_store.ts");
    await Deno.writeTextFile(
      datastoreFile,
      `
import { z } from "npm:zod";

export const datastore = {
  type: "@test/custom-store-${Date.now()}",
  name: "Custom Store",
  description: "A test datastore implementation",
  configSchema: z.object({ path: z.string() }),
  createProvider: (_config: Record<string, unknown>) => ({
    createLock: (_datastorePath: string) => ({
      acquire: async () => {},
      release: async () => {},
      withLock: async (fn: () => Promise<unknown>) => fn(),
      inspect: async () => null,
      forceRelease: async (_nonce: string) => false,
    }),
    createVerifier: () => ({
      verify: async () => ({
        healthy: true,
        message: "ok",
        latencyMs: 1,
        datastoreType: "@test/custom-store",
      }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  }),
};
`,
    );

    const loader = new UserDatastoreLoader(new StubDenoRuntime());
    const result = await loader.loadDatastores(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "custom_store.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader - skips files without datastore export", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "datastore_loader_test_",
  });
  try {
    const utilFile = join(tmpDir, "utils.ts");
    await Deno.writeTextFile(utilFile, `export const helper = "hi";`);

    const loader = new UserDatastoreLoader(new StubDenoRuntime());
    const result = await loader.loadDatastores(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader - skips test files", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "datastore_loader_test_",
  });
  try {
    const testFile = join(tmpDir, "my_store_test.ts");
    await Deno.writeTextFile(testFile, `export const datastore = {};`);

    const loader = new UserDatastoreLoader(new StubDenoRuntime());
    const result = await loader.loadDatastores(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader - reports validation failure for invalid export", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "datastore_loader_test_",
  });
  try {
    const datastoreFile = join(tmpDir, "bad_store.ts");
    await Deno.writeTextFile(
      datastoreFile,
      `
export const datastore = {
  type: "invalid type!",
  name: "Bad Store",
};
`,
    );

    const loader = new UserDatastoreLoader(new StubDenoRuntime());
    const result = await loader.loadDatastores(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].file, "bad_store.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DatastoreTypeRegistry standalone - rejects duplicate registration", () => {
  const registry = new DatastoreTypeRegistry();
  registry.register({
    type: "test-dup",
    name: "Test",
    description: "test",
    isBuiltIn: true,
  });

  let threw = false;
  try {
    registry.register({
      type: "test-dup",
      name: "Test2",
      description: "test2",
      isBuiltIn: true,
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("UserDatastoreLoader - loads valid non-@ datastore type", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "datastore_loader_test_",
  });
  try {
    const datastoreFile = join(tmpDir, "custom_store.ts");
    await Deno.writeTextFile(
      datastoreFile,
      `
export const datastore = {
  type: "myorg/gcs-store",
  name: "GCS Store",
  description: "A test datastore without @ prefix",
  createProvider: (_config: Record<string, unknown>) => ({
    createLock: (_p: string) => ({
      acquire: async () => {},
      release: async () => {},
      withLock: async (fn: () => Promise<unknown>) => fn(),
      inspect: async () => null,
      forceRelease: async (_n: string) => false,
    }),
    createVerifier: () => ({
      verify: async () => ({
        healthy: true,
        message: "ok",
        latencyMs: 1,
        datastoreType: "myorg/gcs-store",
      }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  }),
};
`,
    );

    const loader = new UserDatastoreLoader(new StubDenoRuntime());
    const result = await loader.loadDatastores(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "custom_store.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader - invalidates bundle cache when dependency changes", async () => {
  const ts = Date.now();
  const helperCode = `export const storeName = "original";`;
  const datastoreCode = `
import { storeName } from "./helper.ts";

export const datastore = {
  type: "@test/cache-dep-store-${ts}",
  name: storeName,
  description: "Cache test datastore",
  createProvider: (_config: Record<string, unknown>) => ({
    createLock: (_p: string) => ({
      acquire: async () => {},
      release: async () => {},
      withLock: async (fn: () => Promise<unknown>) => fn(),
      inspect: async () => null,
      forceRelease: async (_n: string) => false,
    }),
    createVerifier: () => ({
      verify: async () => ({
        healthy: true,
        message: "ok",
        latencyMs: 1,
        datastoreType: "@test/cache-dep-store",
      }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  }),
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "datastore_cache_test_repo_",
  });
  const datastoresDir = await Deno.makeTempDir({
    prefix: "datastore_cache_test_stores_",
  });
  try {
    // Write initial files
    await Deno.writeTextFile(join(datastoresDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(
      join(datastoresDir, "my_store.ts"),
      datastoreCode,
    );

    // First load — populates cache
    const loader1 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader1.loadDatastores(datastoresDir);

    // Read the cached bundle content (namespaced by baseDir hash)
    const { bundleNamespace } = await import(
      "../../infrastructure/persistence/paths.ts"
    );
    const ns = bundleNamespace(datastoresDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "datastore-bundles",
      ns,
      "my_store.js",
    );
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    // Wait so mtime differs
    await new Promise((r) => setTimeout(r, 1100));

    // Modify only the dependency (not the entry point)
    await Deno.writeTextFile(
      join(datastoresDir, "helper.ts"),
      `export const storeName = "updated";`,
    );

    // Second load — should detect dependency change and rebundle
    const loader2 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader2.loadDatastores(datastoresDir);

    // The bundle should have been regenerated with the new dependency content
    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertEquals(cachedBundle1 !== cachedBundle2, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(datastoresDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader buildIndex rebundles when source content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const datastoreType = `@user/preserved-mtime-datastore-${ts}`;
  const v1 = `
export const datastore = {
  type: "${datastoreType}",
  name: "V1_MARKER",
  description: "V1_MARKER",
  createProvider: (_config) => ({
    async read() { return "V1_MARKER"; },
    async write() {},
    async delete() {},
    async list() { return []; },
    async exists() { return false; },
  }),
};
`;
  const v2 = `
export const datastore = {
  type: "${datastoreType}",
  name: "V2_MARKER",
  description: "V2_MARKER",
  createProvider: (_config) => ({
    async read() { return "V2_MARKER"; },
    async write() {},
    async delete() {},
    async list() { return []; },
    async exists() { return false; },
  }),
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_ds_repo_",
  });
  const datastoresDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_ds_src_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const sourcePath = join(datastoresDir, "store.ts");
    await Deno.writeTextFile(sourcePath, v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader1.buildIndex(datastoresDir, catalog1);
    catalog1.close();

    const ns = bundleNamespace(datastoresDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "datastore-bundles",
      ns,
      "store.js",
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
    const loader2 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader2.buildIndex(datastoresDir, catalog2);
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
    await Deno.remove(datastoresDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader buildIndex rebundles when transitive dep content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const datastoreType = `@user/preserved-mtime-datastore-dep-${ts}`;
  const entry = `
import { marker } from "./_lib/marker.ts";
export const datastore = {
  type: "${datastoreType}",
  name: "dep-transitive",
  description: "dep-transitive",
  createProvider: (_config) => ({
    async read() { return marker(); },
    async write() {},
    async delete() {},
    async list() { return []; },
    async exists() { return false; },
  }),
};
`;
  const libV1 = `export const marker = () => "V1_DEP_MARKER";\n`;
  const libV2 = `export const marker = () => "V2_DEP_MARKER";\n`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_ds_dep_repo_",
  });
  const datastoresDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_ds_dep_src_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.mkdir(join(datastoresDir, "_lib"), { recursive: true });
    const entryPath = join(datastoresDir, "store.ts");
    const libPath = join(datastoresDir, "_lib", "marker.ts");
    await Deno.writeTextFile(entryPath, entry);
    await Deno.writeTextFile(libPath, libV1);

    const catalog1 = new ExtensionCatalogStore(dbPath);
    const loader1 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader1.buildIndex(datastoresDir, catalog1);
    catalog1.close();

    const ns = bundleNamespace(datastoresDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "datastore-bundles",
      ns,
      "store.js",
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
    const loader2 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader2.buildIndex(datastoresDir, catalog2);
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
    await Deno.remove(datastoresDir, { recursive: true });
  }
});

Deno.test("UserDatastoreLoader: registerLazyFromCatalog skips validation_failed rows (swamp-club#209)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_ds_repo_",
  });
  const datastoresDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_ds_dir_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const ts = Date.now();
    const validDatastore = `
import { z } from "npm:zod";

export const datastore = {
  type: "@test/issue209-ds-${ts}",
  name: "Test Datastore",
  description: "Healthy datastore",
  configSchema: z.object({}),
  createProvider: (_name, _cfg) => ({
    async write() {},
    async read() { return null; },
    async list() { return []; },
    async delete() {},
  }),
};
`;
    await Deno.writeTextFile(join(datastoresDir, "valid.ts"), validDatastore);

    const catalog = new ExtensionCatalogStore(dbPath);
    const loader = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader.buildIndex(datastoresDir, catalog);

    catalog.upsert({
      source_path: join(datastoresDir, "broken.ts"),
      type_normalized: "",
      kind: "datastore",
      bundle_path: join(repoDir, ".swamp", "datastore-bundles", "broken.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "2026-05-01T12:00:00.000Z",
      source_fingerprint: "deadbeef-broken",
      validation_failed: true,
    });

    const loader2 = new UserDatastoreLoader(new StubDenoRuntime(), repoDir);
    await loader2.buildIndex(datastoresDir, catalog);

    assertEquals(
      datastoreTypeRegistry.has(`@test/issue209-ds-${ts}`),
      true,
    );
    assertEquals(datastoreTypeRegistry.has(""), false);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(datastoresDir, { recursive: true });
  }
});
