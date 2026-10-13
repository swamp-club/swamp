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

import { assert, assertEquals, assertGreater } from "@std/assert";
import { join } from "@std/path";
import {
  ACCESS_DATA_SUBDIRS,
  AccessDataPoller,
  createAccessDataPoller,
} from "./access_data_poller.ts";
import { FilesystemAccessDataChangeSource } from "./filesystem_access_data_change_source.ts";
import { EventBus } from "../domain/events/event_bus.ts";
import { createModelUpdated } from "../domain/events/types.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { createSyncGate, withSyncGate } from "./sync_gate.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../domain/datastore/datastore_sync_service.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  assertPollCycleRoots,
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";

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

Deno.test("AccessDataPoller: pull holds the sync gate, so it cannot interleave a mutation", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();
  const gate = createSyncGate();

  const poller = new AccessDataPoller({
    syncService: sync,
    syncGate: gate,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 1,
  });

  const order: string[] = [];
  // A handler's mutation+push unit. The poller fires every 1ms while this
  // runs, so every one of those attempts must queue behind the gate.
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
  // gatedPull bounds the pull so a hung extension cannot hold the gate.
  assertEquals(typeof sync.pullCalls[0].signal, "object");
});

Deno.test("AccessDataPoller: each poll cycle is the root of its own trace", async () => {
  const sync = createMockSyncService();
  const pull = sync.pullChanged.bind(sync);
  // Stands in for the datastore's own spans, which must nest under the cycle.
  sync.pullChanged = (options) =>
    withSpan("swamp.datastore.sync", {}, () => pull(options));

  await withCapturedSpans(async (spans) => {
    // Started under an active span, as serve starts it under swamp.cli.
    await withSpan("swamp.cli", {}, async () => {
      const loader = createMockPolicySnapshotLoader();
      const { catalogInvalidate } = createCallbackTrackers();
      const poller = new AccessDataPoller({
        syncService: sync,
        policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
        catalogInvalidate,
        pollIntervalMs: 30,
      });
      poller.start();
      await waitFor(
        () => spans.filter((s) => s.name === "swamp.serve.poll").length >= 2,
        "two poll cycles",
      );
      await poller.stop();
    });

    const cycles = assertPollCycleRoots(
      spans,
      "access_data",
      findSpan(spans, "swamp.cli"),
    );
    const syncSpans = spans.filter((s) => s.name === "swamp.datastore.sync");
    assert(syncSpans.length >= 2);
    for (const syncSpan of syncSpans) {
      assert(cycles.some((cycle) => isChildOf(syncSpan, cycle)));
    }
  });
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function writeGrantVersion(
  grantDir: string,
  modelId: string,
  n: number,
): Promise<void> {
  const versionDir = join(grantDir, modelId, "grant-main", String(n));
  await Deno.mkdir(versionDir, { recursive: true });
  await Deno.writeTextFile(join(versionDir, "raw"), `version ${n}`);
}

Deno.test("AccessDataPoller: a change source's peer change reloads policy and invalidates the catalog", async () => {
  await withTempDir(async (dir) => {
    const changeSource = new FilesystemAccessDataChangeSource({
      dirs: [dir],
      eventBus: new EventBus(),
    });
    await changeSource.prime();
    const loader = createMockPolicySnapshotLoader();
    const { state, catalogInvalidate } = createCallbackTrackers();
    const poller = new AccessDataPoller({
      changeSource,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
    });
    poller.start();
    try {
      await writeGrantVersion(dir, "g1", 1);
      await waitFor(() => loader.loadCalls >= 1, "reload after peer change");
    } finally {
      await poller.stop();
    }
    assertEquals(loader.loadCalls, 1);
    assertEquals(state.catalogInvalidateCalls, 1);
  });
});

Deno.test("AccessDataPoller: a change source reporting nothing never reloads", async () => {
  await withTempDir(async (dir) => {
    let detects = 0;
    const changeSource = new FilesystemAccessDataChangeSource({
      dirs: [dir],
      eventBus: new EventBus(),
    });
    await changeSource.prime();
    const detect = changeSource.detect.bind(changeSource);
    changeSource.detect = async () => {
      const count = await detect();
      detects++;
      return count;
    };
    const loader = createMockPolicySnapshotLoader();
    const { state, catalogInvalidate } = createCallbackTrackers();
    const poller = new AccessDataPoller({
      changeSource,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
    });
    poller.start();
    await waitFor(() => detects >= 3, "three cycles");
    await poller.stop();
    assertEquals(loader.loadCalls, 0);
    assertEquals(state.catalogInvalidateCalls, 0);
  });
});

Deno.test("AccessDataPoller: a change source's own write stays staged", async () => {
  await withTempDir(async (dir) => {
    const bus = new EventBus();
    const changeSource = new FilesystemAccessDataChangeSource({
      dirs: [dir],
      eventBus: bus,
    });
    await changeSource.prime();
    let detects = 0;
    const detect = changeSource.detect.bind(changeSource);
    changeSource.detect = async () => {
      const count = await detect();
      detects++;
      return count;
    };
    const loader = createMockPolicySnapshotLoader();
    const { catalogInvalidate } = createCallbackTrackers();
    const poller = new AccessDataPoller({
      changeSource,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
    });
    // Written before the poller starts, so no cycle sees it before its event.
    await writeGrantVersion(dir, "g1", 1);
    await bus.publish(
      createModelUpdated("swamp/grant", "g1", "g1", [
        { name: "grant-main", version: 1 },
      ]),
    );
    poller.start();
    await waitFor(() => detects >= 2, "two cycles");
    await poller.stop();
    assertEquals(loader.loadCalls, 0);
  });
});

Deno.test("AccessDataPoller: a change source change is reloaded again after a failed load", async () => {
  await withTempDir(async (dir) => {
    const changeSource = new FilesystemAccessDataChangeSource({
      dirs: [dir],
      eventBus: new EventBus(),
    });
    await changeSource.prime();
    let attempts = 0;
    const loader = {
      loadCalls: 0,
      load(): Promise<void> {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("transient"));
        loader.loadCalls++;
        return Promise.resolve();
      },
    };
    const { catalogInvalidate } = createCallbackTrackers();
    const poller = new AccessDataPoller({
      changeSource,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
    });
    poller.start();
    try {
      await writeGrantVersion(dir, "g1", 1);
      await waitFor(() => loader.loadCalls >= 1, "reload after retry");
    } finally {
      await poller.stop();
    }
    assertEquals(attempts, 2);
  });
});

function fakeResolver(
  engine: "v2" | "v3",
  base: string,
): DatastorePathResolver {
  return {
    localPath: (...segments: string[]) => join(base, ...segments),
    datastorePath: (...segments: string[]) => join(base, ...segments),
    isDatastoreSubdir: () => true,
    resolvePath: (subdir: string, ...rest: string[]) =>
      join(base, subdir, ...rest),
    getDatastoreConfig: () => ({ type: "filesystem", path: base }),
    engine: () => engine,
  } as unknown as DatastorePathResolver;
}

Deno.test("createAccessDataPoller: a sync service gets the pull poller", async () => {
  const sync = createMockSyncService();
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();
  const poller = await createAccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 10,
    datastoreConfig: {
      type: "@swamp/s3-datastore",
      config: {},
      datastorePath: "bucket",
    },
    datastoreEngine: "v2",
    datastoreResolver: fakeResolver("v2", "/unused"),
    eventBus: new EventBus(),
  });
  assert(poller);
  poller.start();
  await waitFor(() => sync.pullCalls.length >= 1, "a pull");
  await poller.stop();
});

Deno.test("createAccessDataPoller: a v2 filesystem datastore watches the resolved access data directories", async () => {
  await withTempDir(async (dir) => {
    const loader = createMockPolicySnapshotLoader();
    const { catalogInvalidate } = createCallbackTrackers();
    const poller = await createAccessDataPoller({
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
      datastoreConfig: { type: "filesystem", path: dir },
      datastoreEngine: "v2",
      datastoreResolver: fakeResolver("v2", dir),
      eventBus: new EventBus(),
    });
    assert(poller);
    poller.start();
    try {
      for (const subdir of ACCESS_DATA_SUBDIRS) {
        const before = loader.loadCalls;
        await writeGrantVersion(join(dir, subdir), crypto.randomUUID(), 1);
        await waitFor(
          () => loader.loadCalls > before,
          `reload after a change in ${subdir}`,
        );
      }
    } finally {
      await poller.stop();
    }
  });
});

Deno.test("createAccessDataPoller: a v3 datastore gets no poller", async () => {
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();
  const poller = await createAccessDataPoller({
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    datastoreConfig: { type: "filesystem", path: "/unused", format: 3 },
    datastoreEngine: "v3",
    datastoreResolver: fakeResolver("v3", "/unused"),
    eventBus: new EventBus(),
  });
  assertEquals(poller, null);
});

Deno.test("createAccessDataPoller: a custom datastore without a sync service gets no poller", async () => {
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();
  const poller = await createAccessDataPoller({
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    datastoreConfig: {
      type: "@swamp/s3-datastore",
      config: {},
      datastorePath: "bucket",
    },
    datastoreEngine: "v2",
    datastoreResolver: fakeResolver("v2", "/unused"),
    eventBus: new EventBus(),
  });
  assertEquals(poller, null);
});
