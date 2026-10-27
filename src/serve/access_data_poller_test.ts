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
  assertGreater,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  ACCESS_DATA_POLLER_ESCALATE_AFTER,
  ACCESS_DATA_SUBDIRS,
  AccessDataPoller,
  createAccessDataPoller,
} from "./access_data_poller.ts";
import { FilesystemAccessDataChangeSource } from "./filesystem_access_data_change_source.ts";
import { EventBus } from "../domain/events/event_bus.ts";
import { createModelUpdated } from "../domain/events/types.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import {
  createSyncGate,
  POLLER_ESCALATE_AFTER_SKIPS,
  withSyncGate,
} from "./sync_gate.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../domain/datastore/datastore_sync_service.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  assertPollCycleRoots,
  diagnosticPhases,
  findSpan,
  isChildOf,
  type ReadableSpan,
  withCapturedSpans,
  withObservedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import type { DiagnosticPhase } from "../domain/diagnostics/diagnostic_phase.ts";
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
  unreadable: readonly { cause: string }[];
  load(): Promise<void>;
}

function createMockPolicySnapshotLoader(): MockPolicySnapshotLoader {
  const mock: MockPolicySnapshotLoader = {
    loadCalls: 0,
    unreadable: [],
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
    unreadable: [],
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

// --- Unreadable records and repeated failures (swamp-club#3386) ---

Deno.test("AccessDataPoller: reloads every cycle while the snapshot is missing records it could not read, then stops", async () => {
  // Nothing changes on the datastore; only the loader's state drives it.
  const sync = createMockSyncService({ pullResult: 0 });
  const loader = createMockPolicySnapshotLoader();
  // A degraded snapshot this poller did not build (serve's boot load).
  loader.unreadable = [{ cause: "unreadable" }];
  const { state, catalogInvalidate } = createCallbackTrackers();
  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 10,
  });

  poller.start();
  try {
    await waitFor(() => loader.loadCalls >= 3, "retries a degraded snapshot");
    loader.unreadable = [];
    const whole = sync.pullCalls.length;
    const loadsWhenWhole = loader.loadCalls;
    await waitFor(
      () => sync.pullCalls.length >= whole + 3,
      "three cycles once whole",
    );
    // At most the cycle already running when the snapshot became whole.
    assert(loader.loadCalls <= loadsWhenWhole + 1);
  } finally {
    await poller.stop();
  }
  // Retrying a degraded snapshot is not a datastore change.
  assertEquals(state.catalogInvalidateCalls, 0);
});

Deno.test("AccessDataPoller: does not retry a snapshot whose missing records are all corrupt", async () => {
  const sync = createMockSyncService({ pullResult: 0 });
  const loader = createMockPolicySnapshotLoader();
  // Corrupt records never read by themselves; a fixing write is a change.
  loader.unreadable = [{ cause: "corrupt" }, { cause: "unrecognised" }];
  const { catalogInvalidate } = createCallbackTrackers();
  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 10,
  });

  poller.start();
  try {
    await waitFor(() => sync.pullCalls.length >= 3, "three cycles");
  } finally {
    await poller.stop();
  }
  assertEquals(loader.loadCalls, 0);
});

/** Runs `fn` with the access data poller's logs captured. */
async function capturingPollerLogs(
  fn: () => Promise<void>,
): Promise<Array<{ level: string; message: string }>> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "serve", "access-data-poller"],
        lowestLevel: "info",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => ({
    level: record.level,
    message: record.message.map(String).join(""),
  }));
}

Deno.test("AccessDataPoller: repeated cycle failures escalate to error, and recovery is logged", async () => {
  const sync = createMockSyncService({
    pullError: new Error("permission denied"),
  });
  const loader = createMockPolicySnapshotLoader();
  const { catalogInvalidate } = createCallbackTrackers();
  const poller = new AccessDataPoller({
    syncService: sync,
    policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
    catalogInvalidate,
    pollIntervalMs: 10,
  });

  const logs = await capturingPollerLogs(async () => {
    poller.start();
    try {
      await waitFor(
        () => sync.pullCalls.length >= ACCESS_DATA_POLLER_ESCALATE_AFTER + 1,
        "failures past the threshold",
      );
      sync.pullError = null;
      const failed = sync.pullCalls.length;
      await waitFor(
        () => sync.pullCalls.length >= failed + 2,
        "a successful cycle",
      );
    } finally {
      await poller.stop();
    }
  });

  const failures = logs.filter((l) => l.message.includes("cycle failed"));
  const below = ACCESS_DATA_POLLER_ESCALATE_AFTER - 1;
  assertEquals(
    failures.slice(0, below).map((l) => l.level),
    Array(below).fill("warning"),
  );
  assert(failures.length > below);
  for (const escalated of failures.slice(below)) {
    assertEquals(escalated.level, "error");
    assertStringIncludes(escalated.message, "not being applied");
  }
  const recovered = logs.filter((l) => l.message.includes("recovered after"));
  assertEquals(recovered.length, 1);
  assertEquals(recovered[0].level, "info");
});

// Diagnostic phases of the access-data poll (swamp-club#4005).

/** The finished poll_cycle phases, in the order they ended. */
function cycles(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return diagnosticPhases(spans, "poll_cycle");
}

function childPhases(
  spans: readonly ReadableSpan[],
  phase: DiagnosticPhase,
  parent: ReadableSpan,
): ReadableSpan[] {
  return diagnosticPhases(spans, phase).filter((s) => isChildOf(s, parent));
}

function cycleWhere(
  spans: readonly ReadableSpan[],
  attribute: string,
  value: string,
): ReadableSpan {
  const cycle = cycles(spans).find((s) =>
    s.attributes[`swamp.diagnostic.${attribute}`] === value
  );
  assert(cycle, `a poll cycle with ${attribute} ${value}`);
  return cycle;
}

/** Every phase under `cycle`, the cycle included, carries `mode`. */
function assertSourceMode(
  spans: readonly ReadableSpan[],
  cycle: ReadableSpan,
  mode: string,
): void {
  const children = spans.filter((s) => isChildOf(s, cycle));
  for (const span of [cycle, ...children]) {
    assertEquals(
      span.attributes["swamp.diagnostic.source_mode"],
      mode,
      span.name,
    );
  }
}

Deno.test("AccessDataPoller: a change-source cycle exports detection, invalidation and an applied reload, and never a pull", async () => {
  await withTempDir(async (dir) => {
    await withObservedSpans(async (spans) => {
      const changeSource = new FilesystemAccessDataChangeSource({
        dirs: [dir],
        eventBus: new EventBus(),
      });
      await changeSource.prime();
      const loader = createMockPolicySnapshotLoader();
      const { catalogInvalidate } = createCallbackTrackers();
      const poller = new AccessDataPoller({
        changeSource,
        policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
        catalogInvalidate,
        pollIntervalMs: 10,
      });
      poller.start();
      try {
        await waitFor(() => cycles(spans).length >= 1, "an unchanged cycle");
        await writeGrantVersion(dir, "g1", 1);
        await waitFor(() => loader.loadCalls >= 1, "reload after change");
      } finally {
        await poller.stop();
      }

      const applied = cycleWhere(spans, "reload_reason", "changed");
      assertEquals(applied.attributes["swamp.diagnostic.result"], "applied");
      assertEquals(applied.attributes["swamp.diagnostic.changed"], 1);
      assertEquals(applied.attributes["swamp.outcome"], "ok");
      assertEquals(
        applied.attributes["swamp.diagnostic.cancel_observed"],
        false,
      );
      const poll = spans.find((s) =>
        s.name === "swamp.serve.poll" && isChildOf(applied, s)
      );
      assert(poll, "poll_cycle is a child of its swamp.serve.poll");
      assertEquals(poll.attributes["swamp.serve.poller"], "access_data");
      const [detection] = childPhases(spans, "change_detection", applied);
      assertEquals(detection.attributes["swamp.diagnostic.changed"], 1);
      assertEquals(
        detection.attributes["swamp.diagnostic.baseline_missing"],
        false,
      );
      assertEquals(childPhases(spans, "catalog_invalidate", applied).length, 1);
      assertSourceMode(spans, applied, "local_change_source");

      const unchanged = cycleWhere(spans, "reload_reason", "none");
      assertEquals(
        unchanged.attributes["swamp.diagnostic.result"],
        "no_change",
      );
      assertEquals(unchanged.attributes["swamp.diagnostic.changed"], 0);
      assertEquals(
        unchanged.attributes["swamp.diagnostic.unreadable_records"],
        0,
      );
      assertEquals(
        childPhases(spans, "change_detection", unchanged).length,
        1,
      );
      assertEquals(
        childPhases(spans, "catalog_invalidate", unchanged).length,
        0,
      );

      assertEquals(diagnosticPhases(spans, "gate_wait").length, 0);
      assertEquals(diagnosticPhases(spans, "remote_pull").length, 0);
    });
  });
});

Deno.test("AccessDataPoller: an unprimed change source records the missing baseline", async () => {
  await withTempDir(async (dir) => {
    await withObservedSpans(async (spans) => {
      const changeSource = new FilesystemAccessDataChangeSource({
        dirs: [dir],
        eventBus: new EventBus(),
      });
      const loader = createMockPolicySnapshotLoader();
      const poller = new AccessDataPoller({
        changeSource,
        policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
        catalogInvalidate: () => {},
        pollIntervalMs: 10,
      });
      poller.start();
      try {
        await waitFor(() => loader.loadCalls >= 1, "the first cycle reloads");
      } finally {
        await poller.stop();
      }
      const [first] = diagnosticPhases(spans, "change_detection");
      assertEquals(
        first.attributes["swamp.diagnostic.baseline_missing"],
        true,
      );
    });
  });
});

Deno.test("AccessDataPoller: a sync-pull cycle exports the gate wait and the pull, and never change detection", async () => {
  await withObservedSpans(async (spans) => {
    const sync = createMockSyncService({ pullResult: 2 });
    const loader = createMockPolicySnapshotLoader();
    const { catalogInvalidate } = createCallbackTrackers();
    const poller = new AccessDataPoller({
      syncService: sync,
      syncGate: createSyncGate(),
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate,
      pollIntervalMs: 10,
    });
    poller.start();
    try {
      await waitFor(() => loader.loadCalls >= 1, "reload after pull");
      sync.pullResult = undefined;
      await waitFor(
        () =>
          cycles(spans).some((s) =>
            s.attributes["swamp.diagnostic.result"] === "no_change"
          ),
        "a pull that reports no count",
      );
    } finally {
      await poller.stop();
    }

    const applied = cycleWhere(spans, "reload_reason", "changed");
    assertEquals(applied.attributes["swamp.diagnostic.result"], "applied");
    const [wait] = childPhases(spans, "gate_wait", applied);
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], true);
    assertEquals(
      wait.attributes["swamp.diagnostic.gate_mode"],
      "opportunistic",
    );
    const [pull] = childPhases(spans, "remote_pull", applied);
    assertEquals(pull.attributes["swamp.diagnostic.changed"], 2);
    assertEquals(childPhases(spans, "catalog_invalidate", applied).length, 1);
    assertSourceMode(spans, applied, "sync_pull");

    const voidPull = cycles(spans).find((s) =>
      s.attributes["swamp.diagnostic.result"] === "no_change"
    )!;
    assertEquals(voidPull.attributes["swamp.diagnostic.changed"], 0);
    const [noCount] = childPhases(spans, "remote_pull", voidPull);
    assertEquals(noCount.attributes["swamp.diagnostic.count_reported"], false);

    assertEquals(diagnosticPhases(spans, "change_detection").length, 0);
  });
});

Deno.test("AccessDataPoller: a busy gate skips the cycle, and stop() during a queued wait cancels it", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    await gate.acquireShared();
    const sync = createMockSyncService({ pullResult: 1 });
    const loader = createMockPolicySnapshotLoader();
    const poller = new AccessDataPoller({
      syncService: sync,
      syncGate: gate,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate: () => {},
      pollIntervalMs: 10,
    });
    poller.start();
    try {
      // After the skips, the poller queues for the gate.
      await waitFor(() => gate.waiters === 1, "poller queued for the gate");
    } finally {
      await poller.stop();
      gate.releaseShared();
    }
    assertEquals(sync.pullCalls.length, 0);

    // A cycle the interval queued before stop() cleared it also ends
    // cancelled, so the count after the queued one is not pinned.
    const all = cycles(spans);
    assert(all.length >= POLLER_ESCALATE_AFTER_SKIPS + 1);
    for (const skipped of all.slice(0, POLLER_ESCALATE_AFTER_SKIPS)) {
      assertEquals(skipped.attributes["swamp.diagnostic.result"], "skipped");
      assertEquals(skipped.attributes["swamp.outcome"], "ok");
      assertEquals(skipped.attributes["swamp.diagnostic.changed"], undefined);
      assertEquals(
        skipped.attributes["swamp.diagnostic.reload_reason"],
        "none",
      );
      const [wait] = childPhases(spans, "gate_wait", skipped);
      assertEquals(wait.attributes["swamp.diagnostic.acquired"], false);
      assertEquals(wait.attributes["swamp.outcome"], "ok");
    }
    const cancelled = all[POLLER_ESCALATE_AFTER_SKIPS];
    for (const late of all.slice(POLLER_ESCALATE_AFTER_SKIPS + 1)) {
      assertEquals(late.attributes["swamp.outcome"], "cancelled");
    }
    assertEquals(cancelled.attributes["swamp.diagnostic.result"], "skipped");
    assertEquals(cancelled.attributes["swamp.outcome"], "cancelled");
    assertEquals(
      cancelled.attributes["swamp.diagnostic.cancel_observed"],
      true,
    );
    const [queued] = childPhases(spans, "gate_wait", cancelled);
    assertEquals(queued.attributes["swamp.diagnostic.gate_mode"], "queued");
    assertEquals(
      queued.attributes["swamp.diagnostic.consecutive_skips"],
      POLLER_ESCALATE_AFTER_SKIPS,
    );
    assertEquals(queued.attributes["swamp.outcome"], "cancelled");
    assertEquals(diagnosticPhases(spans, "remote_pull").length, 0);
  });
});

Deno.test("AccessDataPoller: a failed reload ends its cycle in error, and the next cycle retries it as pending", async () => {
  await withObservedSpans(async (spans) => {
    const sync = createMockSyncService({ pullResult: 1 });
    let attempts = 0;
    const loader = {
      loadCalls: 0,
      unreadable: [],
      load(): Promise<void> {
        attempts++;
        if (attempts === 1) {
          sync.pullResult = 0;
          return Promise.reject(new Error("transient"));
        }
        loader.loadCalls++;
        return Promise.resolve();
      },
    };
    const poller = new AccessDataPoller({
      syncService: sync,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate: () => {},
      pollIntervalMs: 10,
    });
    await capturingPollerLogs(async () => {
      poller.start();
      try {
        await waitFor(() => loader.loadCalls >= 1, "reload after retry");
      } finally {
        await poller.stop();
      }
    });

    const [failed, retried] = cycles(spans);
    assertEquals(failed.attributes["swamp.outcome"], "error");
    assertEquals(
      failed.attributes["swamp.diagnostic.reload_reason"],
      "changed",
    );
    assertEquals(
      failed.attributes["swamp.diagnostic.consecutive_failures"],
      1,
    );
    assertEquals(failed.attributes["swamp.diagnostic.result"], undefined);
    assertEquals(
      retried.attributes["swamp.diagnostic.reload_reason"],
      "pending_retry",
    );
    assertEquals(retried.attributes["swamp.diagnostic.changed"], 0);
    assertEquals(retried.attributes["swamp.diagnostic.result"], "applied");
    assertEquals(retried.attributes["swamp.outcome"], "ok");
    // No gate: the pull is exported, a wait is not.
    assertEquals(diagnosticPhases(spans, "gate_wait").length, 0);
    assertEquals(childPhases(spans, "remote_pull", failed).length, 1);
  });
});

Deno.test("AccessDataPoller: a snapshot missing unreadable records is retried with that reason and count", async () => {
  await withObservedSpans(async (spans) => {
    const sync = createMockSyncService({ pullResult: 0 });
    const loader = createMockPolicySnapshotLoader();
    loader.unreadable = [{ cause: "unreadable" }, { cause: "corrupt" }];
    const poller = new AccessDataPoller({
      syncService: sync,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate: () => {},
      pollIntervalMs: 10,
    });
    poller.start();
    try {
      await waitFor(() => loader.loadCalls >= 1, "a retry");
    } finally {
      await poller.stop();
    }
    const retry = cycleWhere(spans, "reload_reason", "unreadable_retry");
    assertEquals(retry.attributes["swamp.diagnostic.unreadable_records"], 1);
    assertEquals(retry.attributes["swamp.diagnostic.result"], "applied");
    assertEquals(childPhases(spans, "catalog_invalidate", retry).length, 0);
  });
});

Deno.test("AccessDataPoller: a cycle whose pull was skipped but whose pending reload applied ends ok, even once stopped", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    const sync = createMockSyncService({ pullResult: 1 });
    let attempts = 0;
    let stopping: Promise<void> | undefined;
    const loader = {
      loadCalls: 0,
      unreadable: [],
      async load(): Promise<void> {
        attempts++;
        if (attempts === 1) {
          // The pull released the gate; holding it skips the next pull.
          await gate.acquireShared();
          throw new Error("transient");
        }
        // Stopped while the retry runs: the reload still applies.
        stopping = poller.stop();
        loader.loadCalls++;
      },
    };
    const poller = new AccessDataPoller({
      syncService: sync,
      syncGate: gate,
      policySnapshotLoader: loader as unknown as PolicySnapshotLoader,
      catalogInvalidate: () => {},
      pollIntervalMs: 10,
    });
    await capturingPollerLogs(async () => {
      poller.start();
      try {
        await waitFor(() => loader.loadCalls >= 1, "the pending reload");
      } finally {
        await stopping;
        await poller.stop();
        gate.releaseShared();
      }
    });
    const retried = cycles(spans).find((s) =>
      s.attributes["swamp.diagnostic.reload_reason"] === "pending_retry"
    );
    assert(retried, "a pending retry");
    assertEquals(retried.attributes["swamp.diagnostic.result"], "applied");
    assertEquals(retried.attributes["swamp.diagnostic.changed"], undefined);
    assertEquals(retried.attributes["swamp.outcome"], "ok");
    assertEquals(
      retried.attributes["swamp.diagnostic.cancel_observed"],
      true,
    );
    const [wait] = childPhases(spans, "gate_wait", retried);
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], false);
  });
});
