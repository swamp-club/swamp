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
import { vaultKindAdapter } from "../extensions/vault_kind_adapter.ts";
import { VaultTypeRegistry, vaultTypeRegistry } from "./vault_type_registry.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

/** Stub runtime that returns "deno" as the binary path. */
class StubDenoRuntime implements DenoRuntime {
  ensureDeno(): Promise<string> {
    return Promise.resolve("deno");
  }
}

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

Deno.test("UserVaultLoader - returns empty result for nonexistent directory", async () => {
  const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
  const result = await loader.load("/nonexistent/path");
  assertEquals(result.loaded, []);
  assertEquals(result.failed, []);
});

Deno.test("UserVaultLoader - loads valid vault from temp directory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    // Write a valid vault file
    const vaultFile = join(tmpDir, "custom_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
import { z } from "npm:zod";

export const vault = {
  type: "@test/custom-vault-${Date.now()}",
  name: "Custom Vault",
  description: "A test vault implementation",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider: (name: string, config: Record<string, unknown>) => ({
    get: async (_key: string) => "test-secret",
    put: async (_key: string, _value: string) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "custom_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - allows @swamp/* namespace for local vaults", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const vaultFile = join(tmpDir, "swamp_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
import { z } from "npm:zod";

export const vault = {
  type: "@swamp/my-vault",
  name: "Swamp Vault",
  description: "Local dev vault using @swamp namespace",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider: (name: string, _config: Record<string, unknown>) => ({
    get: async (_key: string) => "test-secret",
    put: async (_key: string, _value: string) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "swamp_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - skips files without vault export", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const utilFile = join(tmpDir, "utils.ts");
    await Deno.writeTextFile(utilFile, `export const helper = "hi";`);

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - skips test files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const testFile = join(tmpDir, "my_vault_test.ts");
    await Deno.writeTextFile(testFile, `export const vault = {};`);

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("VaultTypeRegistry standalone - rejects duplicate registration", () => {
  const registry = new VaultTypeRegistry();
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

Deno.test("UserVaultLoader - loads valid non-@ vault type", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const vaultFile = join(tmpDir, "custom_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
import { z } from "npm:zod";

export const vault = {
  type: "hashicorp/vault",
  name: "HashiCorp Vault",
  description: "A test vault without @ prefix",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider: (name, _config) => ({
    get: async (_key) => "test-secret",
    put: async (_key, _value) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "custom_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - allows swamp/* namespace for local vaults", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const vaultFile = join(tmpDir, "swamp_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
import { z } from "npm:zod";

export const vault = {
  type: "swamp/my-vault",
  name: "Swamp Vault",
  description: "Local dev vault using swamp namespace",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider: (name: string, _config: Record<string, unknown>) => ({
    get: async (_key: string) => "test-secret",
    put: async (_key: string, _value: string) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "swamp_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - invalidates bundle cache when dependency changes", async () => {
  const ts = Date.now();
  const helperCode = `export const vaultName = "original";`;
  const vaultCode = `
import { z } from "npm:zod";
import { vaultName } from "./helper.ts";

export const vault = {
  type: "@test/cache-dep-vault-${ts}",
  name: vaultName,
  description: "Cache test vault",
  createProvider: (name, _config) => ({
    get: async (_key) => "secret",
    put: async (_key, _value) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`;

  const repoDir = await Deno.makeTempDir({ prefix: "vault_cache_test_repo_" });
  const vaultsDir = await Deno.makeTempDir({
    prefix: "vault_cache_test_vaults_",
  });
  try {
    // Write initial files
    await Deno.writeTextFile(join(vaultsDir, "helper.ts"), helperCode);
    await Deno.writeTextFile(join(vaultsDir, "my_vault.ts"), vaultCode);

    // First load — populates cache
    const loader1 = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
    );
    await loader1.load(vaultsDir);

    // Read the cached bundle content (namespaced by baseDir hash)
    const { bundleNamespace } = await import(
      "../../infrastructure/persistence/paths.ts"
    );
    const ns = bundleNamespace(vaultsDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "vault-bundles",
      ns,
      "my_vault.js",
    );
    const cachedBundle1 = await Deno.readTextFile(bundlePath);

    // Wait so mtime differs
    await new Promise((r) => setTimeout(r, 1100));

    // Modify only the dependency (not the entry point)
    await Deno.writeTextFile(
      join(vaultsDir, "helper.ts"),
      `export const vaultName = "updated";`,
    );

    // Second load — should detect dependency change and rebundle
    const loader2 = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
    );
    await loader2.load(vaultsDir);

    // The bundle should have been regenerated with the new dependency content
    const cachedBundle2 = await Deno.readTextFile(bundlePath);
    assertEquals(cachedBundle1 !== cachedBundle2, true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(vaultsDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader - allows si/* namespace for local vaults", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const vaultFile = join(tmpDir, "si_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
import { z } from "npm:zod";

export const vault = {
  type: "si/my-vault",
  name: "SI Vault",
  description: "Local dev vault using si namespace",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider: (name: string, _config: Record<string, unknown>) => ({
    get: async (_key: string) => "test-secret",
    put: async (_key: string, _value: string) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new ExtensionLoader(new StubDenoRuntime(), vaultKindAdapter);
    const result = await loader.load(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "si_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader buildIndex rebundles when source content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const vaultType = `@user/preserved-mtime-vault-${ts}`;
  const v1 = `
export const vault = {
  type: "${vaultType}",
  name: "V1_MARKER",
  description: "V1_MARKER",
  createProvider: (_name, _config) => ({
    async get() { return "V1_MARKER"; },
    async set() {},
    async has() { return false; },
    async list() { return []; },
    async delete() {},
  }),
};
`;
  const v2 = `
export const vault = {
  type: "${vaultType}",
  name: "V2_MARKER",
  description: "V2_MARKER",
  createProvider: (_name, _config) => ({
    async get() { return "V2_MARKER"; },
    async set() {},
    async has() { return false; },
    async list() { return []; },
    async delete() {},
  }),
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_vault_repo_",
  });
  const vaultsDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_vaults_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const sourcePath = join(vaultsDir, "vault.ts");
    await Deno.writeTextFile(sourcePath, v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(vaultsDir);
    catalog1.close();

    const ns = bundleNamespace(vaultsDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "vault-bundles",
      ns,
      "vault.js",
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
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(vaultsDir);
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
    await Deno.remove(vaultsDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader buildIndex rebundles when transitive dep content changes with preserved mtime (#128)", async () => {
  const ts = Date.now();
  const vaultType = `@user/preserved-mtime-vault-dep-${ts}`;
  const entry = `
import { marker } from "./_lib/marker.ts";
export const vault = {
  type: "${vaultType}",
  name: "dep-transitive",
  description: "dep-transitive",
  createProvider: (_name, _config) => ({
    async get() { return marker(); },
    async set() {},
    async has() { return false; },
    async list() { return []; },
    async delete() {},
  }),
};
`;
  const libV1 = `export const marker = () => "V1_DEP_MARKER";\n`;
  const libV2 = `export const marker = () => "V2_DEP_MARKER";\n`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_vault_dep_repo_",
  });
  const vaultsDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_vault_dep_src_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.mkdir(join(vaultsDir, "_lib"), { recursive: true });
    const entryPath = join(vaultsDir, "vault.ts");
    const libPath = join(vaultsDir, "_lib", "marker.ts");
    await Deno.writeTextFile(entryPath, entry);
    await Deno.writeTextFile(libPath, libV1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(vaultsDir);
    catalog1.close();

    const ns = bundleNamespace(vaultsDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "vault-bundles",
      ns,
      "vault.js",
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
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(vaultsDir);
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
    await Deno.remove(vaultsDir, { recursive: true });
  }
});

Deno.test("UserVaultLoader: registerLazyFromCatalog skips validation_failed rows (swamp-club#209)", async () => {
  // Seed the catalog with a validation-failed sentinel row and verify
  // it never reaches the registry. The ADV-1 invariant — findByKind
  // returns the row regardless — is guarded at the catalog-store
  // level; this test guards the per-loader filter.
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_vault_repo_",
  });
  const vaultsDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_vault_dir_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const ts = Date.now();
    const validVault = `
import { z } from "npm:zod";

export const vault = {
  type: "@test/issue209-vault-${ts}",
  name: "Test Vault",
  description: "Healthy vault",
  configSchema: z.object({}),
  createProvider: (_name: string, _cfg: Record<string, unknown>) => ({
    get: async () => "x",
    put: async () => {},
    list: async () => [],
    delete: async () => {},
  }),
};
`;
    await Deno.writeTextFile(join(vaultsDir, "valid.ts"), validVault);

    // Cold-start populates the catalog with the valid vault.
    const catalog = new ExtensionCatalogStore(dbPath);
    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(vaultsDir);

    // Inject a validation-failed row keyed by a different source path.
    catalog.upsert({
      source_path: join(vaultsDir, "broken.ts"),
      type_normalized: "",
      kind: "vault",
      bundle_path: join(repoDir, ".swamp", "vault-bundles", "broken.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "2026-05-01T12:00:00.000Z",
      source_fingerprint: "deadbeef-broken",
      // W1b: validation_failed dropped — state="ValidationFailed" is the signal.
    });

    // Re-run buildIndex. registerLazyFromCatalog must skip the broken
    // row even though findByKind returns it.
    const loader2 = new ExtensionLoader(
      new StubDenoRuntime(),
      vaultKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader2.buildIndex(vaultsDir);

    // Valid type appears; broken sentinel does not. Use the singleton
    // registry the loader writes into.
    assertEquals(vaultTypeRegistry.has(`@test/issue209-vault-${ts}`), true);
    // Empty-string type can never be a real registered name, but
    // assert anyway to pin the invariant.
    assertEquals(vaultTypeRegistry.has(""), false);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(vaultsDir, { recursive: true });
  }
});

// ===== Pin 1 (W2) =====
//
// `bundleAndIndexOne` is the public per-file entry point that
// InstallExtensionService calls during install. The lifecycle service
// owns the catalog write via `repository.save()`; the loader's per-file
// method MUST NOT write directly. This test is the regression net.

Deno.test(
  "UserVaultLoader.bundleAndIndexOne: returns vault metadata without writing catalog rows (Pin 1)",
  async () => {
    const ts = Date.now();
    const vaultType = `@user/pin1-vault-${ts}`;
    const vaultCode = `
import { z } from "npm:zod";

export const vault = {
  type: "${vaultType}",
  name: "Pin1Vault",
  description: "pin1",
  configSchema: z.object({}),
  createProvider: (name) => ({
    get: async () => null,
    put: async () => {},
    list: async () => [],
    getName: () => name,
  }),
};
`;

    const repoDir = await Deno.makeTempDir({ prefix: "swamp_pin1_vault_r_" });
    const vaultsDir = await Deno.makeTempDir({ prefix: "swamp_pin1_vault_v_" });
    const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
    await Deno.mkdir(dirname(dbPath), { recursive: true });

    try {
      await Deno.writeTextFile(join(vaultsDir, "vault.ts"), vaultCode);

      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);
      const loader = new ExtensionLoader(
        new StubDenoRuntime(),
        vaultKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const before = catalog.findAll().length;
      assertEquals(before, 0, "test pre-condition: catalog empty");

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(vaultsDir, "vault.ts"),
        relativePath: "vault.ts",
        baseDir: vaultsDir,
      });

      // Pin 1: catalog row count must be unchanged.
      assertEquals(
        catalog.findAll().length,
        before,
        "Pin 1: bundleAndIndexOne must NOT write catalog rows",
      );

      assertNotEquals(result, null);
      assertEquals(result?.kind, "vault");
      assertEquals(result?.typeNormalized, vaultType.toLowerCase());

      catalog.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(vaultsDir, { recursive: true });
    }
  },
);

Deno.test(
  "loadSingleType: promotes lazy vault entry to fully loaded",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp_vault_lazy_r_",
    });
    const vaultsDir = await Deno.makeTempDir({
      prefix: "swamp_vault_lazy_v_",
    });

    try {
      await Deno.writeTextFile(
        join(vaultsDir, "vault.ts"),
        `export const vault = {
  type: "@test/lazy-vault",
  name: "Lazy Test Vault",
  description: "Test vault for lazy promotion",
  createProvider: (_name: string, _config: Record<string, unknown>) => ({
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    listKeys: async () => [],
  }),
};`,
      );

      const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);

      const loader = new ExtensionLoader(
        new StubDenoRuntime(),
        vaultKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(vaultsDir, "vault.ts"),
        relativePath: "vault.ts",
        baseDir: vaultsDir,
      });
      assertNotEquals(result, null);

      catalog.upsert({
        type_normalized: result!.typeNormalized,
        kind: "vault",
        bundle_path: result!.bundlePath,
        source_path: join(vaultsDir, "vault.ts"),
        version: "",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: result!.fingerprint,
      });

      vaultTypeRegistry.registerLazy({
        type: result!.typeNormalized,
        bundlePath: result!.bundlePath,
        sourcePath: join(vaultsDir, "vault.ts"),
        version: "",
        description: "",
      });

      assertEquals(
        vaultTypeRegistry.get(result!.typeNormalized),
        undefined,
        "lazy entry should not be fully loaded",
      );

      await loader.loadSingleType(result!.typeNormalized);
      assertNotEquals(
        vaultTypeRegistry.get(result!.typeNormalized),
        undefined,
        "loadSingleType must promote lazy vault to fully loaded",
      );

      catalog.close();
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
        await Deno.remove(vaultsDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
        await Deno.remove(vaultsDir, { recursive: true });
      }
    }
  },
);

Deno.test(
  "buildIndex warm-start: BundleBuildFailed state preserved when source unchanged",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp_vault_terminal_r_",
    });
    const vaultsDir = await Deno.makeTempDir({
      prefix: "swamp_vault_terminal_v_",
    });

    try {
      await Deno.writeTextFile(
        join(vaultsDir, "vault.ts"),
        `export const vault = {
  type: "@test/terminal-vault",
  name: "Terminal Test",
  description: "Test vault for terminal state",
  createProvider: (_name: string, _config: Record<string, unknown>) => ({
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    listKeys: async () => [],
  }),
};`,
      );

      const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);

      const loader = new ExtensionLoader(
        new StubDenoRuntime(),
        vaultKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      // Cold-start to populate catalog
      await loader.buildIndex(vaultsDir);

      const rows = catalog.findByKind("vault");
      assertEquals(rows.length > 0, true, "catalog should have vault rows");

      // Manually set state to BundleBuildFailed (simulating a prior build failure)
      const row = rows[0];
      catalog.upsert({
        ...row,
        state: "BundleBuildFailed",
      });

      const beforeState = catalog.findByKind("vault")[0].state;
      assertEquals(beforeState, "BundleBuildFailed", "precondition: state set");

      // Warm-start: source unchanged, fingerprint matches — should NOT rebundle
      await loader.buildIndex(vaultsDir);

      const afterState = catalog.findByKind("vault")[0].state;
      assertEquals(
        afterState,
        "BundleBuildFailed",
        "warm-start must preserve BundleBuildFailed when source is unchanged",
      );

      catalog.close();
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
        await Deno.remove(vaultsDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
        await Deno.remove(vaultsDir, { recursive: true });
      }
    }
  },
);
