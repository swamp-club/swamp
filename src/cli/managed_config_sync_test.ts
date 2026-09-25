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

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  pullManagedConfigAtBoot,
  pushManagedConfigChanges,
} from "./managed_config_sync.ts";
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

Deno.test("pushManagedConfigChanges: handles push error gracefully", async () => {
  const service = {
    markDirty: () => Promise.resolve(),
    pushChanged: () => {
      return Promise.reject(new Error("S3 unreachable"));
    },
    pullChanged: () => Promise.resolve(0),
    capabilities: () => ({}),
  } as unknown as DatastoreSyncService;
  const marker = makeMarker({ managedConfig: true });

  await pushManagedConfigChanges(service, S3_CONFIG, marker);
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
