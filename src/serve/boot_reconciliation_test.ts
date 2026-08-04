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
  CLAIM_TTL_MS,
  cleanupExpiredClaims,
  hydrateLocalCache,
  type HydrateLocalCacheDeps,
  reconcileRemoteInterruptedRuns,
  type ReconcileRemoteInterruptedRunsDeps,
  replayPendingRuns,
  type ReplayPendingRunsDeps,
  sweepStaleRecords,
  type TransitionInput,
} from "./boot_reconciliation.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { PendingRunEntry } from "../infrastructure/persistence/run_tracker_store.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type { HeartbeatRecord } from "./instance_heartbeat.ts";
import { ActiveRun, type ActiveRunData } from "../domain/models/active_run.ts";
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
  opts: {
    hasWebhook?: boolean;
    hasCron?: boolean;
    configuredWebhookWorkflows?: ReadonlySet<string>;
    configuredWebhookRoutes?: ReadonlySet<string>;
    configuredCronWorkflows?: ReadonlySet<string>;
  } = {},
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

  // Default to permissive sets that accept anything — individual tests
  // override when they need to exercise the filter logic.
  const configuredWebhookWorkflows = opts.configuredWebhookWorkflows ??
    new Set(
      pending.filter((e) => e.source === "webhook").map((e) =>
        e.workflowIdOrName
      ),
    );
  const configuredWebhookRoutes = opts.configuredWebhookRoutes ??
    new Set(
      pending.filter((e) => e.source === "webhook" && e.route).map((e) =>
        e.route!
      ),
    );
  const configuredCronWorkflows = opts.configuredCronWorkflows ??
    new Set(
      pending.filter((e) => e.source === "cron").map((e) => e.workflowIdOrName),
    );

  const deps: ReplayPendingRunsDeps = {
    runTracker,
    webhookService,
    scheduledExecution,
    configuredWebhookWorkflows,
    configuredWebhookRoutes,
    configuredCronWorkflows,
  };

  return {
    deps,
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

Deno.test("replayPendingRuns: discards webhook entry with unconfigured workflow", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-unconfigured-wf",
      source: "webhook",
      workflowIdOrName: "unknown-workflow",
      payload: JSON.stringify({ body: null, headers: {} }),
      route: "/hooks/deploy",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    {
      configuredWebhookWorkflows: new Set(["my-workflow"]),
      configuredWebhookRoutes: new Set(["/hooks/deploy"]),
    },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(h.webhookReplays.length, 0);
  assertEquals(h.deleted, ["pr-unconfigured-wf"]);
});

Deno.test("replayPendingRuns: discards webhook entry with unconfigured route", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-unconfigured-route",
      source: "webhook",
      workflowIdOrName: "deploy-flow",
      payload: JSON.stringify({ body: null, headers: {} }),
      route: "/unknown",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    {
      configuredWebhookWorkflows: new Set(["deploy-flow"]),
      configuredWebhookRoutes: new Set(["/hooks/github"]),
    },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(h.webhookReplays.length, 0);
  assertEquals(h.deleted, ["pr-unconfigured-route"]);
});

Deno.test("replayPendingRuns: discards cron entry with unconfigured workflow", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-unconfigured-cron",
      source: "cron",
      workflowIdOrName: "unknown",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    {
      configuredCronWorkflows: new Set(["my-scheduled"]),
    },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(h.cronReplays.length, 0);
  assertEquals(h.deleted, ["pr-unconfigured-cron"]);
});

Deno.test("replayPendingRuns: replays valid webhook entry when workflow is configured", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-valid-wh",
      source: "webhook",
      workflowIdOrName: "deploy-flow",
      payload: JSON.stringify({ body: { ref: "main" }, headers: {} }),
      route: "/hooks/deploy",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    {
      configuredWebhookWorkflows: new Set(["deploy-flow"]),
      configuredWebhookRoutes: new Set(["/hooks/deploy"]),
    },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.webhookReplays.length, 1);
  assertEquals(h.webhookReplays[0].workflowIdOrName, "deploy-flow");
  assertEquals(h.webhookReplays[0].pendingRunId, "pr-valid-wh");
});

Deno.test("replayPendingRuns: replays valid cron entry when workflow is configured", async () => {
  const h = createReplayHarness(
    [{
      id: "pr-valid-cron",
      source: "cron",
      workflowIdOrName: "nightly-sync",
      createdAt: "2026-01-01T00:00:00Z",
    }],
    {
      configuredCronWorkflows: new Set(["nightly-sync"]),
    },
  );

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.cronReplays.length, 1);
  assertEquals(h.cronReplays[0].workflowIdOrName, "nightly-sync");
  assertEquals(h.cronReplays[0].pendingRunId, "pr-valid-cron");
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

// ── replayPendingRuns remote merge tests ──────────────────────────────

const encoder2 = new TextEncoder();

function createInMemoryControlPlaneStore(
  entries: Record<string, unknown> = {},
): ControlPlaneStore & { deleted: string[]; data: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(entries)) {
    store.set(key, encoder2.encode(JSON.stringify(value)));
  }
  const deleted: string[] = [];
  return {
    deleted,
    data: store,
    put: (key: string, data: Uint8Array) => {
      store.set(key, data);
      return Promise.resolve();
    },
    putIfAbsent: (key: string, data: Uint8Array) => {
      if (store.has(key)) return Promise.resolve(false);
      store.set(key, data);
      return Promise.resolve(true);
    },
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    delete: (key: string) => {
      store.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
    list: (prefix: string) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return Promise.resolve(keys.sort());
    },
  };
}

Deno.test("replayPendingRuns: merges remote-only entries into replay", async () => {
  const remoteEntry: PendingRunEntry = {
    id: "remote-1",
    source: "webhook",
    workflowIdOrName: "remote-flow",
    payload: JSON.stringify({ body: null, headers: {} }),
    route: "/hooks/remote",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const controlPlaneStore = createInMemoryControlPlaneStore({
    "pending-runs/remote-1": remoteEntry,
  });
  const h = createReplayHarness([], {
    configuredWebhookWorkflows: new Set(["remote-flow"]),
    configuredWebhookRoutes: new Set(["/hooks/remote"]),
  });
  h.deps.controlPlaneStore = controlPlaneStore;

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.webhookReplays.length, 1);
  assertEquals(h.webhookReplays[0].workflowIdOrName, "remote-flow");
});

Deno.test("replayPendingRuns: deduplicates local and remote entries by id", async () => {
  const sharedEntry: PendingRunEntry = {
    id: "dup-1",
    source: "cron",
    workflowIdOrName: "shared-flow",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const controlPlaneStore = createInMemoryControlPlaneStore({
    "pending-runs/dup-1": sharedEntry,
  });
  // Local also has the same entry
  const h = createReplayHarness([sharedEntry], {
    configuredCronWorkflows: new Set(["shared-flow"]),
  });
  h.deps.controlPlaneStore = controlPlaneStore;

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 1);
  assertEquals(h.cronReplays.length, 1);
});

Deno.test("replayPendingRuns: discards invalid remote entries", async () => {
  const controlPlaneStore = createInMemoryControlPlaneStore({
    "pending-runs/bad-1": { id: "bad-1" }, // missing source and workflowIdOrName
  });
  const h = createReplayHarness([]);
  h.deps.controlPlaneStore = controlPlaneStore;

  const count = await replayPendingRuns(h.deps);

  assertEquals(count, 0);
  assertEquals(controlPlaneStore.deleted, ["pending-runs/bad-1"]);
});

// ── reconcileRemoteInterruptedRuns tests ──────────────────────────────

function makeHeartbeat(
  instanceId: string,
  opts?: { stale?: boolean },
): HeartbeatRecord {
  const now = Date.now();
  const heartbeatAt = opts?.stale
    ? new Date(now - 120_000).toISOString()
    : new Date(now).toISOString();
  return {
    instanceId,
    hostname: "test-host",
    pid: 1234,
    startedAt: new Date(now - 300_000).toISOString(),
    heartbeatAt,
  };
}

function makeActiveRunData(
  overrides: Partial<ActiveRunData> = {},
): ActiveRunData {
  return {
    id: crypto.randomUUID(),
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: "test-wf",
    pid: Deno.pid,
    hostname: Deno.hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

function createReconcileHarness(
  heartbeats: Record<string, HeartbeatRecord>,
  runs: ActiveRunData[],
): {
  deps: ReconcileRemoteInterruptedRunsDeps;
  completed: Array<{ runId: string; status: string; reason?: string }>;
  controlPlaneStore: ControlPlaneStore & { deleted: string[] };
} {
  const storeEntries: Record<string, unknown> = {};
  for (const [key, hb] of Object.entries(heartbeats)) {
    storeEntries[`heartbeats/${key}`] = hb;
  }
  const controlPlaneStore = createInMemoryControlPlaneStore(storeEntries);

  const runMap = new Map<string, ActiveRun>();
  for (const data of runs) {
    runMap.set(data.id, ActiveRun.fromData(data));
  }

  const completed: Array<
    { runId: string; status: string; reason?: string }
  > = [];

  const runTracker = {
    findAllRunning: () => [...runMap.values()],
    complete: (runId: string, status: string, reason?: string) => {
      completed.push({ runId, status, reason });
    },
  } as unknown as ReconcileRemoteInterruptedRunsDeps["runTracker"];

  return {
    deps: {
      controlPlaneStore,
      instanceId: "self-instance",
      runTracker,
    },
    completed,
    controlPlaneStore,
  };
}

Deno.test("reconcileRemoteInterruptedRuns: returns 0 when no heartbeats", async () => {
  const h = createReconcileHarness({}, []);
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: skips fresh heartbeats", async () => {
  const h = createReconcileHarness(
    { "inst-a": makeHeartbeat("inst-a", { stale: false }) },
    [makeActiveRunData({ instanceId: "inst-a" })],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
  assertEquals(h.completed.length, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: reaps runs from stale instances", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 1);
  assertEquals(h.completed.length, 1);
  assertEquals(h.completed[0].runId, "run-1");
  assertEquals(h.completed[0].status, "failed");
  assertEquals(h.completed[0].reason, "remote_instance_dead");
});

Deno.test("reconcileRemoteInterruptedRuns: skips self instance", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "self-instance",
    status: "running",
  });
  const h = createReconcileHarness(
    { "self-instance": makeHeartbeat("self-instance", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
  assertEquals(h.completed.length, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: skips runs with no instanceId", async () => {
  const run1 = makeActiveRunData({ id: "run-1", status: "running" });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: skips non-running runs", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "completed",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: reaps multiple stale instances", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-a",
    status: "running",
  });
  const run2 = makeActiveRunData({
    id: "run-2",
    instanceId: "dead-b",
    status: "running",
  });
  const run3 = makeActiveRunData({
    id: "run-3",
    instanceId: "alive-c",
    status: "running",
  });
  const h = createReconcileHarness(
    {
      "dead-a": makeHeartbeat("dead-a", { stale: true }),
      "dead-b": makeHeartbeat("dead-b", { stale: true }),
      "alive-c": makeHeartbeat("alive-c", { stale: false }),
    },
    [run1, run2, run3],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 2);
  assertEquals(h.completed.length, 2);
  const reapedIds = h.completed.map((c) => c.runId).sort();
  assertEquals(reapedIds, ["run-1", "run-2"]);
});

Deno.test("reconcileRemoteInterruptedRuns: creates claim before reaping when putIfAbsent available", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 1);
  assertEquals(h.completed.length, 1);
  const claimData = await h.controlPlaneStore.get(
    "claims/reconcile-instance/dead-inst",
  );
  assertEquals(claimData !== null, true);
  const claim = JSON.parse(new TextDecoder().decode(claimData!));
  assertEquals(claim.claimedBy, "self-instance");
  assertEquals(typeof claim.claimedAt, "string");
});

Deno.test("reconcileRemoteInterruptedRuns: skips instance when claim fails", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  // Pre-populate a claim to simulate another instance having claimed it
  await h.controlPlaneStore.put(
    "claims/reconcile-instance/dead-inst",
    encoder2.encode(
      JSON.stringify({
        claimedBy: "other-instance",
        claimedAt: new Date().toISOString(),
      }),
    ),
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 0);
  assertEquals(h.completed.length, 0);
});

Deno.test("reconcileRemoteInterruptedRuns: defers heartbeat deletion until after reaping", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  const reaped = await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(reaped, 1);
  assertEquals(h.completed.length, 1);
  assertEquals(h.completed[0].runId, "run-1");
  // Heartbeat should be deleted after reaping
  assertEquals(
    h.controlPlaneStore.deleted.includes("heartbeats/dead-inst"),
    true,
  );
});

Deno.test("reconcileRemoteInterruptedRuns: does not delete heartbeat when claim fails", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const h = createReconcileHarness(
    { "dead-inst": makeHeartbeat("dead-inst", { stale: true }) },
    [run1],
  );
  await h.controlPlaneStore.put(
    "claims/reconcile-instance/dead-inst",
    encoder2.encode(
      JSON.stringify({
        claimedBy: "other-instance",
        claimedAt: new Date().toISOString(),
      }),
    ),
  );
  await reconcileRemoteInterruptedRuns(h.deps);
  assertEquals(
    h.controlPlaneStore.deleted.includes("heartbeats/dead-inst"),
    false,
  );
});

Deno.test("reconcileRemoteInterruptedRuns: works without putIfAbsent (graceful degradation)", async () => {
  const storeEntries: Record<string, unknown> = {
    "heartbeats/dead-inst": makeHeartbeat("dead-inst", { stale: true }),
  };
  // Create a store without putIfAbsent
  const store = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(storeEntries)) {
    store.set(key, encoder2.encode(JSON.stringify(value)));
  }
  const deleted: string[] = [];
  const controlPlaneStore: ControlPlaneStore = {
    put: (key: string, data: Uint8Array) => {
      store.set(key, data);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    delete: (key: string) => {
      store.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
    list: (prefix: string) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return Promise.resolve(keys.sort());
    },
  };

  const completed: Array<{ runId: string; status: string; reason?: string }> =
    [];
  const runMap = new Map<string, ActiveRun>();
  const data = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  runMap.set(data.id, ActiveRun.fromData(data));

  const runTracker = {
    findAllRunning: () => [...runMap.values()],
    complete: (runId: string, status: string, reason?: string) => {
      completed.push({ runId, status, reason });
    },
  } as unknown as ReconcileRemoteInterruptedRunsDeps["runTracker"];

  const reaped = await reconcileRemoteInterruptedRuns({
    controlPlaneStore,
    instanceId: "self-instance",
    runTracker,
  });
  assertEquals(reaped, 1);
  assertEquals(completed.length, 1);
  assertEquals(completed[0].reason, "remote_instance_dead");
  assertEquals(deleted.includes("heartbeats/dead-inst"), true);
});

Deno.test("reconcileRemoteInterruptedRuns: putIfAbsent error propagates", async () => {
  const run1 = makeActiveRunData({
    id: "run-1",
    instanceId: "dead-inst",
    status: "running",
  });
  const storeEntries: Record<string, unknown> = {
    "heartbeats/dead-inst": makeHeartbeat("dead-inst", { stale: true }),
  };
  const baseStore = createInMemoryControlPlaneStore(storeEntries);
  const controlPlaneStore: ControlPlaneStore = {
    ...baseStore,
    putIfAbsent: () => Promise.reject(new Error("S3 network timeout")),
  };

  const completed: Array<{ runId: string; status: string; reason?: string }> =
    [];
  const runMap = new Map<string, ActiveRun>();
  runMap.set(run1.id, ActiveRun.fromData(run1));
  const runTracker = {
    findAllRunning: () => [...runMap.values()],
    complete: (runId: string, status: string, reason?: string) => {
      completed.push({ runId, status, reason });
    },
  } as unknown as ReconcileRemoteInterruptedRunsDeps["runTracker"];

  let caught = false;
  try {
    await reconcileRemoteInterruptedRuns({
      controlPlaneStore,
      instanceId: "self-instance",
      runTracker,
    });
  } catch (err) {
    caught = true;
    assertEquals((err as Error).message, "S3 network timeout");
  }
  assertEquals(caught, true);
  assertEquals(completed.length, 0);
});

// ── cleanupExpiredClaims tests ─────────────────────────────────────────

Deno.test("cleanupExpiredClaims: deletes expired claims", async () => {
  const expiredClaim = {
    claimedBy: "inst-a",
    claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString(),
  };
  const store = createInMemoryControlPlaneStore({
    "claims/reconcile-instance/dead-1": expiredClaim,
  });
  const cleaned = await cleanupExpiredClaims({ controlPlaneStore: store });
  assertEquals(cleaned, 1);
  assertEquals(
    store.deleted.includes("claims/reconcile-instance/dead-1"),
    true,
  );
});

Deno.test("cleanupExpiredClaims: keeps fresh claims", async () => {
  const freshClaim = {
    claimedBy: "inst-a",
    claimedAt: new Date().toISOString(),
  };
  const store = createInMemoryControlPlaneStore({
    "claims/reconcile-instance/dead-1": freshClaim,
  });
  const cleaned = await cleanupExpiredClaims({ controlPlaneStore: store });
  assertEquals(cleaned, 0);
  assertEquals(store.deleted.length, 0);
});

Deno.test("cleanupExpiredClaims: deletes corrupt claim records", async () => {
  const store = createInMemoryControlPlaneStore();
  store.data.set(
    "claims/reconcile-instance/bad-1",
    encoder2.encode("not-valid-json{{{"),
  );
  const cleaned = await cleanupExpiredClaims({ controlPlaneStore: store });
  assertEquals(cleaned, 1);
});

Deno.test("cleanupExpiredClaims: no-op with empty claims list", async () => {
  const store = createInMemoryControlPlaneStore({});
  const cleaned = await cleanupExpiredClaims({ controlPlaneStore: store });
  assertEquals(cleaned, 0);
});

// ── hydrateLocalCache tests ─────────────────────────────────────────

function createHydrateDeps(
  opts: {
    pullResult?: number | void;
    pullError?: Error;
  } = {},
): { deps: HydrateLocalCacheDeps; invalidated: boolean[] } {
  const invalidated: boolean[] = [];
  const syncService = {
    pullChanged: () => {
      if (opts.pullError) return Promise.reject(opts.pullError);
      return Promise.resolve(opts.pullResult);
    },
  } as unknown as DatastoreSyncService;

  return {
    deps: {
      syncService,
      catalogInvalidate: () => invalidated.push(true),
    },
    invalidated,
  };
}

Deno.test("hydrateLocalCache: calls pullChanged and returns file count", async () => {
  const h = createHydrateDeps({ pullResult: 42 });
  const result = await hydrateLocalCache(h.deps);
  assertEquals(result.pulled, 42);
});

Deno.test("hydrateLocalCache: invalidates catalog after successful pull", async () => {
  const h = createHydrateDeps({ pullResult: 5 });
  await hydrateLocalCache(h.deps);
  assertEquals(h.invalidated.length, 1);
});

Deno.test("hydrateLocalCache: handles void return from pullChanged", async () => {
  const h = createHydrateDeps({ pullResult: undefined });
  const result = await hydrateLocalCache(h.deps);
  assertEquals(result.pulled, 0);
  assertEquals(h.invalidated.length, 1);
});

Deno.test("hydrateLocalCache: catches pull failure and returns zero", async () => {
  const h = createHydrateDeps({ pullError: new Error("S3 timeout") });
  const result = await hydrateLocalCache(h.deps);
  assertEquals(result.pulled, 0);
});

Deno.test("hydrateLocalCache: does not invalidate catalog on failure", async () => {
  const h = createHydrateDeps({ pullError: new Error("network error") });
  await hydrateLocalCache(h.deps);
  assertEquals(h.invalidated.length, 0);
});
