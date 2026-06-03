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
import { assertErrors, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDatastoreSyncDeps,
  datastoreSync,
  type DatastoreSyncDeps,
  type DatastoreSyncEvent,
} from "./sync.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncOptions } from "../../domain/datastore/datastore_sync_service.ts";

function makeDeps(
  overrides: Partial<DatastoreSyncDeps> = {},
): DatastoreSyncDeps {
  return {
    validateSyncSupport: () =>
      Promise.resolve({ supported: true, type: "custom" }),
    pushSync: () => Promise.resolve({ filesPushed: 5 }),
    pullSync: () => Promise.resolve({ filesPulled: 3 }),
    fullSync: () =>
      Promise.resolve({ filesPulled: 3, filesPushed: 5, errors: [] }),
    ...overrides,
  };
}

Deno.test("datastoreSync: push mode success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "push" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "push" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "push");
  assertEquals(completed.data.filesPushed, 5);
  assertEquals(completed.data.filesPulled, undefined);
});

Deno.test("datastoreSync: pull mode success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "pull" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "pull" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "pull");
  assertEquals(completed.data.filesPulled, 3);
  assertEquals(completed.data.filesPushed, undefined);
});

Deno.test("datastoreSync: full sync success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "sync" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "sync" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "sync");
  assertEquals(completed.data.filesPulled, 3);
  assertEquals(completed.data.filesPushed, 5);
  assertEquals(completed.data.errors, []);
});

// ============================================================================
// createDatastoreSyncDeps: namespace threading
// ============================================================================

const syncSpyCalls: {
  method: string;
  options: DatastoreSyncOptions | undefined;
}[] = [];

const SYNC_TEST_TYPE = "test-sync-ns-threading";

if (!datastoreTypeRegistry.has(SYNC_TEST_TYPE)) {
  datastoreTypeRegistry.register({
    type: SYNC_TEST_TYPE,
    name: "Sync NS Test",
    description: "Test datastore for namespace threading",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
        withLock: <T>(fn: () => Promise<T>) => fn(),
        inspect: () => Promise.resolve(null),
        forceRelease: () => Promise.resolve(true),
      }),
      createVerifier: () => ({
        verify: () =>
          Promise.resolve({
            healthy: true,
            message: "ok",
            latencyMs: 1,
            datastoreType: SYNC_TEST_TYPE,
          }),
      }),
      resolveDatastorePath: (repoDir: string) => `${repoDir}/.store`,
      createSyncService: () => ({
        pullChanged: (opts?: DatastoreSyncOptions) => {
          syncSpyCalls.push({ method: "pullChanged", options: opts });
          return Promise.resolve(1);
        },
        pushChanged: (opts?: DatastoreSyncOptions) => {
          syncSpyCalls.push({ method: "pushChanged", options: opts });
          return Promise.resolve(2);
        },
        markDirty: () => Promise.resolve(),
      }),
    }),
  });
}

function makeResolver(namespace?: string): DatastorePathResolver {
  const config: CustomDatastoreConfig = {
    type: SYNC_TEST_TYPE,
    config: {},
    datastorePath: "s3://bucket/path",
    cachePath: "/tmp/cache",
    ...(namespace ? { namespace } : {}),
  };
  return {
    localPath: (...segs: string[]) => `/tmp/local/${segs.join("/")}`,
    datastorePath: (...segs: string[]) => `/tmp/ds/${segs.join("/")}`,
    isDatastoreSubdir: () => true,
    isExcluded: () => false,
    resolvePath: (subdir: string, ...rest: string[]) =>
      `/tmp/ds/${subdir}/${rest.join("/")}`,
    config: () => config,
  };
}

Deno.test("createDatastoreSyncDeps: pushSync threads namespace from config", async () => {
  syncSpyCalls.length = 0;
  const deps = await createDatastoreSyncDeps(
    "/tmp/repo",
    makeResolver("my-ns"),
  );
  await deps.pushSync();

  const push = syncSpyCalls.find((c) => c.method === "pushChanged");
  assertEquals(push?.options?.namespace, "my-ns");
});

Deno.test("createDatastoreSyncDeps: pullSync threads namespace from config", async () => {
  syncSpyCalls.length = 0;
  const deps = await createDatastoreSyncDeps(
    "/tmp/repo",
    makeResolver("my-ns"),
  );
  await deps.pullSync();

  const pull = syncSpyCalls.find((c) => c.method === "pullChanged");
  assertEquals(pull?.options?.namespace, "my-ns");
});

Deno.test("createDatastoreSyncDeps: fullSync threads namespace to both push and pull", async () => {
  syncSpyCalls.length = 0;
  const deps = await createDatastoreSyncDeps(
    "/tmp/repo",
    makeResolver("my-ns"),
  );
  await deps.fullSync();

  const pull = syncSpyCalls.find((c) => c.method === "pullChanged");
  const push = syncSpyCalls.find((c) => c.method === "pushChanged");
  assertEquals(pull?.options?.namespace, "my-ns");
  assertEquals(push?.options?.namespace, "my-ns");
});

Deno.test("createDatastoreSyncDeps: omits namespace when config has none", async () => {
  syncSpyCalls.length = 0;
  const deps = await createDatastoreSyncDeps(
    "/tmp/repo",
    makeResolver(),
  );
  await deps.pushSync();

  const push = syncSpyCalls.find((c) => c.method === "pushChanged");
  assertEquals(push?.options?.namespace, undefined);
});

Deno.test("datastoreSync: unsupported datastore type yields error", async () => {
  const deps = makeDeps({
    validateSyncSupport: () =>
      Promise.resolve({
        supported: false,
        type: "filesystem",
        errorMessage:
          "Datastore sync is only available for sync-capable custom datastores.",
      }),
  });

  const error = await assertErrors<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "sync" }),
    "sync_not_supported",
  );
  assertEquals(
    error.message,
    "Datastore sync is only available for sync-capable custom datastores.",
  );
});
