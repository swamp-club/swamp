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
import { ConfigPoller, MAX_FAILED_RELOAD_ATTEMPTS } from "./config_poller.ts";
import type { ExtensionReloadStatus } from "./extension_reload.ts";
import { createSyncGate, withSyncGate } from "./sync_gate.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../domain/datastore/datastore_sync_service.ts";
import { waitFor } from "@swamp-club/swamp-testing";

interface MockSyncService extends DatastoreSyncService {
  pullCalls: DatastoreSyncOptions[];
  pullResult: number | void;
  pullResultFn?: (options: DatastoreSyncOptions) => number | void;
  pullDelay: number;
  pullError: Error | null;
}

function createMockSyncService(
  overrides: Partial<
    Pick<
      MockSyncService,
      "pullResult" | "pullDelay" | "pullError" | "pullResultFn"
    >
  > = {},
): MockSyncService {
  const mock: MockSyncService = {
    pullCalls: [],
    pullResult: overrides.pullResult ?? 0,
    pullResultFn: overrides.pullResultFn,
    pullDelay: overrides.pullDelay ?? 0,
    pullError: overrides.pullError ?? null,
    async pullChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      const opts = options ?? {};
      mock.pullCalls.push(opts);
      if (mock.pullDelay > 0) {
        await new Promise<void>((r) => setTimeout(r, mock.pullDelay));
      }
      if (mock.pullError) {
        throw mock.pullError;
      }
      if (mock.pullResultFn) {
        return mock.pullResultFn(opts);
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
    extensionReloaderCalls: 0,
  };
  return {
    state,
    catalogInvalidate: () => {
      state.catalogInvalidateCalls++;
    },
    extensionReloader: (): Promise<ExtensionReloadStatus> => {
      state.extensionReloaderCalls++;
      return Promise.resolve("ok");
    },
  };
}

/** A lockfile whose hash a test changes, counting each read. */
function createLockfile(initial: string | null = "hash-a") {
  const lockfile = {
    hash: initial,
    reads: 0,
    lockfileHash: (): Promise<string | null> => {
      lockfile.reads++;
      return Promise.resolve(lockfile.hash);
    },
  };
  return lockfile;
}

Deno.test("ConfigPoller: start and stop lifecycle completes cleanly", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 50,
  });

  poller.start();
  await new Promise<void>((r) => setTimeout(r, 10));
  await poller.stop();
});

Deno.test("ConfigPoller: pullChanged is called with subdirs config", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
    namespace: "test-namespace",
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(sync.pullCalls[0].namespace, "test-namespace");
});

Deno.test("ConfigPoller: invalidates catalogs when pullChanged returns count > 0", async () => {
  const sync = createMockSyncService({ pullResult: 3 });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(
    () => state.catalogInvalidateCalls >= 1,
    "catalog invalidation",
  );
  await poller.stop();

  assertGreater(state.catalogInvalidateCalls, 0);
  assertEquals(state.extensionReloaderCalls, 0);
});

Deno.test("ConfigPoller: does not invalidate catalogs when pullChanged returns 0", async () => {
  const sync = createMockSyncService({ pullResult: 0 });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertEquals(state.catalogInvalidateCalls, 0);
  assertEquals(state.extensionReloaderCalls, 0);
});

Deno.test("ConfigPoller: invalidates catalogs when pullChanged returns void", async () => {
  // The sync contract treats an unknown count as a changed cache.
  const sync = createMockSyncService({ pullResultFn: () => undefined });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(
    () => state.catalogInvalidateCalls >= 1,
    "catalog invalidation",
  );
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 0);
});

Deno.test("ConfigPoller: a cycle skipped for a busy sync gate does not invalidate catalogs", async () => {
  const sync = createMockSyncService({ pullResultFn: () => undefined });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile();
  const gate = createSyncGate();

  let release!: () => void;
  const released = new Promise<void>((r) => release = r);
  const mutation = withSyncGate(gate, () => released);

  const poller = new ConfigPoller({
    syncService: sync,
    syncGate: gate,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    pollIntervalMs: 5,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 2, "two skipped polls");
  const pullsWhileHeld = sync.pullCalls.length;
  const invalidationsWhileHeld = state.catalogInvalidateCalls;
  release();
  await mutation;
  await poller.stop();

  assertEquals(pullsWhileHeld, 0);
  assertEquals(invalidationsWhileHeld, 0);
});

Deno.test("ConfigPoller: survives pullChanged throwing an error", async () => {
  const sync = createMockSyncService({
    pullError: new Error("network timeout"),
  });
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 2, "at least two pulls");
  await poller.stop();

  assertGreater(sync.pullCalls.length, 1);
});

Deno.test("ConfigPoller: serializes pulls — skips tick while pulling", async () => {
  const sync = createMockSyncService({ pullDelay: 100 });
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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

  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
  });

  await poller.stop();
  assertEquals(sync.pullCalls.length, 0);
});

Deno.test("ConfigPoller: can be restarted after stop", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
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
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 30,
  });

  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "at least one pull");
  await poller.stop();

  assertEquals(sync.pullCalls[0].namespace, undefined);
});

Deno.test("ConfigPoller: pull holds the sync gate, so it cannot interleave a mutation", async () => {
  const sync = createMockSyncService();
  const { catalogInvalidate, extensionReloader } = createCallbackTrackers();
  const gate = createSyncGate();

  const poller = new ConfigPoller({
    syncService: sync,
    syncGate: gate,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: createLockfile().lockfileHash,
    pollIntervalMs: 1,
  });

  const order: string[] = [];
  const mutation = withSyncGate(gate, async () => {
    order.push("mutation:start");
    await new Promise<void>((r) => setTimeout(r, 25));
    order.push(`pulls-during-mutation:${sync.pullCalls.length}`);
    order.push("mutation:end");
  });

  poller.start();
  await mutation;
  await waitFor(
    () => sync.pullCalls.length >= 1,
    "poller pulled once the gate was free",
  );
  await poller.stop();

  assertEquals(order, [
    "mutation:start",
    "pulls-during-mutation:0",
    "mutation:end",
  ]);
  assertEquals(typeof sync.pullCalls[0].signal, "object");
});

Deno.test("ConfigPoller: a lockfile-only change runs the extension reloader once", async () => {
  const sync = createMockSyncService({ pullResult: 0 });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 2, "two polls");
  assertEquals(state.extensionReloaderCalls, 0);

  lockfile.hash = "hash-b";
  await waitFor(() => state.extensionReloaderCalls >= 1, "reload");
  const readsAfterReload = lockfile.reads;
  await waitFor(
    () => lockfile.reads >= readsAfterReload + 2,
    "two more polls",
  );
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 1);
  assertEquals(state.catalogInvalidateCalls, 0);
});

Deno.test("ConfigPoller: pulled files without a lockfile change invalidate catalogs but do not reload", async () => {
  const sync = createMockSyncService({ pullResult: 3 });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 2, "two polls");
  assertEquals(state.extensionReloaderCalls, 0);
  assertGreater(state.catalogInvalidateCalls, 0);

  // Archives arrive in one poll, the lockfile in a later one: one reload.
  lockfile.hash = "hash-b";
  await waitFor(() => state.extensionReloaderCalls >= 1, "reload");
  const readsAfterReload = lockfile.reads;
  await waitFor(
    () => lockfile.reads >= readsAfterReload + 2,
    "two more polls",
  );
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 1);
});

Deno.test("ConfigPoller: a void pull with an unchanged lockfile does not reload", async () => {
  const sync = createMockSyncService({ pullResultFn: () => undefined });
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    syncService: sync,
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 3, "three polls");
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 0);
});

Deno.test("ConfigPoller: a baseline matching the boot lockfile causes no reload", async () => {
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 3, "three polls");
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 0);
});

Deno.test("ConfigPoller: without a baseline the first poll seeds it without reloading", async () => {
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => lockfile.reads >= 2, "two polls");
  assertEquals(state.extensionReloaderCalls, 0);

  lockfile.hash = "hash-b";
  await waitFor(() => state.extensionReloaderCalls >= 1, "reload");
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 1);
});

Deno.test("ConfigPoller: a lockfile that appears or disappears counts as a change", async () => {
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile(null);

  const poller = new ConfigPoller({
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: null,
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-a";
  await waitFor(() => state.extensionReloaderCalls >= 1, "reload on create");
  lockfile.hash = null;
  await waitFor(() => state.extensionReloaderCalls >= 2, "reload on delete");
  await poller.stop();

  assertEquals(state.extensionReloaderCalls, 2);
});

Deno.test("ConfigPoller: without a sync service it never pulls and still reloads on a lockfile change", async () => {
  const { state, catalogInvalidate, extensionReloader } =
    createCallbackTrackers();
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate,
    extensionReloader,
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-b";
  await waitFor(() => state.extensionReloaderCalls >= 1, "reload");
  await poller.stop();

  assertEquals(state.catalogInvalidateCalls, 0);
});

Deno.test("ConfigPoller: a busy reload stays pending and is retried until it succeeds", async () => {
  const statuses: ExtensionReloadStatus[] = ["busy", "busy", "ok"];
  let calls = 0;
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => Promise.resolve(statuses[calls++] ?? "ok"),
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-b";
  await waitFor(() => calls >= 3, "three reload attempts");
  const readsAfterOk = lockfile.reads;
  await waitFor(() => lockfile.reads >= readsAfterOk + 2, "two more polls");
  await poller.stop();

  assertEquals(calls, 3);
});

Deno.test("ConfigPoller: a failed reload is retried up to the cap, then waits for the next lockfile change", async () => {
  let calls = 0;
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => {
      calls++;
      return Promise.resolve("failed");
    },
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-b";
  await waitFor(
    () => calls >= MAX_FAILED_RELOAD_ATTEMPTS,
    "reload attempts up to the cap",
  );
  const readsAtCap = lockfile.reads;
  await waitFor(() => lockfile.reads >= readsAtCap + 2, "two more polls");
  assertEquals(calls, MAX_FAILED_RELOAD_ATTEMPTS);

  lockfile.hash = "hash-c";
  await waitFor(
    () => calls > MAX_FAILED_RELOAD_ATTEMPTS,
    "a fresh attempt after the next change",
  );
  await poller.stop();
});

Deno.test("ConfigPoller: a throwing reloader counts as failed and the poller keeps running", async () => {
  let calls = 0;
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => {
      calls++;
      return Promise.reject(new Error("reload failed"));
    },
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-b";
  await waitFor(() => calls >= 2, "reloader retried after throwing");
  await poller.stop();

  assertGreater(calls, 1);
});

Deno.test("ConfigPoller: a lockfile change landing during a reload triggers another reload", async () => {
  let calls = 0;
  const lockfile = createLockfile("hash-a");

  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => {
      calls++;
      if (calls === 1) lockfile.hash = "hash-c";
      return Promise.resolve("ok");
    },
    lockfileHash: lockfile.lockfileHash,
    baselineLockfileHash: "hash-a",
    pollIntervalMs: 10,
  });

  poller.start();
  lockfile.hash = "hash-b";
  await waitFor(() => calls >= 2, "second reload for the mid-reload change");
  const readsAfter = lockfile.reads;
  await waitFor(() => lockfile.reads >= readsAfter + 2, "two more polls");
  await poller.stop();

  assertEquals(calls, 2);
});

Deno.test("ConfigPoller: survives the lockfile hash read throwing", async () => {
  let reads = 0;
  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => Promise.resolve("ok"),
    lockfileHash: () => {
      reads++;
      return Promise.reject(new Error("permission denied"));
    },
    pollIntervalMs: 10,
  });

  poller.start();
  await waitFor(() => reads >= 2, "hash read retried on the next poll");
  await poller.stop();
});
