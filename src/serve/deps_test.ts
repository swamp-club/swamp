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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { WorkflowExecutionService } from "../domain/workflows/execution_service.ts";
import { createWorkflowRunDeps, executeWorkflowWithLocks } from "./deps.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { WorkflowTelemetrySink } from "../libswamp/mod.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { createSyncGate } from "./sync_gate.ts";
import { waitFor } from "@swamp-club/swamp-testing";

// CLI-adjacent code needs logging initialized and the models barrel imported
// before it can run.
import "../domain/models/models.ts";

await initializeLogging({});

/**
 * `createWorkflowRunDeps` only reads a handful of fields off the context to
 * assemble the deps object, so a partial stub is enough to observe how the
 * telemetry sink is threaded through.
 */
function stubRepoContext(): RepositoryContext {
  return {
    workflowRepo: {},
    workflowRunRepo: {},
    catalogStore: {},
    unifiedDataRepo: { namespace: "test" },
    definitionRepo: {},
    autoDefinitionsDir: "/tmp/auto-definitions",
    markDirty: () => {},
    eventBus: {},
  } as unknown as RepositoryContext;
}

const datastoreConfig = { type: "filesystem" } as unknown as DatastoreConfig;

Deno.test("createWorkflowRunDeps: sets telemetrySink when one is supplied", async () => {
  const sink: WorkflowTelemetrySink = {
    parentInvocationId: "parent-1",
    recordChildInvocation: () => Promise.resolve(),
  };

  const deps = await createWorkflowRunDeps(
    "/tmp/repo",
    stubRepoContext(),
    datastoreConfig,
    undefined,
    undefined,
    { telemetrySink: sink },
  );

  assertEquals(deps.telemetrySink, sink);
});

Deno.test("createWorkflowRunDeps: leaves telemetrySink undefined by default", async () => {
  // Callers that are not a serve-executed run must stay a no-op — libswamp
  // only constructs its telemetry bridge when the sink is present.
  const deps = await createWorkflowRunDeps(
    "/tmp/repo",
    stubRepoContext(),
    datastoreConfig,
  );

  assertEquals(deps.telemetrySink, undefined);
});

Deno.test("createWorkflowRunDeps: createExecutionService produces a WorkflowExecutionService", async () => {
  const deps = await createWorkflowRunDeps(
    "/tmp/repo",
    stubRepoContext(),
    datastoreConfig,
  );

  const service = deps.createExecutionService(
    {} as never,
    {} as never,
    "/tmp/repo",
    {} as never,
  );

  assertInstanceOf(service, WorkflowExecutionService);
});

function stubSyncService(): DatastoreSyncService & { pushCalledCount: number } {
  const svc = {
    pushCalledCount: 0,
    pullChanged: () => Promise.resolve(),
    pushChanged: () => {
      svc.pushCalledCount++;
      return Promise.resolve();
    },
    markDirty: () => Promise.resolve(),
  };
  return svc;
}

function stubRepoContextWithRepos(): RepositoryContext {
  return {
    workflowRepo: {
      findByName: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      findAll: () => Promise.resolve([]),
    },
    workflowRunRepo: {},
    catalogStore: { invalidate: () => {} },
    unifiedDataRepo: { namespace: "test" },
    definitionRepo: {},
    autoDefinitionsDir: "/tmp/auto-definitions",
    markDirty: () => {},
    eventBus: {},
  } as unknown as RepositoryContext;
}

Deno.test("executeWorkflowWithLocks: calls pushChanged after run completes", async () => {
  const syncService = stubSyncService();
  const ctx = stubRepoContextWithRepos();

  await executeWorkflowWithLocks(
    "/tmp/repo",
    ctx,
    datastoreConfig,
    { workflowIdOrName: "nonexistent" },
    new AbortController().signal,
    () => {},
    syncService,
    undefined,
    { syncGate: undefined },
  );

  assertEquals(syncService.pushCalledCount, 1);
});

Deno.test("executeWorkflowWithLocks: calls pushChanged even when onEvent throws", async () => {
  const syncService = stubSyncService();
  const ctx = stubRepoContextWithRepos();

  let threw = false;
  try {
    await executeWorkflowWithLocks(
      "/tmp/repo",
      ctx,
      datastoreConfig,
      { workflowIdOrName: "nonexistent" },
      new AbortController().signal,
      () => {
        throw new Error("deliberate onEvent failure");
      },
      syncService,
      undefined,
      { syncGate: undefined },
    );
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
  assertEquals(syncService.pushCalledCount, 1);
});

Deno.test("executeWorkflowWithLocks: skips pushChanged when no syncService", async () => {
  const ctx = stubRepoContextWithRepos();

  await executeWorkflowWithLocks(
    "/tmp/repo",
    ctx,
    datastoreConfig,
    { workflowIdOrName: "nonexistent" },
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    { syncGate: undefined },
  );
});

Deno.test("executeWorkflowWithLocks: the post-run push waits while a pull holds the sync gate", async () => {
  // swamp-club#2405: a poller pull that overlaps a run's push prunes the
  // entries that push commits. The push must queue behind the pull.
  const syncService = stubSyncService();
  const ctx = stubRepoContextWithRepos();
  const gate = createSyncGate();
  await gate.acquire(); // a poller pull in flight

  const run = executeWorkflowWithLocks(
    "/tmp/repo",
    ctx,
    datastoreConfig,
    { workflowIdOrName: "nonexistent" },
    new AbortController().signal,
    () => {},
    syncService,
    undefined,
    { syncGate: gate },
  );

  await waitFor(() => gate.waiters === 1, "post-run push queued on the gate");
  assertEquals(syncService.pushCalledCount, 0);

  gate.release();
  await run;

  assertEquals(syncService.pushCalledCount, 1);
  assertEquals(gate.sharedHolders, 0);
});

Deno.test("executeWorkflowWithLocks: post-run pushes of concurrent runs share the gate", async () => {
  const ctx = stubRepoContextWithRepos();
  const gate = createSyncGate();
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const syncService: DatastoreSyncService = {
    pullChanged: () => Promise.resolve(),
    pushChanged: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await released;
      active--;
    },
    markDirty: () => Promise.resolve(),
  };

  const runOnce = () =>
    executeWorkflowWithLocks(
      "/tmp/repo",
      ctx,
      datastoreConfig,
      { workflowIdOrName: "nonexistent" },
      new AbortController().signal,
      () => {},
      syncService,
      undefined,
      { syncGate: gate },
    );
  const runs = [runOnce(), runOnce()];

  await waitFor(() => active === 2, "both post-run pushes in flight");
  release();
  await Promise.all(runs);

  assertEquals(maxActive, 2);
});
