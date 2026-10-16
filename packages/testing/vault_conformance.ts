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
  type VaultExistenceProvider,
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
  /**
   * When true, tests that put() forwards tags to the provider.
   * Only enable for providers that support provider-native tags.
   * Requires a getStoredTags callback to verify tag storage.
   */
  testTags?: boolean;
  /**
   * Callback to retrieve tags stored for a secret key.
   * Required when testTags is true.
   */
  getStoredTags?: (secretKey: string) => Record<string, string> | undefined;
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

    // tag pass-through (opt-in)
    if (options?.testTags) {
      assertExists(
        options.getStoredTags,
        "getStoredTags callback is required when testTags is true",
      );
      const tagKey = `${prefix}tagged-${crypto.randomUUID().slice(0, 8)}`;
      const testTags = { env: "test", team: "platform" };
      await provider.put(tagKey, "tagged-value", { tags: testTags });
      createdKeys.push(tagKey);

      const storedTags = options.getStoredTags(tagKey);
      assertExists(
        storedTags,
        "getStoredTags() must return tags for a key that was put() with tags",
      );
      assertEquals(
        storedTags["env"],
        "test",
        "stored tags must include the tags passed to put()",
      );
      assertEquals(
        storedTags["team"],
        "platform",
        "stored tags must include the tags passed to put()",
      );

      // put without tags should not create tags
      const noTagKey = `${prefix}no-tags-${crypto.randomUUID().slice(0, 8)}`;
      await provider.put(noTagKey, "untagged-value");
      createdKeys.push(noTagKey);
      const noTags = options.getStoredTags(noTagKey);
      assertEquals(
        noTags,
        undefined,
        "getStoredTags() must return undefined for a key put() without tags",
      );
    }
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

/**
 * The vault export shape for vaults that support existence checks.
 * Extends the base VaultExport with the VaultExistenceProvider method.
 */
export interface VaultExistenceExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider & VaultExistenceProvider;
}

/** Options for vault existence export conformance. */
export interface VaultExistenceExportConformanceOptions {
  /** Configs that should pass schema validation. At least one required. */
  validConfigs: Record<string, unknown>[];
}

/**
 * Asserts that a vault export's createProvider returns an object that
 * implements VaultExistenceProvider.
 *
 * Call this **after** `assertVaultExportConformance`. It is a separate call
 * because existence checks are opt-in — a provider implements `has()` only
 * where its API can answer without reading the value.
 *
 * ```typescript
 * import {
 *   assertVaultExistenceExportConformance,
 *   assertVaultExportConformance,
 * } from "@swamp-club/swamp-testing";
 * import { vault } from "./my_vault.ts";
 *
 * Deno.test("vault export conforms with existence checks", () => {
 *   assertVaultExportConformance(vault, {
 *     validConfigs: [{ region: "us-east-1" }],
 *   });
 *   assertVaultExistenceExportConformance(vault, {
 *     validConfigs: [{ region: "us-east-1" }],
 *   });
 * });
 * ```
 */
export function assertVaultExistenceExportConformance(
  vaultExport: VaultExistenceExport,
  options: VaultExistenceExportConformanceOptions,
): void {
  assertEquals(
    options.validConfigs.length > 0,
    true,
    "At least one valid config must be provided",
  );

  const provider = vaultExport.createProvider(
    "existence-conformance-test",
    options.validConfigs[0],
  );
  assertExists(provider, "createProvider must return a provider");
  assertEquals(
    typeof provider.has,
    "function",
    "provider must have has()",
  );
}

/** Options for vault existence behavioral conformance. */
export interface VaultExistenceConformanceOptions {
  /** Prefix for test keys to avoid collisions (default: "swamp-conformance-test-"). */
  keyPrefix?: string;
  /** Remove test keys after the test (default: true). */
  cleanup?: boolean;
  /**
   * Returns how many secret values the provider has read so far. When
   * supplied, the suite reads it immediately before and after every has()
   * call and asserts it did not change, which proves a has() answer never
   * reads a value. Wire it to the provider's own counter; for
   * createVaultTestContext({ withExistence: true }) that is
   * getOperationsByMethod("get").length.
   */
  getValueReadCount?: () => number;
  /**
   * A key the provider's credentials may not read. When supplied, the suite
   * asserts has() and get() both reject for it with the same error name and
   * message. The key is never written.
   */
  unauthorizedKey?: string;
}

/**
 * Asserts that a VaultExistenceProvider implementation satisfies the
 * behavioral contract: has() is true exactly when get() succeeds, false for
 * a missing key, rejects an unauthorized key with the same error get()
 * raises, and never reads a value.
 *
 * Tests: has(missing) is false and get(missing) rejects; after put(), has()
 * is true and get() resolves; writing a second key leaves the first answer
 * unchanged; after delete() (when the provider has one), has() is false and
 * get() rejects; every answer is a boolean. With `getValueReadCount`, no
 * has() call changes the count. With `unauthorizedKey`, has() and get()
 * reject alike.
 *
 * **Warning**: This hits real infrastructure. Test keys are prefixed and
 * cleaned up by default.
 *
 * ```typescript
 * import { assertVaultExistenceConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("vault existence contract", async () => {
 *   const provider = vault.createProvider("test", { region: "us-east-1" });
 *   await assertVaultExistenceConformance(provider);
 * });
 * ```
 */
export async function assertVaultExistenceConformance(
  provider: VaultProvider & VaultExistenceProvider,
  options?: VaultExistenceConformanceOptions,
): Promise<void> {
  const prefix = options?.keyPrefix ?? "swamp-conformance-test-";
  const cleanup = options?.cleanup ?? true;
  const readCount = options?.getValueReadCount;
  const createdKeys: string[] = [];

  const deleteFn = (provider as Partial<{ delete: unknown }>).delete;
  const canDelete = typeof deleteFn === "function";
  const remove = (key: string) =>
    (provider as unknown as { delete(k: string): Promise<void> }).delete(key);

  // has() bracketed by the read count, so the suite's own get() calls
  // between has() calls never hide or fake a read inside has().
  async function has(key: string): Promise<boolean> {
    const before = readCount?.();
    const answer = await provider.has(key);
    if (readCount) {
      assertEquals(
        readCount(),
        before,
        `has("${key}") must not read a value`,
      );
    }
    assertEquals(
      typeof answer,
      "boolean",
      `has("${key}") must resolve a boolean`,
    );
    return answer;
  }

  async function getSucceeds(key: string): Promise<boolean> {
    try {
      await provider.get(key);
      return true;
    } catch {
      return false;
    }
  }

  async function rejection(fn: () => Promise<unknown>): Promise<Error | null> {
    try {
      await fn();
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    // missing key: has() false, get() rejects
    const missingKey = `${prefix}nonexistent-${
      crypto.randomUUID().slice(0, 8)
    }`;
    assertEquals(
      await has(missingKey),
      false,
      "has() must resolve false for a key that was never put()",
    );
    assertEquals(
      await getSucceeds(missingKey),
      false,
      "get() must reject for a key has() answers false",
    );

    // present key: has() true, get() resolves
    const testKey1 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
    await provider.put(testKey1, "existence-value-1");
    createdKeys.push(testKey1);
    assertEquals(
      await has(testKey1),
      true,
      "has() must resolve true for a key that was put()",
    );
    assertEquals(
      await getSucceeds(testKey1),
      true,
      "get() must succeed for a key has() answers true",
    );

    // a second key leaves the first answer unchanged
    const testKey2 = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
    await provider.put(testKey2, "existence-value-2");
    createdKeys.push(testKey2);
    assertEquals(
      await has(testKey2),
      true,
      "has() must resolve true for a second key that was put()",
    );
    assertEquals(
      await has(testKey1),
      true,
      "has(key1) must still be true after writing key2",
    );

    // delete, when the provider supports it
    if (canDelete) {
      await remove(testKey2);
      createdKeys.splice(createdKeys.indexOf(testKey2), 1);
      assertEquals(
        await has(testKey2),
        false,
        "has() must resolve false after delete()",
      );
      assertEquals(
        await getSucceeds(testKey2),
        false,
        "get() must reject after delete()",
      );
    }

    // unauthorized key: has() and get() reject alike
    if (options?.unauthorizedKey !== undefined) {
      const key = options.unauthorizedKey;
      const before = readCount?.();
      const hasError = await rejection(() => provider.has(key));
      if (readCount) {
        assertEquals(
          readCount(),
          before,
          `has("${key}") must not read a value for an unauthorized key`,
        );
      }
      assertExists(
        hasError,
        "has() must reject for a key the credentials cannot read",
      );
      const getError = await rejection(() => provider.get(key));
      assertExists(
        getError,
        "get() must reject for a key the credentials cannot read",
      );
      assertEquals(
        hasError.name,
        getError.name,
        "has() must reject with the same error get() raises for an unauthorized key",
      );
      assertEquals(
        hasError.message,
        getError.message,
        "has() must reject with the same error get() raises for an unauthorized key",
      );
    }
  } finally {
    if (cleanup) {
      // Best-effort cleanup — don't fail the test if cleanup fails. Delete
      // when the provider can; otherwise overwrite with an empty value, as
      // assertVaultConformance does.
      for (const key of createdKeys) {
        try {
          if (canDelete) {
            await remove(key);
          } else {
            await provider.put(key, "");
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
