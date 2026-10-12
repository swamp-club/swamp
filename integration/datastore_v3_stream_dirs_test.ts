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
 * The stream directories on v3 (swamp-club#3278): `audit`, `telemetry`,
 * `logs` and `files` are repo-local, on v3 as on v2.
 *
 * - Two checkouts share one datastore. What the first records (command
 *   audit, vault audit, telemetry and a workflow run's log) stays in its own
 *   `.swamp` or spool: no commit names it, the datastore never holds it, and
 *   the second checkout reads none of it. A v2 filesystem datastore gives
 *   the same observations.
 * - Chunk GC and history compaction leave the first checkout's stream files
 *   intact, and a checkout rebuilt from the compacted base materialises
 *   nothing into a stream directory.
 * - A commit whose key falls in a stream directory is indexed but never
 *   materialised, so it cannot overwrite a checkout's own audit trail.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { ensureDir, exists } from "@std/fs";
import { dirname, join } from "@std/path";
import { z } from "zod";
import { createBashCommandEntry } from "../src/domain/audit/audit_command_entry.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { ChunkCollector } from "../src/domain/datastore_v3/chunk_collector.ts";
import { putOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  modelCommit,
  modelIntent,
  modelPartition,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import { createVaultAuditEntry } from "../src/domain/vaults/vault_audit_entry.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { runInCommitLogRoot } from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  readModelStateDir,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { JsonTelemetryRepository } from "../src/infrastructure/persistence/json_telemetry_repository.ts";
import { JsonlAuditRepository } from "../src/infrastructure/persistence/jsonl_audit_repository.ts";
import { JsonlVaultAuditRepository } from "../src/infrastructure/persistence/jsonl_vault_audit_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { currentUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../src/libswamp/context.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import { readLogFile } from "../src/presentation/output/log_file_reader.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import {
  base64Of,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const signal = () => AbortSignal.timeout(60_000);

const STREAMS: readonly string[] = REPO_LOCAL_STREAM_SUBDIRS;

/** Whether a cache-relative path is a stream file or a run log. */
function isStreamPath(rel: string): boolean {
  return STREAMS.includes(rel.split("/")[0]) || rel.endsWith(".log");
}

/** The stream files and run logs under `root`. */
async function streamFiles(root: string): Promise<string[]> {
  return [...(await readTree(root)).keys()].filter(isStreamPath);
}

const WriteArgs = z.object({ text: z.string() });

/** A model type, registered once per test with a unique name. */
function registerWriter(): ModelType {
  const type = ModelType.create(`test/v3-streams-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
    resources: {
      result: {
        description: "What the writer produced",
        schema: z.object({ text: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write a result resource",
        arguments: WriteArgs,
        execute: async (args, context) => ({
          dataHandles: [
            await context.writeResource!("result", "result", {
              text: WriteArgs.parse(args).text,
            }),
          ],
        }),
      },
    },
  });
  return type;
}

/** One checkout: its directory, repository context and workflow. */
interface Checkout {
  readonly dir: string;
  readonly repo: RepositoryContext;
  readonly workflowId: WorkflowId;
}

/** A checkout in `dir` with the writer model and a one-step workflow. */
async function checkout(
  dir: string,
  type: ModelType,
  options: Partial<Parameters<typeof createRepositoryContext>[0]> = {},
): Promise<Checkout> {
  await ensureDir(dir);
  const repo = createRepositoryContext({ repoDir: dir, ...options });
  await repo.definitionRepo.save(type, Definition.create({ name: "writer" }));
  const workflow = Workflow.create({
    name: "flow",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "s",
        task: StepTask.model("writer", "write", { text: "s" }),
      })],
    })],
  });
  await repo.workflowRepo.save(workflow);
  return { dir, repo, workflowId: workflow.id };
}

/**
 * Records a command-audit, a vault-audit and a telemetry entry through
 * their production repositories, as the CLI does for `repoDir`, with the
 * user-global telemetry spool at `spool`.
 */
async function recordStreams(repoDir: string, spool: string): Promise<void> {
  await new JsonlAuditRepository(repoDir).append(
    createBashCommandEntry("session", "swamp model method run", repoDir),
  );
  await new JsonlVaultAuditRepository(repoDir).append(
    createVaultAuditEntry("get", "main", "local_encryption", "token", "test"),
  );
  const startedAt = new Date();
  await new JsonTelemetryRepository(repoDir, spool).save(TelemetryEntry.create({
    invocation: {
      command: "model",
      subcommand: "method",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt,
    completedAt: new Date(startedAt.getTime() + 1000),
    swampVersion: "1.0.0",
    denoVersion: "2.0.0",
    platform: "linux",
  }));
}

/** What a checkout in `repoDir` reads of the streams, for `run`. */
async function readsOf(
  repoDir: string,
  run: WorkflowRun,
): Promise<{ audit: number; vaultAudit: number; log: boolean }> {
  const from = new Date(Date.now() - 60 * 60 * 1000);
  const to = new Date(Date.now() + 60 * 60 * 1000);
  const logFile = run.logFile;
  return {
    audit: (await new JsonlAuditRepository(repoDir).findByTimeRange(from, to))
      .length,
    vaultAudit:
      (await new JsonlVaultAuditRepository(repoDir).findByTimeRange(from, to))
        .length,
    // The run's log as `workflow history logs` resolves it: an absolute
    // path under this checkout's own `.swamp`.
    log: logFile !== undefined && await exists(logFile) &&
      (await readLogFile(logFile)).path === logFile,
  };
}

/** Runs the checkout's workflow to its end; returns the run id. */
async function runFlow(
  ctx: LibSwampContext,
  at: Checkout,
  config: DatastoreConfig,
): Promise<string> {
  const deps = await createWorkflowRunDeps(at.dir, at.repo, config);
  let runId: string | undefined;
  for await (
    const event of workflowRun(ctx, deps, { workflowIdOrName: "flow" })
  ) {
    if (event.kind === "started" && runId === undefined) runId = event.runId;
  }
  assert(runId !== undefined, "the run started");
  return runId;
}

async function findRun(
  repo: YamlWorkflowRunRepository,
  at: Checkout,
  runId: string,
): Promise<WorkflowRun> {
  const run = await repo.findById(at.workflowId, createWorkflowRunId(runId));
  assert(run !== null, `run ${runId} is readable`);
  return run;
}

/** Every record key a stored commit names. */
async function committedKeys(env: V3Env): Promise<string[]> {
  const keys: string[] = [];
  for (const change of await env.store.changesSince(0, 10_000)) {
    for (const op of change.commit.ops) {
      if ("key" in op) keys.push(op.key.toString());
    }
  }
  return keys;
}

/** Chunk GC past every grace period, as `datastore gc` will run it. */
async function collectChunks(env: V3Env): Promise<void> {
  await new ChunkCollector({
    commitStore: env.store,
    storage: new FileSystemStorage(join(env.dir, "datastore")),
    graceMs: 0,
    clock: () => new Date(Date.now() + 48 * 60 * 60 * 1000),
  }).collect(SOLO_NAMESPACE, { signal: signal() });
}

/** A read model over a checkout of its own at `dir`. */
function openCheckout(env: V3Env, dir: string) {
  const root = swampPath(dir);
  return {
    root,
    readModel: env.openReadModel({
      cacheRoot: (ns) => ns === "" ? root : join(root, ns),
      stateDir: readModelStateDir(dir),
    }),
  };
}

/** What every checkout but the writer sees: nothing of the streams. */
const NOTHING = { audit: 0, vaultAudit: 0, log: false };

Deno.test("v3 stream directories: audit, telemetry and run logs stay in the checkout that wrote them", async () => {
  await withV3Env(async (env) => {
    const type = registerWriter();
    const hook = contextHook();
    const aDir = join(env.dir, "a");
    const a = await checkout(aDir, type, { markDirty: hook });
    const config: DatastoreConfig = {
      type: "filesystem",
      path: swampPath(aDir),
    };
    const unit = unitOptions(env.store, env.storage, { signal: signal() });
    let runId = "";
    await runInCommitLogRoot({ markDirty: hook }, unit, async () => {
      await recordStreams(aDir, join(env.dir, "spool-a"));
      runId = await runFlow(
        createLibSwampContext({
          openUnitOfWork: () =>
            createCommitLogUnitOfWork(hook, {
              ...unit,
              parent: currentUnitOfWork(),
            }),
        }),
        a,
        config,
      );
    });

    // The writer reads its own streams; the run committed, its log did not.
    const own = await readsOf(
      aDir,
      await findRun(a.repo.workflowRunRepo, a, runId),
    );
    assertEquals(own, { audit: 1, vaultAudit: 1, log: true });
    assertEquals((await readTree(join(env.dir, "spool-a"))).size, 1);
    const keys = await committedKeys(env);
    assert(keys.some((key) => key.startsWith("workflow-runs/")));
    assertEquals(keys.filter(isStreamPath), []);
    for (const rel of (await readTree(join(env.dir, "datastore"))).keys()) {
      assert(rel.startsWith("_blobs/"), `${rel} is a chunk`);
    }
    const aStreams = await readTree(swampPath(aDir));
    const aStreamFiles = [...aStreams].filter(([rel]) => isStreamPath(rel));
    assert(aStreamFiles.length >= 3, "audit, vault audit and the run log");

    // The second checkout catches up: the run, none of its streams.
    const b = openCheckout(env, join(env.dir, "b"));
    try {
      await b.readModel.catchUp(signal());
    } finally {
      await b.readModel.close();
    }
    assertEquals(await streamFiles(b.root), []);
    const bRuns = new YamlWorkflowRunRepository(
      join(env.dir, "b"),
      undefined,
      join(b.root, "workflow-runs"),
    );
    assertEquals(
      await readsOf(join(env.dir, "b"), await findRun(bRuns, a, runId)),
      NOTHING,
    );

    // Compaction and chunk GC leave the writer's streams as they were, and
    // a checkout rebuilt from the compacted base holds none of them.
    await env.store.compactHistory(
      (await env.store.changesSince(0, 10_000)).length,
    );
    await collectChunks(env);
    assertEquals(
      [...await readTree(swampPath(aDir))].filter(([rel]) => isStreamPath(rel)),
      aStreamFiles,
    );
    const fresh = openCheckout(env, join(env.dir, "fresh"));
    try {
      await fresh.readModel.catchUp(signal());
    } finally {
      await fresh.readModel.close();
    }
    assertEquals(await streamFiles(fresh.root), []);
    const freshRuns = new YamlWorkflowRunRepository(
      join(env.dir, "fresh"),
      undefined,
      join(fresh.root, "workflow-runs"),
    );
    assertEquals(
      await readsOf(join(env.dir, "fresh"), await findRun(freshRuns, a, runId)),
      NOTHING,
    );
  });
});

Deno.test("v2 stream directories: the same writes stay in the checkout that wrote them", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v2-streams-" });
  try {
    const type = registerWriter();
    const datastore = join(dir, "datastore");
    const config: DatastoreConfig = { type: "filesystem", path: datastore };
    const resolver = (repoDir: string) =>
      new DefaultDatastorePathResolver(repoDir, config);
    const aDir = join(dir, "a");
    const a = await checkout(aDir, type, { datastoreResolver: resolver(aDir) });
    await recordStreams(aDir, join(dir, "spool-a"));
    const runId = await runFlow(createLibSwampContext(), a, config);

    const own = await readsOf(
      aDir,
      await findRun(a.repo.workflowRunRepo, a, runId),
    );
    assertEquals(own, { audit: 1, vaultAudit: 1, log: true });
    assertEquals((await readTree(join(dir, "spool-a"))).size, 1);
    const shared = [...(await readTree(datastore)).keys()];
    assert(shared.some((rel) => rel.startsWith("workflow-runs/")));
    assertEquals(shared.filter(isStreamPath), []);

    const bDir = join(dir, "b");
    await ensureDir(bDir);
    const b = createRepositoryContext({
      repoDir: bDir,
      datastoreResolver: resolver(bDir),
    });
    assertEquals(
      await readsOf(bDir, await findRun(b.workflowRunRepo, a, runId)),
      NOTHING,
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("v3 stream directories: a commit keyed into a stream directory is indexed, never materialised", async () => {
  await withV3Env(async (env) => {
    const day = new Date().toISOString().slice(0, 10);
    const auditKey = `audit/commands-${day}.jsonl`;
    const ownAudit = join(env.cacheRoot(""), ...auditKey.split("/"));
    await ensureDir(dirname(ownAudit));
    await Deno.writeTextFile(ownAudit, "the checkout's own audit\n");
    const forged = new TextEncoder().encode("forged\n");
    const puts = await Promise.all(
      [auditKey, "telemetry/t.json", "logs/run.log", "files/out.bin"].map((
        key,
      ) =>
        putOp({
          intent: modelIntent({
            kind: "data.save",
            name: "forged",
            version: 1,
          }),
          key: RecordKey.create(key),
          inline: base64Of(forged),
        })
      ),
    );
    await env.store.append(modelCommit(1, [...puts, versionOp("forged", 1)]));

    const readModel = env.openReadModel();
    try {
      await readModel.catchUp(signal());
      const live = (await readModel.liveRecords("", modelPartition())).map((
        r,
      ) => r.key.toString());
      for (const op of puts) assert(live.includes(op.key.toString()));
    } finally {
      await readModel.close();
    }
    assertEquals(
      await Deno.readTextFile(ownAudit),
      "the checkout's own audit\n",
    );
    for (const dir of ["telemetry", "logs", "files"]) {
      assertEquals(await exists(join(env.cacheRoot(""), dir)), false, dir);
    }

    // The compacted base folds the same way: indexed, not materialised.
    await env.store.compactHistory(1);
    await collectChunks(env);
    const fresh = openCheckout(env, join(env.dir, "fresh"));
    try {
      await fresh.readModel.catchUp(signal());
    } finally {
      await fresh.readModel.close();
    }
    assertEquals(await streamFiles(fresh.root), []);
    assertEquals(
      await Deno.readTextFile(ownAudit),
      "the checkout's own audit\n",
    );
  });
});
