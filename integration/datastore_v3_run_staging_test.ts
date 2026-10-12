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
 * The v3 gate for the workflow run repository (swamp-club#3257).
 *
 * - The real repository runs on v3 inside a commit-log root, solo and
 *   namespaced; the unit commits to a real `commits.db` and filesystem
 *   `storage/1`, and a read model catches up into a second directory, whose
 *   run records (bytes) must equal what the repository wrote.
 * - Run outcomes (decision 5): the real `workflowRun` use case runs on a v3
 *   context, and its unit commits on a succeeded, failed, suspended or
 *   cancelled run and discards on an early stop.
 * - A run record never names data whose partition was refused (decision 7):
 *   a real `version-live` refusal, and an `expect-failed` one, followed by
 *   the run's record.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { PartitionsRefusedError } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
} from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  type CommitLogRootOptions,
  runInCommitLogRoot,
} from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import {
  type CommitSink,
  createCommitLogUnitOfWork,
} from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { reconcileRefusedRuns } from "../src/infrastructure/datastore_v3/refused_run_records.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { currentUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { result } from "../src/libswamp/stream.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import {
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

/** Files beside run records that are never datastore records. */
function isLocalOnly(rel: string): boolean {
  return rel.endsWith(".runs-index.json") || rel.endsWith(".log");
}

async function catchUp(env: V3Env): Promise<void> {
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
}

/** The run records under `root`'s `workflow-runs`, by relative path. */
async function runRecords(root: string): Promise<Map<string, string>> {
  return new Map(
    [...await readTree(join(root, "workflow-runs"))].filter(([rel]) =>
      !isLocalOnly(rel)
    ),
  );
}

/** One v3 repository context's workflow run repository. */
class RunWriter {
  readonly dir: string;
  readonly root: string;
  readonly hook = contextHook();
  readonly namespace: Namespace;
  readonly repo: YamlWorkflowRunRepository;

  constructor(readonly env: V3Env, readonly namespaceName: string) {
    this.dir = join(env.dir, "writer");
    this.namespace = namespaceName === ""
      ? SOLO_NAMESPACE
      : restoreNamespace(namespaceName);
    this.root = namespaceName === ""
      ? swampPath(this.dir)
      : swampPath(this.dir, namespaceName);
    this.repo = new YamlWorkflowRunRepository(
      this.dir,
      undefined,
      join(this.root, "workflow-runs"),
      this.hook,
    );
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return runInCommitLogRoot(
      { markDirty: this.hook },
      unitOptions(this.env.store, this.env.storage, {
        namespace: this.namespace,
        signal: AbortSignal.timeout(60_000),
      }),
      fn,
    );
  }

  /** Catches the read model up; its run records must equal the writer's. */
  async assertMatches(): Promise<void> {
    await catchUp(this.env);
    assertEquals(
      await runRecords(this.env.cacheRoot(this.namespaceName)),
      await runRecords(this.root),
    );
  }

  async commitsOf(workflowId: string, runId: string): Promise<Commit[]> {
    return (await this.env.store.readPartition(
      this.namespaceName,
      partitionOf({ kind: "run", workflowId, runId }),
      1,
      1_000,
    )).map((change) => change.commit);
  }
}

function plainWorkflow(): Workflow {
  return Workflow.create({
    name: "runs",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
    })],
  });
}

for (const namespace of ["", "infra"]) {
  const label = namespace === "" ? "an unnamespaced" : "a namespaced";

  Deno.test(`v3 run staging: run record writes match the read model for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new RunWriter(env, namespace);
      const workflow = plainWorkflow();
      const wfId = workflow.id;

      // Many saves of one run in one unit commit once, its last record.
      const run = WorkflowRun.create(workflow);
      await writer.run(async () => {
        await writer.repo.save(wfId, run);
        run.start();
        await writer.repo.save(wfId, run);
        run.complete();
        await writer.repo.save(wfId, run);
      });
      const [commit, ...more] = await writer.commitsOf(wfId, run.id);
      assertEquals(more, []);
      assertEquals(
        commit.ops.map((op) => op.kind === "put" ? op.intent.kind : op.kind),
        ["run.update"],
      );
      await writer.assertMatches();

      // A later unit's save of the same run updates it.
      await writer.run(() => writer.repo.save(wfId, run));
      assertEquals((await writer.commitsOf(wfId, run.id)).length, 2);
      await writer.assertMatches();

      // Run GC: a finished run, an unparseable record and a stray file
      // whose name holds no UUID; a dry run removes and stages nothing.
      const cancelled = WorkflowRun.create(workflow);
      cancelled.start();
      cancelled.endAsCancelled("test");
      await writer.run(() => writer.repo.save(wfId, cancelled));
      const runsDir = join(writer.root, "workflow-runs", wfId);
      // A committed record a hook-less write later truncated.
      const truncated = WorkflowRun.create(workflow);
      await writer.run(() => writer.repo.save(wfId, truncated));
      await Deno.writeTextFile(writer.repo.getPath(wfId, truncated.id), "");
      // A record no repository ever put.
      const unparseable = crypto.randomUUID();
      await Deno.writeTextFile(
        join(runsDir, `workflow-run-${unparseable}.yaml`),
        "",
      );
      await Deno.writeTextFile(join(runsDir, "workflow-run-stray.yaml"), "");
      const cutoff = new Date(Date.now() + 60_000);
      await writer.run(() =>
        writer.repo.deleteOlderThan(cutoff, { dryRun: true })
      );
      const result = await writer.run(() =>
        writer.repo.deleteOlderThan(cutoff)
      );
      assertEquals(result.deleted, 5);
      await writer.assertMatches();
      assertEquals(await runRecords(writer.root), new Map());

      // deleteAllByWorkflowId: one tombstone per run.
      const runs = [WorkflowRun.create(workflow), WorkflowRun.create(workflow)];
      await writer.run(async () => {
        for (const each of runs) await writer.repo.save(wfId, each);
      });
      await writer.assertMatches();
      assertEquals((await runRecords(writer.root)).size, 2);
      await writer.run(() => writer.repo.deleteAllByWorkflowId(wfId));
      await writer.assertMatches();
      assertEquals(await runRecords(env.cacheRoot(namespace)), new Map());
    });
  });
}

// ── Run outcomes and refusals through the workflow run use case ─────────

const WriteArgs = z.object({ text: z.string() });

/** A repository context over a v3 hook, with a model that writes data. */
interface RunContext {
  readonly dir: string;
  readonly hook: ReturnType<typeof contextHook>;
  readonly repo: RepositoryContext;
  readonly workflowId: WorkflowId;
}

/** A model type, registered once per test with a unique name. */
function registerWriter(): ModelType {
  const type = ModelType.create(`test/v3-runs-${crypto.randomUUID()}`);
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
      fail: {
        description: "Fail",
        arguments: z.object({}),
        execute: () => Promise.reject(new Error("the method failed")),
      },
    },
  });
  return type;
}

/**
 * A repository context in `name` over a fresh v3 hook, with the writer
 * model saved under `definition` and a workflow of `steps`. Setup writes
 * run before the hook requires a unit.
 */
async function runContext(
  env: V3Env,
  name: string,
  type: ModelType,
  definition: Definition,
  steps: Step[],
): Promise<RunContext> {
  const dir = join(env.dir, name);
  await ensureDir(dir);
  const hook = contextHook();
  const repo = createRepositoryContext({ repoDir: dir, markDirty: hook });
  await repo.definitionRepo.save(type, definition);
  const workflow = Workflow.create({
    name: "flow",
    jobs: [Job.create({ name: "main", steps })],
  });
  await repo.workflowRepo.save(workflow);
  return { dir, hook, repo, workflowId: workflow.id };
}

function writeStep(name: string): Step {
  return Step.create({
    name,
    task: StepTask.model("writer", "write", { text: name }),
  });
}

/**
 * Runs the workflow through the `workflowRun` use case inside a commit-log
 * root over `context`'s hook, the use case's unit a child of it, consuming
 * the stream with `consume`. Returns the run id.
 */
async function runWorkflow(
  env: V3Env,
  context: RunContext,
  consume: (stream: AsyncIterable<{ kind: string }>) => Promise<void>,
  options: {
    sink?: CommitSink;
    onRefused?: CommitLogRootOptions<unknown>["onRefused"];
    abort?: AbortController;
  } = {},
): Promise<string> {
  const unit = unitOptions(options.sink ?? env.store, env.storage, {
    signal: AbortSignal.timeout(60_000),
  });
  const deps = await createWorkflowRunDeps(context.dir, context.repo, {
    type: "filesystem",
    path: join(context.dir, ".swamp"),
  });
  let runId: string | undefined;
  await runInCommitLogRoot(
    { markDirty: context.hook },
    { ...unit, onRefused: options.onRefused },
    async () => {
      const ctx = createLibSwampContext({
        signal: options.abort?.signal,
        openUnitOfWork: () =>
          createCommitLogUnitOfWork(context.hook, {
            ...unit,
            parent: currentUnitOfWork(),
          }),
      });
      const stream = workflowRun(ctx, deps, { workflowIdOrName: "flow" });
      await consume((async function* () {
        for await (const event of stream) {
          if (event.kind === "started" && runId === undefined) {
            runId = event.runId;
          }
          yield event;
        }
      })());
    },
  );
  assert(runId !== undefined, "the run started");
  return runId;
}

async function drain(stream: AsyncIterable<{ kind: string }>): Promise<void> {
  for await (const _event of stream) {
    // consume every event
  }
}

/** The run's record in the read model, or undefined when never committed. */
async function committedRecord(
  env: V3Env,
  context: RunContext,
  runId: string,
): Promise<string | undefined> {
  await catchUp(env);
  try {
    return await Deno.readTextFile(
      join(
        env.cacheRoot(""),
        "workflow-runs",
        context.workflowId,
        `workflow-run-${runId}.yaml`,
      ),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function localRecord(context: RunContext, runId: string) {
  return await Deno.readTextFile(
    context.repo.workflowRunRepo.getPath(
      context.workflowId,
      createWorkflowRunId(runId),
    ),
  );
}

async function storedRun(
  env: V3Env,
  context: RunContext,
  runId: string,
): Promise<WorkflowRun | null> {
  await catchUp(env);
  return await new YamlWorkflowRunRepository(
    env.repoDir,
    undefined,
    join(env.cacheRoot(""), "workflow-runs"),
  ).findById(context.workflowId, createWorkflowRunId(runId));
}

Deno.test("v3 run staging: a run's unit commits when it ends succeeded, failed, suspended or cancelled, with the record the run saved last", async () => {
  await withV3Env(async (env) => {
    const type = registerWriter();
    // A model per context: each run's reports write versions of their own.
    const definition = () => Definition.create({ name: "writer" });
    const cases: [string, Step[], string][] = [
      ["succeeded", [writeStep("a")], "succeeded"],
      [
        "failed",
        [Step.create({ name: "f", task: StepTask.model("writer", "fail") })],
        "failed",
      ],
      [
        "suspended",
        [Step.create({
          name: "gate",
          task: StepTask.manualApproval("Approve"),
        })],
        "suspended",
      ],
    ];
    for (const [name, steps, status] of cases) {
      const context = await runContext(env, name, type, definition(), steps);
      const runId = await runWorkflow(env, context, drain);
      const committed = await committedRecord(env, context, runId);
      assertEquals(committed, await localRecord(context, runId), name);
      assertEquals((await storedRun(env, context, runId))?.status, status);
    }

    // Cancelled: the abort lands while the run is underway.
    const abort = new AbortController();
    const cancelled = await runContext(env, "cancelled", type, definition(), [
      writeStep("a"),
      writeStep("b"),
    ]);
    const runId = await runWorkflow(env, cancelled, async (stream) => {
      for await (const event of stream) {
        if (event.kind === "step_completed") abort.abort();
      }
    }, { abort });
    assertEquals(
      await committedRecord(env, cancelled, runId),
      await localRecord(cancelled, runId),
    );
    assertEquals(
      (await storedRun(env, cancelled, runId))?.status,
      "cancelled",
    );
  });
});

Deno.test("v3 run staging: a run whose consumer stops before an outcome commits nothing; one that stops at completed (result()) commits", async () => {
  await withV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const stopped = await runContext(env, "stopped", type, definition, [
      writeStep("a"),
    ]);
    const runId = await runWorkflow(env, stopped, async (stream) => {
      for await (const event of stream) {
        if (event.kind === "started") break;
      }
    });
    assertEquals(await committedRecord(env, stopped, runId), undefined);

    const viaResult = await runContext(env, "result", type, definition, [
      writeStep("a"),
    ]);
    const resultRun = await runWorkflow(
      env,
      viaResult,
      async (stream) => {
        await result(stream as never);
      },
    );
    // result() stops at completed, before the executor's last save of the
    // run, so the record, local and committed alike, is the one saved while
    // it ran (v2 leaves the same local file). The CLI and serve drain the
    // stream, so their runs end with their final record.
    assertEquals(
      await committedRecord(env, viaResult, resultRun),
      await localRecord(viaResult, resultRun),
    );
    assertEquals(
      (await storedRun(env, viaResult, resultRun))?.status,
      "running",
    );
  });
});

/** A sink that refuses each model-partition commit as `reason`. */
function refusingModels(env: V3Env, reason: "expect-failed"): CommitSink {
  return {
    append: (commit) =>
      commit.partition.kind === "model"
        ? Promise.reject(
          new CommitRejectedError(
            reason,
            `refused ${commit.partition} (${reason})`,
          ),
        )
        : env.store.append(commit),
    head: (namespace, key) => env.store.head(namespace, key),
  };
}

for (const reason of ["version-live", "expect-failed"] as const) {
  Deno.test(`v3 run staging: after a ${reason} refusal, the run commits with the step that wrote the refused data failed, and never names it as a success`, async () => {
    await withV3Env(async (env) => {
      const type = registerWriter();
      const definition = Definition.create({ name: "writer" });
      const steps = [writeStep("a")];
      let sink: CommitSink | undefined;
      if (reason === "version-live") {
        // Another checkout of the same model already recorded result@1.
        const first = await runContext(env, "first", type, definition, steps);
        await runWorkflow(env, first, drain);
      } else {
        sink = refusingModels(env, reason);
      }

      const context = await runContext(env, "second", type, definition, steps);
      const seen: PartitionsRefusedError[] = [];
      let runId: string | undefined;
      const error = await assertRejects(
        async () => {
          runId = await runWorkflow(env, context, drain, {
            sink,
            onRefused: async (refusal) => {
              seen.push(refusal);
              await reconcileRefusedRuns(context.repo.workflowRunRepo, refusal);
            },
          });
        },
        PartitionsRefusedError,
      );
      assertEquals(error.reason, reason);
      assertEquals(seen.length, 1);
      // The step's result and the run's report data, all in the model's
      // refused partition.
      assert(error.refusals[0].versions.length > 0);
      // runInCommitLogRoot threw, so read the run id from the local records.
      const ids = await context.repo.workflowRunRepo.listRunIdsForWorkflow(
        context.workflowId,
      );
      runId ??= ids[0];

      // The committed record is the re-saved one: the step and run failed.
      const stored = await storedRun(env, context, runId);
      assertEquals(stored?.status, "failed");
      const step = stored!.getJob("main")!.getStep("a")!;
      assertEquals(step.status, "failed");
      assert(step.error?.includes("refused"));
      assertEquals(
        await committedRecord(env, context, runId),
        await localRecord(context, runId),
      );

      // A later unit's save of the run (as a resume makes) commits the
      // same failed record.
      const later = await context.repo.workflowRunRepo.findById(
        context.workflowId,
        createWorkflowRunId(runId),
      );
      await runInCommitLogRoot(
        { markDirty: context.hook },
        unitOptions(env.store, env.storage, {
          signal: AbortSignal.timeout(60_000),
        }),
        () => context.repo.workflowRunRepo.save(context.workflowId, later!),
      );
      assertEquals(
        (await storedRun(env, context, runId))?.getJob("main")?.getStep("a")
          ?.status,
        "failed",
      );
    });
  });
}

Deno.test("v3 run staging: without onRefused, a refused data partition commits no run record", async () => {
  await withV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const context = await runContext(env, "plain", type, definition, [
      writeStep("a"),
    ]);
    await assertRejects(
      () =>
        runWorkflow(env, context, drain, {
          sink: refusingModels(env, "expect-failed"),
        }),
      PartitionsRefusedError,
    );
    const [runId] = await context.repo.workflowRunRepo.listRunIdsForWorkflow(
      context.workflowId,
    );
    assertEquals(await committedRecord(env, context, runId), undefined);
  });
});
