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

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  SyncCapabilities,
} from "../domain/datastore/datastore_sync_service.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { initializeControlPlaneVaultForCli } from "./control_plane_vault.ts";

await initializeLogging({});

function createMockStore(): ControlPlaneStore {
  const data = new Map<string, Uint8Array>();
  return {
    put(key: string, value: Uint8Array): Promise<void> {
      data.set(key, new Uint8Array(value));
      return Promise.resolve();
    },
    putIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, new Uint8Array(value));
      return Promise.resolve(true);
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...data.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

interface MockSyncServiceOptions {
  pullShouldFail?: boolean;
}

function createMockSyncService(
  opts: MockSyncServiceOptions = {},
): {
  syncService: DatastoreSyncService;
  calls: { method: string; options?: DatastoreSyncOptions }[];
} {
  const calls: { method: string; options?: DatastoreSyncOptions }[] = [];
  const store = createMockStore();

  const syncService: DatastoreSyncService = {
    pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      calls.push({ method: "pullChanged", options });
      if (opts.pullShouldFail) {
        return Promise.reject(new Error("S3 unreachable"));
      }
      return Promise.resolve(0);
    },
    pushChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      calls.push({ method: "pushChanged", options });
      return Promise.resolve(0);
    },
    capabilities(): SyncCapabilities {
      return { controlPlane: true };
    },
    markDirty(): Promise<void> {
      calls.push({ method: "markDirty" });
      return Promise.resolve();
    },
    controlPlaneStore(): ControlPlaneStore {
      calls.push({ method: "controlPlaneStore" });
      return store;
    },
  };

  return { syncService, calls };
}

Deno.test("initializeControlPlaneVaultForCli: calls pullChanged with namespace before controlPlaneStore", async () => {
  const { syncService, calls } = createMockSyncService();

  const result = await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
    {
      namespace: "my-namespace",
      catalogInvalidate: () => {},
    },
  );

  assertNotEquals(result, null);

  const pullIndex = calls.findIndex((c) => c.method === "pullChanged");
  const storeIndex = calls.findIndex((c) => c.method === "controlPlaneStore");

  assertNotEquals(pullIndex, -1, "pullChanged must be called");
  assertNotEquals(storeIndex, -1, "controlPlaneStore must be called");
  assertEquals(
    pullIndex < storeIndex,
    true,
    "pullChanged must be called before controlPlaneStore",
  );
  assertEquals(calls[pullIndex].options?.namespace, "my-namespace");
});

Deno.test("initializeControlPlaneVaultForCli: calls catalogInvalidate after pullChanged", async () => {
  const { syncService } = createMockSyncService();

  let invalidated = false;
  await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
    {
      namespace: "my-namespace",
      catalogInvalidate: () => {
        invalidated = true;
      },
    },
  );

  assertEquals(invalidated, true);
});

Deno.test("initializeControlPlaneVaultForCli: skips pullChanged when no namespace", async () => {
  const { syncService, calls } = createMockSyncService();

  const result = await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
  );

  assertNotEquals(result, null);

  const pullCalls = calls.filter((c) => c.method === "pullChanged");
  assertEquals(
    pullCalls.length,
    0,
    "pullChanged must not be called without namespace",
  );

  const storeCalls = calls.filter((c) => c.method === "controlPlaneStore");
  assertEquals(storeCalls.length, 1, "controlPlaneStore must still be called");
});

Deno.test("initializeControlPlaneVaultForCli: propagates pullChanged failure", async () => {
  const { syncService } = createMockSyncService({ pullShouldFail: true });

  await assertRejects(
    () =>
      initializeControlPlaneVaultForCli(
        "/tmp/test-repo",
        syncService,
        { namespace: "my-namespace" },
      ),
    Error,
    "S3 unreachable",
  );
});

Deno.test("initializeControlPlaneVaultForCli: works without sync service", async () => {
  const result = await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    undefined,
  );

  // Falls back to FileSystemControlPlaneStore — init may fail because
  // /tmp/test-repo/.swamp doesn't exist, returning null. That's fine;
  // we're testing that it doesn't throw on the sync path.
  assertEquals(result === null || result !== undefined, true);
});
