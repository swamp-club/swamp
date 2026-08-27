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

import { assertEquals, assertGreater } from "@std/assert";
import { ConfigPoller } from "./config_poller.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../domain/datastore/datastore_sync_service.ts";
import { waitFor } from "@swamp-club/swamp-testing";

interface MockSyncService extends DatastoreSyncService {
  pullCalls: DatastoreSyncOptions[];
  pullResult: number | void;
  pullDelay: number;
  pullError: Error | null;
}

function createMockSyncService(
  overrides: Partial<
    Pick<MockSyncService, "pullResult" | "pullDelay" | "pullError">
  > = {},
): MockSyncService {
  const mock: MockSyncService = {
    pullCalls: [],
    pullResult: overrides.pullResult ?? 0,
    pullDelay: overrides.pullDelay ?? 0,
    pullError: overrides.pullError ?? null,
    async pullChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      mock.pullCalls.push(options ?? {});
      if (mock.pullDelay > 0) {
        await new Promise<void>((r) => setTimeout(r, mock.pullDelay));
      }
      if (mock.pullError) {
        throw mock.pullError;
      }
      return mock.pullResult;
    },
    pushChanged(): Promise<number | void> {
      return Promise.resolve(0);
    },
    async markDirty(): Promise<void> {},
  };
  return mock;
}

function createCallbackTrackers() {
  const state = {
    catalogInvalidateCalls: 0,
    extensionCatalogInvalidateCalls: 0,
  };
  return {
    state,
    catalogInvalidate: () => {
      state.catalogInvalidateCalls++;
    },
    extensionCatalogInvalidate: () => {
      state.extensionCatalogInvalidateCalls++;
    },
  };
}

Deno.test("ConfigPoller: start and stop lifecycle completes cleanly", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 50,
  });

  poller.start();
  await new Promise<void>((r) => setTimeout(r, 10));
  await poller.stop();
});

Deno.test("ConfigPoller: pullChanged is called with subdirs config", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  const call = sync.pullCalls[0];
  assertEquals(call.subdirs, ["config"]);
});

Deno.test("ConfigPoller: namespace is passed through to pullChanged", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
    namespace: "test-namespace",
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(sync.pullCalls[0].namespace, "test-namespace");
});

Deno.test("ConfigPoller: invalidates both catalogs when pullChanged returns count > 0", async () => {
  const sync = createMockSyncService({ pullResult: 3 });
  const { state, catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(
    () => state.catalogInvalidateCalls >= 1,
    "catalog invalidation",
  );
  await poller.stop();

  assertGreater(state.catalogInvalidateCalls, 0);
  assertGreater(state.extensionCatalogInvalidateCalls, 0);
  assertEquals(
    state.catalogInvalidateCalls,
    state.extensionCatalogInvalidateCalls,
  );
});

Deno.test("ConfigPoller: does not invalidate catalogs when pullChanged returns 0", async () => {
  const sync = createMockSyncService({ pullResult: 0 });
  const { state, catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertEquals(state.catalogInvalidateCalls, 0);
  assertEquals(state.extensionCatalogInvalidateCalls, 0);
});

Deno.test("ConfigPoller: does not invalidate catalogs when pullChanged returns void", async () => {
  const sync = createMockSyncService({ pullResult: undefined });
  const { state, catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertEquals(state.catalogInvalidateCalls, 0);
  assertEquals(state.extensionCatalogInvalidateCalls, 0);
});

Deno.test("ConfigPoller: survives pullChanged throwing an error", async () => {
  const sync = createMockSyncService({
    pullError: new Error("network timeout"),
  });
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertGreater(sync.pullCalls.length, 1);
});

Deno.test("ConfigPoller: serializes pulls — skips tick while pulling", async () => {
  const sync = createMockSyncService({ pullDelay: 100 });
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 20,
  });

  poller.start();
  // Wait enough ticks that multiple would fire during the slow pull
  await new Promise<void>((r) => setTimeout(r, 200));
  await poller.stop();

  // Despite 200ms with 20ms intervals (10 ticks), only 1–2 pulls
  // should have started because the first blocks for 100ms
  assertEquals(sync.pullCalls.length <= 3, true);
});

Deno.test("ConfigPoller: double start does not create duplicate timers", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  poller.start();

  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  const countAfterDoubleStart = sync.pullCalls.length;
  await poller.stop();

  // If duplicate timers existed, we'd see roughly 2x the pull count.
  // With a single timer at 30ms over ~100ms, expect 2–4 calls, not 6+.
  assertEquals(countAfterDoubleStart <= 5, true);
});

Deno.test("ConfigPoller: stop awaits pending pull before returning", async () => {
  let pullCompleted = false;
  const sync = createMockSyncService({ pullDelay: 80 });
  const originalPull = sync.pullChanged.bind(sync);
  sync.pullChanged = async (options?: DatastoreSyncOptions) => {
    const result = await originalPull(options);
    pullCompleted = true;
    return result;
  };

  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 20,
  });

  poller.start();
  // Wait for at least one pull to start
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  // Stop should await the pending pull
  await poller.stop();

  assertEquals(pullCompleted, true);
});

Deno.test("ConfigPoller: respects custom pollIntervalMs", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 80,
  });

  poller.start();
  // At 80ms interval, after 50ms we should have 0 pulls
  await new Promise<void>((r) => setTimeout(r, 50));
  assertEquals(sync.pullCalls.length, 0);

  // After 120ms total we should have exactly 1
  await new Promise<void>((r) => setTimeout(r, 70));
  assertEquals(sync.pullCalls.length, 1);

  await poller.stop();
});

Deno.test("ConfigPoller: stop on never-started poller is a no-op", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
  });

  await poller.stop();
  assertEquals(sync.pullCalls.length, 0);
});

Deno.test("ConfigPoller: can be restarted after stop", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  const countAfterFirstRun = sync.pullCalls.length;

  poller.start();
  await waitFor(
    () => sync.pullCalls.length > countAfterFirstRun,
    "pulls resume after restart",
  );
  await poller.stop();

  assertGreater(sync.pullCalls.length, countAfterFirstRun);
});

Deno.test("ConfigPoller: without namespace, pullChanged options omit namespace", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionCatalogInvalidate } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionCatalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(sync.pullCalls[0].namespace, undefined);
});
