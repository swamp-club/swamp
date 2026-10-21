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

/**
 * Cross-namespace reads on a v3 datastore (swamp-club#3691): two checkouts,
 * `alpha` and `beta`, share one v3 filesystem datastore. A read in alpha of
 * beta's data returns beta's content, whether the two use the same model id
 * or not, through `data.latest` (getLatestRecord), `data query`, its
 * `--select content` projection, and a workflow run's CEL. A record alpha's
 * read model could not materialise fails the read with its code instead of
 * reading as empty.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { Data } from "../src/domain/data/mod.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { UserError } from "../src/domain/errors.ts";
import { UNREADABLE_RECORD_CODE } from "../src/domain/datastore_v3/read_model.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";

await initializeLogging({});

/** A checkout of the shared datastore; `namespace` undefined is solo. */
async function initRepo(
  repoDir: string,
  datastorePath: string,
  namespace: string | undefined,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + [
      "datastore:",
      "  type: filesystem",
      `  path: ${JSON.stringify(datastorePath)}`,
      "  format: 3",
      ...(namespace === undefined ? [] : [`  namespace: ${namespace}`]),
    ].join("\n") + "\n",
  );
}

/** Commits `m1`'s `state` resource in `repoDir`, holding `content`. */
async function writeState(
  repoDir: string,
  modelType: ModelType,
  modelId: string,
  content: Uint8Array,
): Promise<void> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  await runInRootUnitOfWork(ctx.repoContext, { flush: undefined }, async () => {
    await ctx.repoContext.unifiedDataRepo.save(
      modelType,
      modelId,
      Data.create({
        name: "state",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", modelName: "m1", specName: "state" },
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: `${modelType.normalized}:${modelId}`,
        },
      }),
      content,
    );
  });
}

const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

interface Shared {
  dir: string;
  datastorePath: string;
  modelType: ModelType;
}

/** A fresh v3 filesystem datastore and a per-run model type. */
async function withDatastore(fn: (s: Shared) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-3691-foreign-" }),
  );
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    await fn({
      dir,
      datastorePath,
      modelType: ModelType.create(
        `test/foreign-${crypto.randomUUID().slice(0, 8)}`,
      ),
    });
  } finally {
    await closeV3Datastores();
    await flushDatastoreSync();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Checkouts alpha and beta, each holding `m1`'s `state` saying who wrote
 * it; beta writes first. Returns alpha's query service.
 */
async function alphaAndBeta(
  s: Shared,
  alphaId: string,
  betaId: string,
): Promise<DataQueryService> {
  const repoAlpha = join(s.dir, "alpha");
  const repoBeta = join(s.dir, "beta");
  await initRepo(repoAlpha, s.datastorePath, "alpha");
  await initRepo(repoBeta, s.datastorePath, "beta");
  await writeState(repoBeta, s.modelType, betaId, json({ who: "beta" }));
  await writeState(repoAlpha, s.modelType, alphaId, json({ who: "alpha" }));
  return await queryServiceOf(repoAlpha);
}

async function queryServiceOf(repoDir: string): Promise<DataQueryService> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  return new DataQueryService(
    ctx.repoContext.catalogStore,
    ctx.repoContext.unifiedDataRepo,
  );
}

/** What alpha reads of beta's `m1` through each read path. */
async function readsOfBeta(dqs: DataQueryService) {
  const latest = await dqs.getLatestRecord("m1", "state", "beta");
  const queried = await dqs.query('ns == "beta"') as DataRecord[];
  const selected = await dqs.query('ns == "beta"', { select: "content" });
  return {
    latest: latest?.attributes,
    query: queried.map((r) => r.attributes),
    selectContent: selected,
  };
}

const BETA_READS = {
  latest: { who: "beta" },
  query: [{ who: "beta" }],
  selectContent: [{ who: "beta" }],
};

Deno.test("v3 foreign reads: alpha reads beta's m1 under a shared model id and gets beta's content", async () => {
  await withDatastore(async (s) => {
    const id = crypto.randomUUID();
    const dqs = await alphaAndBeta(s, id, id);
    assertEquals(await readsOfBeta(dqs), BETA_READS);
    // Alpha's own reads are unchanged.
    assertEquals(
      (await dqs.getLatestRecord("m1", "state", "alpha"))?.attributes,
      { who: "alpha" },
    );
  });
});

Deno.test("v3 foreign reads: alpha reads beta's m1 under distinct model ids and gets beta's content", async () => {
  await withDatastore(async (s) => {
    const dqs = await alphaAndBeta(
      s,
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
    assertEquals(await readsOfBeta(dqs), BETA_READS);
  });
});

Deno.test("v3 foreign reads: a namespaced checkout reads a solo checkout's row from the solo cache root", async () => {
  await withDatastore(async (s) => {
    const id = crypto.randomUUID();
    const repoSolo = join(s.dir, "solo");
    const repoAlpha = join(s.dir, "alpha");
    await initRepo(repoSolo, s.datastorePath, undefined);
    await initRepo(repoAlpha, s.datastorePath, "alpha");
    await writeState(repoSolo, s.modelType, id, json({ who: "solo" }));
    await writeState(repoAlpha, s.modelType, id, json({ who: "alpha" }));
    const dqs = await queryServiceOf(repoAlpha);

    assertEquals(
      (await dqs.getLatestRecord("m1", "state", ""))?.attributes,
      { who: "solo" },
    );
    assertEquals(
      (await dqs.query('ns == ""') as DataRecord[]).map((r) => r.attributes),
      [{ who: "solo" }],
    );
    assertEquals(await dqs.query('ns == ""', { select: "content" }), [{
      who: "solo",
    }]);
  });
});

Deno.test("v3 foreign reads: a workflow run in alpha whose CEL reads data.latest of beta:m1 gets beta's content", async () => {
  await withDatastore(async (s) => {
    const id = crypto.randomUUID();
    const repoAlpha = join(s.dir, "alpha");
    await alphaAndBeta(s, id, id);

    const seen: string[] = [];
    const readerType = ModelType.create(
      `test/foreign-reader-${crypto.randomUUID()}`,
    );
    modelRegistry.register({
      type: readerType,
      version: "2026.10.21.1",
      globalArguments: z.object({}),
      methods: {
        read: {
          description: "Records the value it is given",
          arguments: z.object({ who: z.string() }),
          execute: (args) => {
            seen.push((args as { who: string }).who);
            return Promise.resolve({});
          },
        },
      },
    });
    const workflow = Workflow.create({
      name: `read-beta-${crypto.randomUUID().slice(0, 8)}`,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "read",
          task: StepTask.directExecution(
            readerType.normalized,
            "reader",
            "read",
            { who: "${{ data.latest('beta:m1', 'state').attributes.who }}" },
          ),
        })],
      })],
    });
    await new YamlWorkflowRepository(repoAlpha).save(workflow);
    const ctx = await requireInitializedRepoUnlocked({
      repoDir: repoAlpha,
      outputMode: "log",
    });
    let status: string | undefined;
    const events: string[] = [];
    await executeWorkflowWithLocks(
      ctx.repoDir,
      ctx.repoContext,
      ctx.datastoreConfig,
      { workflowIdOrName: workflow.name },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "completed") status = event.run.status;
        events.push(JSON.stringify(event).slice(0, 600));
      },
      ctx.syncService,
      undefined,
      { syncGate: undefined },
    );

    assertEquals(status, "succeeded", events.join("\n"));
    assertEquals(seen, ["beta"]);
  });
});

Deno.test("v3 foreign reads: a foreign record alpha could not materialise fails the read with its code instead of reading as empty", async () => {
  await withDatastore(async (s) => {
    const id = crypto.randomUUID();
    const repoAlpha = join(s.dir, "alpha");
    const repoBeta = join(s.dir, "beta");
    await initRepo(repoAlpha, s.datastorePath, "alpha");
    await initRepo(repoBeta, s.datastorePath, "beta");
    // Past the inline limit, so the commit names chunks; then lose them.
    await writeState(
      repoBeta,
      s.modelType,
      id,
      json({ who: "beta", pad: "y".repeat(40 * 1024) }),
    );
    let removed = 0;
    for await (
      const entry of walk(join(s.datastorePath, "_blobs"), {
        includeDirs: false,
      })
    ) {
      await Deno.remove(entry.path);
      removed++;
    }
    assert(removed > 0, "beta's content names chunks");
    // Alpha opens after: its read model cannot materialise beta's record.
    await writeState(repoAlpha, s.modelType, id, json({ who: "alpha" }));
    const dqs = await queryServiceOf(repoAlpha);

    const refused = async (read: () => Promise<unknown>) => {
      const error = await assertRejects(read, UserError);
      assertEquals(error.code, UNREADABLE_RECORD_CODE);
    };
    await refused(() => dqs.getLatestRecord("m1", "state", "beta"));
    await refused(() => dqs.query('ns == "beta"'));
    await refused(() => dqs.query('ns == "beta"', { select: "content" }));
  });
});
