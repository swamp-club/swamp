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
import { pushManagedConfigChanges } from "./managed_config_sync.ts";
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
