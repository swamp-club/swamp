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
import {
  type BootReconciliationDeps,
  reconcileRemoteInterruptedRuns,
  replayPendingRuns,
  type ReplayPendingRunsDeps,
  sweepStaleRecords,
  type TransitionInput,
} from "./boot_reconciliation.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type { PendingRunEntry } from "../infrastructure/persistence/run_tracker_store.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { Data } from "../domain/data/data.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

const encoder = new TextEncoder();

interface DataItem {
  modelName: string;
  dataName: string;
  modelType: string;
  attrs: Record<string, unknown>;
}

function makeData(
  item: DataItem,
): { data: Data; modelType: ModelType; modelId: string } {
  const modelType = ModelType.create(item.modelType);
  const modelId = `def-${item.modelName}`;
  const data = Data.create({
    name: item.dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", modelName: item.modelName },
    ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
  });
  return { data, modelType, modelId };
}

function createHarness(items: Map<string, DataItem[]>) {
  const transitions: TransitionInput[] = [];
  let failOn: string | null = null;
  const contentMap = new Map<string, Uint8Array>();
  const dataByType = new Map<
    string,
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >();

  for (const [typeKey, typeItems] of items) {
    const dataItems: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of typeItems) {
      const d = makeData(item);
      dataItems.push(d);
      const key = `${d.modelType.normalized}/${d.modelId}/${d.data.name}`;
      contentMap.set(key, encoder.encode(JSON.stringify(item.attrs)));
    }
    dataByType.set(typeKey, dataItems);
  }

  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      unifiedDataRepo: {
        findAllForType: (type: ModelType) => {
          return Promise.resolve(dataByType.get(type.normalized) ?? []);
        },
        getContent: (
          type: ModelType,
          modelId: string,
          dataName: string,
        ) => {
          const key = `${type.normalized}/${modelId}/${dataName}`;
          return Promise.resolve(contentMap.get(key) ?? null);
        },
      },
    } as unknown as RepositoryContext,
    runTransition: (input: TransitionInput) => {
      if (failOn && input.definitionName === failOn) {
        return Promise.reject(new Error(`transition failed: ${failOn}`));
      }
      transitions.push(input);
      return Promise.resolve();
    },
  };

  return {
    deps,
    transitions,
    setFailOn: (name: string) => {
      failOn = name;
    },
  };
}

Deno.test("sweepStaleRecords: clean boot returns zeros with no transitions", async () => {
  const h = createHarness(new Map());
  const result = await sweepStaleRecords(h.deps);

  assertEquals(result, { leases: 0, pendingDispatches: 0, workers: 0 });
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: expires active leases", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "lease-1", state: "active" },
        },
        {
          modelName: "leases",
          dataName: "data-secondary",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "lease-2", state: "active" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 2);
  assertEquals(h.transitions.length, 2);
  assertEquals(h.transitions[0].typeArg, "swamp/step-lease");
  assertEquals(h.transitions[0].methodName, "expire");
  assertEquals(h.transitions[0].inputs.leaseId, "lease-1");
  assertEquals(h.transitions[0].inputs.error, "orchestrator restart");
  assertEquals(h.transitions[1].inputs.leaseId, "lease-2");
});

Deno.test("sweepStaleRecords: orphans waiting pending dispatches", async () => {
  const h = createHarness(
    new Map([
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { queueId: "q-1", state: "waiting" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.pendingDispatches, 1);
  assertEquals(h.transitions.length, 1);
  assertEquals(h.transitions[0].typeArg, "swamp/pending-dispatch");
  assertEquals(h.transitions[0].methodName, "orphan");
  assertEquals(h.transitions[0].inputs.queueId, "q-1");
  assertEquals(typeof h.transitions[0].inputs.endedAt, "string");
});

Deno.test("sweepStaleRecords: disconnects stale workers", async () => {
  const h = createHarness(
    new Map([
      ["swamp/worker", [
        {
          modelName: "worker-w1",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { name: "w1", status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.workers, 1);
  assertEquals(h.transitions.length, 1);
  assertEquals(h.transitions[0].typeArg, "swamp/worker");
  assertEquals(h.transitions[0].definitionName, "worker-w1");
  assertEquals(h.transitions[0].methodName, "set_status");
  assertEquals(h.transitions[0].inputs.status, "disconnected");
});

Deno.test("sweepStaleRecords: transition failure warns but continues sweeping", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "bad-lease", state: "active" },
        },
        {
          modelName: "leases",
          dataName: "data-secondary",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "good-lease", state: "active" },
        },
      ]],
    ]),
  );
  h.setFailOn("leases");

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: mixed failure and success across model types", async () => {
  let callCount = 0;
  const leaseItem = makeData({
    modelName: "leases",
    dataName: "data-main",
    modelType: "swamp/step-lease",
    attrs: { leaseId: "l1", state: "active" },
  });
  const leaseAttrs = { leaseId: "l1", state: "active" };

  const workerItem = makeData({
    modelName: "worker-w1",
    dataName: "state-main",
    modelType: "swamp/worker",
    attrs: { name: "w1", status: "busy" },
  });
  const workerAttrs = { name: "w1", status: "busy" };

  const contentMap = new Map<string, Uint8Array>();
  contentMap.set(
    `${leaseItem.modelType.normalized}/${leaseItem.modelId}/${leaseItem.data.name}`,
    encoder.encode(JSON.stringify(leaseAttrs)),
  );
  contentMap.set(
    `${workerItem.modelType.normalized}/${workerItem.modelId}/${workerItem.data.name}`,
    encoder.encode(JSON.stringify(workerAttrs)),
  );

  const deps: BootReconciliationDeps = {
    repoDir: "/tmp/test",
    repoContext: {
      unifiedDataRepo: {
        findAllForType: (type: ModelType) => {
          if (type.normalized === "swamp/step-lease") {
            return Promise.resolve([leaseItem]);
          }
          if (type.normalized === "swamp/worker") {
            return Promise.resolve([workerItem]);
          }
          return Promise.resolve([]);
        },
        getContent: (
          type: ModelType,
          modelId: string,
          dataName: string,
        ) => {
          const key = `${type.normalized}/${modelId}/${dataName}`;
          return Promise.resolve(contentMap.get(key) ?? null);
        },
      },
    } as unknown as RepositoryContext,
    runTransition: () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("lease transition failed"));
      }
      return Promise.resolve();
    },
  };

  const result = await sweepStaleRecords(deps);

  assertEquals(result.leases, 0);
  assertEquals(result.pendingDispatches, 0);
  assertEquals(result.workers, 1);
});

Deno.test("sweepStaleRecords: skips records with missing leaseId attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { state: "active" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.leases, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: skips records with missing queueId attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { state: "waiting" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.pendingDispatches, 0);
  assertEquals(h.transitions.length, 0);
});

Deno.test("sweepStaleRecords: skips records with missing worker name attribute", async () => {
  const h = createHarness(
    new Map([
      ["swamp/worker", [
        {
          modelName: "worker-orphan",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result.workers, 0);
  assertEquals(h.transitions.length, 0);
});

// ── replayPendingRuns tests ──────────────────────────────────────────

interface ReplayedWebhook {
  pendingRunId: string;
  workflowIdOrName: string;
  route: string;
}

interface ReplayedCron {
  pendingRunId: string;
  workflowIdOrName: string;
}

function createReplayHarness(
  pending: PendingRunEntry[],
  opts: { hasWebhook?: boolean; hasCron?: boolean } = {},
) {
  const deleted: string[] = [];
  const webhookReplays: ReplayedWebhook[] = [];
  const cronReplays: ReplayedCron[] = [];

  const runTracker = {
    findAllPendingRuns: () => pending,
    deletePendingRun: (id: string) => deleted.push(id),
  } as unknown as ReplayPendingRunsDeps["runTracker"];

  const webhookService = opts.hasWebhook !== false
    ? {
      enqueueForReplay: (entry: ReplayedWebhook) => webhookReplays.push(entry),
    } as unknown as ReplayPendingRunsDeps["webhookService"]
    : undefined;

  const scheduledExecution = opts.hasCron !== false
    ? {
      enqueueForReplay: (entry: ReplayedCron) => cronReplays.push(entry),
    } as unknown as ReplayPendingRunsDeps["scheduledExecution"]
    : undefined;

  return {
    deps: { runTracker, webhookService, scheduledExecution },
    deleted,
    webhookReplays,
    cronReplays,
  };
}

Deno.test("replayPendingRuns: returns 0 with no pending runs", async () => {
  const h = createReplayHarness([]);
  assertEquals(await replayPendingRuns(h.deps), 0);
});

Deno.test("replayPendingRuns: replays webhook run to webhook service", async () => {
  const h = createReplayHarness([{
    id: "pr-1",
    source: "webhook",
    workflowIdOrName: "deploy-flow",
    payload: JSON.stringify({
      body: { ref: "main" },
      headers: { "x-sig": "abc" },
      route: "/hooks/deploy",
    }),
    route: "/hooks/deploy",
    createdAt: "2026-01-01T00:00:00Z",
  }]);

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.webhookReplays.length, 1);
  assertEquals(h.webhookReplays[0].workflowIdOrName, "deploy-flow");
  assertEquals(h.webhookReplays[0].pendingRunId, "pr-1");
});

Deno.test("replayPendingRuns: replays cron run to scheduled execution", async () => {
  const h = createReplayHarness([{
    id: "pr-2",
    source: "cron",
    workflowIdOrName: "nightly-sync",
    createdAt: "2026-01-01T00:00:00Z",
  }]);

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.cronReplays.length, 1);
  assertEquals(h.cronReplays[0].workflowIdOrName, "nightly-sync");
  assertEquals(h.cronReplays[0].pendingRunId, "pr-2");
});

Deno.test("replayPendingRuns: discards webhook run with corrupt payload", async () => {
  const h = createReplayHarness([{
    id: "pr-bad",
    source: "webhook",
    workflowIdOrName: "deploy-flow",
    payload: "not-json{{{",
    route: "/hooks/deploy",
    createdAt: "2026-01-01T00:00:00Z",
  }]);

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(h.webhookReplays.length, 0);
  assertEquals(h.deleted, ["pr-bad"]);
});

Deno.test("replayPendingRuns: discards run when no matching service", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-orphan",
      source: "webhook",
      workflowIdOrName: "some-flow",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    { hasWebhook: false },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(h.deleted, ["pr-orphan"]);
});

Deno.test("replayPendingRuns: replays mixed webhook and cron runs", async () => {
  const h = createReplayHarness([
    {
      id: "pr-1",
      source: "webhook",
      workflowIdOrName: "deploy",
      payload: JSON.stringify({ body: null, headers: {} }),
      route: "/hooks/ci",
      createdAt: "2026-01-01T00:00:01Z",
    },
    {
      id: "pr-2",
      source: "cron",
      workflowIdOrName: "nightly",
      createdAt: "2026-01-01T00:00:02Z",
    },
  ]);

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 2);
  assertEquals(h.webhookReplays.length, 1);
  assertEquals(h.cronReplays.length, 1);
});

Deno.test("replayPendingRuns: webhook with no payload uses empty object", async () => {
  const h = createReplayHarness([{
    id: "pr-empty",
    source: "webhook",
    workflowIdOrName: "deploy",
    route: "/hooks/ci",
    createdAt: "2026-01-01T00:00:00Z",
  }]);

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.webhookReplays.length, 1);
});

Deno.test("sweepStaleRecords: sweeps all three model types together", async () => {
  const h = createHarness(
    new Map([
      ["swamp/step-lease", [
        {
          modelName: "leases",
          dataName: "data-main",
          modelType: "swamp/step-lease",
          attrs: { leaseId: "l1", state: "active" },
        },
      ]],
      ["swamp/pending-dispatch", [
        {
          modelName: "pending",
          dataName: "data-main",
          modelType: "swamp/pending-dispatch",
          attrs: { queueId: "q1", state: "waiting" },
        },
      ]],
      ["swamp/worker", [
        {
          modelName: "worker-w1",
          dataName: "state-main",
          modelType: "swamp/worker",
          attrs: { name: "w1", status: "idle" },
        },
      ]],
    ]),
  );

  const result = await sweepStaleRecords(h.deps);

  assertEquals(result, { leases: 1, pendingDispatches: 1, workers: 1 });
  assertEquals(h.transitions.length, 3);
});

// ── reconcileRemoteInterruptedRuns tests ────────────────────────────

function createMockControlPlaneStore(): ControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put(key: string, value: Uint8Array): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
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
        [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
      );
    },
  };
}

function makeHeartbeat(
  instanceId: string,
  stale: boolean,
): Uint8Array {
  const heartbeatAt = stale
    ? new Date(Date.now() - 120_000).toISOString()
    : new Date().toISOString();
  return new TextEncoder().encode(JSON.stringify({
    instanceId,
    hostname: "test-host",
    pid: 12345,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt,
  }));
}

interface MockRun {
  id: string;
  workflowName: string;
  status: string;
  instanceId?: string;
  interrupted: boolean;
  saved: boolean;
}

function createMockWorkflowRunRepo(
  runs: MockRun[],
): import("./boot_reconciliation.ts").RemoteReconciliationDeps[
  "workflowRunRepo"
] {
  return {
    findAllGlobalSince(_since: Date) {
      return Promise.resolve(
        runs.map((r) => ({
          run: {
            id: r.id,
            workflowName: r.workflowName,
            status: r.status,
            instanceId: r.instanceId,
            interrupt(_reason: string) {
              r.interrupted = true;
              r.status = "failed";
            },
          } as unknown as import("../domain/workflows/workflow_run.ts").WorkflowRun,
          workflowId:
            `wf-${r.id}` as unknown as import("../domain/workflows/workflow_id.ts").WorkflowId,
        })),
      );
    },
    save(_wid, _run) {
      const run = _run as unknown as { id: string };
      const match = runs.find((r) => r.id === run.id);
      if (match) match.saved = true;
      return Promise.resolve();
    },
  };
}

Deno.test("reconcileRemoteInterruptedRuns: no heartbeats returns 0", async () => {
  const store = createMockControlPlaneStore();
  const repo = createMockWorkflowRunRepo([]);

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: repo,
  });

  assertEquals(count, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: fresh heartbeat is skipped", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/other", makeHeartbeat("other", false));

  const runs: MockRun[] = [{
    id: "r1",
    workflowName: "wf1",
    status: "running",
    instanceId: "other",
    interrupted: false,
    saved: false,
  }];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 0);
  assertEquals(runs[0].interrupted, false);
});

Deno.test("reconcileRemoteInterruptedRuns: stale heartbeat interrupts matching runs", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/dead", makeHeartbeat("dead", true));

  const runs: MockRun[] = [{
    id: "r1",
    workflowName: "wf1",
    status: "running",
    instanceId: "dead",
    interrupted: false,
    saved: false,
  }];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 1);
  assertEquals(runs[0].interrupted, true);
  assertEquals(runs[0].saved, true);
  assertEquals(store.data.has("heartbeats/dead"), false);
});

Deno.test("reconcileRemoteInterruptedRuns: skips own heartbeat", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/my-instance", makeHeartbeat("my-instance", true));

  const runs: MockRun[] = [{
    id: "r1",
    workflowName: "wf1",
    status: "running",
    instanceId: "my-instance",
    interrupted: false,
    saved: false,
  }];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 0);
  assertEquals(runs[0].interrupted, false);
});

Deno.test("reconcileRemoteInterruptedRuns: skips runs without instanceId", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/dead", makeHeartbeat("dead", true));

  const runs: MockRun[] = [{
    id: "r1",
    workflowName: "wf1",
    status: "running",
    instanceId: undefined,
    interrupted: false,
    saved: false,
  }];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 0);
  assertEquals(runs[0].interrupted, false);
});

Deno.test("reconcileRemoteInterruptedRuns: skips non-running runs", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/dead", makeHeartbeat("dead", true));

  const runs: MockRun[] = [{
    id: "r1",
    workflowName: "wf1",
    status: "succeeded",
    instanceId: "dead",
    interrupted: false,
    saved: false,
  }];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: multiple stale instances", async () => {
  const store = createMockControlPlaneStore();
  store.data.set("heartbeats/dead-a", makeHeartbeat("dead-a", true));
  store.data.set("heartbeats/dead-b", makeHeartbeat("dead-b", true));

  const runs: MockRun[] = [
    {
      id: "r1",
      workflowName: "wf1",
      status: "running",
      instanceId: "dead-a",
      interrupted: false,
      saved: false,
    },
    {
      id: "r2",
      workflowName: "wf2",
      status: "running",
      instanceId: "dead-b",
      interrupted: false,
      saved: false,
    },
  ];

  const count = await reconcileRemoteInterruptedRuns({
    controlPlaneStore: store,
    instanceId: "my-instance",
    workflowRunRepo: createMockWorkflowRunRepo(runs),
  });

  assertEquals(count, 2);
  assertEquals(runs[0].interrupted, true);
  assertEquals(runs[1].interrupted, true);
  assertEquals(store.data.has("heartbeats/dead-a"), false);
  assertEquals(store.data.has("heartbeats/dead-b"), false);
});

// ── replayPendingRuns remote merge tests ────────────────────────────

Deno.test("replayPendingRuns: merges remote entries when local is empty", async () => {
  const store = createMockControlPlaneStore();
  const entry: PendingRunEntry = {
    id: "remote-1",
    source: "webhook",
    workflowIdOrName: "deploy",
    payload: '{"body":{},"headers":{},"route":"/hooks/test"}',
    route: "/hooks/test",
    createdAt: new Date().toISOString(),
  };
  store.data.set(
    "pending-runs/remote-1",
    new TextEncoder().encode(JSON.stringify(entry)),
  );

  const h = createReplayHarness([]);
  (h.deps as ReplayPendingRunsDeps).controlPlaneStore = store;

  const count = await replayPendingRuns(h.deps);
  assertEquals(count, 1);
  assertEquals(h.webhookReplays.length, 1);
  assertEquals(h.webhookReplays[0].workflowIdOrName, "deploy");
});

Deno.test("replayPendingRuns: deduplicates remote entries against local", async () => {
  const store = createMockControlPlaneStore();
  const entry: PendingRunEntry = {
    id: "dup-1",
    source: "webhook",
    workflowIdOrName: "deploy",
    payload: '{"body":{},"headers":{},"route":"/hooks/test"}',
    route: "/hooks/test",
    createdAt: new Date().toISOString(),
  };
  store.data.set(
    "pending-runs/dup-1",
    new TextEncoder().encode(JSON.stringify(entry)),
  );

  const h = createReplayHarness([entry]);
  (h.deps as ReplayPendingRunsDeps).controlPlaneStore = store;

  const count = await replayPendingRuns(h.deps);
  assertEquals(count, 1);
});

Deno.test("replayPendingRuns: discards invalid remote entries", async () => {
  const store = createMockControlPlaneStore();
  store.data.set(
    "pending-runs/bad-1",
    new TextEncoder().encode('{"id":"bad-1"}'),
  );

  const h = createReplayHarness([]);
  (h.deps as ReplayPendingRunsDeps).controlPlaneStore = store;

  const count = await replayPendingRuns(h.deps);
  assertEquals(count, 0);
});
