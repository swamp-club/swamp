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

// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import type { VaultProvider } from "./vault_types.ts";

/**
 * The vault export shape that extension authors must produce.
 * Matches the `export const vault = { ... }` pattern.
 */
export interface VaultExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider;
}

/** Options for vault export conformance. */
export interface VaultExportConformanceOptions {
  /** Configs that should pass schema validation. At least one required. */
  validConfigs: Record<string, unknown>[];
  /** Configs that should fail schema validation. */
  invalidConfigs?: Record<string, unknown>[];
}

/**
 * Asserts that a vault export has the correct structural shape.
 *
 * Tests: type matches naming pattern, name/description are non-empty,
 * configSchema accepts valid configs and rejects invalid ones,
 * createProvider returns an object with get/put/list/getName.
 *
 * ```typescript
 * import { assertVaultExportConformance } from "@systeminit/swamp-testing";
 * import { vault } from "./my_vault.ts";
 *
 * Deno.test("vault export conforms", () => {
 *   assertVaultExportConformance(vault, {
 *     validConfigs: [{ region: "us-east-1" }],
 *     invalidConfigs: [{}, { region: "" }],
 *   });
 * });
 * ```
 */
export function assertVaultExportConformance(
  vaultExport: VaultExport,
  options: VaultExportConformanceOptions,
): void {
  // Type must match pattern: @collective/name or collective/name
  assertExists(vaultExport.type, "vault.type must exist");
  assertEquals(
    /^@?[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(vaultExport.type),
    true,
    `vault.type "${vaultExport.type}" must match pattern @collective/name or collective/name`,
  );

  // Name and description
  assertExists(vaultExport.name, "vault.name must exist");
  assertEquals(
    vaultExport.name.length > 0,
    true,
    "vault.name must be non-empty",
  );
  assertExists(vaultExport.description, "vault.description must exist");
  assertEquals(
    vaultExport.description.length > 0,
    true,
    "vault.description must be non-empty",
  );

  // configSchema
  assertExists(vaultExport.configSchema, "vault.configSchema must exist");
  assertEquals(
    typeof vaultExport.configSchema.safeParse,
    "function",
    "vault.configSchema must have a safeParse method",
  );

  // Valid configs should pass
  assertEquals(
    options.validConfigs.length > 0,
    true,
    "At least one valid config must be provided",
  );
  for (const config of options.validConfigs) {
    const result = vaultExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      true,
      `configSchema should accept ${JSON.stringify(config)}`,
    );
  }

  // Invalid configs should fail
  for (const config of options.invalidConfigs ?? []) {
    const result = vaultExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      false,
      `configSchema should reject ${JSON.stringify(config)}`,
    );
  }

  // createProvider
  assertEquals(
    typeof vaultExport.createProvider,
    "function",
    "vault.createProvider must be a function",
  );

  // Create a provider with the first valid config and check methods
  const provider = vaultExport.createProvider(
    "conformance-test",
    options.validConfigs[0],
  );
  assertExists(provider, "createProvider must return a provider");
  assertEquals(typeof provider.get, "function", "provider must have get()");
  assertEquals(typeof provider.put, "function", "provider must have put()");
  assertEquals(typeof provider.list, "function", "provider must have list()");
  assertEquals(
    typeof provider.getName,
    "function",
    "provider must have getName()",
  );
}

/** Options for vault behavioral conformance. */
export interface VaultConformanceOptions {
  /** Prefix for test keys to avoid collisions (default: "swamp-conformance-test-"). */
  keyPrefix?: string;
  /** Delete test keys after the test (default: true). */
  cleanup?: boolean;
}

/**
 * Asserts that a VaultProvider implementation satisfies the behavioral contract.
 *
 * Tests: put/get roundtrip, get-missing rejects, put overwrites existing key,
 * list includes stored keys, getName returns non-empty string.
 *
 * **Warning**: This hits real infrastructure. Test keys are prefixed and
 * cleaned up by default.
 *
 * ```typescript
 * import { assertVaultConformance } from "@systeminit/swamp-testing";
 *
 * Deno.test("aws-sm vault contract", async () => {
 *   const provider = vault.createProvider("test", { region: "us-east-1" });
 *   await assertVaultConformance(provider);
 * });
 * ```
 */
export async function assertVaultConformance(
  provider: VaultProvider,
  options?: VaultConformanceOptions,
): Promise<void> {
  const prefix = options?.keyPrefix ?? "swamp-conformance-test-";
  const cleanup = options?.cleanup ?? true;

  const testKey1 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const testKey2 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const createdKeys: string[] = [];

  try {
    // getName returns a non-empty string
    const name = provider.getName();
    assertEquals(typeof name, "string", "getName() must return a string");
    assertEquals(
      name.length > 0,
      true,
      "getName() must return a non-empty string",
    );

    // put/get roundtrip
    await provider.put(testKey1, "conformance-value-1");
    createdKeys.push(testKey1);
    const value1 = await provider.get(testKey1);
    assertEquals(
      value1,
      "conformance-value-1",
      "get() must return the value that was put()",
    );

    // put overwrites
    await provider.put(testKey1, "conformance-value-updated");
    const valueUpdated = await provider.get(testKey1);
    assertEquals(
      valueUpdated,
      "conformance-value-updated",
      "put() must overwrite an existing key",
    );

    // second key
    await provider.put(testKey2, "conformance-value-2");
    createdKeys.push(testKey2);

    // list includes stored keys
    const keys = await provider.list();
    assertEquals(Array.isArray(keys), true, "list() must return an array");
    assertStringIncludes(
      keys.join(","),
      testKey1,
      `list() must include "${testKey1}"`,
    );
    assertStringIncludes(
      keys.join(","),
      testKey2,
      `list() must include "${testKey2}"`,
    );

    // get-missing rejects
    const missingKey = `${prefix}nonexistent-${
      crypto.randomUUID().slice(0, 8)
    }`;
    let getMissingThrew = false;
    try {
      await provider.get(missingKey);
    } catch {
      getMissingThrew = true;
    }
    assertEquals(
      getMissingThrew,
      true,
      "get() must reject for a key that was never put()",
    );
  } finally {
    if (cleanup) {
      // Best-effort cleanup — don't fail the test if cleanup fails.
      // Not all vault providers have a delete method, so we use put
      // with an empty value as a soft cleanup signal. The keys are
      // namespaced with the prefix, so leftover keys are identifiable.
      for (const key of createdKeys) {
        try {
          await provider.put(key, "");
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
