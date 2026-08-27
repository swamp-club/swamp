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
import { AccessDataPoller } from "./access_data_poller.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../domain/datastore/datastore_sync_service.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
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

interface MockPolicySnapshotLoader {
  loadCalls: number;
  load(): Promise<void>;
}

function createMockPolicySnapshotLoader(): MockPolicySnapshotLoader {
  const mock: MockPolicySnapshotLoader = {
    loadCalls: 0,
    load(): Promise<void> {
      mock.loadCalls++;
      return Promise.resolve();
    },
  };
  return mock;
}

function createCallbackTrackers() {
  const state = { catalogInvalidateCalls: 0 };
  return {
    state,
    catalogInvalidate: () => {
      state.catalogInvalidateCalls++;
    },
  };
}

Deno.test("AccessDataPoller: start and stop lifecycle completes cleanly", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 50,
  });

  poller.start();
  await new Promise<void>((r) => setTimeout(r, 10));
  await poller.stop();
});

Deno.test("AccessDataPoller: pullChanged is called with grant and group subdirs", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  const call = sync.pullCalls[0];
  assertEquals(call.subdirs, [
    "data/swamp/grant",
    "data/swamp/group",
    "data/@swamp/grant",
    "data/@swamp/group",
  ]);
});

Deno.test("AccessDataPoller: namespace is passed through to pullChanged", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
    namespace: "test-namespace",
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(sync.pullCalls[0].namespace, "test-namespace");
});

Deno.test("AccessDataPoller: reloads policy and invalidates catalog when pullChanged returns count > 0", async () => {
  const sync = createMockSyncService({ pullResult: 3 });
  const loader = createMockPolicySnapshotLoader();
  const { state, catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => loader.loadCalls >= 1, "policy reload");
  await poller.stop();

  assertGreater(loader.loadCalls, 0);
  assertGreater(state.catalogInvalidateCalls, 0);
});

Deno.test("AccessDataPoller: does not reload policy when pullChanged returns 0", async () => {
  const sync = createMockSyncService({ pullResult: 0 });
  const loader = createMockPolicySnapshotLoader();
  const { state, catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertEquals(loader.loadCalls, 0);
  assertEquals(state.catalogInvalidateCalls, 0);
});

Deno.test("AccessDataPoller: does not reload policy when pullChanged returns void", async () => {
  const sync = createMockSyncService({ pullResult: undefined });
  const loader = createMockPolicySnapshotLoader();
  const { state, catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertEquals(loader.loadCalls, 0);
  assertEquals(state.catalogInvalidateCalls, 0);
});

Deno.test("AccessDataPoller: survives pullChanged throwing an error", async () => {
  const sync = createMockSyncService({
    pullError: new Error("network timeout"),
  });
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertGreater(sync.pullCalls.length, 1);
});

Deno.test("AccessDataPoller: serializes pulls — skips tick while pulling", async () => {
  const sync = createMockSyncService({ pullDelay: 100 });
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 20,
  });

  poller.start();
  await new Promise<void>((r) => setTimeout(r, 200));
  await poller.stop();

  assertEquals(sync.pullCalls.length <= 3, true);
});

Deno.test("AccessDataPoller: double start does not create duplicate timers", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  poller.start();

  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  const countAfterDoubleStart = sync.pullCalls.length;
  await poller.stop();

  assertEquals(countAfterDoubleStart <= 5, true);
});

Deno.test("AccessDataPoller: stop awaits pending pull before returning", async () => {
  let pullCompleted = false;
  const sync = createMockSyncService({ pullDelay: 80 });
  const originalPull = sync.pullChanged.bind(sync);
  sync.pullChanged = async (options?: DatastoreSyncOptions) => {
    const result = await originalPull(options);
    pullCompleted = true;
    return result;
  };

  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 20,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(pullCompleted, true);
});

Deno.test("AccessDataPoller: stop on never-started poller is a no-op", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
  });

  await poller.stop();
  assertEquals(sync.pullCalls.length, 0);
});

Deno.test("AccessDataPoller: retries policy reload on next tick if load fails", async () => {
  let loadCallCount = 0;
  let shouldFail = true;
  const sync = createMockSyncService({ pullResult: 2 });
  const loader: MockPolicySnapshotLoader = {
    loadCalls: 0,
    load(): Promise<void> {
      loadCallCount++;
      if (shouldFail && loadCallCount === 1) {
        return Promise.reject(new Error("transient failure"));
      }
      loader.loadCalls++;
      return Promise.resolve();
    },
  };
  const { state, catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 30,
  });

  poller.start();
  // First tick: pull returns 2 (changes), load fails
  await waitFor(() => loadCallCount >= 1, "first load attempt");
  // Second tick: pull returns 2 (still returning changes), load succeeds
  shouldFail = false;
  sync.pullResult = 0;
  await waitFor(() => loader.loadCalls >= 1, "successful reload after retry");
  await poller.stop();

  assertGreater(loader.loadCalls, 0);
  assertGreater(state.catalogInvalidateCalls, 0);
});

Deno.test("AccessDataPoller: can be restarted after stop", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();

  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
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
