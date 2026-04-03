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
import { UserDatastoreLoader } from "./user_datastore_loader.ts";
import { DatastoreTypeRegistry } from "./datastore_type_registry.ts";
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
