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
import { assertStringIncludes } from "@std/assert/string-includes";
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

Deno.test("UserVaultLoader - rejects vault with reserved namespace", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vault_loader_test_" });
  try {
    const vaultFile = join(tmpDir, "bad_vault.ts");
    await Deno.writeTextFile(
      vaultFile,
      `
export const vault = {
  type: "@swamp/my-vault",
  name: "Bad Vault",
  description: "Uses reserved namespace",
  createProvider: (name: string, _config: Record<string, unknown>) => ({
    get: async (_key: string) => "",
    put: async (_key: string, _value: string) => {},
    list: async () => [],
    getName: () => name,
  }),
};
`,
    );

    const loader = new UserVaultLoader(new StubDenoRuntime());
    const result = await loader.loadVaults(tmpDir);

    assertEquals(result.loaded.length, 0);
    assertEquals(result.failed.length, 1);
    assertStringIncludes(result.failed[0].error, "reserved namespace");
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
