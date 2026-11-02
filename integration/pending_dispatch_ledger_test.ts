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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { Data } from "../src/domain/data/data.ts";
import {
  type EnqueuePendingArgs,
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
  pendingDataName,
  type PendingDispatch,
} from "../src/domain/models/worker/pending_dispatch_model.ts";
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
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import {
  createWorkerQueueListDeps,
  workerQueueList,
} from "../src/libswamp/worker/queue_list.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import {
  methodRunnerPendingDispatchStore,
  PendingDispatchLedger,
  type PendingDispatchStore,
  type ServePendingDispatchEnd,
} from "../src/serve/pending_dispatch_ledger.ts";
import type { ModelMethodRunner } from "../src/serve/worker_gateway.ts";
import { datastoreRecords } from "./usecase_v3_fixtures.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

await initializeLogging({});

const QUEUED = 20;

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

// mirrors the dispatch service's default runner: a use case unit in whatever root is ambient
function methodRunner(dir: string, ctx: RepositoryContext): ModelMethodRunner {
  return async (input) => {
    const deps = await createWorkerModelRunDeps(dir, ctx, {
      definitionType: PENDING_DISPATCH_MODEL_TYPE,
    });
    const libCtx = createLibSwampContext({
      openUnitOfWork: repoUnitOfWorkFactory(ctx),
    });
    for await (
      const event of modelMethodRun(libCtx, deps, {
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
  };
}

function counting(
  store: PendingDispatchStore,
): PendingDispatchStore & { calls: number } {
  const counted = {
    calls: 0,
    enqueue: (args: EnqueuePendingArgs) => {
      counted.calls++;
      return store.enqueue(args);
    },
    end: (queueId: string, end: ServePendingDispatchEnd) => {
      counted.calls++;
      return store.end(queueId, end);
    },
  };
  return counted;
}

function enqueueArgs(queueId: string): EnqueuePendingArgs {
  return {
    queueId,
    target: "prod",
    labels: { tier: "smoke" },
    platform: "linux",
    workflowName: "deploy",
    jobName: "main",
    stepName: "build",
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: "2026-11-02T10:00:00.000Z",
  };
}

const ENDED_AT = "2026-11-02T10:01:00.000Z";

async function pendingDefinitionId(ctx: RepositoryContext) {
  const definition = await ctx.definitionRepo.findByName(
    PENDING_DISPATCH_MODEL_TYPE,
    PENDING_DISPATCH_INSTANCE_NAME,
  );
  assert(definition !== null, "the pending definition exists");
  return definition.id;
}

async function storedPending(
  ctx: RepositoryContext,
  queueId: string,
): Promise<{ data: Data; record: PendingDispatch }> {
  const modelId = await pendingDefinitionId(ctx);
  const name = pendingDataName(queueId);
  const data = await ctx.unifiedDataRepo.findByName(
    PENDING_DISPATCH_MODEL_TYPE,
    modelId,
    name,
  );
  assert(data !== null, `queue entry ${queueId} has a record`);
  const content = await ctx.unifiedDataRepo.getContent(
    PENDING_DISPATCH_MODEL_TYPE,
    modelId,
    name,
  );
  assert(content !== null);
  return {
    data,
    record: JSON.parse(new TextDecoder().decode(content)) as PendingDispatch,
  };
}

async function pendingOutputs(ctx: RepositoryContext): Promise<number> {
  const outputs = await ctx.outputRepo.findByDefinition(
    PENDING_DISPATCH_MODEL_TYPE,
    await pendingDefinitionId(ctx),
  );
  return outputs.length;
}

// the data name differs per queue entry, so it is checked, then replaced
function metadata(data: Data, queueId: string) {
  assertEquals(data.name, pendingDataName(queueId));
  return {
    contentType: data.contentType,
    lifetime: data.lifetime,
    garbageCollection: data.garbageCollection,
    tags: data.tags,
    ownerDefinition: data.ownerDefinition,
    version: data.version,
  };
}

const ENDS: ServePendingDispatchEnd[] = [
  { state: "dispatched", dispatchId: "d-1", endedAt: ENDED_AT },
  { state: "timed_out", endedAt: ENDED_AT },
  { state: "cancelled", endedAt: ENDED_AT },
];

async function assertLedgerMatchesMethodRun(
  dir: string,
  ctx: RepositoryContext,
): Promise<void> {
  const viaMethod = methodRunnerPendingDispatchStore(methodRunner(dir, ctx));
  // the first method run creates the pending definition
  await viaMethod.enqueue(enqueueArgs("seed"));
  const fallback = counting(viaMethod);
  const ledger = new PendingDispatchLedger(ctx, fallback);
  const outputsBefore = await pendingOutputs(ctx);
  let methodRuns = 0;

  for (const [i, end] of ENDS.entries()) {
    const byMethod = `method-${i}`;
    const byLedger = `ledger-${i}`;
    await viaMethod.enqueue(enqueueArgs(byMethod));
    await ledger.enqueue(enqueueArgs(byLedger));
    await viaMethod.end(byMethod, end);
    await ledger.end(byLedger, end);
    // a terminal entry is not rewritten by a later end
    await viaMethod.end(byMethod, { state: "cancelled", endedAt: ENDED_AT });
    await ledger.end(byLedger, { state: "cancelled", endedAt: ENDED_AT });
    methodRuns += 3;

    const method = await storedPending(ctx, byMethod);
    const written = await storedPending(ctx, byLedger);
    assertEquals(
      metadata(written.data, byLedger),
      metadata(method.data, byMethod),
    );
    assertEquals(written.data.version, 2);
    assertEquals(written.record, { ...method.record, queueId: byLedger });
    assertEquals(written.record.state, end.state);
  }
  assertEquals(fallback.calls, 0);
  assertEquals(await pendingOutputs(ctx), outputsBefore + methodRuns);
}

Deno.test("PendingDispatchLedger: writes the record each method run writes, and no output", async () => {
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

Deno.test("PendingDispatchLedger: falls back to the method run until the pending definition exists, then writes directly", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      const fallback = counting(
        methodRunnerPendingDispatchStore(methodRunner(dir, ctx)),
      );
      const ledger = new PendingDispatchLedger(ctx, fallback);

      await ledger.enqueue(enqueueArgs("q-1"));
      assertEquals(fallback.calls, 1);
      assertEquals(await pendingOutputs(ctx), 1);

      await ledger.end("q-1", {
        state: "dispatched",
        dispatchId: "d-1",
        endedAt: ENDED_AT,
      });
      await assertRejects(
        () => ledger.enqueue(enqueueArgs("q-1")),
        Error,
        "Pending dispatch 'q-1' already exists",
      );
      await assertRejects(
        () => ledger.end("ghost", { state: "timed_out", endedAt: ENDED_AT }),
        Error,
        "Pending dispatch 'ghost' does not exist",
      );
      assertEquals(fallback.calls, 1);
      assertEquals(
        (await storedPending(ctx, "q-1")).record.state,
        "dispatched",
      );
      assertEquals(await pendingOutputs(ctx), 1);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("PendingDispatchLedger: a saturated queue writes record versions and no output records, and the queue listing sees only waiting entries", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({ repoDir: dir });
    try {
      const ledger = new PendingDispatchLedger(
        ctx,
        methodRunnerPendingDispatchStore(methodRunner(dir, ctx)),
      );
      // the first enqueue falls back and creates the definition
      for (let i = 0; i < QUEUED; i++) {
        await ledger.enqueue(enqueueArgs(`q-${i}`));
      }
      for (let i = 0; i < QUEUED / 2; i++) {
        await ledger.end(`q-${i}`, {
          state: "dispatched",
          dispatchId: `d-${i}`,
          endedAt: ENDED_AT,
        });
      }
      assertEquals(await pendingOutputs(ctx), 1);
      assertEquals((await storedPending(ctx, "q-1")).data.version, 2);
      assertEquals(
        (await storedPending(ctx, `q-${QUEUED - 1}`)).data.version,
        1,
      );

      const listed: string[] = [];
      for await (
        const event of workerQueueList(
          createLibSwampContext({}),
          createWorkerQueueListDeps(ctx.dataQueryService),
        )
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
        if (event.kind === "completed") {
          listed.push(...event.data.items.map((item) => item.queueId));
        }
      }
      const waiting = Array.from(
        { length: QUEUED / 2 },
        (_, i) => `q-${QUEUED / 2 + i}`,
      );
      assertEquals(listed.sort(), waiting.sort());
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("PendingDispatchLedger: outside any root its write reaches the datastore hook as the method run's does, inside a root with no push it stages there, and after that root ended it reaches the hook", async () => {
  await withTempDir(async (dir) => {
    const marks: string[] = [];
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      markDirty: (relPath) => {
        if (relPath !== undefined) marks.push(relPath);
        return Promise.resolve();
      },
    });
    try {
      await withUnscopedWriteGuard(async () => {
        const viaMethod = methodRunnerPendingDispatchStore(
          methodRunner(dir, ctx),
        );
        await viaMethod.enqueue(enqueueArgs("seed"));
        const modelId = await pendingDefinitionId(ctx);
        const recordPrefix = (queueId: string) =>
          join(
            "swamp",
            "pending-dispatch",
            modelId,
            pendingDataName(queueId),
          );
        const recordMarks = (from: number, queueId: string) =>
          marks.slice(from).filter((mark) =>
            mark.includes(recordPrefix(queueId))
          );
        const ledger = new PendingDispatchLedger(ctx, viaMethod);

        let from = marks.length;
        await viaMethod.enqueue(enqueueArgs("by-method"));
        const methodMarks = recordMarks(from, "by-method").length;
        assert(methodMarks > 0, "the method run marks the record");

        from = marks.length;
        await ledger.enqueue(enqueueArgs("by-ledger"));
        assertEquals(recordMarks(from, "by-ledger").length, methodMarks);
        assertEquals(
          marks.slice(from).filter((mark) =>
            !mark.includes(recordPrefix("by-ledger"))
          ),
          [],
          "the ledger marks only the record: no output or run log",
        );

        from = marks.length;
        let staged: string[] = [];
        await runInRootUnitOfWork(ctx, { flush: undefined }, async (root) => {
          await ledger.enqueue(enqueueArgs("in-root"));
          staged = root.staged().flatMap((change) =>
            change.kind === "bulk" ? [] : [change.path]
          );
        });
        assert(
          staged.some((path) => path.includes(recordPrefix("in-root"))),
          `the write is staged in the root: ${staged}`,
        );
        assertEquals(recordMarks(from, "in-root").length, methodMarks);

        // the dispatch service does not await a queue transition, so one
        // chained inside a run can start after that run's root ended
        const gate = Promise.withResolvers<void>();
        let late: Promise<void> | undefined;
        await runInRootUnitOfWork(ctx, { flush: undefined }, () => {
          late = gate.promise.then(() =>
            ledger.end("in-root", {
              state: "dispatched",
              dispatchId: "d-late",
              endedAt: ENDED_AT,
            })
          );
          return Promise.resolve();
        });
        from = marks.length;
        gate.resolve();
        await late;
        assertEquals(recordMarks(from, "in-root").length, methodMarks);
        assertEquals(
          (await storedPending(ctx, "in-root")).record.state,
          "dispatched",
        );
      });
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("PendingDispatchLedger: on a v3 datastore each transition commits, one starting after its root ended commits too, and a second checkout reads the same records", async () => {
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
      await assertLedgerMatchesMethodRun(repoA, ctx);

      const ledger = new PendingDispatchLedger(
        ctx,
        methodRunnerPendingDispatchStore(methodRunner(repoA, ctx)),
      );
      await ledger.enqueue(enqueueArgs("late"));
      const gate = Promise.withResolvers<void>();
      let late: Promise<void> | undefined;
      await runInRootUnitOfWork(ctx, { flush: undefined }, () => {
        late = gate.promise.then(() =>
          ledger.end("late", { state: "timed_out", endedAt: ENDED_AT })
        );
        return Promise.resolve();
      });
      gate.resolve();
      await late;

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
      assert(records.size > 0, "the pending dispatch records are committed");
      assertEquals(await datastoreRecords(repoB, "team-a"), records);
      const lateRecord = [...records.keys()].find((key) =>
        key.includes(pendingDataName("late"))
      );
      assert(lateRecord !== undefined, "the late transition committed");
    } finally {
      await closeV3Datastores();
    }
  });
});
