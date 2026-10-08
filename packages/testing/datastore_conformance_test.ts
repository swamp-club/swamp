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

import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join, relative, SEPARATOR } from "@std/path";
import { Buffer } from "node:buffer";
import {
  assertDatastoreExportConformance,
  assertLockConformance,
  assertLockTimeoutConformance,
  assertSyncServiceConformance,
  assertSyncServiceRoundTripConformance,
  assertVerifierConformance,
  type SyncServiceRoundTripFactory,
  type SyncServiceRoundTripFixture,
} from "./datastore_conformance.ts";
import { createDatastoreTestContext } from "./datastore_test_context.ts";
import type {
  DatastoreSyncOptions,
  DistributedLock,
} from "./datastore_types.ts";
import {
  createInMemoryRemote,
  type InMemoryRemoteOptions,
  type InMemorySyncService,
} from "./in_memory_remote.ts";

// --- assertDatastoreExportConformance ---

Deno.test("assertDatastoreExportConformance: passes for valid export", () => {
  const { provider } = createDatastoreTestContext();
  const validExport = {
    type: "@test/my-datastore",
    name: "Test Datastore",
    description: "A test datastore provider",
    configSchema: {
      safeParse: (v: unknown) => {
        const obj = v as Record<string, unknown>;
        return { success: typeof obj?.bucket === "string" };
      },
    },
    createProvider: (_config: Record<string, unknown>) => provider,
  };

  assertDatastoreExportConformance(validExport, {
    validConfigs: [{ bucket: "my-bucket" }],
    invalidConfigs: [{}],
  });
});

Deno.test("assertDatastoreExportConformance: fails for bad type pattern", () => {
  const { provider } = createDatastoreTestContext();
  const badExport = {
    type: "INVALID",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: true }) },
    createProvider: () => provider,
  };

  assertThrows(
    () =>
      assertDatastoreExportConformance(
        badExport as Parameters<typeof assertDatastoreExportConformance>[0],
        { validConfigs: [{}] },
      ),
    Error,
    "must match pattern",
  );
});

// --- assertLockConformance ---

Deno.test("assertLockConformance: passes for conforming in-memory lock", async () => {
  const { provider } = createDatastoreTestContext();
  const lock = provider.createLock("/test/path");
  await assertLockConformance(lock);
});

// --- assertLockTimeoutConformance ---

/**
 * Minimal contended lock: locks created by one factory share a single slot,
 * and acquire() gives up after maxWaitMs with the given rejection.
 */
function contendedLockFactory(
  reject: (lockKey: string, waitedMs: number) => unknown,
): (options: { maxWaitMs: number }) => DistributedLock {
  let held = false;
  return ({ maxWaitMs }) => ({
    acquire: async () => {
      const start = Date.now();
      while (held) {
        if (Date.now() - start >= maxWaitMs) {
          throw reject("t/.lock", Date.now() - start);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      held = true;
    },
    release: () => {
      held = false;
      return Promise.resolve();
    },
    withLock: (fn) => fn(),
    inspect: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
  });
}

Deno.test("assertLockTimeoutConformance: passes for an uppercase LOCK_TIMEOUT error", async () => {
  await assertLockTimeoutConformance(
    contendedLockFactory((lockKey, waitedMs) =>
      Object.assign(new Error("timed out"), {
        code: "LOCK_TIMEOUT",
        lockKey,
        waitedMs,
      })
    ),
  );
});

Deno.test("assertLockTimeoutConformance: fails for a plain Error", async () => {
  await assertRejects(
    () =>
      assertLockTimeoutConformance(
        contendedLockFactory(() => new Error("timed out")),
      ),
    Error,
    "code lock_timeout",
  );
});

// --- assertVerifierConformance ---

Deno.test("assertVerifierConformance: passes for conforming verifier", async () => {
  const { provider } = createDatastoreTestContext();
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});

Deno.test("assertVerifierConformance: passes for unhealthy verifier", async () => {
  const { provider } = createDatastoreTestContext({
    healthResult: { healthy: false, message: "Unreachable" },
  });
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});

// --- assertSyncServiceConformance ---

Deno.test("assertSyncServiceConformance: passes for basic sync service", async () => {
  const { provider } = createDatastoreTestContext({ withSyncService: true });
  const syncService = provider.createSyncService!("/repo", "/cache");
  await assertSyncServiceConformance(syncService);
});

Deno.test("assertSyncServiceConformance: passes for sync service with capabilities", async () => {
  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ scopedSync: true }),
  };
  await assertSyncServiceConformance(syncService, { expectScopedSync: true });
});

Deno.test("assertSyncServiceConformance: passes without capabilities method", async () => {
  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  await assertSyncServiceConformance(syncService);
});

// --- assertSyncServiceRoundTripConformance ---

async function removeTempDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A round-trip fixture whose services are in-memory remote connections. */
interface InMemoryRoundTripFixture extends SyncServiceRoundTripFixture {
  first: { service: InMemorySyncService; cacheDir: string };
  second: { service: InMemorySyncService; cacheDir: string };
}

/**
 * Two instances of one fresh in-memory remote, per case. `breakFixture`
 * lets a test swap in a deliberately broken service.
 */
function inMemoryRemoteFactory(
  remoteOptions?: InMemoryRemoteOptions,
  withFailureHook = true,
  breakFixture?: (
    fixture: InMemoryRoundTripFixture,
  ) => SyncServiceRoundTripFixture,
): SyncServiceRoundTripFactory {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-round-trip-" });
    const firstCache = join(dir, "first");
    const secondCache = join(dir, "second");
    await Deno.mkdir(firstCache);
    await Deno.mkdir(secondCache);
    const remote = createInMemoryRemote(remoteOptions);
    const fixture: InMemoryRoundTripFixture = {
      first: {
        service: remote.connect(firstCache, { instance: "first" }),
        cacheDir: firstCache,
      },
      second: {
        service: remote.connect(secondCache, { instance: "second" }),
        cacheDir: secondCache,
      },
      failNextPush: withFailureHook
        ? () => remote.failNext("push", undefined, { instance: "first" })
        : undefined,
      failNextFetch: withFailureHook
        ? () => remote.failNext("fetch", undefined, { instance: "second" })
        : undefined,
      namespace: "conformance-ns",
      cleanup: () => removeTempDir(dir),
    };
    return breakFixture ? breakFixture(fixture) : fixture;
  };
}

const ALL_ROUND_TRIP_CASES = [
  "round-trip",
  "push-deletes",
  "pull-deletes",
  "bulk-mark",
  "failed-push-retry",
  "two-phase",
  "pull-nothing-new",
  "forward-slash-paths",
  "fetch-content",
  "fetch-content-error",
  "fetch-content-namespace",
];

Deno.test("assertSyncServiceRoundTripConformance: legacy in-memory remote passes and skips only pull-deletes", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory(),
  );
  // Known gap: like the S3 and GCS datastores today, the legacy remote never
  // deletes local files on pull, so pull-deletes is skipped by default.
  assertEquals(result.skipped.map((s) => s.name), ["pull-deletes"]);
  assertEquals(
    result.passed,
    ALL_ROUND_TRIP_CASES.filter((name) => name !== "pull-deletes"),
  );
});

Deno.test("assertSyncServiceRoundTripConformance: skips failed-push-retry without a failure hook", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory(undefined, false),
  );
  assertEquals(result.skipped.map((s) => s.name), [
    "pull-deletes",
    "failed-push-retry",
    "fetch-content-error",
  ]);
});

Deno.test("assertSyncServiceRoundTripConformance: a remote whose pulls delete passes every case", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory({ semantics: { pullDeletes: true } }),
    { expectPullDeletes: true },
  );
  assertEquals(result.skipped, []);
  assertEquals(result.passed, ALL_ROUND_TRIP_CASES);
});

Deno.test("assertSyncServiceRoundTripConformance: skips every fetch-content case for a service without fetchContent", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory(undefined, true, (fixture) => {
      const { fetchContent: _fetchContent, ...service } =
        fixture.second.service;
      return withSecond(fixture, service);
    }),
  );
  const reason = "second.service has no fetchContent";
  assertEquals(result.skipped.slice(1), [
    { name: "fetch-content", reason },
    { name: "fetch-content-error", reason },
    { name: "fetch-content-namespace", reason },
  ]);
  assertEquals(result.skipped[0].name, "pull-deletes");
});

Deno.test("assertSyncServiceRoundTripConformance: a fetchContent that returns a Buffer passes every fetch-content case", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory(undefined, true, (fixture) => {
      const { service } = fixture.second;
      return withSecond(fixture, {
        ...service,
        fetchContent: async (relPath, options) => {
          const bytes = await service.fetchContent!(relPath, options);
          return bytes && Buffer.from(bytes);
        },
      });
    }),
  );
  assertEquals(result.skipped.map((s) => s.name), ["pull-deletes"]);
  assertEquals(result.passed.includes("fetch-content"), true);
  assertEquals(result.passed.includes("fetch-content-error"), true);
  assertEquals(result.passed.includes("fetch-content-namespace"), true);
});

Deno.test("assertSyncServiceRoundTripConformance: skips fetch-content-namespace for a fixture that names no namespace", async () => {
  const result = await assertSyncServiceRoundTripConformance(
    inMemoryRemoteFactory(undefined, true, (fixture) => ({
      ...fixture,
      namespace: undefined,
    })),
  );
  assertEquals(result.skipped.map((s) => s.name), [
    "pull-deletes",
    "fetch-content-namespace",
  ]);
  assertEquals(result.passed.includes("fetch-content"), true);
});

Deno.test("assertSyncServiceRoundTripConformance: pins that legacy pulls never delete local files", async () => {
  // Known gap: S3/GCS pulls keep files the remote deleted. When the legacy
  // semantics change, this test fails on purpose.
  await assertRejects(
    () =>
      assertSyncServiceRoundTripConformance(inMemoryRemoteFactory(), {
        expectPullDeletes: true,
      }),
    Error,
    'case "pull-deletes" failed',
  );
});

Deno.test("assertSyncServiceRoundTripConformance: rejects a stub service that never uploads", async () => {
  const factory: SyncServiceRoundTripFactory = async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-round-trip-" });
    const stub = () => ({
      pullChanged: () => Promise.resolve(0),
      // Claims an upload but sends nothing.
      pushChanged: () => Promise.resolve(1),
      markDirty: () => Promise.resolve(),
    });
    const firstCache = join(dir, "first");
    const secondCache = join(dir, "second");
    await Deno.mkdir(firstCache);
    await Deno.mkdir(secondCache);
    return {
      first: { service: stub(), cacheDir: firstCache },
      second: { service: stub(), cacheDir: secondCache },
      cleanup: () => removeTempDir(dir),
    };
  };
  await assertRejects(
    () => assertSyncServiceRoundTripConformance(factory),
    Error,
    'case "round-trip" failed',
  );
});

Deno.test("assertSyncServiceRoundTripConformance: a factory rejection names the case", async () => {
  const factory: SyncServiceRoundTripFactory = () =>
    Promise.reject(new Error("backend unavailable"));
  await assertRejects(
    () => assertSyncServiceRoundTripConformance(factory),
    Error,
    'sync round-trip case "round-trip" failed: backend unavailable',
  );
});

Deno.test("assertSyncServiceRoundTripConformance: rejects two instances on one cache directory", async () => {
  let cleanups = 0;
  const factory: SyncServiceRoundTripFactory = async () => {
    const fixture = await inMemoryRemoteFactory()();
    return {
      ...fixture,
      second: {
        ...fixture.second,
        // Same directory, spelled differently.
        cacheDir: join(fixture.first.cacheDir, "..", "first"),
      },
      cleanup: async () => {
        cleanups++;
        await fixture.cleanup();
      },
    };
  };
  await assertRejects(
    () => assertSyncServiceRoundTripConformance(factory),
    Error,
    "first.cacheDir and second.cacheDir must be different directories",
  );
  assertEquals(cleanups, 1);
});

Deno.test("assertSyncServiceRoundTripConformance: a cleanup error does not mask a case failure", async () => {
  const factory: SyncServiceRoundTripFactory = async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-round-trip-" });
    const stub = () => ({
      pullChanged: () => Promise.resolve(0),
      // Claims an upload but sends nothing.
      pushChanged: () => Promise.resolve(1),
      markDirty: () => Promise.resolve(),
    });
    const firstCache = join(dir, "first");
    const secondCache = join(dir, "second");
    await Deno.mkdir(firstCache);
    await Deno.mkdir(secondCache);
    return {
      first: { service: stub(), cacheDir: firstCache },
      second: { service: stub(), cacheDir: secondCache },
      cleanup: async () => {
        await removeTempDir(dir);
        throw new Error("cleanup exploded");
      },
    };
  };
  const error = await assertRejects(
    () => assertSyncServiceRoundTripConformance(factory),
    Error,
    'sync round-trip case "round-trip" failed',
  );
  assertStringIncludes(error.message, "cleanup also failed: cleanup exploded");
});

Deno.test("assertSyncServiceRoundTripConformance: a cleanup error after a passing case names the case", async () => {
  const inner = inMemoryRemoteFactory();
  const cleanupError = new Error("cleanup exploded");
  const factory: SyncServiceRoundTripFactory = async () => {
    const fixture = await inner();
    return {
      ...fixture,
      cleanup: async () => {
        await fixture.cleanup();
        throw cleanupError;
      },
    };
  };
  const error = await assertRejects(
    () => assertSyncServiceRoundTripConformance(factory),
    Error,
    'sync round-trip case "round-trip" failed: cleanup failed: cleanup exploded',
  );
  assertStrictEquals(error.cause, cleanupError);
});

Deno.test({
  name:
    "assertSyncServiceRoundTripConformance: rejects a second cacheDir that is a symlink to the first",
  // Windows hosts without Developer Mode cannot create symlinks, and
  // Windows is not fully supported yet.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const factory: SyncServiceRoundTripFactory = async () => {
      const fixture = await inMemoryRemoteFactory()();
      const link = join(fixture.first.cacheDir, "..", "second-link");
      await Deno.symlink(fixture.first.cacheDir, link, { type: "dir" });
      return {
        ...fixture,
        second: { ...fixture.second, cacheDir: link },
      };
    };
    await assertRejects(
      () => assertSyncServiceRoundTripConformance(factory),
      Error,
      "first.cacheDir and second.cacheDir must be different directories",
    );
  },
});

// --- assertSyncServiceRoundTripConformance: every case can fail ---

/** Every file in `dir`, as forward-slash paths relative to it. */
async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile) {
        found.push(relative(dir, child).split(SEPARATOR).join("/"));
      }
    }
  };
  await visit(dir);
  return found;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function withFirst(
  fixture: InMemoryRoundTripFixture,
  service: SyncServiceRoundTripFixture["first"]["service"],
): SyncServiceRoundTripFixture {
  return { ...fixture, first: { ...fixture.first, service } };
}

function withSecond(
  fixture: InMemoryRoundTripFixture,
  service: SyncServiceRoundTripFixture["second"]["service"],
): SyncServiceRoundTripFixture {
  return { ...fixture, second: { ...fixture.second, service } };
}

interface BrokenImplementation {
  /** The case the break targets; every earlier case must still pass. */
  caseName: string;
  /** What the broken service gets wrong. */
  bug: string;
  remoteOptions?: InMemoryRemoteOptions;
  options?: { expectPullDeletes?: boolean };
  breakFixture: (
    fixture: InMemoryRoundTripFixture,
  ) => SyncServiceRoundTripFixture;
}

const BROKEN_IMPLEMENTATIONS: BrokenImplementation[] = [
  {
    caseName: "round-trip",
    bug: "push claims an upload but sends nothing",
    breakFixture: (fixture) =>
      withFirst(fixture, {
        ...fixture.first.service,
        pushChanged: () => Promise.resolve(1),
      }),
  },
  {
    caseName: "push-deletes",
    bug: "push drops marks of paths that are gone on disk",
    breakFixture: (fixture) => {
      const { service, cacheDir } = fixture.first;
      const marked = new Set<string>();
      return withFirst(fixture, {
        ...service,
        markDirty: async (options) => {
          if (options?.relPath) marked.add(options.relPath);
          else await service.markDirty(options);
        },
        pushChanged: async (options) => {
          for (const relPath of marked) {
            if (await fileExists(join(cacheDir, ...relPath.split("/")))) {
              await service.markDirty({ relPath });
            }
          }
          marked.clear();
          return await service.pushChanged(options);
        },
      });
    },
  },
  {
    caseName: "pull-deletes",
    bug: "pull restores local files the remote deleted",
    remoteOptions: { semantics: { pullDeletes: true } },
    options: { expectPullDeletes: true },
    breakFixture: (fixture) => {
      const { service, cacheDir } = fixture.second;
      return withSecond(fixture, {
        ...service,
        pullChanged: async (options) => {
          const before = new Map<string, Uint8Array>();
          for (const rel of await listFiles(cacheDir)) {
            const path = join(cacheDir, ...rel.split("/"));
            before.set(path, await Deno.readFile(path));
          }
          const changed = await service.pullChanged(options);
          for (const [path, bytes] of before) {
            if (!(await fileExists(path))) await Deno.writeFile(path, bytes);
          }
          return changed;
        },
      });
    },
  },
  {
    caseName: "bulk-mark",
    bug: "a bare markDirty() is ignored",
    breakFixture: (fixture) => {
      const { service } = fixture.first;
      return withFirst(fixture, {
        ...service,
        markDirty: (options) =>
          options?.relPath ? service.markDirty(options) : Promise.resolve(),
      });
    },
  },
  {
    caseName: "failed-push-retry",
    bug: "a failed push clears dirty state before it rejects",
    breakFixture: (fixture) => {
      const { service } = fixture.first;
      let failNext = false;
      return {
        ...withFirst(fixture, {
          ...service,
          pushChanged: async (options) => {
            const changed = await service.pushChanged(options);
            if (failNext) {
              failNext = false;
              throw new Error("injected transport failure");
            }
            return changed;
          },
        }),
        failNextPush: () => {
          failNext = true;
        },
      };
    },
  },
  {
    caseName: "two-phase",
    bug: "preparePush publishes at once",
    breakFixture: (fixture) => {
      const { service } = fixture.first;
      return withFirst(fixture, {
        ...service,
        preparePush: async (options?: DatastoreSyncOptions) => {
          await service.pushChanged(options);
          return await service.preparePush(options);
        },
      } as InMemorySyncService);
    },
  },
  {
    caseName: "pull-nothing-new",
    bug: "pull rewrites every local file",
    breakFixture: (fixture) => {
      const { service, cacheDir } = fixture.second;
      return withSecond(fixture, {
        ...service,
        pullChanged: async (options) => {
          const changed = await service.pullChanged(options);
          for (const rel of await listFiles(cacheDir)) {
            const path = join(cacheDir, ...rel.split("/"));
            await Deno.writeFile(path, await Deno.readFile(path));
          }
          return changed;
        },
      });
    },
  },
  {
    caseName: "forward-slash-paths",
    // Earlier cases nest at most five segments deep.
    bug: "pull flattens paths nested deeper than five segments",
    breakFixture: (fixture) => {
      const { service, cacheDir } = fixture.second;
      return withSecond(fixture, {
        ...service,
        pullChanged: async (options) => {
          const changed = await service.pullChanged(options);
          for (const rel of await listFiles(cacheDir)) {
            if (rel.split("/").length <= 5) continue;
            await Deno.rename(
              join(cacheDir, ...rel.split("/")),
              join(cacheDir, rel.replaceAll("/", "_")),
            );
          }
          return changed;
        },
      });
    },
  },
  {
    caseName: "fetch-content",
    bug: "fetchContent writes the fetched file into the cache",
    breakFixture: (fixture) => {
      const { service, cacheDir } = fixture.second;
      return withSecond(fixture, {
        ...service,
        fetchContent: async (relPath, options) => {
          const bytes = await service.fetchContent!(relPath, options);
          if (bytes) {
            const path = join(cacheDir, ...relPath.split("/"));
            await Deno.mkdir(dirname(path), { recursive: true });
            await Deno.writeFile(path, bytes);
          }
          return bytes;
        },
      });
    },
  },
  {
    caseName: "fetch-content-error",
    bug: "fetchContent answers null when the remote cannot be read",
    breakFixture: (fixture) => {
      const { service } = fixture.second;
      return withSecond(fixture, {
        ...service,
        fetchContent: async (relPath, options) => {
          try {
            return await service.fetchContent!(relPath, options);
          } catch (error) {
            // A refused path still rejects, so the earlier case passes.
            if (String(error).includes("Path traversal")) throw error;
            return null;
          }
        },
      });
    },
  },
  {
    caseName: "fetch-content-namespace",
    bug: "fetchContent adds the namespace a second time",
    breakFixture: (fixture) => {
      const { service } = fixture.second;
      return withSecond(fixture, {
        ...service,
        fetchContent: (relPath, options) =>
          service.fetchContent!(
            options?.namespace ? `${options.namespace}/${relPath}` : relPath,
            options,
          ),
      });
    },
  },
];

Deno.test("assertSyncServiceRoundTripConformance: the broken implementations cover every case", () => {
  assertEquals(
    BROKEN_IMPLEMENTATIONS.map((broken) => broken.caseName),
    ALL_ROUND_TRIP_CASES,
  );
});

for (const broken of BROKEN_IMPLEMENTATIONS) {
  Deno.test(`assertSyncServiceRoundTripConformance: fails case "${broken.caseName}" when ${broken.bug}`, async () => {
    const error = await assertRejects(
      () =>
        assertSyncServiceRoundTripConformance(
          inMemoryRemoteFactory(
            broken.remoteOptions,
            true,
            broken.breakFixture,
          ),
          broken.options,
        ),
      Error,
    );
    assertStringIncludes(
      error.message,
      `sync round-trip case "${broken.caseName}" failed:`,
    );
  });
}

Deno.test("assertSyncServiceRoundTripConformance: an option-skipped case never calls the factory", async () => {
  let calls = 0;
  const inner = inMemoryRemoteFactory();
  const result = await assertSyncServiceRoundTripConformance(() => {
    calls++;
    return inner();
  });
  assertEquals(result.skipped.map((s) => s.name), ["pull-deletes"]);
  assertEquals(calls, ALL_ROUND_TRIP_CASES.length - 1);
});
