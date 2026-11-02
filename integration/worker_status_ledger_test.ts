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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { Data } from "../src/domain/data/data.ts";
import {
  type SetStatusArgs,
  WORKER_MODEL_TYPE,
  WORKER_STATE_DATA_NAME,
  workerDefinitionName,
  type WorkerState,
} from "../src/domain/models/worker/worker_model.ts";
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
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import type { ModelMethodRunner } from "../src/serve/worker_gateway.ts";
import {
  methodRunnerWorkerStatusStore,
  WorkerStatusLedger,
  type WorkerStatusStore,
} from "../src/serve/worker_status_ledger.ts";
import { datastoreRecords } from "./usecase_v3_fixtures.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

await initializeLogging({});

const DISPATCHES = 20;

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

// mirrors the gateway's default runner: a use case unit in whatever root is ambient
function methodRunner(dir: string, ctx: RepositoryContext): ModelMethodRunner {
  return async (input) => {
    const deps = await createWorkerModelRunDeps(dir, ctx, {
      definitionType: WORKER_MODEL_TYPE,
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

async function enroll(
  dir: string,
  ctx: RepositoryContext,
  workerName: string,
): Promise<void> {
  await methodRunner(dir, ctx)({
    typeArg: WORKER_MODEL_TYPE.normalized,
    definitionName: workerDefinitionName(workerName),
    methodName: "enroll",
    inputs: {
      instanceUuid: crypto.randomUUID(),
      tokenName: "pool",
      workerName,
      labels: { region: "us-east" },
      platform: "linux",
      arch: "x86_64",
      swampVersion: "1.0.0",
      protocolVersion: 6,
      capacity: 2,
    },
  });
}

function counting(
  store: WorkerStatusStore,
): WorkerStatusStore & { calls: number } {
  const counted = {
    calls: 0,
    recordStatus: (workerName: string, args: SetStatusArgs) => {
      counted.calls++;
      return store.recordStatus(workerName, args);
    },
  };
  return counted;
}

async function workerDefinitionId(
  ctx: RepositoryContext,
  workerName: string,
) {
  const definition = await ctx.definitionRepo.findByName(
    WORKER_MODEL_TYPE,
    workerDefinitionName(workerName),
  );
  assert(definition !== null, `worker ${workerName} has a definition`);
  return definition.id;
}

async function storedState(
  ctx: RepositoryContext,
  workerName: string,
): Promise<{ data: Data; state: WorkerState }> {
  const modelId = await workerDefinitionId(ctx, workerName);
  const data = await ctx.unifiedDataRepo.findByName(
    WORKER_MODEL_TYPE,
    modelId,
    WORKER_STATE_DATA_NAME,
  );
  assert(data !== null, `worker ${workerName} has a state record`);
  const content = await ctx.unifiedDataRepo.getContent(
    WORKER_MODEL_TYPE,
    modelId,
    WORKER_STATE_DATA_NAME,
  );
  assert(content !== null);
  return {
    data,
    state: JSON.parse(new TextDecoder().decode(content)) as WorkerState,
  };
}

async function setStatusOutputs(
  ctx: RepositoryContext,
  workerName: string,
): Promise<number> {
  const outputs = await ctx.outputRepo.findByDefinition(
    WORKER_MODEL_TYPE,
    await workerDefinitionId(ctx, workerName),
  );
  return outputs.filter((output) => output.methodName === "set_status").length;
}

// the owner id and model name differ per worker, so they are checked, then replaced
async function metadata(
  ctx: RepositoryContext,
  workerName: string,
  data: Data,
) {
  const definitionId = await workerDefinitionId(ctx, workerName);
  assertEquals(data.ownerDefinition?.ownerRef, String(definitionId));
  assertEquals(data.tags.modelName, workerDefinitionName(workerName));
  return {
    contentType: data.contentType,
    lifetime: data.lifetime,
    garbageCollection: data.garbageCollection,
    tags: { ...data.tags, modelName: "<worker>" },
    ownerDefinition: { ...data.ownerDefinition, ownerRef: "<definition>" },
    version: data.version,
  };
}

const STATUS_CHANGES: SetStatusArgs[] = [
  { status: "busy", activeDispatchIds: ["d-1"] },
  { status: "busy", activeDispatchIds: ["d-1", "d-2"] },
  { status: "idle" },
  { status: "unverified", verifyFailureReason: "probe failed" },
  { status: "draining" },
  { status: "disconnected" },
];

async function assertLedgerMatchesMethodRun(
  dir: string,
  ctx: RepositoryContext,
): Promise<void> {
  await enroll(dir, ctx, "via-method");
  await enroll(dir, ctx, "via-ledger");
  const viaMethod = methodRunnerWorkerStatusStore(methodRunner(dir, ctx));
  const fallback = counting(viaMethod);
  const ledger = new WorkerStatusLedger(ctx, fallback);

  for (const args of STATUS_CHANGES) {
    await viaMethod.recordStatus("via-method", args);
    await ledger.recordStatus("via-ledger", args);
    const method = await storedState(ctx, "via-method");
    const written = await storedState(ctx, "via-ledger");
    assertEquals(
      await metadata(ctx, "via-ledger", written.data),
      await metadata(ctx, "via-method", method.data),
    );
    const comparable = (
      {
        name: _n,
        instanceUuid: _i,
        enrolledAt: _e,
        lastSeenAt: _l,
        disconnectedAt: _d,
        ...rest
      }: WorkerState,
    ) => rest;
    assertEquals(comparable(written.state), comparable(method.state));
    assertEquals(written.state.status, args.status);
  }
  assertEquals(fallback.calls, 0);
  assertEquals(
    await setStatusOutputs(ctx, "via-method"),
    STATUS_CHANGES.length,
  );
  assertEquals(await setStatusOutputs(ctx, "via-ledger"), 0);
}

Deno.test("WorkerStatusLedger: writes the state record a set_status method run writes, and no output", async () => {
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

Deno.test("WorkerStatusLedger: falls back to the method run until the worker's definition exists, then writes directly", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      const fallback = counting(
        methodRunnerWorkerStatusStore(methodRunner(dir, ctx)),
      );
      const ledger = new WorkerStatusLedger(ctx, fallback);

      let refused: unknown;
      try {
        await ledger.recordStatus("ghost", { status: "idle" });
      } catch (error) {
        refused = error;
      }
      assertEquals(fallback.calls, 1);
      assert(
        refused instanceof Error && refused.message.includes("enroll first"),
        `the method run refuses the unenrolled worker: ${refused}`,
      );

      await enroll(dir, ctx, "w1");
      await ledger.recordStatus("w1", {
        status: "busy",
        activeDispatchIds: [],
      });
      assertEquals(fallback.calls, 1);
      assertEquals((await storedState(ctx, "w1")).state.status, "busy");
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("WorkerStatusLedger: dispatches change status twice each and write no output records", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      await enroll(dir, ctx, "w1");
      const ledger = new WorkerStatusLedger(
        ctx,
        methodRunnerWorkerStatusStore(methodRunner(dir, ctx)),
      );
      for (let i = 0; i < DISPATCHES; i++) {
        await ledger.recordStatus("w1", {
          status: "busy",
          activeDispatchIds: [`d-${i}`],
        });
        await ledger.recordStatus("w1", { status: "idle" });
      }
      const { data, state } = await storedState(ctx, "w1");
      assertEquals(state.status, "idle");
      assertEquals(state.activeDispatchIds, []);
      // Enrollment is version 1; every change is a version after it.
      assertEquals(data.version, 1 + 2 * DISPATCHES);
      assertEquals(await setStatusOutputs(ctx, "w1"), 0);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("WorkerStatusLedger: outside any root its write reaches the datastore hook as the method run's does, and inside a root with no push it stages there", async () => {
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
        await enroll(dir, ctx, "w1");
        const modelId = await workerDefinitionId(ctx, "w1");
        const statePrefix = join(
          "swamp",
          "worker",
          modelId,
          WORKER_STATE_DATA_NAME,
        );
        const stateMarks = (from: number) =>
          marks.slice(from).filter((mark) => mark.includes(statePrefix));
        const viaMethod = methodRunnerWorkerStatusStore(
          methodRunner(dir, ctx),
        );
        const ledger = new WorkerStatusLedger(ctx, viaMethod);

        // outside any run, as the gateway records a disconnect
        let from = marks.length;
        await viaMethod.recordStatus("w1", { status: "disconnected" });
        const methodStateMarks = stateMarks(from).length;
        assert(methodStateMarks > 0, "the method run marks the state record");

        from = marks.length;
        await ledger.recordStatus("w1", { status: "disconnected" });
        const ledgerMarks = marks.slice(from);
        assertEquals(stateMarks(from).length, methodStateMarks);
        assertEquals(
          ledgerMarks.filter((mark) => !mark.includes(statePrefix)),
          [],
          "the ledger marks only the state record: no output or run log",
        );

        from = marks.length;
        let staged: string[] = [];
        await runInRootUnitOfWork(ctx, { flush: undefined }, async (root) => {
          await ledger.recordStatus("w1", { status: "busy" });
          staged = root.staged().flatMap((change) =>
            change.kind === "bulk" ? [] : [change.path]
          );
        });
        assert(
          staged.some((path) => path.includes(statePrefix)),
          `the write is staged in the root: ${staged}`,
        );
        assertEquals(stateMarks(from).length, methodStateMarks);
      });
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("WorkerStatusLedger: on a v3 datastore each status write commits, and a second checkout reads the same records", async () => {
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
      assert(records.size > 0, "the worker records are committed");
      assertEquals(await datastoreRecords(repoB, "team-a"), records);
    } finally {
      await closeV3Datastores();
    }
  });
});
