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

export interface DatastoreExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (config: Record<string, unknown>) => DatastoreProvider;
}

export interface DatastoreExportConformanceOptions {
  validConfigs: Record<string, unknown>[];
  invalidConfigs?: Record<string, unknown>[];
}

export function assertDatastoreExportConformance(
  datastoreExport: DatastoreExport,
  options: DatastoreExportConformanceOptions,
): void {
  assertExists(datastoreExport.type, "datastore.type must exist");
  assertEquals(
    /^@?[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(datastoreExport.type),
    true,
    `datastore.type "${datastoreExport.type}" must match pattern @collective/name`,
  );

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

  assertExists(
    datastoreExport.configSchema,
    "datastore.configSchema must exist",
  );
  assertEquals(
    typeof datastoreExport.configSchema.safeParse,
    "function",
    "datastore.configSchema must have a safeParse method",
  );

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

  for (const config of options.invalidConfigs ?? []) {
    const result = datastoreExport.configSchema.safeParse(config);
    assertEquals(
      result.success,
      false,
      `configSchema should reject ${JSON.stringify(config)}`,
    );
  }

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

  const verifier = provider.createVerifier();
  assertExists(verifier, "createVerifier must return a verifier");
  assertEquals(
    typeof verifier.verify,
    "function",
    "verifier must have verify()",
  );
}

// memory contract, not runtime-assertable: pullChanged must not retain file
// content buffers in instance state after writing to disk, since in swamp serve
// the sync service is a process-lifetime singleton

export async function assertLockConformance(
  lock: DistributedLock,
): Promise<void> {
  const infoBeforeAcquire = await lock.inspect();
  assertEquals(
    infoBeforeAcquire,
    null,
    "inspect() must return null when lock is not held",
  );

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

  const infoAfterRelease = await lock.inspect();
  assertEquals(
    infoAfterRelease,
    null,
    "inspect() must return null after release",
  );

  await lock.release();

  const result = await lock.withLock(() => Promise.resolve(42));
  assertEquals(result, 42, "withLock must return the callback's result");

  const infoAfterWithLock = await lock.inspect();
  assertEquals(
    infoAfterWithLock,
    null,
    "lock must be released after withLock completes",
  );

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
    try {
      await lock.release();
    } catch {
      // May already be released
    }
  }

  await lock.acquire();
  try {
    const released = await lock.forceRelease("wrong-nonce-value");
    assertEquals(
      released,
      false,
      "forceRelease with wrong nonce must return false",
    );

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
 * core translates the rejection into its lock_timeout error (exit 75): code is
 * lock_timeout in any case, lockKey a string, waitedMs a number; createLock
 * must return locks on the same key
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

export interface SyncServiceConformanceOptions {
  expectScopedSync?: boolean;
}

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

export interface SyncServiceRoundTripInstance {
  service: DatastoreSyncService;
  cacheDir: string;
}

/**
 * Two sync services on one shared backend, as two machines would see it.
 * The cache directories must differ.
 */
export interface SyncServiceRoundTripFixture {
  first: SyncServiceRoundTripInstance;
  second: SyncServiceRoundTripInstance;
  failNextPush?: () => void;
  failNextFetch?: () => void;
  /**
   * A namespace both services can sync. The `fetch-content-namespace` case
   * passes it to every call it makes, the warm-up pulls included, and is
   * skipped without it. No other case passes a namespace.
   */
  namespace?: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a fresh fixture on an empty backend. The suite calls it once per
 * case, so each case starts from a clean backend and clean caches.
 */
export type SyncServiceRoundTripFactory = () => Promise<
  SyncServiceRoundTripFixture
>;

export interface SyncServiceRoundTripOptions {
  /**
   * Whether a pull removes a local file the remote dropped. Default false,
   * which skips the pull-deletes case: the S3 and GCS datastores never
   * delete local files on pull.
   */
  expectPullDeletes?: boolean;
}

export interface SyncServiceRoundTripResult {
  passed: string[];
  skipped: { name: string; reason: string }[];
}

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
const NO_CLEAR_DIRTY = "first.service has no clearDirty";
const NO_REPAIR_UNPUSHED = "first.service has no repairUnpushedFiles";

function skipWithoutRepairUnpushed(
  fixture: SyncServiceRoundTripFixture,
): string | undefined {
  return typeof fixture.first.service.repairUnpushedFiles === "function"
    ? undefined
    : NO_REPAIR_UNPUSHED;
}
const NO_TWO_PHASE = "the sync service has no preparePush/commitPush";

function skipWithoutTwoPhase(
  fixture: SyncServiceRoundTripFixture,
): string | undefined {
  return twoPhasePush(fixture.first.service) ? undefined : NO_TWO_PHASE;
}

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
  skip?: (fixture: SyncServiceRoundTripFixture) => string | undefined;
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
        : "S3/GCS pulls do not remove every local file the remote deleted; set expectPullDeletes to run it",
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
    skip: skipWithoutTwoPhase,
    run: async ({ first, second }) => {
      const twoPhase = twoPhasePush(first.service)!;

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
  {
    name: "mark-between-prepare-and-commit",
    skip: skipWithoutTwoPhase,
    run: async ({ first, second }) => {
      const twoPhase = twoPhasePush(first.service)!;
      const prepared = `${ROOT}/mark-between/prepared/raw`;
      const later = `${ROOT}/mark-between/later/raw`;
      const preparedBytes = sampleBytes("mark-between-prepared");
      const laterBytes = sampleBytes("mark-between-later");
      await markAndWrite(first, prepared, preparedBytes);
      const manifest = await twoPhase.preparePush();
      await markAndWrite(first, later, laterBytes);
      assertChanged(await twoPhase.commitPush(manifest), "first commitPush()");
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of a path marked after preparePush",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        prepared,
        preparedBytes,
        "commitPush must publish the prepared manifest",
      );
      await assertHasBytes(
        second,
        later,
        laterBytes,
        "commitPush must clear only the marks the prepare handled, so a path marked after preparePush is pushed next",
      );
    },
  },
  {
    name: "remark-between-prepare-and-commit",
    skip: skipWithoutTwoPhase,
    run: async ({ first, second }) => {
      const twoPhase = twoPhasePush(first.service)!;
      const rel = `${ROOT}/remark-between/raw`;
      await markAndWrite(first, rel, sampleBytes("remark-between-prepared"));
      const manifest = await twoPhase.preparePush();
      const rewritten = sampleBytes("remark-between-rewritten");
      await markAndWrite(first, rel, rewritten);
      assertChanged(await twoPhase.commitPush(manifest), "first commitPush()");
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of a path marked again after preparePush",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        rel,
        rewritten,
        "a path marked again after preparePush must stay dirty through commitPush, so its new bytes are pushed next",
      );
    },
  },
  {
    name: "bulk-between-prepare-and-commit",
    skip: skipWithoutTwoPhase,
    run: async ({ first, second }) => {
      const twoPhase = twoPhasePush(first.service)!;
      const prepared = `${ROOT}/bulk-between/prepared/raw`;
      const later = `${ROOT}/bulk-between/later/raw`;
      const preparedBytes = sampleBytes("bulk-between-prepared");
      const laterBytes = sampleBytes("bulk-between-later");
      await markAndWrite(first, prepared, preparedBytes);
      const manifest = await twoPhase.preparePush();
      await first.service.markDirty();
      await writeLocal(first.cacheDir, later, laterBytes);
      assertChanged(await twoPhase.commitPush(manifest), "first commitPush()");
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() after a bare mark made after preparePush",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        prepared,
        preparedBytes,
        "commitPush must publish the prepared manifest",
      );
      await assertHasBytes(
        second,
        later,
        laterBytes,
        "a bare markDirty() after preparePush must stay set through commitPush, so the next push sends every changed file",
      );
    },
  },
  {
    name: "vanish-during-walk",
    // Windows hosts without Developer Mode cannot create symlinks, and
    // Windows is not fully supported yet.
    skip: () =>
      Deno.build.os === "windows"
        ? "Windows hosts without Developer Mode cannot create the dangling symlink this case needs"
        : undefined,
    run: async ({ first, second }) => {
      const dir = `${ROOT}/vanish-during-walk`;
      const live = `${dir}/live/raw`;
      const added = `${dir}/added/raw`;
      const liveBytes = sampleBytes("vanish-live");
      const addedBytes = sampleBytes("vanish-added");
      await markAndWrite(first, live, liveBytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");

      await first.service.markDirty({ relPath: dir });
      await writeLocal(first.cacheDir, added, addedBytes);
      await Deno.symlink(
        localPath(first.cacheDir, `${dir}/missing-target`),
        localPath(first.cacheDir, `${dir}/vanished`),
        { type: "file" },
      );
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of a marked directory with a vanished entry",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        live,
        liveBytes,
        "an entry that vanishes while a push walks a marked directory must not delete the directory's other files remotely",
      );
      await assertHasBytes(
        second,
        added,
        addedBytes,
        "an entry that vanishes while a push walks a marked directory must not stop the push sending the directory's changes",
      );
    },
  },
  {
    name: "clear-dirty",
    skip: ({ first }) =>
      typeof first.service.clearDirty === "function"
        ? undefined
        : NO_CLEAR_DIRTY,
    run: async ({ first, second }) => {
      const dir = `${ROOT}/clear-dirty`;
      const peer = `${dir}/peer/raw`;
      const later = `${dir}/later/raw`;
      const peerBytes = sampleBytes("clear-dirty-peer");
      const laterBytes = sampleBytes("clear-dirty-later");
      // a directory first marked for a write it then undid, as a refused push
      // leaves its data-name directory
      await first.service.markDirty({ relPath: dir });
      await markAndWrite(second, peer, peerBytes);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");

      await first.service.clearDirty!([dir]);
      assertUnchanged(
        await first.service.pushChanged(),
        "first pushChanged() after clearDirty",
      );
      assertChanged(await first.service.pullChanged(), "first pullChanged()");
      await assertHasBytes(
        first,
        peer,
        peerBytes,
        "a cleared directory mark must not delete the peer's file remotely",
      );

      await first.service.markDirty({ relPath: dir });
      await writeLocal(first.cacheDir, later, laterBytes);
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        later,
        laterBytes,
        "a mark made after clearDirty must still be pushed",
      );
    },
  },
  {
    name: "repair-unpushed",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const rel = `${ROOT}/repair-unpushed/raw`;
      const bytes = sampleBytes("repair-unpushed");
      // Written behind the sync service, so no push will ever send it.
      await writeLocal(first.cacheDir, rel, bytes);
      assertUnchanged(
        await first.service.pushChanged(),
        "first pushChanged() of a file that was never marked",
      );

      const preview = await first.service.repairUnpushedFiles!({
        dryRun: true,
      });
      assertEquals(
        preview.samplePaths.includes(rel),
        true,
        "a dry run must report a cache file the remote never received",
      );
      assertEquals(
        preview.unpushed >= 1,
        true,
        "a dry run must count a cache file the remote never received as unpushed",
      );
      assertEquals(preview.uploaded, 0, "a dry run must upload nothing");
      assertUnchanged(
        await second.service.pullChanged(),
        "second pullChanged() after a dry run",
      );

      const summary = await first.service.repairUnpushedFiles!();
      assertEquals(
        summary.uploaded >= 1,
        true,
        "repairUnpushedFiles must upload the unpushed file",
      );
      assertEquals(
        summary.samplePaths.includes(rel),
        false,
        "a real run reports only the files it left unuploaded",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertHasBytes(
        second,
        rel,
        bytes,
        "a file repairUnpushedFiles uploaded must pull on second",
      );
    },
  },
  {
    name: "repair-unpushed-keeps-pending",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const gone = `${ROOT}/repair-keeps-pending/gone/raw`;
      const stranded = `${ROOT}/repair-keeps-pending/stranded/raw`;
      await markAndWrite(first, gone, sampleBytes("repair-gone"));
      assertChanged(await first.service.pushChanged(), "first pushChanged()");
      await markAndDelete(first, gone);
      await writeLocal(first.cacheDir, stranded, sampleBytes("repair-pend"));

      const preview = await first.service.repairUnpushedFiles!({
        dryRun: true,
      });
      assertEquals(
        preview.pendingChanges,
        true,
        "a recorded delete not yet pushed is a pending change",
      );
      await first.service.repairUnpushedFiles!();
      assertChanged(
        await first.service.pushChanged(),
        "first pushChanged() of the recorded delete",
      );
      assertChanged(await second.service.pullChanged(), "second pullChanged()");
      await assertAbsent(
        second,
        gone,
        "repairUnpushedFiles must leave a recorded delete for the next push (contract rule 8)",
      );
    },
  },
  {
    name: "repair-unpushed-keeps-fingerprint",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const peers = `${ROOT}/repair-keeps-fingerprint/peers/raw`;
      const stranded = `${ROOT}/repair-keeps-fingerprint/stranded/raw`;
      const bytes = sampleBytes("repair-fingerprint-peer");
      await markAndWrite(second, peers, bytes);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");
      await writeLocal(first.cacheDir, stranded, sampleBytes("repair-fp"));

      await first.service.repairUnpushedFiles!();
      await first.service.pullChanged();
      await assertHasBytes(
        first,
        peers,
        bytes,
        "a repair must not advance the sync fingerprint, or the next pull skips a peer's earlier commit (contract rule 8)",
      );
    },
  },
  {
    name: "repair-unpushed-classifies",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const dir = `${ROOT}/repair-classifies`;
      const edited = `${dir}/edited/raw`;
      const stale = `${dir}/stale/raw`;
      const both = `${dir}/both/raw`;
      const peerDeleted = `${dir}/peer-deleted/raw`;
      const editedV1 = sampleBytes("edited-v1");
      const staleV2 = sampleBytes("stale-v2");
      const bothV2 = sampleBytes("both-v2");
      await markAndWrite(second, edited, editedV1);
      for (const rel of [stale, both, peerDeleted]) {
        await markAndWrite(second, rel, sampleBytes(`v1-${rel}`));
      }
      assertChanged(await second.service.pushChanged(), "second pushChanged()");
      assertChanged(await first.service.pullChanged(), "first pullChanged()");
      await writeLocal(first.cacheDir, edited, sampleBytes("edited-local"));
      await writeLocal(first.cacheDir, both, sampleBytes("both-local"));
      await markAndWrite(second, stale, staleV2);
      await markAndWrite(second, both, bothV2);
      await markAndDelete(second, peerDeleted);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");

      const preview = await first.service.repairUnpushedFiles!({
        dryRun: true,
        exact: true,
      });
      assertEquals(
        [edited, both].every((rel) => preview.sampleModified.includes(rel)),
        true,
        "a file edited since the last sync must be locallyModified, even when the remote moved on too",
      );
      assertEquals(
        preview.sampleModified.includes(stale),
        false,
        "a stale copy of a file a peer changed is not a local change",
      );
      assertEquals(
        preview.remoteMovedOn >= 2,
        true,
        "files a peer changed since the last sync must count as remoteMovedOn",
      );
      assertEquals(
        preview.samplePaths.includes(peerDeleted),
        false,
        "a file a peer deleted after the last sync is not unpushed",
      );
      await first.service.repairUnpushedFiles!();
      assertCount(await second.service.pullChanged(), "second pullChanged()");
      await assertAbsent(
        second,
        peerDeleted,
        "repairUnpushedFiles must not bring back a file a peer deleted",
      );
      const peersBytes = [
        [edited, editedV1],
        [stale, staleV2],
        [both, bothV2],
      ] as const;
      for (const [rel, bytes] of peersBytes) {
        await assertHasBytes(
          second,
          rel,
          bytes,
          "a real repair reports a local edit or stale copy and never uploads it (contract rule 2)",
        );
      }
    },
  },
  {
    name: "repair-unpushed-peer-deleted",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const dir = `${ROOT}/repair-peer-deleted`;
      const kept = `${dir}/kept/raw`;
      const other = `${dir}/other/raw`;
      // other keeps the remote non-empty, so a pull is free to remove an
      // unchanged copy; kept is edited, so every pull keeps it.
      for (const rel of [kept, other]) {
        await markAndWrite(second, rel, sampleBytes(`v1-${rel}`));
      }
      assertChanged(await second.service.pushChanged(), "second pushChanged()");
      assertChanged(await first.service.pullChanged(), "first pullChanged()");
      await writeLocal(first.cacheDir, kept, sampleBytes("kept-edited"));
      await markAndDelete(second, kept);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");
      assertCount(await first.service.pullChanged(), "first pullChanged()");

      const preview = await first.service.repairUnpushedFiles!({
        dryRun: true,
      });
      assertEquals(
        preview.samplePaths.includes(kept),
        false,
        "a copy a pull kept after a peer deleted its key is not unpushed (contract rule 10)",
      );
      // A pull that removes even an edited copy leaves nothing to classify,
      // so only the final check, that second never gets it back, applies.
      if (await readLocalFile(first.cacheDir, kept)) {
        assertEquals(
          preview.samplePeerDeleted.includes(kept),
          true,
          "a copy a pull kept after a peer deleted its key is peerDeleted",
        );
        assertEquals(
          preview.peerDeleted >= 1,
          true,
          "a copy a pull kept after a peer deleted its key counts as peerDeleted",
        );
      }
      await first.service.repairUnpushedFiles!();
      assertCount(await second.service.pullChanged(), "second pullChanged()");
      await assertAbsent(
        second,
        kept,
        "repairUnpushedFiles must not bring back a file a peer deleted before the last pull",
      );
    },
  },
  {
    name: "repair-unpushed-already-present",
    skip: skipWithoutRepairUnpushed,
    run: async ({ first, second }) => {
      const rel = `${ROOT}/repair-already-present/raw`;
      await writeLocal(first.cacheDir, rel, sampleBytes("repair-ours"));
      const theirs = sampleBytes("repair-theirs");
      await markAndWrite(second, rel, theirs);
      assertChanged(await second.service.pushChanged(), "second pushChanged()");

      const summary = await first.service.repairUnpushedFiles!();
      assertEquals(
        summary.sampleAlreadyPresent.includes(rel),
        true,
        "a local file whose key a peer pushed with other bytes is alreadyPresent",
      );
      assertUnchanged(
        await second.service.pullChanged(),
        "second pullChanged() after the repair",
      );
      await assertHasBytes(
        second,
        rel,
        theirs,
        "repairUnpushedFiles must never overwrite a key the remote holds",
      );
    },
  },
];

/**
 * counts may be void (unknown); a failing case rejects naming it and skipped
 * cases are returned; defaults follow the S3 and GCS extensions and may change,
 * so assert on the cases you rely on
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
