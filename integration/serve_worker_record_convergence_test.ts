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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import {
  WORKER_MODEL_TYPE,
  WORKER_STATE_DATA_NAME,
  workerDefinitionName,
  type WorkerEnrollment,
  WorkerStateSchema,
} from "../src/domain/models/worker/worker_model.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { ensureWorkerDefinition } from "../src/libswamp/worker/ensure_definition.ts";
import { workerPrune } from "../src/libswamp/worker/prune.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { createWorkerTokenNameQuery } from "../src/serve/bookkeeping_gc.ts";
import type { ModelMethodRunner } from "../src/serve/worker_gateway.ts";
import {
  methodRunnerWorkerStatusStore,
  WorkerStatusLedger,
} from "../src/serve/worker_status_ledger.ts";

await initializeLogging({});

const WORKER = "pool-worker";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-worker-converge-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(repoDir: string, typeName: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
}

type Clone = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>> & {
  dir: string;
  ledger: WorkerStatusLedger;
  run: ModelMethodRunner;
};

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
      if (event.kind === "error") throw new Error(JSON.stringify(event.error));
    }
  };
}

// a serve's own cache: worker writes are only marked, never pushed by the write
async function openClone(dir: string): Promise<Clone> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir: dir,
    outputMode: "json",
  });
  const run = methodRunner(dir, ctx.repoContext);
  const ledger = new WorkerStatusLedger(
    ctx.repoContext,
    methodRunnerWorkerStatusStore(run),
    (workerName) => ensureWorkerDefinition(dir, ctx.repoContext, workerName),
  );
  return { ...ctx, dir, ledger, run };
}

function enrollment(instanceUuid: string): WorkerEnrollment {
  return {
    instanceUuid,
    tokenName: WORKER,
    workerName: WORKER,
    labels: { pool: "repro" },
    platform: "linux",
    arch: "x86_64",
    swampVersion: "1.0.0",
    protocolVersion: 6,
    capacity: 1,
  };
}

async function enroll(clone: Clone, instanceUuid: string): Promise<void> {
  await clone.run({
    typeArg: WORKER_MODEL_TYPE.normalized,
    definitionName: workerDefinitionName(WORKER),
    methodName: "enroll",
    inputs: { ...enrollment(instanceUuid) },
  });
}

async function stored(clone: Clone) {
  const definition = await clone.repoContext.definitionRepo.findByName(
    WORKER_MODEL_TYPE,
    workerDefinitionName(WORKER),
  );
  assert(definition !== null, "the worker has a definition");
  const content = await clone.repoContext.unifiedDataRepo.getContent(
    WORKER_MODEL_TYPE,
    definition.id,
    WORKER_STATE_DATA_NAME,
  );
  assert(content !== null, "the worker has a state record");
  return WorkerStateSchema.parse(
    JSON.parse(new TextDecoder().decode(content)),
  );
}

async function pull(clone: Clone): Promise<void> {
  await clone.syncService!.pullChanged({
    subdirs: ["data", "auto-definitions"],
  });
  clone.repoContext.catalogStore.invalidate();
}

async function push(clone: Clone): Promise<void> {
  await clone.syncService!.pushChanged();
}

Deno.test("serve worker record: a peer's colliding stale versions are pulled over a live enrollment, then reasserted and kept from GC", async () => {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      await initRepo(join(dir, "old"), typeName);
      await initRepo(join(dir, "new"), typeName);
      const oldServe = await openClone(join(dir, "old"));
      const newServe = await openClone(join(dir, "new"));
      try {
        const oldInstance = crypto.randomUUID();
        const newInstance = crypto.randomUUID();

        // the old serve held the worker and published its record
        await enroll(oldServe, oldInstance);
        await push(oldServe);
        await pull(newServe);

        // the worker reconnects to the new serve, which publishes first
        await enroll(newServe, newInstance);
        await push(newServe);
        assertEquals((await stored(newServe)).instanceUuid, newInstance);

        // the old serve, not having pulled, numbers its departure from its own
        // stale copy and publishes on top
        await oldServe.ledger.recordStatus(
          WORKER,
          { status: "draining" },
          enrollment(oldInstance),
        );
        await oldServe.ledger.recordStatus(
          WORKER,
          { status: "disconnected" },
          enrollment(oldInstance),
        );
        await push(oldServe);

        await pull(newServe);
        const pulled = await stored(newServe);
        assertEquals(pulled.instanceUuid, oldInstance);
        assertEquals(pulled.status, "disconnected");

        const decision = await newServe.ledger.reassert(
          WORKER,
          { status: "idle" },
          enrollment(newInstance),
        );
        assertEquals(decision, "rewrite");
        const restored = await stored(newServe);
        assertEquals(restored.instanceUuid, newInstance);
        assertEquals(restored.status, "idle");

        await push(newServe);
        await pull(oldServe);
        assertEquals((await stored(oldServe)).instanceUuid, newInstance);

        // a second pass leaves the record alone
        assertEquals(
          await newServe.ledger.reassert(
            WORKER,
            { status: "idle" },
            enrollment(newInstance),
          ),
          "keep",
        );

        let deleted = 0;
        for await (
          const event of workerPrune(createLibSwampContext(), {
            listWorkers: () =>
              Promise.resolve([{
                name: WORKER,
                definitionName: workerDefinitionName(WORKER),
                definitionId: "unused",
                status: "disconnected",
                tokenName: WORKER,
                disconnectedAt: new Date(0).toISOString(),
              }]),
            listTokens: () => Promise.resolve([]),
            isLive: (name) => name === WORKER,
            deleteWorker: () => {
              deleted++;
              throw new Error("a live worker is never deleted");
            },
            pruneBindings: () => {
              throw new Error("no bindings are pruned");
            },
          }, { gracePeriodMs: 0, dryRun: false })
        ) {
          if (event.kind === "error") throw new Error(event.error.message);
        }
        assertEquals(deleted, 0);
        assertEquals((await stored(newServe)).instanceUuid, newInstance);
      } finally {
        oldServe.repoContext.catalogStore.close();
        newServe.repoContext.catalogStore.close();
      }
    });
  } finally {
    dispose();
  }
});

Deno.test("serve worker record: a departure never stamps a newer enrollment's record, and a missing record is recreated from the live connection", async () => {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      await initRepo(join(dir, "serve"), typeName);
      const serve = await openClone(join(dir, "serve"));
      try {
        const older = crypto.randomUUID();
        const newer = crypto.randomUUID();
        await enroll(serve, newer);

        for (const status of ["draining", "disconnected"] as const) {
          await serve.ledger.recordStatus(
            WORKER,
            { status },
            enrollment(older),
          );
          const kept = await stored(serve);
          assertEquals(kept.instanceUuid, newer);
          assertEquals(kept.status, "idle");
        }

        // GC on another serve removed the definition and its data
        const definition = await serve.repoContext.definitionRepo.findByName(
          WORKER_MODEL_TYPE,
          workerDefinitionName(WORKER),
        );
        assert(definition !== null);
        await runInRootUnitOfWork(
          serve.repoContext,
          { flush: undefined },
          async () => {
            await serve.repoContext.unifiedDataRepo.delete(
              WORKER_MODEL_TYPE,
              definition.id,
              WORKER_STATE_DATA_NAME,
            );
            await serve.repoContext.definitionRepo.delete(
              WORKER_MODEL_TYPE,
              definition.id,
            );
          },
        );

        await serve.ledger.recordStatus(
          WORKER,
          { status: "busy", activeDispatchIds: ["d-1"] },
          enrollment(newer),
        );
        const recreated = await stored(serve);
        assertEquals(recreated.instanceUuid, newer);
        assertEquals(recreated.status, "busy");
        assertEquals(recreated.activeDispatchIds, ["d-1"]);
      } finally {
        serve.repoContext.catalogStore.close();
      }
    });
  } finally {
    dispose();
  }
});

Deno.test("serve worker record: a push that removes a peer's deleted worker record leaves the token reap able to list references", async () => {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      await initRepo(join(dir, "deleter"), typeName);
      await initRepo(join(dir, "reaper"), typeName);
      const deleter = await openClone(join(dir, "deleter"));
      const reaper = await openClone(join(dir, "reaper"));
      try {
        await enroll(deleter, crypto.randomUUID());
        await push(deleter);
        await pull(reaper);
        const namespace = reaper.repoContext.unifiedDataRepo.namespace;
        const strict = createWorkerTokenNameQuery(
          reaper.repoContext.dataQueryService,
          namespace,
        );
        assertEquals([...await strict()], [WORKER]);

        const definition = await deleter.repoContext.definitionRepo
          .findByName(WORKER_MODEL_TYPE, workerDefinitionName(WORKER));
        assert(definition !== null);
        await runInRootUnitOfWork(
          deleter.repoContext,
          { flush: undefined },
          () =>
            deleter.repoContext.unifiedDataRepo.delete(
              WORKER_MODEL_TYPE,
              definition.id,
              WORKER_STATE_DATA_NAME,
            ),
        );
        await push(deleter);

        // the reaper's own push removes its copy of the peer's delete, and
        // nothing tells its catalog
        await reaper.repoContext.unifiedDataRepo.getContent(
          WORKER_MODEL_TYPE,
          definition.id,
          WORKER_STATE_DATA_NAME,
        );
        await reaper.syncService!.markDirty();
        await push(reaper);
        assertEquals(
          await reaper.repoContext.unifiedDataRepo.getContent(
            WORKER_MODEL_TYPE,
            definition.id,
            WORKER_STATE_DATA_NAME,
          ),
          null,
        );
        await assertRejects(() => strict(), Error, "no readable token name");

        const vanished: string[] = [];
        const tolerant = createWorkerTokenNameQuery(
          reaper.repoContext.dataQueryService,
          namespace,
          {
            repo: reaper.repoContext.unifiedDataRepo,
            onVanished: (ids) => {
              vanished.push(...ids);
              const gone = new Set(ids);
              reaper.repoContext.catalogStore.clearRows((row) =>
                gone.has(row.model_id)
              );
            },
          },
        );
        assertEquals([...await tolerant()], []);
        assertEquals(vanished, [definition.id]);
        assertEquals([...await strict()], []);
      } finally {
        deleter.repoContext.catalogStore.close();
        reaper.repoContext.catalogStore.close();
      }
    });
  } finally {
    dispose();
  }
});
