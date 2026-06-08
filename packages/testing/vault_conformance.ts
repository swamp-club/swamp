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

// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import {
  VaultAnnotation,
  type VaultAnnotationProvider,
  type VaultProvider,
} from "./vault_types.ts";

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
 * import { assertVaultExportConformance } from "@swamp-club/swamp-testing";
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
 * import { assertVaultConformance } from "@swamp-club/swamp-testing";
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

    // re-read first key to confirm second write didn't clobber it
    const value1AfterKey2 = await provider.get(testKey1);
    assertEquals(
      value1AfterKey2,
      "conformance-value-updated",
      "get(key1) must still return key1's value after writing key2",
    );

    // list includes stored keys
    const keys = await provider.list();
    assertEquals(Array.isArray(keys), true, "list() must return an array");
    assertEquals(
      keys.includes(testKey1),
      true,
      `list() must include "${testKey1}"`,
    );
    assertEquals(
      keys.includes(testKey2),
      true,
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

/**
 * The vault export shape for vaults that support annotations.
 * Extends the base VaultExport with annotation provider methods.
 */
export interface VaultAnnotationExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider & VaultAnnotationProvider;
}

/** Options for vault annotation export conformance. */
export interface VaultAnnotationExportConformanceOptions {
  /** Configs that should pass schema validation. At least one required. */
  validConfigs: Record<string, unknown>[];
}

/**
 * Asserts that a vault export's createProvider returns an object that
 * implements VaultAnnotationProvider methods.
 *
 * Call this **after** `assertVaultExportConformance` to additionally verify
 * annotation support. This is a separate call because annotation support
 * is opt-in — not all vault providers implement it.
 *
 * ```typescript
 * import {
 *   assertVaultExportConformance,
 *   assertVaultAnnotationExportConformance,
 * } from "@swamp-club/swamp-testing";
 * import { vault } from "./my_vault.ts";
 *
 * Deno.test("vault export conforms with annotations", () => {
 *   assertVaultExportConformance(vault, {
 *     validConfigs: [{ region: "us-east-1" }],
 *   });
 *   assertVaultAnnotationExportConformance(vault, {
 *     validConfigs: [{ region: "us-east-1" }],
 *   });
 * });
 * ```
 */
export function assertVaultAnnotationExportConformance(
  vaultExport: VaultAnnotationExport,
  options: VaultAnnotationExportConformanceOptions,
): void {
  assertEquals(
    options.validConfigs.length > 0,
    true,
    "At least one valid config must be provided",
  );

  const provider = vaultExport.createProvider(
    "annotation-conformance-test",
    options.validConfigs[0],
  );
  assertExists(provider, "createProvider must return a provider");
  assertEquals(
    typeof provider.getAnnotation,
    "function",
    "provider must have getAnnotation()",
  );
  assertEquals(
    typeof provider.putAnnotation,
    "function",
    "provider must have putAnnotation()",
  );
  assertEquals(
    typeof provider.deleteAnnotation,
    "function",
    "provider must have deleteAnnotation()",
  );
  assertEquals(
    typeof provider.listAnnotations,
    "function",
    "provider must have listAnnotations()",
  );
}

/** Options for vault annotation behavioral conformance. */
export interface VaultAnnotationConformanceOptions {
  /** Prefix for test keys to avoid collisions (default: "swamp-conformance-test-"). */
  keyPrefix?: string;
  /** Delete test annotations after the test (default: true). */
  cleanup?: boolean;
}

/**
 * Asserts that a VaultAnnotationProvider implementation satisfies the
 * behavioral contract.
 *
 * Tests: putAnnotation/getAnnotation roundtrip, getAnnotation returns null
 * for unannotated key, deleteAnnotation clears annotations, listAnnotations
 * includes annotated keys, VaultAnnotation.merge() preserves existing fields,
 * toData()/fromData() roundtrip, isEmpty() for empty annotations.
 *
 * **Warning**: This hits real infrastructure. Test keys are prefixed and
 * cleaned up by default.
 *
 * ```typescript
 * import { assertVaultAnnotationConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("vault annotation contract", async () => {
 *   const provider = vault.createProvider("test", { region: "us-east-1" });
 *   await assertVaultAnnotationConformance(provider);
 * });
 * ```
 */
export async function assertVaultAnnotationConformance(
  provider: VaultAnnotationProvider,
  options?: VaultAnnotationConformanceOptions,
): Promise<void> {
  const prefix = options?.keyPrefix ?? "swamp-conformance-test-";
  const cleanup = options?.cleanup ?? true;

  const testKey1 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const testKey2 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const annotatedKeys: string[] = [];

  try {
    // getAnnotation returns null for unannotated key
    const missing = await provider.getAnnotation(testKey1);
    assertEquals(
      missing,
      null,
      "getAnnotation() must return null for a key with no annotation",
    );

    // putAnnotation/getAnnotation roundtrip
    const annotation1 = VaultAnnotation.create({
      url: "https://example.com/secret-1",
      notes: "conformance test annotation",
      labels: { env: "test", team: "platform" },
    });
    await provider.putAnnotation(testKey1, annotation1);
    annotatedKeys.push(testKey1);

    const retrieved = await provider.getAnnotation(testKey1);
    assertExists(
      retrieved,
      "getAnnotation() must return the annotation that was put",
    );
    assertEquals(
      retrieved.url,
      "https://example.com/secret-1",
      "getAnnotation().url must match what was put",
    );
    assertEquals(
      retrieved.notes,
      "conformance test annotation",
      "getAnnotation().notes must match what was put",
    );
    assertEquals(
      retrieved.labels["env"],
      "test",
      "getAnnotation().labels must match what was put",
    );
    assertEquals(
      retrieved.labels["team"],
      "platform",
      "getAnnotation().labels must match what was put",
    );

    // toData()/fromData() roundtrip
    const data = retrieved.toData();
    assertExists(data.updatedAt, "toData().updatedAt must exist");
    const restored = VaultAnnotation.fromData(data);
    assertEquals(
      restored.url,
      retrieved.url,
      "fromData(toData()) must preserve url",
    );
    assertEquals(
      restored.notes,
      retrieved.notes,
      "fromData(toData()) must preserve notes",
    );

    // merge() preserves existing fields and adds new ones
    const merged = retrieved.merge({
      labels: { version: "2" },
    });
    assertEquals(
      merged.url,
      retrieved.url,
      "merge() must preserve unmodified fields",
    );
    assertEquals(
      merged.labels["env"],
      "test",
      "merge() must preserve existing labels",
    );
    assertEquals(
      merged.labels["version"],
      "2",
      "merge() must add new labels",
    );

    // isEmpty() returns true for empty annotations
    const empty = VaultAnnotation.create({});
    assertEquals(
      empty.isEmpty(),
      true,
      "isEmpty() must return true for annotation with no fields",
    );
    assertEquals(
      annotation1.isEmpty(),
      false,
      "isEmpty() must return false for annotation with fields",
    );

    // Second annotation on a different key
    const annotation2 = VaultAnnotation.create({
      notes: "second annotation",
    });
    await provider.putAnnotation(testKey2, annotation2);
    annotatedKeys.push(testKey2);

    // listAnnotations includes annotated keys
    const annotations = await provider.listAnnotations();
    assertEquals(
      annotations instanceof Map,
      true,
      "listAnnotations() must return a Map",
    );
    assertEquals(
      annotations.has(testKey1),
      true,
      `listAnnotations() must include "${testKey1}"`,
    );
    assertEquals(
      annotations.has(testKey2),
      true,
      `listAnnotations() must include "${testKey2}"`,
    );

    // deleteAnnotation clears the annotation
    await provider.deleteAnnotation(testKey1);
    const afterDelete = await provider.getAnnotation(testKey1);
    assertEquals(
      afterDelete,
      null,
      "getAnnotation() must return null after deleteAnnotation()",
    );

    // listAnnotations no longer includes deleted key
    const annotationsAfterDelete = await provider.listAnnotations();
    assertEquals(
      annotationsAfterDelete.has(testKey1),
      false,
      "listAnnotations() must not include deleted key",
    );
    assertEquals(
      annotationsAfterDelete.has(testKey2),
      true,
      "listAnnotations() must still include non-deleted key",
    );

    // Remove testKey1 from cleanup list since it's already deleted
    const idx = annotatedKeys.indexOf(testKey1);
    if (idx !== -1) annotatedKeys.splice(idx, 1);
  } finally {
    if (cleanup) {
      for (const key of annotatedKeys) {
        try {
          await provider.deleteAnnotation(key);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
