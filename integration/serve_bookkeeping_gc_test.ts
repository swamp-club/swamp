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

// The serve bookkeeping reaper against a real repository, catalog and query
// service on disk, wired to a sync service through the same markDirty hook
// serve uses and to a real sync gate. Records are written through the real
// step-lease and pending-dispatch model methods (swamp-club#2262).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { buildMarkDirtyHook } from "../src/cli/repo_context.ts";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import {
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
} from "../src/domain/models/worker/pending_dispatch_model.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../src/domain/models/worker/step_lease_model.ts";
import { WORKER_MODEL_TYPE } from "../src/domain/models/worker/worker_model.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { CatalogRow } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  createLibSwampContext,
  createWorkerModelRunDeps,
  modelMethodRun,
  workerQueueList,
} from "../src/libswamp/mod.ts";
import { reapEndedBookkeepingRecords } from "../src/serve/bookkeeping_gc.ts";
import {
  createSyncGate,
  gatedPull,
  POLLER_ESCALATE_AFTER_SKIPS,
} from "../src/serve/sync_gate.ts";
import { workerGcListPredicate } from "../src/serve/worker_gc_service.ts";

await initializeLogging({});

const GRACE_MS = 60 * 60 * 1000;

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

type SyncEvent =
  | { kind: "mark"; relPath?: string }
  | { kind: "push" }
  | { kind: "pull" };

function createRecordingSyncService(
  onMark?: () => void,
): { service: DatastoreSyncService; events: SyncEvent[] } {
  const events: SyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      events.push({ kind: "pull" });
      return Promise.resolve(0);
    },
    pushChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      events.push({ kind: "push" });
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      events.push({ kind: "mark", relPath: options?.relPath });
      onMark?.();
      return Promise.resolve();
    },
  };
  return { service, events };
}

async function runMethod(
  dir: string,
  repoContext: RepositoryContext,
  modelType: ModelType,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  const deps = await createWorkerModelRunDeps(dir, repoContext);
  for await (
    const event of modelMethodRun(createLibSwampContext({}), deps, {
      modelIdOrName: definitionName,
      methodName,
      inputs,
      lastEvaluated: false,
      typeArg: modelType.normalized,
      definitionName,
      skipAllReports: true,
    })
  ) {
    if (event.kind === "error") {
      throw new Error(JSON.stringify(event.error));
    }
  }
}

function lease(
  dir: string,
  ctx: RepositoryContext,
  method: string,
  inputs: Record<string, unknown>,
) {
  return runMethod(
    dir,
    ctx,
    STEP_LEASE_MODEL_TYPE,
    STEP_LEASE_INSTANCE_NAME,
    method,
    inputs,
  );
}

function pending(
  dir: string,
  ctx: RepositoryContext,
  method: string,
  inputs: Record<string, unknown>,
) {
  return runMethod(
    dir,
    ctx,
    PENDING_DISPATCH_MODEL_TYPE,
    PENDING_DISPATCH_INSTANCE_NAME,
    method,
    inputs,
  );
}

function acquireInputs(leaseId: string): Record<string, unknown> {
  return {
    leaseId,
    dispatchId: `d-${leaseId}`,
    workerName: "w1",
    modelType: "command/shell",
    modelId: "m1",
    methodName: "execute",
  };
}

function enqueueInputs(queueId: string): Record<string, unknown> {
  return {
    queueId,
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: new Date().toISOString(),
  };
}

async function dataNames(
  ctx: RepositoryContext,
  modelType: ModelType,
  instanceName: string,
): Promise<string[]> {
  const records = await ctx.dataQueryService.query(
    `modelType == ${JSON.stringify(modelType.normalized)} && modelName == ${
      JSON.stringify(instanceName)
    }`,
  ) as DataRecord[];
  return records.map((r) => r.name).sort();
}

/** Saves a record directly, stamped with the context's namespace. */
async function saveRecord(
  ctx: RepositoryContext,
  modelType: ModelType,
  modelId: string,
  modelName: string,
  name: string,
  attrs: Record<string, unknown>,
): Promise<void> {
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "lease", modelName },
    ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
  });
  await ctx.unifiedDataRepo.save(
    modelType,
    modelId,
    data,
    new TextEncoder().encode(JSON.stringify(attrs)),
  );
}

function queryDeps(ctx: RepositoryContext) {
  return async (predicate: string) =>
    await ctx.dataQueryService.query(predicate, {
      loadAttributes: true,
    }) as DataRecord[];
}

Deno.test("reapEndedBookkeepingRecords: removes ended records past grace from disk and catalog, keeps live and recent ones", async () => {
  await withTempDir(async (dir) => {
    const { service, events } = createRecordingSyncService();
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      namespace: "team-a",
      markDirty: buildMarkDirtyHook(service, swampPath(dir), dir),
    });
    try {
      const realNow = Date.now();
      const reapNow = realNow + 2 * GRACE_MS;

      await lease(dir, ctx, "acquire", acquireInputs("done"));
      await lease(dir, ctx, "complete", { leaseId: "done" });
      await lease(dir, ctx, "acquire", acquireInputs("failed"));
      await lease(dir, ctx, "fail", { leaseId: "failed", error: "x" });
      await lease(dir, ctx, "acquire", acquireInputs("live"));

      await pending(dir, ctx, "enqueue", enqueueInputs("sent"));
      await pending(dir, ctx, "mark_dispatched", {
        queueId: "sent",
        dispatchId: "d-sent",
        endedAt: new Date(realNow).toISOString(),
      });
      await pending(dir, ctx, "enqueue", enqueueInputs("recent"));
      await pending(dir, ctx, "cancel", {
        queueId: "recent",
        endedAt: new Date(reapNow - GRACE_MS / 2).toISOString(),
      });
      await pending(dir, ctx, "enqueue", enqueueInputs("waiting"));

      const leaseDir = (await ctx.dataQueryService.query(
        `modelType == "swamp/step-lease" && name == "lease-done"`,
      ) as DataRecord[])[0].modelId;

      events.length = 0;
      const result = await reapEndedBookkeepingRecords(
        {
          query: queryDeps(ctx),
          repo: ctx.unifiedDataRepo,
          syncService: service,
          syncGate: createSyncGate(),
          now: () => reapNow,
        },
        GRACE_MS,
      );

      assertEquals(result, {
        leasesDeleted: 2,
        dispatchesDeleted: 1,
        failed: 0,
        batches: 1,
        pushFailures: 0,
      });
      assertEquals(
        await dataNames(ctx, STEP_LEASE_MODEL_TYPE, STEP_LEASE_INSTANCE_NAME),
        ["lease-live"],
      );
      assertEquals(
        await dataNames(
          ctx,
          PENDING_DISPATCH_MODEL_TYPE,
          PENDING_DISPATCH_INSTANCE_NAME,
        ),
        ["pending-recent", "pending-waiting"],
      );

      const doneDir = join(
        swampPath(dir),
        "data",
        STEP_LEASE_MODEL_TYPE.normalized,
        leaseDir,
        "lease-done",
      );
      let gone = false;
      try {
        await Deno.stat(doneDir);
      } catch (error) {
        gone = error instanceof Deno.errors.NotFound;
      }
      assert(gone, "lease-done directory should be removed from disk");

      // Every deleted version was marked dirty, then one push committed them.
      const marks = events.filter((e) => e.kind === "mark");
      assert(marks.length > 0);
      assertEquals(events[events.length - 1], { kind: "push" });
      const doneMark = marks.find((e) =>
        e.kind === "mark" && e.relPath?.includes("lease-done") &&
        e.relPath.endsWith("1")
      );
      assert(doneMark, "version 1 of lease-done should be marked dirty");
      assertPathEquals(
        (doneMark as { relPath: string }).relPath,
        join(
          "data",
          STEP_LEASE_MODEL_TYPE.normalized,
          leaseDir,
          "lease-done",
          "1",
        ),
      );

      // The live queue view is unaffected.
      const queue: string[] = [];
      for await (
        const event of workerQueueList(createLibSwampContext({}), {
          query: queryDeps(ctx),
        })
      ) {
        if (event.kind === "completed") {
          for (const item of event.data.items) queue.push(item.queueId);
        }
      }
      assertEquals(queue, ["waiting"]);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("reapEndedBookkeepingRecords: a pull queued mid-sweep never lands between a delete and its push", async () => {
  await withTempDir(async (dir) => {
    const gate = createSyncGate();
    let pullPromise: Promise<number | void> | undefined;
    // Queue the pull exactly once, on the first delete, while the reaper
    // holds the gate for batch one. The escalated path queues FIFO, so the
    // pull is deterministic and needs no timing.
    const { service, events } = createRecordingSyncService(() => {
      if (pullPromise || !reaping) return;
      pullPromise = gatedPull(
        gate,
        "test-poller",
        () => service.pullChanged(),
        { state: { consecutiveSkips: POLLER_ESCALATE_AFTER_SKIPS } },
      );
    });
    let reaping = false;
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      namespace: "team-a",
      markDirty: buildMarkDirtyHook(service, swampPath(dir), dir),
    });
    try {
      const reapNow = Date.now() + 2 * GRACE_MS;
      for (const id of ["a", "b", "c", "d", "e"]) {
        await lease(dir, ctx, "acquire", acquireInputs(id));
        await lease(dir, ctx, "complete", { leaseId: id });
      }

      events.length = 0;
      reaping = true;
      const result = await reapEndedBookkeepingRecords(
        {
          query: queryDeps(ctx),
          repo: ctx.unifiedDataRepo,
          syncService: service,
          syncGate: gate,
          batchSize: 2,
          now: () => reapNow,
        },
        GRACE_MS,
      );
      reaping = false;
      assert(pullPromise, "a pull should have been queued mid-sweep");
      await pullPromise;

      assertEquals(result.leasesDeleted, 5);
      assertEquals(result.batches, 3);
      assertEquals(events.filter((e) => e.kind === "push").length, 3);
      assertEquals(events.filter((e) => e.kind === "pull").length, 1);

      // Invariant: once a delete is marked, its push comes before any pull.
      let unpushedMarks = false;
      for (const event of events) {
        if (event.kind === "mark") unpushedMarks = true;
        if (event.kind === "push") unpushedMarks = false;
        if (event.kind === "pull") {
          assert(!unpushedMarks, "pull landed between a delete and its push");
        }
      }
    } finally {
      ctx.catalogStore.close();
    }
  });
});

function foreignRow(
  modelType: ModelType,
  modelName: string,
  dataName: string,
): CatalogRow {
  return {
    namespace: "team-b",
    type_normalized: modelType.normalized,
    model_id: crypto.randomUUID(),
    data_name: dataName,
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    model_name: modelName,
    spec_name: "",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 1,
    created_at: new Date().toISOString(),
    tags: "{}",
    owner_ref: "foreign",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

Deno.test("reapEndedBookkeepingRecords and workerGcListPredicate: ignore another namespace's catalog rows", async () => {
  await withTempDir(async (dir) => {
    const { service } = createRecordingSyncService();
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      namespace: "team-a",
      markDirty: buildMarkDirtyHook(service, swampPath(dir), dir),
    });
    try {
      const reapNow = Date.now() + 2 * GRACE_MS;
      const endedAt = new Date(Date.now()).toISOString();

      await saveRecord(
        ctx,
        WORKER_MODEL_TYPE,
        crypto.randomUUID(),
        "worker-w2",
        "state-main",
        { name: "w2", status: "idle" },
      );
      // Populate the catalog from disk before the foreign rows arrive, the
      // way a running serve has already backfilled before a catalog pull.
      await ctx.dataQueryService.query(`name == "state-main"`);

      // Rows from another namespace, as `datastore catalog pull` writes them:
      // catalog-only, with content served by the foreign fetcher.
      ctx.catalogStore.bulkUpsertForeign("team-b", [
        foreignRow(STEP_LEASE_MODEL_TYPE, STEP_LEASE_INSTANCE_NAME, "lease-x"),
        foreignRow(WORKER_MODEL_TYPE, "worker-w1", "state-main"),
      ]);
      let foreignFetches = 0;
      ctx.dataQueryService.setForeignContentFetcher((_ns, relPath) => {
        foreignFetches++;
        const attrs = relPath.includes("step-lease")
          ? {
            ...acquireInputs("x"),
            state: "completed",
            hasWrites: false,
            createdAt: endedAt,
            endedAt,
          }
          : { name: "w1", status: "disconnected" };
        return Promise.resolve(new TextEncoder().encode(JSON.stringify(attrs)));
      });

      const result = await reapEndedBookkeepingRecords(
        {
          query: queryDeps(ctx),
          repo: ctx.unifiedDataRepo,
          syncService: service,
          syncGate: createSyncGate(),
          now: () => reapNow,
        },
        GRACE_MS,
      );
      assertEquals(result.batches, 0, "no foreign lease may be reaped");
      assertEquals(foreignFetches, 0, "no foreign content may be fetched");

      const workers = await ctx.dataQueryService.query(
        workerGcListPredicate(ctx.unifiedDataRepo.namespace),
        { loadAttributes: true },
      ) as DataRecord[];
      assertEquals(workers.map((w) => w.modelName), ["worker-w2"]);
      assertEquals(foreignFetches, 0);
    } finally {
      ctx.catalogStore.close();
    }
  });
});
