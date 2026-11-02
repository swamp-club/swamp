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

export interface VaultExportConformanceOptions {
  validConfigs: Record<string, unknown>[];
  invalidConfigs?: Record<string, unknown>[];
}

export function assertVaultExportConformance(
  vaultExport: VaultExport,
  options: VaultExportConformanceOptions,
): void {
  assertExists(vaultExport.type, "vault.type must exist");
  assertEquals(
    /^@?[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(vaultExport.type),
    true,
    `vault.type "${vaultExport.type}" must match pattern @collective/name or collective/name`,
  );

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

  assertExists(vaultExport.configSchema, "vault.configSchema must exist");
  assertEquals(
    typeof vaultExport.configSchema.safeParse,
    "function",
    "vault.configSchema must have a safeParse method",
  );

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

  for (const config of options.invalidConfigs ?? []) {
    const result = vaultExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      false,
      `configSchema should reject ${JSON.stringify(config)}`,
    );
  }

  assertEquals(
    typeof vaultExport.createProvider,
    "function",
    "vault.createProvider must be a function",
  );

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

export interface VaultConformanceOptions {
  keyPrefix?: string;
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

/** hits real infrastructure; test keys are prefixed and cleaned up by default. */
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
    const name = provider.getName();
    assertEquals(typeof name, "string", "getName() must return a string");
    assertEquals(
      name.length > 0,
      true,
      "getName() must return a non-empty string",
    );

    await provider.put(testKey1, "conformance-value-1");
    createdKeys.push(testKey1);
    const value1 = await provider.get(testKey1);
    assertEquals(
      value1,
      "conformance-value-1",
      "get() must return the value that was put()",
    );

    await provider.put(testKey1, "conformance-value-updated");
    const valueUpdated = await provider.get(testKey1);
    assertEquals(
      valueUpdated,
      "conformance-value-updated",
      "put() must overwrite an existing key",
    );

    await provider.put(testKey2, "conformance-value-2");
    createdKeys.push(testKey2);

    const value1AfterKey2 = await provider.get(testKey1);
    assertEquals(
      value1AfterKey2,
      "conformance-value-updated",
      "get(key1) must still return key1's value after writing key2",
    );

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
      // best-effort cleanup: not every provider has delete, so put an empty
      // value as a soft signal; prefixed keys stay identifiable.
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

export interface VaultAnnotationExportConformanceOptions {
  validConfigs: Record<string, unknown>[];
}

/**
 * call after assertVaultExportConformance; separate because annotation support
 * is opt-in.
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

export interface VaultAnnotationConformanceOptions {
  keyPrefix?: string;
  cleanup?: boolean;
}

/** hits real infrastructure; test keys are prefixed and cleaned up by default. */
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
    const missing = await provider.getAnnotation(testKey1);
    assertEquals(
      missing,
      null,
      "getAnnotation() must return null for a key with no annotation",
    );

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

    const annotation2 = VaultAnnotation.create({
      notes: "second annotation",
    });
    await provider.putAnnotation(testKey2, annotation2);
    annotatedKeys.push(testKey2);

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

    await provider.deleteAnnotation(testKey1);
    const afterDelete = await provider.getAnnotation(testKey1);
    assertEquals(
      afterDelete,
      null,
      "getAnnotation() must return null after deleteAnnotation()",
    );

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

export interface VaultExistenceExportConformanceOptions {
  validConfigs: Record<string, unknown>[];
}

/**
 * call after assertVaultExportConformance; separate because existence checks
 * are opt-in, a provider implementing has() only where its API can answer
 * without reading the value.
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

export interface VaultExistenceConformanceOptions {
  keyPrefix?: string;
  cleanup?: boolean;
  /**
   * the suite asserts this count does not change across has(), proving has()
   * never reads a value; for createVaultTestContext({ withExistence: true })
   * use getOperationsByMethod(`get`).length
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
 * has() is true exactly when get() succeeds, false for a missing key, rejects
 * an unauthorized key with the same error get() raises, and never reads a
 * value. Hits real infrastructure; keys are prefixed and cleaned up.
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
      // best-effort cleanup: delete when the provider can, otherwise overwrite
      // with an empty value.
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
