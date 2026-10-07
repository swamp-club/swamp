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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  buildManagedLockfileTransaction,
  createManagedLockfileTransaction,
  ManagedConfigUnpublishedError,
  ManagedLockfileUnavailableError,
  pullManagedConfigAtBoot,
  pushManagedConfigChanges,
  reportManagedConfigCleanupError,
  runManagedConfigMutation,
} from "./managed_config_sync.ts";
import { UserError } from "../domain/errors.ts";
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import {
  markLockfilePublishPending,
  readLockfilePublishPending,
} from "../infrastructure/persistence/pending_lockfile_publish.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { ManagedLockfileUnpublishedError } from "../libswamp/extensions/managed_lockfile_transaction.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/extensions/enumerate_pulled.ts";
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

/**
 * A repo context whose mark hook forwards a bare mark to `service`, as
 * `buildMarkDirtyHook` does, and records the order of marks and pushes.
 */
function rootRepoContext(service: DatastoreSyncService, events: string[]) {
  const recorded = {
    ...service,
    markDirty: (opts?: unknown) => {
      events.push("mark");
      return service.markDirty(opts as never);
    },
    pushChanged: (opts?: { namespace?: string }) => {
      events.push("push");
      return service.pushChanged(opts);
    },
  } as DatastoreSyncService;
  return {
    syncService: recorded,
    repoContext: { markDirty: () => recorded.markDirty() },
  };
}

Deno.test("runManagedConfigMutation: marks bare after the mutation, then pushes through the root", async () => {
  const { service, markDirtyCalls, pushCalls } = createMockSyncService();
  const events: string[] = [];
  const { syncService, repoContext } = rootRepoContext(service, events);

  const value = await runManagedConfigMutation(
    repoContext,
    syncService,
    S3_CONFIG,
    makeMarker({ managedConfig: true }),
    "model create",
    () => {
      events.push("mutate");
      return Promise.resolve("created");
    },
  );

  assertEquals(value, "created");
  assertEquals(events, ["mutate", "mark", "push"]);
  assertEquals(markDirtyCalls, [undefined]);
  assertEquals(pushCalls, [{ namespace: "ns1" }]);
});

Deno.test("runManagedConfigMutation: a failed mutation marks and pushes nothing", async () => {
  const { service } = createMockSyncService();
  const events: string[] = [];
  const { syncService, repoContext } = rootRepoContext(service, events);

  await assertRejects(
    () =>
      runManagedConfigMutation(
        repoContext,
        syncService,
        S3_CONFIG,
        makeMarker({ managedConfig: true }),
        "model create",
        () => Promise.reject(new Error("invalid model")),
      ),
    Error,
    "invalid model",
  );
  assertEquals(events, []);
});

Deno.test("runManagedConfigMutation: without managedConfig nothing is marked or pushed", async () => {
  const { service } = createMockSyncService();
  const events: string[] = [];
  const { syncService, repoContext } = rootRepoContext(service, events);

  await runManagedConfigMutation(
    repoContext,
    syncService,
    S3_CONFIG,
    makeMarker({ managedConfig: false }),
    "model create",
    () => Promise.resolve(),
  );
  assertEquals(events, []);
});

Deno.test("runManagedConfigMutation: a push error throws ManagedConfigUnpublishedError", async () => {
  const cause = new Error("S3 unreachable");
  const service = {
    markDirty: () => Promise.resolve(),
    pushChanged: () => Promise.reject(cause),
    pullChanged: () => Promise.resolve(0),
    capabilities: () => ({}),
  } as unknown as DatastoreSyncService;

  const error = await assertRejects(() =>
    runManagedConfigMutation(
      { markDirty: () => service.markDirty() },
      service,
      S3_CONFIG,
      makeMarker({ managedConfig: true }),
      "model create",
      () => Promise.resolve(),
    )
  );
  assertUnpublished(error, cause);
});

Deno.test("runManagedConfigMutation: a mark error throws ManagedConfigUnpublishedError and skips the push", async () => {
  const cause = new Error("cache unwritable");
  const pushes: unknown[] = [];
  const service = {
    markDirty: () => Promise.reject(cause),
    pushChanged: (opts?: unknown) => {
      pushes.push(opts);
      return Promise.resolve();
    },
    pullChanged: () => Promise.resolve(0),
    capabilities: () => ({}),
  } as unknown as DatastoreSyncService;

  const error = await assertRejects(() =>
    runManagedConfigMutation(
      { markDirty: () => service.markDirty() },
      service,
      S3_CONFIG,
      makeMarker({ managedConfig: true }),
      "model create",
      () => Promise.resolve(),
    )
  );
  assertUnpublished(error, cause);
  assertEquals(pushes, []);
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

function createLockfileSyncService(
  cacheDir: string,
  remote: { lockfile: string | null },
  options: { failPull?: boolean } = {},
): {
  service: DatastoreSyncService;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  const tierLockfile = join(
    cacheDir,
    "ns1",
    "config",
    "upstream_extensions.json",
  );
  const service = {
    markDirty: (opts?: { relPath?: string }) => {
      events.push({ kind: "mark", relPath: opts?.relPath });
      return Promise.resolve();
    },
    pullChanged: async (
      opts?: { subdirs?: string[]; namespace?: string; signal?: AbortSignal },
    ) => {
      events.push({
        kind: "pull",
        subdirs: opts?.subdirs,
        namespace: opts?.namespace,
        hasSignal: opts?.signal instanceof AbortSignal,
      });
      if (options.failPull) throw new Error("bucket unreachable");
      if (remote.lockfile !== null) {
        await ensureDir(join(cacheDir, "ns1", "config"));
        await Deno.writeTextFile(tierLockfile, remote.lockfile);
      }
      return 1;
    },
    pushChanged: async (opts?: { namespace?: string }) => {
      events.push({ kind: "push", namespace: opts?.namespace });
      remote.lockfile = await Deno.readTextFile(tierLockfile);
      return 1;
    },
  } as unknown as DatastoreSyncService;
  return { service, events };
}

async function withLockfileTxnDirs(
  fn: (repoDir: string, cacheDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lockfile-txn-cli-" });
  try {
    const repoDir = join(dir, "repo");
    await ensureDir(join(repoDir, ".swamp"));
    await fn(repoDir, join(dir, "cache"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const NOOP_LOCK = {
  acquire: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

Deno.test("buildManagedLockfileTransaction: fetches the config tier, then publishes only the lockfile (swamp-club#2838)", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const remote = {
      lockfile: JSON.stringify({
        "@peer/p": { version: "1", pulledAt: "2026-09-30T00:00:00.000Z" },
      }),
    };
    const { service, events } = createLockfileSyncService(cacheDir, remote);
    const lockfilePath = join(
      cacheDir,
      "ns1",
      "config",
      "upstream_extensions.json",
    );
    const transaction = buildManagedLockfileTransaction({
      syncService: service,
      datastoreConfig: {
        ...S3_CONFIG,
        datastorePath: cacheDir,
        cachePath: cacheDir,
      },
      repoDir,
      lockfilePath,
      lock: NOOP_LOCK,
    });

    await transaction.run(async () => {
      const repo = await LockfileRepository.create(lockfilePath);
      await repo.writeEntry("@me/x", "1", []);
    });

    assertEquals(events, [
      {
        kind: "pull",
        subdirs: ["config"],
        namespace: "ns1",
        hasSignal: true,
      },
      { kind: "mark", relPath: "ns1/config/upstream_extensions.json" },
      { kind: "push", namespace: "ns1" },
    ]);
    assertEquals(
      Object.keys(JSON.parse(remote.lockfile!)).sort(),
      ["@me/x", "@peer/p"],
    );
    assertEquals(await readLockfilePublishPending(repoDir), { kind: "none" });
  });
});

Deno.test("buildManagedLockfileTransaction: a failed fetch throws ManagedLockfileUnavailableError and changes nothing", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { service, events } = createLockfileSyncService(
      cacheDir,
      { lockfile: null },
      { failPull: true },
    );
    const transaction = buildManagedLockfileTransaction({
      syncService: service,
      datastoreConfig: {
        ...S3_CONFIG,
        datastorePath: cacheDir,
        cachePath: cacheDir,
      },
      repoDir,
      lockfilePath: join(cacheDir, "ns1", "config", "upstream_extensions.json"),
      lock: NOOP_LOCK,
    });
    let ran = false;
    const error = await assertRejects(
      () =>
        transaction.run(() => {
          ran = true;
          return Promise.resolve();
        }),
      ManagedLockfileUnavailableError,
      "bucket unreachable",
    );
    assertInstanceOf(error, UserError);
    assertEquals(ran, false);
    assertEquals(events.map((e) => e.kind), ["pull"]);
  });
});

Deno.test("buildManagedLockfileTransaction: an unreachable datastore lock throws ManagedLockfileUnavailableError; a held lock keeps LockTimeoutError", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { service, events } = createLockfileSyncService(cacheDir, {
      lockfile: null,
    });
    const build = (acquire: () => Promise<void>) =>
      buildManagedLockfileTransaction({
        syncService: service,
        datastoreConfig: {
          ...S3_CONFIG,
          datastorePath: cacheDir,
          cachePath: cacheDir,
        },
        repoDir,
        lockfilePath: join(
          cacheDir,
          "ns1",
          "config",
          "upstream_extensions.json",
        ),
        lock: { acquire, release: () => Promise.resolve() },
      });

    await assertRejects(
      () =>
        build(() =>
          Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:19001"))
        ).run(() => Promise.resolve()),
      ManagedLockfileUnavailableError,
      "ECONNREFUSED",
    );
    await assertRejects(
      () =>
        build(() =>
          Promise.reject(
            new LockTimeoutError(".datastore.lock", null, 60_000),
          )
        ).run(() => Promise.resolve()),
      LockTimeoutError,
    );
    assertEquals(events, []);
  });
});

Deno.test("buildManagedLockfileTransaction: a failed publish throws ManagedLockfileUnpublishedError and leaves the change pending", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { service } = createLockfileSyncService(cacheDir, { lockfile: null });
    (service as unknown as { pushChanged: () => Promise<number> })
      .pushChanged = () => Promise.reject(new Error("push refused"));
    const lockfilePath = join(
      cacheDir,
      "ns1",
      "config",
      "upstream_extensions.json",
    );
    const transaction = buildManagedLockfileTransaction({
      syncService: service,
      datastoreConfig: {
        ...S3_CONFIG,
        datastorePath: cacheDir,
        cachePath: cacheDir,
      },
      repoDir,
      lockfilePath,
      lock: NOOP_LOCK,
    });
    const error = await assertRejects(
      () =>
        transaction.run(async () => {
          const repo = await LockfileRepository.create(lockfilePath);
          await repo.writeEntry("@me/x", "1", []);
        }),
      ManagedLockfileUnpublishedError,
      "push refused",
    );
    // A plain `datastore sync --push` would publish the local copy without
    // fetching; `extension install` replays the change onto a fresh fetch.
    assertStringIncludes(error.message, "Run 'swamp extension install'");
    const pending = await readLockfilePublishPending(repoDir);
    assertEquals(pending.kind, "delta");
    assertEquals(
      pending.kind === "delta" ? Object.keys(pending.delta.upserts) : [],
      ["@me/x"],
    );
  });
});

function pushSendingNothing(
  cacheDir: string,
  repoDir: string,
  pushed: number | undefined,
): {
  transaction: ReturnType<typeof buildManagedLockfileTransaction>;
  lockfilePath: string;
} {
  const { service } = createLockfileSyncService(cacheDir, { lockfile: null });
  // The sync service reports the push as done without sending anything,
  // as one that lost track of its unpushed files does.
  (service as unknown as { pushChanged: () => Promise<number | undefined> })
    .pushChanged = () => Promise.resolve(pushed);
  const lockfilePath = join(
    cacheDir,
    "ns1",
    "config",
    "upstream_extensions.json",
  );
  const transaction = buildManagedLockfileTransaction({
    syncService: service,
    datastoreConfig: {
      ...S3_CONFIG,
      datastorePath: cacheDir,
      cachePath: cacheDir,
    },
    repoDir,
    lockfilePath,
    lock: NOOP_LOCK,
  });
  return { transaction, lockfilePath };
}

Deno.test("buildManagedLockfileTransaction: a push that sends nothing leaves the change pending", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { transaction, lockfilePath } = pushSendingNothing(
      cacheDir,
      repoDir,
      0,
    );
    const error = await assertRejects(
      () =>
        transaction.run(async () => {
          const repo = await LockfileRepository.create(lockfilePath);
          await repo.writeEntry("@me/x", "1", []);
        }),
      ManagedLockfileUnpublishedError,
      "the push uploaded nothing",
    );
    assertEquals(error.code, "managed_config_unpublished");
    assertStringIncludes(error.message, "Run 'swamp extension install'");
    const pending = await readLockfilePublishPending(repoDir);
    assertEquals(
      pending.kind === "delta" ? Object.keys(pending.delta.upserts) : [],
      ["@me/x"],
    );
  });
});

Deno.test("buildManagedLockfileTransaction: a push that does not report a count clears the change", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { transaction, lockfilePath } = pushSendingNothing(
      cacheDir,
      repoDir,
      undefined,
    );
    await transaction.run(async () => {
      const repo = await LockfileRepository.create(lockfilePath);
      await repo.writeEntry("@me/x", "1", []);
    });
    assertEquals(await readLockfilePublishPending(repoDir), { kind: "none" });
  });
});

Deno.test("buildManagedLockfileTransaction: a refresh that fails to publish an earlier change does not claim this command's change was saved", async () => {
  await withLockfileTxnDirs(async (repoDir, cacheDir) => {
    const { service } = createLockfileSyncService(cacheDir, { lockfile: null });
    (service as unknown as { pushChanged: () => Promise<number> })
      .pushChanged = () => Promise.reject(new Error("push refused"));
    await markLockfilePublishPending(repoDir, {
      upserts: {
        "@me/x": { version: "1", pulledAt: "2026-09-30T00:00:00.000Z" },
      },
      removals: [],
    });
    const transaction = buildManagedLockfileTransaction({
      syncService: service,
      datastoreConfig: {
        ...S3_CONFIG,
        datastorePath: cacheDir,
        cachePath: cacheDir,
      },
      repoDir,
      lockfilePath: join(cacheDir, "ns1", "config", "upstream_extensions.json"),
      lock: NOOP_LOCK,
    });

    const error = await assertRejects(
      () => transaction.refresh(),
      ManagedLockfileUnpublishedError,
      "An earlier extension lockfile change is still not published",
    );
    assertEquals(error.code, "managed_config_unpublished");
    assertStringIncludes(error.message, "this command did not change");
    assertEquals(error.message.includes("The change is saved locally"), false);
    assertEquals((await readLockfilePublishPending(repoDir)).kind, "delta");
  });
});

Deno.test("createManagedLockfileTransaction: none unless the lockfile is shared through an extension datastore", () => {
  const write = {
    lockfilePath: "/cache/config/upstream_extensions.json",
    publish: true,
  };
  assertEquals(
    createManagedLockfileTransaction(
      "/repo",
      makeMarker({ managedConfig: false }),
      write,
    ),
    undefined,
  );
  assertEquals(
    createManagedLockfileTransaction(
      "/repo",
      makeMarker({ managedConfig: true, type: "filesystem" }),
      write,
    ),
    undefined,
  );
  assertEquals(
    createManagedLockfileTransaction(
      "/repo",
      makeMarker({ managedConfig: true }),
      {
        ...write,
        publish: false,
      },
    ),
    undefined,
  );
  assertEquals(
    createManagedLockfileTransaction(
      "/repo",
      makeMarker({ managedConfig: true }),
      write,
    )
      ?.lockfilePath,
    write.lockfilePath,
  );
});

Deno.test("reportManagedConfigCleanupError: a failed push after the mutation throws ManagedConfigUnpublishedError", () => {
  const cause = new Error("push failed");
  const cleanupErrors: unknown[] = [];

  const error = assertThrows(() =>
    reportManagedConfigCleanupError(
      cause,
      true,
      makeMarker({ managedConfig: true }),
      (e) => cleanupErrors.push(e),
    )
  );

  assertUnpublished(error, cause);
  assertEquals(cleanupErrors, []);
});

Deno.test("reportManagedConfigCleanupError: before the mutation completed, a failure only reports", () => {
  const cause = new Error("push failed");
  const cleanupErrors: unknown[] = [];

  reportManagedConfigCleanupError(
    cause,
    false,
    makeMarker({ managedConfig: true }),
    (e) => cleanupErrors.push(e),
  );

  assertEquals(cleanupErrors, [cause]);
});

Deno.test("reportManagedConfigCleanupError: without managedConfig a failure only reports", () => {
  const cause = new Error("push failed");
  const cleanupErrors: unknown[] = [];

  reportManagedConfigCleanupError(
    cause,
    true,
    makeMarker({ managedConfig: false }),
    (e) => cleanupErrors.push(e),
  );

  assertEquals(cleanupErrors, [cause]);
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
