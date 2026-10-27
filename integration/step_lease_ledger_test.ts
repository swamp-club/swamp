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

// Serve records a dispatch's lease transitions through StepLeaseLedger,
// which reads and writes the one lease record directly instead of running a
// `swamp/step-lease` method (swamp-club#4038). These tests run the ledger
// against a real repository on disk, v2 and v3, and check that what it
// writes is what the method run writes, that leases written at once lose
// nothing, and that the boot sweep and the bookkeeping reaper still handle
// them.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { Data } from "../src/domain/data/data.ts";
import {
  type AcquireLeaseArgs,
  leaseDataName,
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
  type StepLease,
} from "../src/domain/models/worker/step_lease_model.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";
import {
  createBookkeepingRecordQuery,
  reapEndedBookkeepingRecords,
} from "../src/serve/bookkeeping_gc.ts";
import {
  methodRunnerLeaseStore,
  StepLeaseLedger,
  type StepLeaseStore,
} from "../src/serve/step_lease_ledger.ts";
import type { ModelMethodRunner } from "../src/serve/worker_gateway.ts";
import { datastoreRecords } from "./usecase_v3_fixtures.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

await initializeLogging({});

const BURST = 25;

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

/**
 * Runs a `swamp/step-lease` method the way serve's dispatch runner does,
 * inside a root with no push as the dispatching run provides in serve.
 */
function methodRunner(dir: string, ctx: RepositoryContext): ModelMethodRunner {
  return (input) =>
    runInRootUnitOfWork(ctx, { flush: undefined }, async () => {
      const deps = await createWorkerModelRunDeps(dir, ctx, {
        definitionType: STEP_LEASE_MODEL_TYPE,
      });
      for await (
        const event of modelMethodRun(createLibSwampContext({}), deps, {
          modelIdOrName: input.definitionName,
          methodName: input.methodName,
          inputs: input.inputs,
          lastEvaluated: false,
          typeArg: input.typeArg,
          definitionName: input.definitionName,
          skipAllReports: true,
        })
      ) {
        if (event.kind === "error") {
          throw new Error(JSON.stringify(event.error));
        }
      }
    });
}

/** A store that counts the transitions it is handed. */
function counting(store: StepLeaseStore): StepLeaseStore & { calls: number } {
  const counted = {
    calls: 0,
    acquire: (args: AcquireLeaseArgs) => {
      counted.calls++;
      return store.acquire(args);
    },
    markWrites: (leaseId: string) => {
      counted.calls++;
      return store.markWrites(leaseId);
    },
    end: (...args: Parameters<StepLeaseStore["end"]>) => {
      counted.calls++;
      return store.end(...args);
    },
  };
  return counted;
}

function acquireArgs(leaseId: string): AcquireLeaseArgs {
  return {
    leaseId,
    dispatchId: `d-${leaseId}`,
    workerName: "w1",
    modelType: "command/shell",
    modelId: "m1",
    methodName: "execute",
    workflowName: "deploy",
    workflowRunId: "run-1",
    stepName: "build",
  };
}

async function leasesDefinitionId(ctx: RepositoryContext): Promise<string> {
  const definition = await ctx.definitionRepo.findByName(
    STEP_LEASE_MODEL_TYPE,
    STEP_LEASE_INSTANCE_NAME,
  );
  assert(definition !== null, "the leases definition exists");
  return definition.id;
}

async function storedLease(
  ctx: RepositoryContext,
  leaseId: string,
): Promise<{ data: Data; lease: StepLease }> {
  const modelId = await leasesDefinitionId(ctx);
  const name = leaseDataName(leaseId);
  const data = await ctx.unifiedDataRepo.findByName(
    STEP_LEASE_MODEL_TYPE,
    modelId,
    name,
  );
  assert(data !== null, `lease ${leaseId} is stored`);
  const content = await ctx.unifiedDataRepo.getContent(
    STEP_LEASE_MODEL_TYPE,
    modelId,
    name,
  );
  assert(content !== null);
  return {
    data,
    lease: JSON.parse(new TextDecoder().decode(content)) as StepLease,
  };
}

/** What a reader of the record sees besides its body. */
function metadata(data: Data) {
  return {
    contentType: data.contentType,
    lifetime: data.lifetime,
    garbageCollection: data.garbageCollection,
    tags: data.tags,
    ownerDefinition: data.ownerDefinition,
    version: data.version,
  };
}

/** Builds a lease through each path and checks they store the same record. */
async function assertLedgerMatchesMethodRun(
  dir: string,
  ctx: RepositoryContext,
): Promise<void> {
  const viaMethod = methodRunnerLeaseStore(methodRunner(dir, ctx));
  const fallback = counting(viaMethod);
  const ledger = new StepLeaseLedger(ctx, fallback);

  for (
    const [store, leaseId] of [[viaMethod, "method"], [
      ledger,
      "ledger",
    ]] as const
  ) {
    await store.acquire(acquireArgs(leaseId));
    await store.markWrites(leaseId);
    await store.end(leaseId, "failed", "boom");
  }
  // The method run created the definition, so the ledger never fell back.
  assertEquals(fallback.calls, 0);

  const method = await storedLease(ctx, "method");
  const ledgerLease = await storedLease(ctx, "ledger");
  assertEquals(metadata(ledgerLease.data), metadata(method.data));
  const comparable = (
    { leaseId: _l, dispatchId: _d, createdAt: _c, endedAt: _e, ...rest }:
      StepLease,
  ) => rest;
  assertEquals(comparable(ledgerLease.lease), comparable(method.lease));
  assertEquals(ledgerLease.lease.state, "failed");
  assertEquals(ledgerLease.lease.hasWrites, true);
}

/** Runs BURST leases through the ledger at once, a transition at a time. */
async function assertBurstLosesNothing(
  ctx: RepositoryContext,
  ledger: StepLeaseStore,
) {
  const ids = Array.from({ length: BURST }, (_, i) => `burst-${i}`);
  await Promise.all(ids.map((id) => ledger.acquire(acquireArgs(id))));
  await Promise.all(ids.map((id) => ledger.markWrites(id)));
  await Promise.all(ids.map((id) => ledger.end(id, "completed")));
  for (const id of ids) {
    const { data, lease } = await storedLease(ctx, id);
    assertEquals(lease.state, "completed");
    assertEquals(lease.hasWrites, true);
    assertEquals(data.version, 3);
  }
}

Deno.test("StepLeaseLedger: writes the lease record a step-lease method run writes", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      await withUnscopedWriteGuard(() =>
        assertLedgerMatchesMethodRun(dir, ctx)
      );
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("StepLeaseLedger: falls back to the method run until the leases definition exists, then writes directly", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      const fallback = counting(methodRunnerLeaseStore(methodRunner(dir, ctx)));
      const ledger = new StepLeaseLedger(ctx, fallback);

      await ledger.acquire(acquireArgs("first"));
      assertEquals(fallback.calls, 1);
      await ledger.markWrites("first");
      await ledger.end("first", "completed");
      assertEquals(fallback.calls, 1);
      assertEquals((await storedLease(ctx, "first")).lease.state, "completed");
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("StepLeaseLedger: leases written at once all end, with one version per transition", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      const runner = methodRunnerLeaseStore(methodRunner(dir, ctx));
      // The method run creates the definition the ledger writes under.
      await runner.acquire(acquireArgs("seed"));
      await withUnscopedWriteGuard(() =>
        assertBurstLosesNothing(ctx, new StepLeaseLedger(ctx, runner))
      );
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("StepLeaseLedger: the boot sweep expires an active ledger lease and the reaper removes an ended one", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      const runner = methodRunnerLeaseStore(methodRunner(dir, ctx));
      const ledger = new StepLeaseLedger(ctx, runner);
      await runner.acquire(acquireArgs("seed"));
      await runner.end("seed", "completed");
      await ledger.acquire(acquireArgs("live"));
      await ledger.acquire(acquireArgs("done"));
      await ledger.end("done", "completed");

      const swept = await sweepStaleRecords({ repoContext: ctx });
      assertEquals(swept.leases, 1);
      assertEquals((await storedLease(ctx, "live")).lease.state, "expired");

      const reaped = await reapEndedBookkeepingRecords(
        {
          query: createBookkeepingRecordQuery(ctx.dataQueryService),
          repo: ctx.unifiedDataRepo,
          markDirty: ctx.markDirty,
          now: () => Date.now() + 2 * 60 * 60 * 1000,
        },
        60 * 60 * 1000,
      );
      assertEquals(reaped.leasesDeleted, 3);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("StepLeaseLedger: on a v3 datastore each lease write commits, and a second checkout reads the same records", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
      namespace: "team-a",
    };
    const repoA = join(dir, "a");
    await Deno.mkdir(repoA, { recursive: true });
    const ctx = createRepositoryContext({
      repoDir: repoA,
      enableIndexing: false,
      namespace: "team-a",
      datastoreResolver: new DefaultDatastorePathResolver(repoA, config, {
        engine: "v3",
      }),
      ...await v3RepositoryFactoryConfig(repoA, config),
    });
    try {
      const runner = methodRunnerLeaseStore(methodRunner(repoA, ctx));
      await runner.acquire(acquireArgs("seed"));
      await assertLedgerMatchesMethodRun(repoA, ctx);
      await assertBurstLosesNothing(ctx, new StepLeaseLedger(ctx, runner));

      const repoB = join(dir, "b");
      const b = openV3Datastore({
        repoDir: repoB,
        datastorePath,
        namespace: "team-a",
      });
      try {
        await b.catchUp();
      } finally {
        await b.close();
      }
      const records = await datastoreRecords(repoA, "team-a");
      assert(records.size > 0, "the leases are committed");
      assertEquals(await datastoreRecords(repoB, "team-a"), records);
    } finally {
      await closeV3Datastores();
    }
  });
});
