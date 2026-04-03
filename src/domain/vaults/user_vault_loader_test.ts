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
import { UserVaultLoader } from "./user_vault_loader.ts";
import { VaultTypeRegistry } from "./vault_type_registry.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

/** Stub runtime that returns "deno" as the binary path. */
class StubDenoRuntime implements DenoRuntime {
  ensureDeno(): Promise<string> {
    return Promise.resolve("deno");
  }
}

Deno.test("UserVaultLoader - returns empty result for nonexistent directory", async () => {
  const loader = new UserVaultLoader(new StubDenoRuntime());
  const result = await loader.loadVaults("/nonexistent/path");
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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

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
    const loader1 = new UserVaultLoader(new StubDenoRuntime(), repoDir);
    await loader1.loadVaults(vaultsDir);

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
    const loader2 = new UserVaultLoader(new StubDenoRuntime(), repoDir);
    await loader2.loadVaults(vaultsDir);

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

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

    assertEquals(result.loaded.length, 1);
    assertEquals(result.loaded[0], "si_vault.ts");
    assertEquals(result.failed.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
