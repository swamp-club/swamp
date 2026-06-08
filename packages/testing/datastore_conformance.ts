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
import type {
  DatastoreProvider,
  DatastoreSyncService,
  DatastoreVerifier,
  DistributedLock,
} from "./datastore_types.ts";

/**
 * The datastore export shape that extension authors must produce.
 * Matches the `export const datastore = { ... }` pattern.
 */
export interface DatastoreExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (config: Record<string, unknown>) => DatastoreProvider;
}

/** Options for datastore export conformance. */
export interface DatastoreExportConformanceOptions {
  /** Configs that should pass schema validation. At least one required. */
  validConfigs: Record<string, unknown>[];
  /** Configs that should fail schema validation. */
  invalidConfigs?: Record<string, unknown>[];
}

/**
 * Asserts that a datastore export has the correct structural shape.
 *
 * Tests: type matches naming pattern, name/description are non-empty,
 * configSchema accepts valid configs and rejects invalid ones,
 * createProvider returns a DatastoreProvider with required methods.
 *
 * ```typescript
 * import { assertDatastoreExportConformance } from "@swamp-club/swamp-testing";
 * import { datastore } from "./s3.ts";
 *
 * Deno.test("datastore export conforms", () => {
 *   assertDatastoreExportConformance(datastore, {
 *     validConfigs: [{ bucket: "my-bucket", region: "us-east-1" }],
 *     invalidConfigs: [{}, { bucket: "AB" }],
 *   });
 * });
 * ```
 */
export function assertDatastoreExportConformance(
  datastoreExport: DatastoreExport,
  options: DatastoreExportConformanceOptions,
): void {
  // Type must match pattern
  assertExists(datastoreExport.type, "datastore.type must exist");
  assertEquals(
    /^@?[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(datastoreExport.type),
    true,
    `datastore.type "${datastoreExport.type}" must match pattern @collective/name`,
  );

  // Name and description
  assertExists(datastoreExport.name, "datastore.name must exist");
  assertEquals(
    datastoreExport.name.length > 0,
    true,
    "datastore.name must be non-empty",
  );
  assertExists(datastoreExport.description, "datastore.description must exist");
  assertEquals(
    datastoreExport.description.length > 0,
    true,
    "datastore.description must be non-empty",
  );

  // configSchema
  assertExists(
    datastoreExport.configSchema,
    "datastore.configSchema must exist",
  );
  assertEquals(
    typeof datastoreExport.configSchema.safeParse,
    "function",
    "datastore.configSchema must have a safeParse method",
  );

  // Valid configs
  assertEquals(
    options.validConfigs.length > 0,
    true,
    "At least one valid config must be provided",
  );
  for (const config of options.validConfigs) {
    const result = datastoreExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      true,
      `configSchema should accept ${JSON.stringify(config)}`,
    );
  }

  // Invalid configs
  for (const config of options.invalidConfigs ?? []) {
    const result = datastoreExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      false,
      `configSchema should reject ${JSON.stringify(config)}`,
    );
  }

  // createProvider
  assertEquals(
    typeof datastoreExport.createProvider,
    "function",
    "datastore.createProvider must be a function",
  );

  const provider = datastoreExport.createProvider(options.validConfigs[0]);
  assertExists(provider, "createProvider must return a provider");
  assertEquals(
    typeof provider.createLock,
    "function",
    "provider must have createLock()",
  );
  assertEquals(
    typeof provider.createVerifier,
    "function",
    "provider must have createVerifier()",
  );
  assertEquals(
    typeof provider.resolveDatastorePath,
    "function",
    "provider must have resolveDatastorePath()",
  );

  // resolveDatastorePath must return a string
  const path = provider.resolveDatastorePath("/tmp/test-repo");
  assertEquals(
    typeof path,
    "string",
    "resolveDatastorePath must return a string",
  );
  assertEquals(
    path.length > 0,
    true,
    "resolveDatastorePath must return a non-empty string",
  );

  // createLock must return an object with the right methods
  const lock = provider.createLock("/tmp/test-ds");
  assertExists(lock, "createLock must return a lock");
  assertEquals(typeof lock.acquire, "function", "lock must have acquire()");
  assertEquals(typeof lock.release, "function", "lock must have release()");
  assertEquals(typeof lock.withLock, "function", "lock must have withLock()");
  assertEquals(typeof lock.inspect, "function", "lock must have inspect()");
  assertEquals(
    typeof lock.forceRelease,
    "function",
    "lock must have forceRelease()",
  );

  // createVerifier must return an object with verify()
  const verifier = provider.createVerifier();
  assertExists(verifier, "createVerifier must return a verifier");
  assertEquals(
    typeof verifier.verify,
    "function",
    "verifier must have verify()",
  );
}

/**
 * Asserts that a DistributedLock implementation satisfies the behavioral
 * contract.
 *
 * Tests: acquire/release lifecycle, withLock executes and releases,
 * withLock releases on error, inspect returns info when held and null when
 * not, forceRelease with correct/wrong nonce, release is idempotent.
 *
 * ```typescript
 * import { assertLockConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("s3 lock contract", async () => {
 *   const lock = provider.createLock("/test/path");
 *   await assertLockConformance(lock);
 * });
 * ```
 */
export async function assertLockConformance(
  lock: DistributedLock,
): Promise<void> {
  // inspect returns null when not held
  const infoBeforeAcquire = await lock.inspect();
  assertEquals(
    infoBeforeAcquire,
    null,
    "inspect() must return null when lock is not held",
  );

  // acquire/release lifecycle
  await lock.acquire();
  try {
    const infoWhileHeld = await lock.inspect();
    assertExists(infoWhileHeld, "inspect() must return info when lock is held");
    if (infoWhileHeld) {
      assertEquals(
        typeof infoWhileHeld.holder,
        "string",
        "lock info must have a holder",
      );
      assertEquals(
        typeof infoWhileHeld.pid,
        "number",
        "lock info must have a pid",
      );
      assertEquals(
        typeof infoWhileHeld.acquiredAt,
        "string",
        "lock info must have acquiredAt",
      );
      assertEquals(
        typeof infoWhileHeld.ttlMs,
        "number",
        "lock info must have ttlMs",
      );
    }
  } finally {
    await lock.release();
  }

  // After release, inspect returns null
  const infoAfterRelease = await lock.inspect();
  assertEquals(
    infoAfterRelease,
    null,
    "inspect() must return null after release",
  );

  // release is idempotent
  await lock.release();

  // withLock executes callback and returns result
  const result = await lock.withLock(() => Promise.resolve(42));
  assertEquals(result, 42, "withLock must return the callback's result");

  // Lock is released after withLock
  const infoAfterWithLock = await lock.inspect();
  assertEquals(
    infoAfterWithLock,
    null,
    "lock must be released after withLock completes",
  );

  // withLock releases on error
  try {
    await lock.withLock(() => Promise.reject(new Error("test error")));
  } catch {
    // expected
  }
  const infoAfterWithLockError = await lock.inspect();
  assertEquals(
    infoAfterWithLockError,
    null,
    "lock must be released after withLock throws",
  );

  // forceRelease with correct nonce
  await lock.acquire();
  try {
    const info = await lock.inspect();
    assertExists(info, "lock must be held after acquire");
    assertExists(
      info!.nonce,
      "lock info must include a nonce for forceRelease conformance",
    );
    assertEquals(
      typeof info!.nonce,
      "string",
      "lock info nonce must be a string",
    );

    const released = await lock.forceRelease(info!.nonce!);
    assertEquals(
      released,
      true,
      "forceRelease with correct nonce must return true",
    );

    const infoAfterForce = await lock.inspect();
    assertEquals(
      infoAfterForce,
      null,
      "lock must be released after forceRelease",
    );
  } finally {
    // Ensure cleanup even if forceRelease didn't work
    try {
      await lock.release();
    } catch {
      // May already be released
    }
  }

  // forceRelease with wrong nonce
  await lock.acquire();
  try {
    const released = await lock.forceRelease("wrong-nonce-value");
    assertEquals(
      released,
      false,
      "forceRelease with wrong nonce must return false",
    );

    // Verify lock is still held after wrong-nonce forceRelease
    const stillHeld = await lock.inspect();
    assertExists(
      stillHeld,
      "lock must remain held after wrong-nonce forceRelease",
    );
  } finally {
    await lock.release();
  }
}

/**
 * Asserts that a DatastoreVerifier implementation returns a valid health result.
 *
 * ```typescript
 * import { assertVerifierConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("s3 verifier contract", async () => {
 *   const verifier = provider.createVerifier();
 *   await assertVerifierConformance(verifier);
 * });
 * ```
 */
export async function assertVerifierConformance(
  verifier: DatastoreVerifier,
): Promise<void> {
  const result = await verifier.verify();

  assertExists(result, "verify() must return a result");
  assertEquals(
    typeof result.healthy,
    "boolean",
    "result.healthy must be a boolean",
  );
  assertEquals(
    typeof result.message,
    "string",
    "result.message must be a string",
  );
  assertEquals(
    typeof result.latencyMs,
    "number",
    "result.latencyMs must be a number",
  );
  assertEquals(
    result.latencyMs >= 0,
    true,
    "result.latencyMs must be non-negative",
  );
  assertEquals(
    typeof result.datastoreType,
    "string",
    "result.datastoreType must be a string",
  );
}

/** Options for sync service conformance. */
export interface SyncServiceConformanceOptions {
  /** Whether to assert that capabilities() returns scopedSync: true. */
  expectScopedSync?: boolean;
}

/**
 * Asserts that a DatastoreSyncService implementation satisfies the
 * behavioral contract.
 *
 * Tests: pullChanged/pushChanged/markDirty exist and are callable.
 * When `capabilities()` is present, validates it returns a well-formed
 * `SyncCapabilities`. When `expectScopedSync` is true, asserts
 * `scopedSync === true`.
 *
 * ```typescript
 * import { assertSyncServiceConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("s3 sync service contract", async () => {
 *   const syncService = provider.createSyncService!("/repo", "/cache");
 *   await assertSyncServiceConformance(syncService);
 * });
 * ```
 */
export async function assertSyncServiceConformance(
  syncService: DatastoreSyncService,
  options?: SyncServiceConformanceOptions,
): Promise<void> {
  assertEquals(
    typeof syncService.pullChanged,
    "function",
    "syncService must have pullChanged()",
  );
  assertEquals(
    typeof syncService.pushChanged,
    "function",
    "syncService must have pushChanged()",
  );
  assertEquals(
    typeof syncService.markDirty,
    "function",
    "syncService must have markDirty()",
  );

  await syncService.markDirty();

  const pulled = await syncService.pullChanged();
  if (pulled !== undefined) {
    assertEquals(
      typeof pulled,
      "number",
      "pullChanged() must return number or void",
    );
  }

  const pushed = await syncService.pushChanged();
  if (pushed !== undefined) {
    assertEquals(
      typeof pushed,
      "number",
      "pushChanged() must return number or void",
    );
  }

  if (syncService.capabilities) {
    assertEquals(
      typeof syncService.capabilities,
      "function",
      "capabilities must be a function",
    );

    const caps = syncService.capabilities();
    assertExists(caps, "capabilities() must return a value");
    if (caps.scopedSync !== undefined) {
      assertEquals(
        typeof caps.scopedSync,
        "boolean",
        "capabilities().scopedSync must be a boolean when present",
      );
    }

    if (options?.expectScopedSync) {
      assertEquals(
        caps.scopedSync,
        true,
        "capabilities().scopedSync must be true when expectScopedSync is set",
      );
    }
  }
}
