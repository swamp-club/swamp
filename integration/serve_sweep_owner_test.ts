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

import { assertEquals, assertRejects } from "@std/assert";
import "../src/domain/models/models.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import type { OrchestratorOwner } from "../src/domain/models/worker/orchestrator_owner.ts";
import {
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
  pendingDataName,
} from "../src/domain/models/worker/pending_dispatch_model.ts";
import {
  leaseDataName,
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../src/domain/models/worker/step_lease_model.ts";
import {
  WORKER_MODEL_TYPE,
  WORKER_STATE_DATA_NAME,
  workerDefinitionName,
} from "../src/domain/models/worker/worker_model.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
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
  methodRunnerPendingDispatchStore,
  PendingDispatchLedger,
} from "../src/serve/pending_dispatch_ledger.ts";
import {
  methodRunnerLeaseStore,
  StepLeaseLedger,
} from "../src/serve/step_lease_ledger.ts";
import type { ModelMethodRunner } from "../src/serve/worker_gateway.ts";
import {
  methodRunnerWorkerStatusStore,
  WorkerStatusLedger,
} from "../src/serve/worker_status_ledger.ts";

await initializeLogging({});

const SERVE_A: OrchestratorOwner = {
  instanceId: "serve-a",
  pid: 4101,
  host: "host-1",
};
const SERVE_B = "serve-b";

async function withRepo(
  fn: (ctx: RepositoryContext, run: ModelMethodRunner) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const ctx = createRepositoryContext({ repoDir: dir, enableIndexing: false });
  const run: ModelMethodRunner = (input) =>
    runInRootUnitOfWork(ctx, { flush: undefined }, async () => {
      const deps = await createWorkerModelRunDeps(dir, ctx, {
        definitionType: input.typeArg === STEP_LEASE_MODEL_TYPE.normalized
          ? STEP_LEASE_MODEL_TYPE
          : input.typeArg === PENDING_DISPATCH_MODEL_TYPE.normalized
          ? PENDING_DISPATCH_MODEL_TYPE
          : WORKER_MODEL_TYPE,
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
  try {
    await fn(ctx, run);
  } finally {
    ctx.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function stored(
  ctx: RepositoryContext,
  type: ModelType,
  definitionName: string,
  dataName: string,
): Promise<Record<string, unknown>> {
  const definition = await ctx.definitionRepo.findByName(type, definitionName);
  const content = definition === null
    ? null
    : await ctx.unifiedDataRepo.getContent(type, definition.id, dataName);
  if (content === null) throw new Error(`${dataName} is not stored`);
  return JSON.parse(new TextDecoder().decode(content));
}

/** serve A's live work, written through serve's own ledgers */
async function seedServeA(
  ctx: RepositoryContext,
  run: ModelMethodRunner,
  owner: OrchestratorOwner | undefined,
) {
  const leases = new StepLeaseLedger(ctx, methodRunnerLeaseStore(run));
  const pending = new PendingDispatchLedger(
    ctx,
    methodRunnerPendingDispatchStore(run),
  );
  const workers = new WorkerStatusLedger(
    ctx,
    methodRunnerWorkerStatusStore(run),
  );
  const stamp = owner === undefined ? {} : { owner };
  await run({
    typeArg: WORKER_MODEL_TYPE.normalized,
    definitionName: workerDefinitionName("w1"),
    methodName: "enroll",
    inputs: {
      instanceUuid: "uuid-1",
      tokenName: "w1",
      workerName: "w1",
      labels: {},
      platform: "linux",
      arch: "x86_64",
      swampVersion: "1.0.0",
      protocolVersion: 7,
      capacity: 1,
      ...stamp,
    },
  });
  await leases.acquire({
    leaseId: "l1",
    dispatchId: "l1",
    workerName: "w1",
    modelType: "command/shell",
    modelId: "m1",
    methodName: "execute",
    ...stamp,
  });
  await workers.recordStatus("w1", {
    status: "busy",
    activeDispatchIds: ["l1"],
    ...stamp,
  });
  await pending.enqueue({
    queueId: "q1",
    labels: { pool: "nobody" },
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: new Date().toISOString(),
    ...stamp,
  });
  return { leases };
}

async function states(ctx: RepositoryContext) {
  return {
    lease: (await stored(
      ctx,
      STEP_LEASE_MODEL_TYPE,
      STEP_LEASE_INSTANCE_NAME,
      leaseDataName("l1"),
    )).state,
    queued: (await stored(
      ctx,
      PENDING_DISPATCH_MODEL_TYPE,
      PENDING_DISPATCH_INSTANCE_NAME,
      pendingDataName("q1"),
    )).state,
    worker: (await stored(
      ctx,
      WORKER_MODEL_TYPE,
      workerDefinitionName("w1"),
      WORKER_STATE_DATA_NAME,
    )).status,
  };
}

const LIVE = { lease: "active", queued: "waiting", worker: "busy" };
const SETTLED = {
  lease: "expired",
  queued: "orphaned",
  worker: "disconnected",
};

Deno.test("sweepStaleRecords: a serve starting beside a live one leaves that one's lease, queued dispatch and worker, and settles them once it is gone", async () => {
  await withRepo(async (ctx, run) => {
    const { leases } = await seedServeA(ctx, run, SERVE_A);
    let aliveA = true;
    const ownerAlive = (owner: OrchestratorOwner) =>
      Promise.resolve(
        owner.instanceId === SERVE_B ||
          (owner.instanceId === SERVE_A.instanceId && aliveA),
      );

    const boot = await sweepStaleRecords({ repoContext: ctx, ownerAlive });
    assertEquals(boot.deferredOwners, [SERVE_A]);
    assertEquals(await states(ctx), LIVE);
    // the step serve A dispatched still records its write
    await leases.markWrites("l1");

    aliveA = false;
    const settled = await sweepStaleRecords({
      repoContext: ctx,
      onlyOwner: SERVE_A.instanceId,
    });
    assertEquals(
      [settled.leases, settled.pendingDispatches, settled.workers],
      [1, 1, 1],
    );
    assertEquals(await states(ctx), SETTLED);
  });
});

Deno.test("sweepStaleRecords: records an older serve wrote with no owner are settled at boot as before", async () => {
  await withRepo(async (ctx, run) => {
    const { leases } = await seedServeA(ctx, run, undefined);
    const boot = await sweepStaleRecords({
      repoContext: ctx,
      ownerAlive: () => Promise.resolve(true),
    });
    assertEquals(boot.deferredOwners, []);
    assertEquals(await states(ctx), SETTLED);
    await assertRejects(
      () => leases.markWrites("l1"),
      Error,
      "only active leases record writes",
    );
  });
});
