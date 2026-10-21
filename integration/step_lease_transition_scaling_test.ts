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

// Serve records every remote dispatch's lease transitions as method runs on
// one `leases` instance that holds a data name per lease. An update
// transition (mark_writes, complete) must read a fixed amount of that data
// however many leases are kept, or each transition slows as leases pile up
// and the data-plane write waiting on mark_writes stalls (swamp-club#3755).
// Runs the real step-lease model through the same method runner serve uses,
// against a real repository on disk, v2 and v3.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import type { Data } from "../src/domain/data/data.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { ModelTypeInput } from "../src/domain/models/model_type.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../src/domain/models/worker/step_lease_model.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { v3RepositoryFactoryConfig } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
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

await initializeLogging({});

const SEEDED_LEASES = 200;

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

async function lease(
  dir: string,
  ctx: RepositoryContext,
  methodName: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  const deps = await createWorkerModelRunDeps(dir, ctx, {
    definitionType: STEP_LEASE_MODEL_TYPE,
  });
  for await (
    const event of modelMethodRun(createLibSwampContext({}), deps, {
      modelIdOrName: STEP_LEASE_INSTANCE_NAME,
      methodName,
      inputs,
      lastEvaluated: false,
      typeArg: STEP_LEASE_MODEL_TYPE.normalized,
      definitionName: STEP_LEASE_INSTANCE_NAME,
      skipAllReports: true,
    })
  ) {
    if (event.kind === "error") {
      throw new Error(JSON.stringify(event.error));
    }
  }
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

/** Counts the model data the method runs read through the repository. */
function countModelReads(ctx: RepositoryContext) {
  const reads = { pulled: 0, findAllForModel: 0 };
  const repo = ctx.unifiedDataRepo;
  const iterate = repo.iterateForModel.bind(repo);
  const findAll = repo.findAllForModel.bind(repo);
  repo.iterateForModel = async function* (
    type: ModelTypeInput,
    modelId: string,
  ): AsyncIterable<Data> {
    for await (const data of iterate(type, modelId)) {
      reads.pulled++;
      yield data;
    }
  };
  repo.findAllForModel = (type: ModelTypeInput, modelId: string) => {
    reads.findAllForModel++;
    return findAll(type, modelId);
  };
  return reads;
}

/**
 * Seeds the leases, then runs one lease's acquire, mark_writes and complete,
 * asserting each update read at most one item of the instance's data.
 */
async function assertUpdatesReadFixedData(
  dir: string,
  ctx: RepositoryContext,
): Promise<void> {
  for (let i = 0; i < SEEDED_LEASES; i++) {
    await lease(dir, ctx, "acquire", acquireInputs(`seed-${i}`));
  }
  await lease(dir, ctx, "acquire", acquireInputs("probe"));

  const reads = countModelReads(ctx);
  await lease(dir, ctx, "mark_writes", { leaseId: "probe" });
  assertEquals(reads, { pulled: 1, findAllForModel: 0 });

  reads.pulled = 0;
  await lease(dir, ctx, "complete", { leaseId: "probe" });
  assertEquals(reads, { pulled: 1, findAllForModel: 0 });
}

Deno.test("lease update transitions read one data item however many leases are kept (swamp-club#3755)", async () => {
  await withTempDir(async (dir) => {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    try {
      await assertUpdatesReadFixedData(dir, ctx);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("lease update transitions read one data item on a v3 datastore (swamp-club#3755)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
    };
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    const ctx = createRepositoryContext({
      repoDir,
      enableIndexing: false,
      datastoreResolver: new DefaultDatastorePathResolver(repoDir, config, {
        engine: "v3",
      }),
      ...await v3RepositoryFactoryConfig(repoDir, config),
    });
    try {
      await runInRootUnitOfWork(
        ctx,
        { flush: undefined },
        () => assertUpdatesReadFixedData(repoDir, ctx),
      );
    } finally {
      ctx.catalogStore.close();
    }
  });
});
