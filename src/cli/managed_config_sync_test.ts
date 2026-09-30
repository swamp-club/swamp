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
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join, resolve } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  flushAfterManagedConfigMutation,
  ManagedConfigUnpublishedError,
  pullManagedConfigAtBoot,
  pushManagedConfigChanges,
  pushManagedConfigPaths,
  pushManagedConfigPathsDeferred,
  pushManagedLockfileIfChangedDeferred,
  snapshotLockfileHash,
} from "./managed_config_sync.ts";
import { UserError } from "../domain/errors.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/mod.ts";
import { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import type {
  CustomDatastoreConfig,
  DatastoreConfig,
  FilesystemDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

function createMockSyncService(): {
  service: DatastoreSyncService;
  markDirtyCalls: unknown[];
  pushCalls: Array<{ namespace?: string }>;
} {
  const markDirtyCalls: unknown[] = [];
  const pushCalls: Array<{ namespace?: string }> = [];
  const service = {
    markDirty: (opts?: unknown) => {
      markDirtyCalls.push(opts);
      return Promise.resolve();
    },
    pushChanged: (opts?: { namespace?: string }) => {
      pushCalls.push(opts ?? {});
      return Promise.resolve();
    },
    pullChanged: () => Promise.resolve(0),
    capabilities: () => ({}),
  } as unknown as DatastoreSyncService;
  return { service, markDirtyCalls, pushCalls };
}

function makeMarker(
  opts: { managedConfig?: boolean; type?: string } = {},
): RepoMarkerData {
  return {
    swampVersion: "0.1.0",
    repoId: "test-repo-id",
    initializedAt: "2026-01-01T00:00:00Z",
    tools: [],
    gitignoreManaged: false,
    datastore: {
      type: opts.type ?? "@swamp/s3-datastore",
      managedConfig: opts.managedConfig ?? false,
    },
  };
}

const S3_CONFIG: CustomDatastoreConfig = {
  type: "@swamp/s3-datastore",
  config: { bucket: "test" },
  datastorePath: "/cache/s3",
  namespace: "ns1",
};

const FS_CONFIG: FilesystemDatastoreConfig = {
  type: "filesystem",
  path: "/data",
};

Deno.test("pushManagedConfigChanges: pushes when managedConfig is true", async () => {
  const { service, markDirtyCalls, pushCalls } = createMockSyncService();
  const marker = makeMarker({ managedConfig: true });

  await pushManagedConfigChanges(service, S3_CONFIG, marker);

  assertEquals(markDirtyCalls.length, 1);
  assertEquals(pushCalls.length, 1);
  assertEquals(pushCalls[0].namespace, "ns1");
});

Deno.test("pushManagedConfigChanges: no-op when managedConfig is false", async () => {
  const { service, markDirtyCalls, pushCalls } = createMockSyncService();
  const marker = makeMarker({ managedConfig: false });

  await pushManagedConfigChanges(service, FS_CONFIG, marker);

  assertEquals(markDirtyCalls.length, 0);
  assertEquals(pushCalls.length, 0);
});

Deno.test("pushManagedConfigChanges: no-op when syncService is undefined", async () => {
  const marker = makeMarker({ managedConfig: true });

  await pushManagedConfigChanges(undefined, S3_CONFIG, marker);
});

Deno.test("pushManagedConfigChanges: no-op when marker is null", async () => {
  const { service, markDirtyCalls, pushCalls } = createMockSyncService();

  await pushManagedConfigChanges(service, FS_CONFIG, null);

  assertEquals(markDirtyCalls.length, 0);
  assertEquals(pushCalls.length, 0);
});

function assertUnpublished(error: unknown, cause: unknown): void {
  assertInstanceOf(error, ManagedConfigUnpublishedError);
  assertInstanceOf(error, UserError);
  assertEquals(error.code, "managed_config_unpublished");
  assertStringIncludes(error.message, "saved locally but was not published");
  assertStringIncludes(error.message, "swamp datastore sync --push");
  assertEquals(error.cause, cause);
}

Deno.test("pushManagedConfigChanges: a push error throws ManagedConfigUnpublishedError", async () => {
  const cause = new Error("S3 unreachable");
  const service = {
    markDirty: () => Promise.resolve(),
    pushChanged: () => Promise.reject(cause),
    pullChanged: () => Promise.resolve(0),
    capabilities: () => ({}),
  } as unknown as DatastoreSyncService;
  const marker = makeMarker({ managedConfig: true });

  const error = await assertRejects(() =>
    pushManagedConfigChanges(service, S3_CONFIG, marker)
  );
  assertUnpublished(error, cause);
  assertStringIncludes((error as Error).message, "S3 unreachable");
});

Deno.test("ManagedConfigUnpublishedError: does not double a trailing period from the cause", () => {
  const error = new ManagedConfigUnpublishedError(new Error("S3 down."));
  assertStringIncludes(error.message, "datastore: S3 down. Run");
});

Deno.test("pushManagedConfigChanges: passes undefined namespace for filesystem config", async () => {
  const { service, pushCalls } = createMockSyncService();
  const fsConfig: DatastoreConfig = {
    type: "filesystem",
    path: "/data",
  };
  const marker = makeMarker({
    managedConfig: true,
    type: "filesystem",
  });

  await pushManagedConfigChanges(service, fsConfig, marker);

  assertEquals(pushCalls.length, 1);
  assertEquals(pushCalls[0].namespace, undefined);
});

function createRecordingSyncService(): {
  service: DatastoreSyncService;
  events: Array<
    | { kind: "mark"; relPath: string | undefined }
    | { kind: "push"; namespace?: string; hasSignal: boolean }
  >;
} {
  const events: Array<
    | { kind: "mark"; relPath: string | undefined }
    | { kind: "push"; namespace?: string; hasSignal: boolean }
  > = [];
  const service = {
    markDirty: (opts?: { relPath?: string }) => {
      events.push({ kind: "mark", relPath: opts?.relPath });
      return Promise.resolve();
    },
    pushChanged: (opts?: { namespace?: string; signal?: AbortSignal }) => {
      events.push({
        kind: "push",
        namespace: opts?.namespace,
        hasSignal: opts?.signal instanceof AbortSignal,
      });
      return Promise.resolve(1);
    },
    pullChanged: () => Promise.resolve(0),
  } as unknown as DatastoreSyncService;
  return { service, events };
}

const PATHS_REPO = resolve("swamp-paths-test-repo");
const PATHS_CACHE = resolve("swamp-paths-test-cache");
const PATHS_CONFIG: CustomDatastoreConfig = {
  type: "@swamp/s3-datastore",
  config: { bucket: "test" },
  datastorePath: PATHS_CACHE,
  cachePath: PATHS_CACHE,
  namespace: "ns1",
};
const TIER_LOCKFILE = join(
  PATHS_CACHE,
  "ns1",
  "config",
  "upstream_extensions.json",
);

Deno.test("pushManagedConfigPaths: marks each path with its namespaced cache-relative key, then pushes", async () => {
  const { service, events } = createRecordingSyncService();
  const archive = join(PATHS_CACHE, "ns1", "config", "archives", "a.tgz");

  await pushManagedConfigPaths(
    service,
    PATHS_CONFIG,
    makeMarker({ managedConfig: true }),
    PATHS_REPO,
    [TIER_LOCKFILE, archive],
  );

  assertEquals(events, [
    { kind: "mark", relPath: "ns1/config/upstream_extensions.json" },
    { kind: "mark", relPath: "ns1/config/archives/a.tgz" },
    { kind: "push", namespace: "ns1", hasSignal: true },
  ]);
});

Deno.test("pushManagedConfigPaths: drops paths outside the namespace's cache tree", async () => {
  const { service, events } = createRecordingSyncService();

  await pushManagedConfigPaths(
    service,
    PATHS_CONFIG,
    makeMarker({ managedConfig: true }),
    PATHS_REPO,
    [
      // The in-repo lockfile: the mark hook would map it to an
      // un-namespaced config/ key.
      join(PATHS_REPO, ".swamp", "config", "upstream_extensions.json"),
      join(PATHS_CACHE, "other-ns", "config", "upstream_extensions.json"),
      join(PATHS_CACHE, "ns1"),
    ],
  );

  assertEquals(events, []);
});

Deno.test("pushManagedConfigPaths: without a namespace, keys are relative to the cache root", async () => {
  const { service, events } = createRecordingSyncService();

  await pushManagedConfigPaths(
    service,
    { ...PATHS_CONFIG, namespace: undefined },
    makeMarker({ managedConfig: true }),
    PATHS_REPO,
    [join(PATHS_CACHE, "config", "upstream_extensions.json")],
  );

  assertEquals(events, [
    { kind: "mark", relPath: "config/upstream_extensions.json" },
    { kind: "push", namespace: undefined, hasSignal: true },
  ]);
});

Deno.test("pushManagedConfigPaths: no-op without managedConfig, a sync service or a cache", async () => {
  const { service, events } = createRecordingSyncService();

  await pushManagedConfigPaths(
    service,
    PATHS_CONFIG,
    makeMarker({ managedConfig: false }),
    PATHS_REPO,
    [TIER_LOCKFILE],
  );
  await pushManagedConfigPaths(
    undefined,
    PATHS_CONFIG,
    makeMarker({ managedConfig: true }),
    PATHS_REPO,
    [TIER_LOCKFILE],
  );
  await pushManagedConfigPaths(
    service,
    { ...PATHS_CONFIG, cachePath: undefined },
    makeMarker({ managedConfig: true }),
    PATHS_REPO,
    [TIER_LOCKFILE],
  );
  await pushManagedConfigPaths(
    service,
    FS_CONFIG,
    makeMarker({ managedConfig: true, type: "filesystem" }),
    PATHS_REPO,
    [TIER_LOCKFILE],
  );

  assertEquals(events, []);
});

Deno.test("pushManagedConfigPaths: a push error throws ManagedConfigUnpublishedError", async () => {
  const { service, events } = createRecordingSyncService();
  const cause = new Error("S3 unreachable");
  service.pushChanged = () => Promise.reject(cause);

  const error = await assertRejects(() =>
    pushManagedConfigPaths(
      service,
      PATHS_CONFIG,
      makeMarker({ managedConfig: true }),
      PATHS_REPO,
      [TIER_LOCKFILE],
    )
  );

  assertUnpublished(error, cause);
  assertEquals(events, [
    { kind: "mark", relPath: "ns1/config/upstream_extensions.json" },
  ]);
});

Deno.test("pushManagedConfigPathsDeferred: a failure to resolve the datastore throws ManagedConfigUnpublishedError", async () => {
  await withTempDir(async (dir) => {
    // Not an initialized repo, so resolving the datastore fails.
    const error = await assertRejects(() =>
      pushManagedConfigPathsDeferred(
        dir,
        makeMarker({ managedConfig: true }),
        [join(dir, "upstream_extensions.json")],
      )
    );
    assertInstanceOf(error, ManagedConfigUnpublishedError);
    assertStringIncludes(error.message, "Not a swamp repository");
  });
});

Deno.test("pushManagedConfigPathsDeferred: no-op without managedConfig or paths", async () => {
  await withTempDir(async (dir) => {
    await pushManagedConfigPathsDeferred(dir, makeMarker(), [
      join(dir, "upstream_extensions.json"),
    ]);
    await pushManagedConfigPathsDeferred(
      dir,
      makeMarker({ managedConfig: true }),
      [],
    );
  });
});

Deno.test("snapshotLockfileHash: null for a missing lockfile, stable for unchanged content", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    assertEquals(await snapshotLockfileHash(path), null);
    await Deno.writeTextFile(path, "{}");
    const hash = await snapshotLockfileHash(path);
    assertEquals(await snapshotLockfileHash(path), hash);
  });
});

function createRecordingPush() {
  const calls: Array<{ repoDir: string; paths: readonly string[] }> = [];
  const push = (
    repoDir: string,
    _marker: RepoMarkerData | null,
    paths: readonly string[],
  ) => {
    calls.push({ repoDir, paths });
    return Promise.resolve();
  };
  return { calls, push };
}

Deno.test("pushManagedLockfileIfChangedDeferred: pushes the lockfile only when its content changed", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(path, "{}");
    const before = await snapshotLockfileHash(path);
    const marker = makeMarker({ managedConfig: true });
    const { calls, push } = createRecordingPush();

    await pushManagedLockfileIfChangedDeferred(dir, marker, path, before, push);
    assertEquals(calls, []);

    await Deno.writeTextFile(path, '{"@acme/a":{}}');
    await pushManagedLockfileIfChangedDeferred(dir, marker, path, before, push);
    assertEquals(calls, [{ repoDir: dir, paths: [path] }]);
  });
});

Deno.test("pushManagedLockfileIfChangedDeferred: a lockfile the command created counts as changed", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const before = await snapshotLockfileHash(path);
    await Deno.writeTextFile(path, "{}");
    const { calls, push } = createRecordingPush();

    await pushManagedLockfileIfChangedDeferred(
      dir,
      makeMarker({ managedConfig: true }),
      path,
      before,
      push,
    );

    assertEquals(calls, [{ repoDir: dir, paths: [path] }]);
  });
});

Deno.test("pushManagedLockfileIfChangedDeferred: no-op without managedConfig", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(path, "{}");
    const { calls, push } = createRecordingPush();

    await pushManagedLockfileIfChangedDeferred(
      dir,
      makeMarker({ managedConfig: false }),
      path,
      null,
      push,
    );

    assertEquals(calls, []);
  });
});

Deno.test("pushManagedLockfileIfChangedDeferred: an unchanged lockfile makes no push even when the push would fail", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(path, "{}");
    const before = await snapshotLockfileHash(path);
    let pushes = 0;
    const failingPush = () => {
      pushes++;
      return Promise.reject(
        new ManagedConfigUnpublishedError(new Error("S3 unreachable")),
      );
    };

    await pushManagedLockfileIfChangedDeferred(
      dir,
      makeMarker({ managedConfig: true }),
      path,
      before,
      failingPush,
    );

    assertEquals(pushes, 0);
  });
});

Deno.test("pushManagedLockfileIfChangedDeferred: propagates the push helper's error for a changed lockfile", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const before = await snapshotLockfileHash(path);
    await Deno.writeTextFile(path, "{}");
    const cause = new ManagedConfigUnpublishedError(new Error("S3 down"));

    const error = await assertRejects(() =>
      pushManagedLockfileIfChangedDeferred(
        dir,
        makeMarker({ managedConfig: true }),
        path,
        before,
        () => Promise.reject(cause),
      )
    );

    assertEquals(error, cause);
  });
});

Deno.test("pushManagedLockfileIfChangedDeferred: an unreadable lockfile throws ManagedConfigUnpublishedError", async () => {
  await withTempDir(async (dir) => {
    // A directory at the lockfile path cannot be read as a file.
    const path = join(dir, "upstream_extensions.json");
    await ensureDir(path);
    const { calls, push } = createRecordingPush();

    const error = await assertRejects(() =>
      pushManagedLockfileIfChangedDeferred(
        dir,
        makeMarker({ managedConfig: true }),
        path,
        null,
        push,
      )
    );

    assertInstanceOf(error, ManagedConfigUnpublishedError);
    assertEquals(calls, []);
  });
});

Deno.test("flushAfterManagedConfigMutation: a failed flush after the mutation throws ManagedConfigUnpublishedError", async () => {
  const cause = new Error("push failed");
  const cleanupErrors: unknown[] = [];

  const error = await assertRejects(() =>
    flushAfterManagedConfigMutation(
      () => Promise.reject(cause),
      true,
      makeMarker({ managedConfig: true }),
      (e) => cleanupErrors.push(e),
    )
  );

  assertUnpublished(error, cause);
  assertEquals(cleanupErrors, []);
});

Deno.test("flushAfterManagedConfigMutation: before the mutation completed, a failed flush only reports", async () => {
  const cause = new Error("push failed");
  const cleanupErrors: unknown[] = [];

  await flushAfterManagedConfigMutation(
    () => Promise.reject(cause),
    false,
    makeMarker({ managedConfig: true }),
    (e) => cleanupErrors.push(e),
  );

  assertEquals(cleanupErrors, [cause]);
});

Deno.test("flushAfterManagedConfigMutation: an in-flight error is not replaced by the flush failure", async () => {
  const original = new Error("delete failed");
  const cleanupErrors: unknown[] = [];
  let mutated = false;

  const error = await assertRejects(async () => {
    try {
      await Promise.reject(original);
      mutated = true;
    } finally {
      await flushAfterManagedConfigMutation(
        () => Promise.reject(new Error("push failed")),
        mutated,
        makeMarker({ managedConfig: true }),
        (e) => cleanupErrors.push(e),
      );
    }
  });

  assertEquals(error, original);
  assertEquals(cleanupErrors.length, 1);
});

Deno.test("flushAfterManagedConfigMutation: without managedConfig a failed flush only reports", async () => {
  const cleanupErrors: unknown[] = [];

  await flushAfterManagedConfigMutation(
    () => Promise.reject(new Error("push failed")),
    true,
    makeMarker({ managedConfig: false }),
    (e) => cleanupErrors.push(e),
  );

  assertEquals(cleanupErrors.length, 1);
});

Deno.test("flushAfterManagedConfigMutation: a successful flush neither throws nor reports", async () => {
  const cleanupErrors: unknown[] = [];
  let flushed = false;

  await flushAfterManagedConfigMutation(
    () => {
      flushed = true;
      return Promise.resolve();
    },
    true,
    makeMarker({ managedConfig: true }),
    (e) => cleanupErrors.push(e),
  );

  assert(flushed);
  assertEquals(cleanupErrors, []);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-managed-config-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * A sync service whose config pull lands a pulled extension — lockfile
 * entry plus one workflow — in a cache that was empty until then, as on a
 * fresh serve instance backed by a remote datastore.
 */
function createPullingSyncService(configBase: string): {
  service: Pick<DatastoreSyncService, "pullChanged">;
  pullCalls: Array<{ subdirs?: readonly string[]; namespace?: string }>;
} {
  const pullCalls: Array<{ subdirs?: readonly string[]; namespace?: string }> =
    [];
  const service = {
    pullChanged: async (
      opts?: { subdirs?: readonly string[]; namespace?: string },
    ) => {
      pullCalls.push({ subdirs: opts?.subdirs, namespace: opts?.namespace });
      const workflowsDir = join(
        configBase,
        "pulled-extensions",
        "@example",
        "pkg-a",
        "workflows",
      );
      await ensureDir(workflowsDir);
      await Deno.writeTextFile(
        join(workflowsDir, "deploy.yaml"),
        stringifyYaml({
          id: crypto.randomUUID(),
          name: "pkg-a-deploy",
          version: 1,
          jobs: [{
            name: "deploy",
            steps: [{
              name: "run",
              task: {
                type: "model_method",
                modelIdOrName: "thing",
                methodName: "run",
              },
            }],
          }],
        }),
      );
      await Deno.writeTextFile(
        join(configBase, "upstream_extensions.json"),
        JSON.stringify({
          "@example/pkg-a": {
            version: "2026.09.25.1",
            pulledAt: "2026-09-25T00:00:00Z",
          },
        }),
      );
      return 2;
    },
  };
  return { service, pullCalls };
}

Deno.test("pullManagedConfigAtBoot: registers pulled workflows on a fresh instance with an empty cache", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, "cache", "config");
    const lockfilePath = join(configBase, "upstream_extensions.json");
    const pulledExtensionsRoot = join(configBase, "pulled-extensions");

    // Built as requireInitializedRepoUnlocked builds it: pulled workflow
    // dirs enumerated before anything has been pulled, so none are found.
    const extensionWorkflowRepo = new ExtensionWorkflowRepository(
      join(repoDir, "workflows"),
      await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "workflows",
        pulledExtensionsRoot,
      ),
    );
    assertEquals(await extensionWorkflowRepo.findAll(), []);

    const { service, pullCalls } = createPullingSyncService(configBase);
    let invalidations = 0;
    await pullManagedConfigAtBoot({
      syncService: service,
      namespace: "ns1",
      catalogInvalidate: () => invalidations++,
      extensionWorkflowRepo,
      repoDir,
      lockfilePath,
      pulledExtensionsRoot,
    });

    assertEquals(pullCalls, [{
      subdirs: ["config", "auto-definitions"],
      namespace: "ns1",
    }]);
    assertEquals(invalidations, 1);
    const workflows = await extensionWorkflowRepo.findAll();
    assertEquals(workflows.map((w) => w.name), ["pkg-a-deploy"]);
  });
});

Deno.test("pullManagedConfigAtBoot: pulls and invalidates when there is no extension workflow repository", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, "cache", "config");
    const { service, pullCalls } = createPullingSyncService(configBase);
    let invalidations = 0;

    await pullManagedConfigAtBoot({
      syncService: service,
      catalogInvalidate: () => invalidations++,
      extensionWorkflowRepo: null,
      repoDir,
      lockfilePath: join(configBase, "upstream_extensions.json"),
    });

    assertEquals(pullCalls.length, 1);
    assertEquals(invalidations, 1);
  });
});
