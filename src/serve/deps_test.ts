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

import { assertEquals, assertInstanceOf, assertMatch } from "@std/assert";
import { WorkflowExecutionService } from "../domain/workflows/execution_service.ts";
import {
  createStepLockHook,
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "./deps.ts";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { resolveDatastoreForRepo } from "../cli/repo_context.ts";
import { VERSION } from "../cli/commands/version.ts";
import { isCustomDatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { WorkflowTelemetrySink } from "../libswamp/workflows/run.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { createLegacyUnitOfWork } from "../infrastructure/persistence/legacy_unit_of_work.ts";
import { useUnitOfWorkFactoryForTesting } from "../infrastructure/persistence/repo_unit_of_work.ts";
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

Deno.test("executeWorkflowWithLocks: runs in one root unit whose flush is the post-run push, if any", async () => {
  for (const syncService of [stubSyncService(), undefined]) {
    const ctx = stubRepoContextWithRepos();
    const roots: { hookMatches: boolean; flushes: boolean }[] = [];
    const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
      if (options.role === "root") {
        roots.push({
          hookMatches: markDirty === ctx.markDirty,
          flushes: options.flush !== undefined,
        });
      }
      return createLegacyUnitOfWork(markDirty, {
        flush: options.flush,
        parent: options.parent,
        afterCommit: "forward",
      });
    });
    try {
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
    } finally {
      dispose();
    }

    assertEquals(roots, [{
      hookMatches: true,
      flushes: syncService !== undefined,
    }]);
    if (syncService) assertEquals(syncService.pushCalledCount, 1);
  }
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

// Serve runs requests under the locks a client forwarded
// (runAdoptingForwardedLocks). A step run in that scope whose hook did not
// name its locks would have its nested swamp wait on the step's own lock.
Deno.test("createStepLockHook: names the lock it took by the nonce in its lock file", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-step-lock-hook-" });
  try {
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    const modelId = crypto.randomUUID();
    const hook = createStepLockHook(
      repoDir,
      stubRepoContext(),
      datastoreConfig,
      undefined,
      undefined,
    );

    const lock = await hook("test/step-lock-hook", modelId);
    try {
      const nonces: string[] = [];
      for await (
        const entry of walk(datastoreConfig.path, {
          includeDirs: false,
          match: [/\.lock$/],
        })
      ) {
        if (!entry.path.includes(modelId)) continue;
        nonces.push(
          String(JSON.parse(await Deno.readTextFile(entry.path)).nonce),
        );
      }

      assertEquals(nonces.length, 1);
      assertMatch(nonces[0], /^[A-Za-z0-9-]+$/);
      assertEquals(lock.heldLockIds, nonces);
    } finally {
      await lock.flush();
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
