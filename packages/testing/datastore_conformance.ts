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
import {
  assertEquals,
  assertExists,
  AssertionError,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { dirname, join, resolve } from "@std/path";
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

// ── Memory contract (not runtime-assertable) ──────────────────────────
//
// pullChanged implementations MUST NOT retain file content buffers
// (Uint8Array, ArrayBuffer) in instance state after writing to disk.
// In swamp serve the sync service is a process-lifetime singleton, so
// any accumulated state leaks for the entire process. See
// design/enablers/datastores.md "Memory contract" for the full rules.

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
 * Asserts that a lock rejects with a recognisable timeout error when another
 * holder keeps the lock past `maxWaitMs`.
 *
 * Swamp core translates the rejection into its own lock-timeout error, which
 * `swamp model method run` reports as `"code": "lock_timeout"` with exit code
 * 75, so callers know to retry. The translation relies on this shape:
 *
 * - `code` is `"lock_timeout"`, matched in any case (`"LOCK_TIMEOUT"` is fine)
 * - `lockKey` is a string
 * - `waitedMs` is a number
 *
 * `createLock` must return locks on the same key, so that a second lock
 * contends with the first. Each call receives the `maxWaitMs` to use.
 *
 * ```typescript
 * import { assertLockTimeoutConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("s3 lock timeout contract", async () => {
 *   await assertLockTimeoutConformance(({ maxWaitMs }) =>
 *     provider.createLock("/test/path", { lockKey: "t/.lock", maxWaitMs })
 *   );
 * });
 * ```
 */
export async function assertLockTimeoutConformance(
  createLock: (options: { maxWaitMs: number }) => DistributedLock,
): Promise<void> {
  const holder = createLock({ maxWaitMs: 5_000 });
  const waiter = createLock({ maxWaitMs: 200 });

  await holder.acquire();
  let rejection: unknown = undefined;
  let acquired = false;
  try {
    await waiter.acquire();
    acquired = true;
  } catch (error) {
    rejection = error;
  } finally {
    if (acquired) await waiter.release();
    await holder.release();
  }

  assertEquals(
    acquired,
    false,
    "acquire() must reject while another holder keeps the lock past maxWaitMs",
  );
  const fields =
    (typeof rejection === "object" && rejection !== null
      ? rejection
      : {}) as Record<string, unknown>;
  assertEquals(
    typeof fields.code === "string" ? fields.code.toLowerCase() : fields.code,
    "lock_timeout",
    "lock timeout errors must carry code lock_timeout (any case)",
  );
  assertEquals(
    typeof fields.lockKey,
    "string",
    "lock timeout errors must carry the lockKey",
  );
  assertEquals(
    typeof fields.waitedMs,
    "number",
    "lock timeout errors must carry waitedMs",
  );
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

/** One sync service bound to its own cache directory. */
export interface SyncServiceRoundTripInstance {
  /** The sync service under test. */
  service: DatastoreSyncService;
  /** The cache directory the service syncs, which the suite writes into. */
  cacheDir: string;
}

/**
 * Two sync services on one shared backend, as two machines would see it.
 * The cache directories must differ.
 */
export interface SyncServiceRoundTripFixture {
  /** The instance that writes, marks and pushes. */
  first: SyncServiceRoundTripInstance;
  /** The instance that pulls what `first` pushed. */
  second: SyncServiceRoundTripInstance;
  /**
   * Makes the next `first.service.pushChanged()` fail with a transport
   * error. Without it the failed-push case is skipped.
   */
  failNextPush?: () => void;
  /**
   * Makes the next `second.service.fetchContent()` fail with a transport
   * error. Without it the `fetch-content-error` case is skipped.
   */
  failNextFetch?: () => void;
  /**
   * A namespace both services can sync. The `fetch-content-namespace` case
   * passes it to every call it makes, the warm-up pulls included, and is
   * skipped without it. No other case passes a namespace.
   */
  namespace?: string;
  /** Releases the backend and the cache directories. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a fresh fixture on an empty backend. The suite calls it once per
 * case, so each case starts from a clean backend and clean caches.
 */
export type SyncServiceRoundTripFactory = () => Promise<
  SyncServiceRoundTripFixture
>;

/** Options for {@link assertSyncServiceRoundTripConformance}. */
export interface SyncServiceRoundTripOptions {
  /**
   * Whether a pull removes a local file the remote dropped. Default false,
   * which skips the pull-deletes case: the S3 and GCS datastores never
   * delete local files on pull.
   */
  expectPullDeletes?: boolean;
}

/** What {@link assertSyncServiceRoundTripConformance} ran. */
export interface SyncServiceRoundTripResult {
  /** Names of the cases that ran and passed. */
  passed: string[];
  /** Cases that did not run, each with the reason. */
  skipped: { name: string; reason: string }[];
}

/** The two-phase push methods, which `DatastoreSyncService` leaves optional. */
interface TwoPhasePush {
  preparePush(): Promise<unknown>;
  commitPush(manifest: unknown): Promise<number | void>;
}

function twoPhasePush(service: DatastoreSyncService): TwoPhasePush | undefined {
  const candidate = service as DatastoreSyncService & {
    preparePush?: unknown;
    commitPush?: unknown;
  };
  if (
    typeof candidate.preparePush !== "function" ||
    typeof candidate.commitPush !== "function"
  ) {
    return undefined;
  }
  const prepare = candidate.preparePush as () => Promise<unknown>;
  const commit = candidate.commitPush as (
    manifest: unknown,
  ) => Promise<number | void>;
  return {
    preparePush: () => prepare.call(service),
    commitPush: (manifest) => commit.call(service, manifest),
  };
}

type FetchContent = NonNullable<DatastoreSyncService["fetchContent"]>;

/**
 * `fetchContent`, which `DatastoreSyncService` leaves optional. Bytes come
 * back as a plain `Uint8Array`, so a subclass such as Node's `Buffer`
 * compares equal to the bytes pushed.
 */
function fetchContentOf(
  service: DatastoreSyncService,
): FetchContent | undefined {
  const fetch = service.fetchContent;
  if (typeof fetch !== "function") return undefined;
  return async (relPath, options) => {
    const bytes = await fetch.call(service, relPath, options);
    return bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes;
  };
}

const NO_FETCH_CONTENT = "second.service has no fetchContent";

/** Content with a NUL and high bytes, unique to one run. */
function sampleBytes(label: string): Uint8Array {
  const text = new TextEncoder().encode(`${label}:${crypto.randomUUID()}\n`);
  return new Uint8Array([0x00, 0xff, 0x7f, ...text, 0x0a, 0x00]);
}

function localPath(cacheDir: string, relPath: string): string {
  return join(cacheDir, ...relPath.split("/"));
}

async function writeLocal(
  cacheDir: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = localPath(cacheDir, relPath);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
}

async function readLocalFile(
  cacheDir: string,
  relPath: string,
): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(localPath(cacheDir, relPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Marks, then writes, in the order swamp core does (markDirty rule 1). */
async function markAndWrite(
  instance: SyncServiceRoundTripInstance,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  await instance.service.markDirty({ relPath });
  await writeLocal(instance.cacheDir, relPath, bytes);
}

/** Marks, then deletes, in the order swamp core does (markDirty rule 1). */
async function markAndDelete(
  instance: SyncServiceRoundTripInstance,
  relPath: string,
): Promise<void> {
  await instance.service.markDirty({ relPath });
  await Deno.remove(localPath(instance.cacheDir, relPath));
}

function assertCount(value: number | void, what: string): void {
  if (value !== undefined) {
    assertEquals(typeof value, "number", `${what} must return number or void`);
  }
}

/** A changed result is a positive count, or void for "unknown". */
function assertChanged(value: number | void, what: string): void {
  assertCount(value, what);
  if (value !== undefined) {
    assertEquals(
      value > 0,
      true,
      `${what} returned 0 after changing files; resolve to 0 only when nothing changed`,
    );
  }
}

/** An unchanged result is 0, or void for "unknown". */
function assertUnchanged(value: number | void, what: string): void {
  assertCount(value, what);
  if (value !== undefined) {
    assertEquals(
      value,
      0,
      `${what} must return 0 or void when nothing changed`,
    );
  }
}

async function assertHasBytes(
  instance: SyncServiceRoundTripInstance,
  relPath: string,
  expected: Uint8Array,
  message: string,
): Promise<void> {
  const actual = await readLocalFile(instance.cacheDir, relPath);
  assertExists(actual, `${message}: ${relPath} is missing`);
  assertEquals(actual, expected, `${message}: ${relPath} differs`);
}

async function assertAbsent(
  instance: SyncServiceRoundTripInstance,
  relPath: string,
  message: string,
): Promise<void> {
  const actual = await readLocalFile(instance.cacheDir, relPath);
  assertEquals(actual, undefined, `${message}: ${relPath} still exists`);
}

/**
 * Pulls on both instances so each starts from a synced cache. A service
 * may take its namespace from its first pull and refuse another afterwards,
 * so a case that syncs a namespace warms up with it.
 */
async function warmUp(
  fixture: SyncServiceRoundTripFixture,
  namespace: string | undefined,
): Promise<void> {
  const options = namespace === undefined ? undefined : { namespace };
  assertCount(
    await fixture.first.service.pullChanged(options),
    "first pullChanged()",
  );
  assertCount(
    await fixture.second.service.pullChanged(options),
    "second pullChanged()",
  );
}

const ROOT = "data/conformance";

interface RoundTripCase {
  name: string;
  /**
   * Returns a skip reason from the options alone, checked before the
   * factory runs so a skipped case never builds a backend.
   */
  skipForOptions?: (options: SyncServiceRoundTripOptions) => string | undefined;
  /** Returns a skip reason that depends on the fixture. */
  skip?: (fixture: SyncServiceRoundTripFixture) => string | undefined;
  /** Whether the case passes the fixture's namespace to every sync call. */
  namespaced?: boolean;
  run: (fixture: SyncServiceRoundTripFixture) => Promise<void>;
}

const ROUND_TRIP_CASES: readonly RoundTripCase[] = [
  {
    name: "round-trip",
    run: async ({ first, second }) => {
      const rel = `${ROOT}/round-trip/raw`;
      const bytes = sampleBytes("round-trip");
      await markAndWrite(first, rel, bytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        rel,
        bytes,
        "a path-marked file pushed by first must pull on second",
      );
    },
  },
  {
    name: "push-deletes",
    run: async ({ first, second }) => {
      const rel = `${ROOT}/push-deletes/raw`;
      await markAndWrite(first, rel, sampleBytes("push-deletes"));
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      await markAndDelete(first, rel);
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of a deleted path",
      );
      // second never pulled the file, so it only appears if the remote
      // still holds it.
      assertCount(await second.service.pullChanged(), "second pullChanged()");
      await assertAbsent(
        second,
        rel,
        "a marked path absent on disk must delete the remote file (markDirty rule 2)",
      );
    },
  },
  {
    name: "pull-deletes",
    skipForOptions: (options) =>
      options.expectPullDeletes
        ? undefined
        : "S3/GCS pulls never delete local files; set expectPullDeletes to run it",
    run: async ({ first, second }) => {
      const rel = `${ROOT}/pull-deletes/raw`;
      const bytes = sampleBytes("pull-deletes");
      await markAndWrite(first, rel, bytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(second, rel, bytes, "second must pull the file");
      await markAndDelete(first, rel);
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of a deleted path",
      );
      assertChanged(
        await second.service.pullChanged(),
        "second pullChanged() after a remote delete",
      );
      await assertAbsent(
        second,
        rel,
        "a pull must remove a local file the remote deleted",
      );
    },
  },
  {
    name: "bulk-mark",
    run: async ({ first, second }) => {
      const one = `${ROOT}/bulk-mark/one/raw`;
      const two = `${ROOT}/bulk-mark/two/raw`;
      const oneBytes = sampleBytes("bulk-one");
      const twoBytes = sampleBytes("bulk-two");
      await first.service.markDirty();
      await writeLocal(first.cacheDir, one, oneBytes);
      await writeLocal(first.cacheDir, two, twoBytes);
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() after a bare mark",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      const message =
        "a bare markDirty() must push every changed file (markDirty rule 3)";
      await assertHasBytes(second, one, oneBytes, message);
      await assertHasBytes(second, two, twoBytes, message);
    },
  },
  {
    name: "failed-push-retry",
    skip: (fixture) =>
      fixture.failNextPush
        ? undefined
        : "the factory has no failNextPush hook to inject a transport failure",
    run: async ({ first, second, failNextPush }) => {
      const rel = `${ROOT}/failed-push-retry/raw`;
      const bytes = sampleBytes("failed-push-retry");
      await markAndWrite(first, rel, bytes);
      failNextPush!();
      await assertRejects(
        async () => {
          await first.service.pushChanged();
        },
        Error,
        undefined,
        "pushChanged() must reject when the transport fails",
      );
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() retried after a failure",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        rel,
        bytes,
        "a failed push must leave the path dirty so the next push uploads it",
      );
    },
  },
  {
    name: "two-phase",
    skip: (fixture) =>
      twoPhasePush(fixture.first.service)
        ? undefined
        : "the sync service has no preparePush/commitPush",
    run: async ({ first, second }) => {
      const twoPhase = twoPhasePush(first.service)!;

      // preparePush publishes nothing and keeps the path dirty.
      const kept = `${ROOT}/two-phase/kept/raw`;
      const keptBytes = sampleBytes("two-phase-kept");
      await markAndWrite(first, kept, keptBytes);
      await twoPhase.preparePush();
      assertCount(await second.service.pullChanged(), "second pullChanged()");
      await assertAbsent(
        second,
        kept,
        "preparePush must not publish to the remote index",
      );
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() after an uncommitted preparePush",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        kept,
        keptBytes,
        "preparePush must keep the path dirty so a later push uploads it",
      );

      // commitPush publishes the manifest and clears dirty state.
      const committed = `${ROOT}/two-phase/committed/raw`;
      const committedBytes = sampleBytes("two-phase-committed");
      await markAndWrite(first, committed, committedBytes);
      const manifest = await twoPhase.preparePush();
      assertChanged(
        await twoPhase.commitPush(manifest),
        "first commitPush()",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        committed,
        committedBytes,
        "commitPush must publish the prepared manifest",
      );
      // A peer overwrites the file. If commitPush left first dirty, first's
      // next push would upload its stale copy over the peer's.
      const peerBytes = sampleBytes("two-phase-peer");
      await markAndWrite(second, committed, peerBytes);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");
      assertCount(
        await first.service.pushChanged(),
        "first pushChanged() after commitPush",
      );
      assertCount(await first.service.pullChanged(), "first pullChanged()");
      await assertHasBytes(
        first,
        committed,
        peerBytes,
        "commitPush must clear dirty state so the next push sends nothing",
      );

      // Committing what a clean cache prepares changes nothing.
      const empty = await twoPhase.preparePush();
      assertUnchanged(
        await twoPhase.commitPush(empty),
        "commitPush() of a manifest prepared from a clean cache",
      );
      assertUnchanged(
        await second.service.pullChanged(),
        "second pullChanged() after an empty commit",
      );
      await assertHasBytes(
        second,
        committed,
        peerBytes,
        "an empty commit must not change the remote",
      );
    },
  },
  {
    name: "pull-nothing-new",
    run: async ({ first, second }) => {
      const rel = `${ROOT}/pull-nothing-new/raw`;
      const bytes = sampleBytes("pull-nothing-new");
      await markAndWrite(first, rel, bytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      // An old, fixed mtime shows any rewrite, even within one clock tick.
      const mtime = new Date("2001-01-01T00:00:00Z");
      for (const instance of [first, second]) {
        await Deno.utime(localPath(instance.cacheDir, rel), mtime, mtime);
      }
      for (
        const [label, instance] of [["second", second], [
          "first",
          first,
        ]] as const
      ) {
        assertUnchanged(
          await instance.service.pullChanged(),
          `${label} pullChanged() with nothing new`,
        );
        const message =
          `${label} pullChanged() with nothing new must not touch local files`;
        await assertHasBytes(instance, rel, bytes, message);
        const info = await Deno.stat(localPath(instance.cacheDir, rel));
        assertEquals(
          info.mtime?.getTime(),
          mtime.getTime(),
          `${message}: ${rel} was rewritten`,
        );
      }
    },
  },
  {
    name: "forward-slash-paths",
    run: async ({ first, second }) => {
      const rel = `${ROOT}/forward-slash-paths/a/b/c/raw.yaml`;
      const bytes = sampleBytes("forward-slash-paths");
      await markAndWrite(first, rel, bytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        rel,
        bytes,
        "a forward-slash relPath must map to native separators on every OS (markDirty rule 5)",
      );
    },
  },
  {
    name: "fetch-content",
    skip: ({ second }) =>
      fetchContentOf(second.service) ? undefined : NO_FETCH_CONTENT,
    run: async ({ first, second }) => {
      const fetchContent = fetchContentOf(second.service)!;
      const rel = `${ROOT}/fetch-content/raw`;
      const remoteBytes = sampleBytes("fetch-content-remote");
      await markAndWrite(first, rel, remoteBytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");

      assertEquals(
        await fetchContent(rel),
        remoteBytes,
        "fetchContent() must return the bytes first pushed",
      );
      await assertAbsent(
        second,
        rel,
        "fetchContent() must not write into the cache",
      );
      assertEquals(
        await fetchContent(`${ROOT}/fetch-content/missing`),
        null,
        "fetchContent() of a file the remote lacks must return null",
      );
      await assertRejects(
        () => fetchContent(`${ROOT}/fetch-content/../fetch-content/raw`),
        Error,
        undefined,
        "fetchContent() must reject a relPath with a .. segment",
      );
      await assertRejects(
        () => fetchContent(`/${rel}`),
        Error,
        undefined,
        "fetchContent() must reject an absolute relPath",
      );

      // A local change not pushed yet: the remote's bytes come back, and the
      // change stays local and stays pending.
      const localBytes = sampleBytes("fetch-content-local");
      await markAndWrite(second, rel, localBytes);
      const mtime = new Date("2001-01-01T00:00:00Z");
      await Deno.utime(localPath(second.cacheDir, rel), mtime, mtime);
      assertEquals(
        await fetchContent(rel),
        remoteBytes,
        "fetchContent() must return the remote's bytes, not a differing local file's",
      );
      const message = "fetchContent() must not touch a differing local file";
      await assertHasBytes(second, rel, localBytes, message);
      const info = await Deno.stat(localPath(second.cacheDir, rel));
      assertEquals(
        info.mtime?.getTime(),
        mtime.getTime(),
        `${message}: ${rel} was rewritten`,
      );
      // A current mtime again, so a push that compares mtimes still sees the
      // change.
      const now = new Date();
      await Deno.utime(localPath(second.cacheDir, rel), now, now);
      assertChanged(
        await second.service.pushChanged(),
        "second pushChanged() after fetchContent()",
      );
      assertEquals(
        await fetchContent(rel),
        localBytes,
        "fetchContent() must not clear a pending push: second's change must reach the remote",
      );
    },
  },
  {
    name: "fetch-content-error",
    skip: ({ second, failNextFetch }) => {
      if (!fetchContentOf(second.service)) return NO_FETCH_CONTENT;
      return failNextFetch ? undefined : "the fixture has no failNextFetch";
    },
    run: async ({ first, second, failNextFetch }) => {
      const fetchContent = fetchContentOf(second.service)!;
      const rel = `${ROOT}/fetch-content-error/raw`;
      const bytes = sampleBytes("fetch-content-error");
      await markAndWrite(first, rel, bytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");

      failNextFetch!();
      await assertRejects(
        () => fetchContent(rel),
        Error,
        undefined,
        "fetchContent() must reject when the remote cannot be read; null means the file is gone",
      );
      assertEquals(
        await fetchContent(rel),
        bytes,
        "fetchContent() after a failed one must return the remote's bytes",
      );
    },
  },
  {
    name: "fetch-content-namespace",
    namespaced: true,
    skip: ({ second, namespace }) => {
      if (!fetchContentOf(second.service)) return NO_FETCH_CONTENT;
      return namespace ? undefined : "the fixture names no namespace";
    },
    run: async ({ first, second, namespace }) => {
      const fetchContent = fetchContentOf(second.service)!;
      // Cache-relative, so it starts with the namespace (fetchContent rule 3).
      const rel = `${namespace}/${ROOT}/fetch-content-namespace/raw`;
      const bytes = sampleBytes("fetch-content-namespace");
      await first.service.markDirty({ relPath: rel, namespace });
      await writeLocal(first.cacheDir, rel, bytes);
      assertChanged(
        await first.service.pushChanged({ namespace }),
        "first pushChanged() with a namespace",
      );
      assertEquals(
        await fetchContent(rel, { namespace }),
        bytes,
        "fetchContent() of a cache-relative path must not add the namespace a second time",
      );
      await assertAbsent(
        second,
        rel,
        "fetchContent() must not write into the cache",
      );
    },
  },
];

/**
 * Asserts that a DatastoreSyncService moves files between two caches on one
 * backend the way swamp core relies on, following the `markDirty` contract.
 *
 * Each case calls `factory` for a fresh backend, pulls on both instances,
 * then runs:
 *
 * - `round-trip`: a path-marked file pushed by `first` pulls on `second`
 *   with identical bytes.
 * - `push-deletes`: a marked path that is absent on disk deletes the remote
 *   file.
 * - `pull-deletes`: a pull removes a local file the remote deleted. Skipped
 *   unless `expectPullDeletes` is set.
 * - `bulk-mark`: a bare `markDirty()` pushes every changed file.
 * - `failed-push-retry`: a push that fails leaves the path dirty and the next
 *   push uploads it. Skipped when the fixture has no `failNextPush`.
 * - `two-phase`: `preparePush` publishes nothing and keeps the path dirty;
 *   `commitPush` publishes and clears dirty state; committing what a clean
 *   cache prepares changes nothing. Skipped without `preparePush` and
 *   `commitPush`.
 * - `pull-nothing-new`: a pull with nothing new returns 0 or void and leaves
 *   local bytes and mtimes alone.
 * - `forward-slash-paths`: a forward-slash `relPath` lands at the native path.
 * - `fetch-content`: `fetchContent` returns the remote's bytes and `null` for
 *   a missing file, rejects a `..` or absolute path, writes nothing into the
 *   cache, leaves
 *   a differing local file alone and keeps its pending push. Skipped when
 *   `second.service` has no `fetchContent`.
 * - `fetch-content-error`: a `fetchContent` that cannot read the remote
 *   rejects, never resolving to `null`. Skipped without `fetchContent`, and
 *   when the fixture has no `failNextFetch`.
 * - `fetch-content-namespace`: a cache-relative path that starts with the
 *   namespace is read without the namespace being added again. This case
 *   passes the fixture's `namespace` to every call, its warm-up pulls
 *   included, since a service may bind the namespace of its first pull.
 *   Skipped without `fetchContent`, and unless the fixture names a
 *   `namespace`. It has only been run against `createInMemoryRemote`, which
 *   binds a namespace as the S3 and GCS datastores do but stores a
 *   namespaced path as a plain key.
 *
 * Counts may be void ("unknown") everywhere. A failing case rejects with an
 * error naming it; skipped cases are returned so callers can assert on them.
 *
 * Experimental: like `createInMemoryRemote`, the defaults (such as skipping
 * `pull-deletes`) follow what the S3 and GCS datastore extensions do today
 * and may change as those extensions change. New cases may be added, and some
 * may skip, so assert on the cases you rely on rather than on the exact
 * skipped list.
 *
 * ```typescript
 * import { assert } from "@std/assert";
 * import { assertSyncServiceRoundTripConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("s3 sync service round-trips", async () => {
 *   const result = await assertSyncServiceRoundTripConformance(async () => {
 *     const bucket = await createTestBucket();
 *     const firstCache = await Deno.makeTempDir();
 *     const secondCache = await Deno.makeTempDir();
 *     return {
 *       first: { service: syncFor(bucket, firstCache), cacheDir: firstCache },
 *       second: { service: syncFor(bucket, secondCache), cacheDir: secondCache },
 *       failNextPush: () => bucket.failNextPut(),
 *       cleanup: async () => {
 *         await bucket.destroy();
 *         await Deno.remove(firstCache, { recursive: true });
 *         await Deno.remove(secondCache, { recursive: true });
 *       },
 *     };
 *   });
 *   for (const name of ["round-trip", "push-deletes", "failed-push-retry"]) {
 *     assert(result.passed.includes(name), `${name} did not run`);
 *   }
 *   for (const { name, reason } of result.skipped) {
 *     console.log(`skipped ${name}: ${reason}`);
 *   }
 * });
 * ```
 *
 * @experimental
 */
export async function assertSyncServiceRoundTripConformance(
  factory: SyncServiceRoundTripFactory,
  options?: SyncServiceRoundTripOptions,
): Promise<SyncServiceRoundTripResult> {
  const resolved: SyncServiceRoundTripOptions = {
    expectPullDeletes: options?.expectPullDeletes ?? false,
  };
  const result: SyncServiceRoundTripResult = { passed: [], skipped: [] };
  for (const testCase of ROUND_TRIP_CASES) {
    const optionReason = testCase.skipForOptions?.(resolved);
    if (optionReason !== undefined) {
      result.skipped.push({ name: testCase.name, reason: optionReason });
      continue;
    }
    await runRoundTripCase(testCase, factory, result);
  }
  return result;
}

/** Resolves symlinks so two spellings of one directory compare equal. */
async function canonicalDir(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    // Not created yet, or unreadable: compare the lexical path instead.
    return resolve(path);
  }
}

async function runRoundTripCase(
  testCase: RoundTripCase,
  factory: SyncServiceRoundTripFactory,
  result: SyncServiceRoundTripResult,
): Promise<void> {
  let fixture: SyncServiceRoundTripFixture | undefined;
  let caseError: AssertionError | undefined;
  try {
    fixture = await factory();
    const firstDir = await canonicalDir(fixture.first.cacheDir);
    if (firstDir === await canonicalDir(fixture.second.cacheDir)) {
      throw new AssertionError(
        `first.cacheDir and second.cacheDir must be different directories, but both resolve to ${firstDir}`,
      );
    }
    const reason = testCase.skip?.(fixture);
    if (reason !== undefined) {
      result.skipped.push({ name: testCase.name, reason });
    } else {
      await warmUp(
        fixture,
        testCase.namespaced ? fixture.namespace : undefined,
      );
      await testCase.run(fixture);
      result.passed.push(testCase.name);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    caseError = new AssertionError(
      `sync round-trip case "${testCase.name}" failed: ${detail}`,
      { cause: error },
    );
  }
  if (fixture !== undefined) {
    try {
      await fixture.cleanup();
    } catch (cleanupError) {
      if (caseError === undefined) {
        const cleanupDetail = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        throw new AssertionError(
          `sync round-trip case "${testCase.name}" failed: cleanup failed: ${cleanupDetail}`,
          { cause: cleanupError },
        );
      }
      // Keep the case failure primary; a cleanup error must not hide it.
      const cleanupDetail = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      throw new AssertionError(
        `${caseError.message} (cleanup also failed: ${cleanupDetail})`,
        { cause: new AggregateError([caseError, cleanupError]) },
      );
    }
  }
  if (caseError !== undefined) throw caseError;
}
