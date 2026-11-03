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
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
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
  appendNowFrom,
  checkpointFrom,
  type CommitSink,
  createCommitLogUnitOfWork,
} from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import type { RunCheckpointer } from "../src/domain/workflows/run_checkpointer.ts";
import { reconcileRefusedRuns } from "../src/infrastructure/datastore_v3/refused_run_records.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import {
  modelPartition,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { ServeRunWriteFence } from "../src/serve/run_write_fence.ts";
import { WorkflowRunCheckpointer } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";
import type { CommitLogEngine } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
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
  withAuditedV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

function isLocalOnly(rel: string): boolean {
  return rel.endsWith(".runs-index.json") || rel.endsWith(".runs-index.lock") ||
    rel.endsWith(".log");
}

async function catchUp(env: V3Env): Promise<void> {
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
}

async function runRecords(root: string): Promise<Map<string, string>> {
  return new Map(
    [...await readTree(join(root, "workflow-runs"))].filter(([rel]) =>
      !isLocalOnly(rel)
    ),
  );
}

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
    await withAuditedV3Env(async (env) => {
      const writer = new RunWriter(env, namespace);
      const workflow = plainWorkflow();
      const wfId = workflow.id;

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

      await writer.run(() => writer.repo.save(wfId, run));
      assertEquals((await writer.commitsOf(wfId, run.id)).length, 2);
      await writer.assertMatches();

      const cancelled = WorkflowRun.create(workflow);
      cancelled.start();
      cancelled.endAsCancelled("test");
      await writer.run(() => writer.repo.save(wfId, cancelled));
      const runsDir = join(writer.root, "workflow-runs", wfId);
      const truncated = WorkflowRun.create(workflow);
      await writer.run(() => writer.repo.save(wfId, truncated));
      await Deno.writeTextFile(writer.repo.getPath(wfId, truncated.id), "");
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

const WriteArgs = z.object({ text: z.string() });

interface RunContext {
  readonly dir: string;
  readonly hook: ReturnType<typeof contextHook>;
  readonly repo: RepositoryContext;
  readonly workflowId: WorkflowId;
}

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

async function runWorkflow(
  env: V3Env,
  context: RunContext,
  consume: (stream: AsyncIterable<{ kind: string }>) => Promise<void>,
  options: {
    sink?: CommitSink;
    onRefused?: CommitLogRootOptions<unknown>["onRefused"];
    abort?: AbortController;
    checkpoints?: boolean | RunCheckpointer;
  } = {},
): Promise<string> {
  const unit = unitOptions(options.sink ?? env.store, env.storage, {
    signal: AbortSignal.timeout(60_000),
  });
  const deps = await createWorkflowRunDeps(
    context.dir,
    context.repo,
    {
      type: "filesystem",
      path: join(context.dir, ".swamp"),
    },
    undefined,
    undefined,
    options.checkpoints === true
      ? { runCheckpointer: unitCheckpoints }
      : options.checkpoints
      ? { runCheckpointer: options.checkpoints }
      : {},
  );
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

/**
 * Checkpoints the units open around each save, as a v3 context's
 * checkpointer does; a refusal is left for the root to settle.
 */
const unitCheckpoints: RunCheckpointer = {
  async checkpoint() {
    const unit = currentUnitOfWork();
    if (unit === undefined) return;
    try {
      await checkpointFrom(unit);
    } catch (error) {
      if (!(error instanceof PartitionsRefusedError)) throw error;
    }
  },
};

async function drain(stream: AsyncIterable<{ kind: string }>): Promise<void> {
  for await (const _event of stream) {
    // consume every event
  }
}

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
  await withAuditedV3Env(async (env) => {
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
  await withAuditedV3Env(async (env) => {
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
    // result() stops at completed, before the executor's last save, so local
    // and committed records are the one saved while it ran; the CLI and serve
    // drain the stream and end with their final record
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

Deno.test("v3 run staging: with checkpoints, a run whose consumer stops before an outcome keeps the record its last checkpoint committed (swamp-club#3587)", async () => {
  await withAuditedV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const stopped = await runContext(env, "stopped", type, definition, [
      writeStep("a"),
    ]);
    const runId = await runWorkflow(env, stopped, async (stream) => {
      for await (const event of stream) {
        if (event.kind === "started") break;
      }
    }, { checkpoints: true });
    // Committed up to the last checkpoint; only later writes are discarded.
    // The run stays running, as v2 leaves its file, for the dead-owner
    // settling to find.
    assertEquals((await storedRun(env, stopped, runId))?.status, "running");
  });
});

/** The engine a v3 context gives WorkflowRunCheckpointer, over this harness's units. */
const unitEngine: CommitLogEngine = {
  openUnit: () => {
    throw new Error("not used");
  },
  hasOpenUnit: () => currentUnitOfWork() !== undefined,
  async checkpointOpenUnit() {
    const unit = currentUnitOfWork();
    if (unit === undefined) return "no-unit";
    try {
      return await checkpointFrom(unit) ? "committed" : "no-unit";
    } catch (error) {
      if (error instanceof PartitionsRefusedError) return "refused";
      throw error;
    }
  },
  committedBeforeThrowing: () => false,
  runRoot: () => Promise.reject(new Error("not used")),
};

Deno.test("v3 run staging: a run stopped as its second step starts, inside the checkpoint interval, keeps that step's start in the committed record (swamp-club#4295)", async () => {
  await withAuditedV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const second = Step.create({
      name: "b",
      task: StepTask.model("writer", "write", { text: "b" }),
      dependsOn: [{ step: "a", condition: TriggerCondition.succeeded() }],
    });
    const context = await runContext(env, "cut", type, definition, [
      writeStep("a"),
      second,
    ]);
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog: unitEngine },
      { intervalMs: 60_000 },
    );
    const runId = await runWorkflow(env, context, async (stream) => {
      for await (const event of stream) {
        const started = event as { kind: string; stepId?: string };
        if (started.kind === "step_started" && started.stepId === "b") break;
      }
    }, { checkpoints: checkpointer });
    await checkpointer.close();

    const run = await storedRun(env, context, runId);
    const steps = run?.jobs[0].steps.map((step) => [
      step.stepName,
      step.status,
    ]);
    assertEquals(steps, [["a", "succeeded"], ["b", "running"]]);
    assertEquals(run?.unknownStepsIfOrphaned([]), ["b"]);
  });
});

const journalEngine: CommitLogEngine = {
  ...unitEngine,
  async appendToOpenUnit(changes) {
    const unit = currentUnitOfWork();
    if (unit === undefined) return "no-unit";
    return await appendNowFrom(unit, changes) ?? "no-unit";
  },
};

Deno.test("v3 run staging: a run past the inline limit stopped as its second step starts recovers both started steps as unknown from its journal, though no whole record committed at either start (swamp-club#4319)", async () => {
  await withAuditedV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const after = (name: string) => [{
      step: name,
      condition: TriggerCondition.succeeded(),
    }];
    // steps that wait behind b put the record past the 8 KiB inline limit
    const padding = Array.from({ length: 150 }, (_, i) =>
      Step.create({
        name: `padding-step-${String(i).padStart(4, "0")}-of-the-run`,
        task: StepTask.model("writer", "write", { text: "p" }),
        dependsOn: after("b"),
      }));
    const context = await runContext(env, "journal", type, definition, [
      writeStep("a"),
      Step.create({
        name: "b",
        task: StepTask.model("writer", "write", { text: "b" }),
        dependsOn: after("a"),
      }),
      ...padding,
    ]);
    const checkpointer = new WorkflowRunCheckpointer(
      {
        commitLog: journalEngine,
        workflowRunRepo: context.repo.workflowRunRepo,
      },
      { intervalMs: 60_000 },
    );
    const runId = await runWorkflow(env, context, async (stream) => {
      for await (const event of stream) {
        const started = event as { kind: string; stepId?: string };
        if (started.kind === "step_started" && started.stepId === "b") break;
      }
    }, { checkpoints: checkpointer });
    await checkpointer.close();

    const run = await storedRun(env, context, runId);
    assert(run !== null);
    const recordBytes = (await Deno.stat(
      join(
        env.cacheRoot(""),
        "workflow-runs",
        context.workflowId,
        `workflow-run-${runId}.yaml`,
      ),
    )).size;
    assert(recordBytes > 8 * 1024, `the record is ${recordBytes} bytes`);
    assertEquals(run.status, "running");
    const recorded = new Map(
      run.jobs[0].steps.map((step) => [step.stepName, step.status]),
    );
    assertEquals(recorded.get("b"), "pending");

    const starts = await new YamlWorkflowRunRepository(
      env.repoDir,
      undefined,
      join(env.cacheRoot(""), "workflow-runs"),
    ).findStepStarts(context.workflowId, createWorkflowRunId(runId));
    assertEquals(
      starts.map((start) => start.stepName).sort(),
      ["a", "b"],
    );
    run.interruptOrphaned("owner_process_dead", starts);
    const recovered = new Map(
      run.jobs[0].steps.map((step) => [step.stepName, step.status]),
    );
    assertEquals(recovered.get("a"), "unknown");
    assertEquals(recovered.get("b"), "unknown");
    assertEquals(recovered.get(padding[0].name), "pending");
  });
});

function refusingModels(
  env: V3Env,
  reason: "version-live" | "expect-failed",
): CommitSink {
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
    await withAuditedV3Env(async (env) => {
      const type = registerWriter();
      const definition = Definition.create({ name: "writer" });
      const steps = [writeStep("a")];
      const sink = refusingModels(env, reason);

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
      assert(error.refusals[0].versions.length > 0);
      const ids = await context.repo.workflowRunRepo.listRunIdsForWorkflow(
        context.workflowId,
      );
      runId ??= ids[0];

      const stored = await storedRun(env, context, runId);
      assertEquals(stored?.status, "failed");
      const step = stored!.getJob("main")!.getStep("a")!;
      assertEquals(step.status, "failed");
      assert(step.error?.includes("refused"));
      assertEquals(
        await committedRecord(env, context, runId),
        await localRecord(context, runId),
      );

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
  await withAuditedV3Env(async (env) => {
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

Deno.test("v3 run staging: with checkpoints, a refused data partition keeps only the run record checkpointed before it, which never names the refused data (swamp-club#3587)", async () => {
  await withAuditedV3Env(async (env) => {
    const type = registerWriter();
    const definition = Definition.create({ name: "writer" });
    const context = await runContext(env, "plain", type, definition, [
      writeStep("a"),
    ]);
    await assertRejects(
      () =>
        runWorkflow(env, context, drain, {
          sink: refusingModels(env, "expect-failed"),
          checkpoints: true,
        }),
      PartitionsRefusedError,
    );
    const [runId] = await context.repo.workflowRunRepo.listRunIdsForWorkflow(
      context.workflowId,
    );
    const stored = await storedRun(env, context, runId);
    assertEquals(stored?.status, "running");
    const step = stored?.getJob("main")?.getStep("a");
    assert(step?.status !== "succeeded", "the refused step never succeeds");
    assertEquals(step?.dataArtifacts ?? [], []);
  });
});

// separate repositories and roots, as serve's executor and shutdown have
function takeover(env: V3Env) {
  const executor = new RunWriter(env, "");
  const owner = new RunWriter(env, "");
  const fence = new ServeRunWriteFence();
  const workflow = plainWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  return {
    executor,
    owner,
    fence,
    workflow,
    run,
    inExecutorRoot: (
      fn: () => Promise<void>,
      overrides: { sink?: CommitSink; chunkStore?: ChunkStore } = {},
    ) =>
      runInCommitLogRoot(
        { markDirty: executor.hook },
        unitOptions(overrides.sink ?? env.store, env.storage, {
          signal: AbortSignal.timeout(60_000),
          ...(overrides.chunkStore === undefined
            ? {}
            : { chunkStore: overrides.chunkStore }),
        }),
        fn,
      ),
    shutdown: async () => {
      await fence.close([run.id]);
      await owner.run(async () => {
        const loaded = await owner.repo.findById(
          workflow.id,
          createWorkflowRunId(run.id),
        );
        assert(loaded !== null, "shutdown loads the run");
        loaded.interrupt("server_shutdown");
        await owner.repo.save(workflow.id, loaded);
        fence.takeOver(run.id);
      });
    },
    committedStatus: async () => {
      await executor.assertMatches();
      return (await new YamlWorkflowRunRepository(
        env.repoDir,
        undefined,
        join(env.cacheRoot(""), "workflow-runs"),
      ).findById(workflow.id, createWorkflowRunId(run.id)))?.status;
    },
  };
}

Deno.test("v3 run takeover: a checkpoint that read the record before shutdown wrote it does not commit over the interrupted record (swamp-club#4171)", async () => {
  await withAuditedV3Env(async (env) => {
    const t = takeover(env);
    // The store is held once the record is read, as a slow bucket holds it.
    const read = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const chunkStore = new ChunkStore(env.storage);
    const beginBatch = chunkStore.beginBatch.bind(chunkStore);
    chunkStore.beginBatch = (namespace) => {
      const batch = beginBatch(namespace);
      const commit = batch.commit.bind(batch);
      batch.commit = async (signal) => {
        read.resolve();
        await release.promise;
        await commit(signal);
      };
      return batch;
    };

    const executing = t.inExecutorRoot(async () => {
      await t.executor.repo.save(t.workflow.id, t.run, { fence: t.fence });
      await checkpointFrom(currentUnitOfWork()!);
    }, { chunkStore });
    await read.promise;
    await t.shutdown();
    release.resolve();
    await executing;

    assertEquals(await t.committedStatus(), "interrupted");
    assertEquals(
      (await t.executor.commitsOf(t.workflow.id, t.run.id)).length,
      1,
    );
  });
});

Deno.test("v3 run takeover: a checkpoint that failed before shutdown is not replayed by the executor's end commit (swamp-club#4171)", async () => {
  await withAuditedV3Env(async (env) => {
    const t = takeover(env);
    let failing = true;
    const sink: CommitSink = {
      append: (commit) =>
        failing
          ? Promise.reject(new Error("store briefly unreachable"))
          : env.store.append(commit),
      head: (namespace, key) => env.store.head(namespace, key),
    };
    const checkpointFailed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const executing = t.inExecutorRoot(async () => {
      await t.executor.repo.save(t.workflow.id, t.run, { fence: t.fence });
      await assertRejects(() => checkpointFrom(currentUnitOfWork()!));
      checkpointFailed.resolve();
      await release.promise;
    }, { sink });
    await checkpointFailed.promise;
    failing = false;
    await t.shutdown();
    release.resolve();
    await executing;

    assertEquals(await t.committedStatus(), "interrupted");
    assertEquals(
      (await t.executor.commitsOf(t.workflow.id, t.run.id)).length,
      1,
    );
  });
});

Deno.test("v3 run takeover: a trailing checkpoint that fires after the takeover lands nothing for the run, and the data it carries still commits (swamp-club#4171)", async () => {
  await withAuditedV3Env(async (env) => {
    const t = takeover(env);
    const takenOver = Promise.withResolvers<void>();
    const trailingStarted = Promise.withResolvers<void>();
    const trailingDone = Promise.withResolvers<void>();
    let checkpoints = 0;
    // The timer's checkpoint waits for the takeover, so it always fires after.
    const engine = {
      checkpointOpenUnit: async () => {
        const nth = ++checkpoints;
        if (nth === 2) {
          trailingStarted.resolve();
          await takenOver.promise;
        }
        const unit = currentUnitOfWork();
        const outcome = unit === undefined
          ? "no-unit" as const
          : await checkpointFrom(unit)
          ? "committed" as const
          : "no-unit" as const;
        if (nth === 2) trailingDone.resolve();
        return outcome;
      },
    } as unknown as CommitLogEngine;
    const checkpointer = new WorkflowRunCheckpointer(
      { markDirty: t.executor.hook, commitLog: engine },
      // a clock that stands still makes the second checkpoint arm the timer
      { intervalMs: 1, now: () => 0 },
    );

    const executing = t.inExecutorRoot(async () => {
      await t.executor.repo.save(t.workflow.id, t.run, { fence: t.fence });
      await checkpointer.checkpoint(t.run);
      await t.executor.repo.save(t.workflow.id, t.run, { fence: t.fence });
      // Staged with the save, as a step's data is.
      await (currentUnitOfWork() as unknown as {
        stageOp(change: unknown): Promise<void>;
      }).stageOp({ partition: modelPartition(), op: await savePut("a", 1) });
      await checkpointer.checkpoint(t.run);
      assertEquals(checkpoints, 1, "left to the trailing timer");
      await trailingDone.promise;
      await checkpointer.close();
    });
    await trailingStarted.promise;
    await t.shutdown();
    takenOver.resolve();
    await executing;

    assertEquals(await t.committedStatus(), "interrupted");
    // The first checkpoint's running record, then shutdown's interrupted one.
    assertEquals(
      (await t.executor.commitsOf(t.workflow.id, t.run.id)).length,
      2,
    );
    assertEquals(
      (await env.store.readPartition("", modelPartition(), 1, 10)).length,
      1,
    );
  });
});

Deno.test("v3 run takeover: a run shutdown closed but left alone still commits the final record its executor saved (swamp-club#4171)", async () => {
  await withAuditedV3Env(async (env) => {
    const t = takeover(env);
    await t.inExecutorRoot(async () => {
      t.run.complete();
      await t.executor.repo.save(t.workflow.id, t.run, { fence: t.fence });
      // shutdown closes the fence but leaves an ended run alone
      await t.fence.close([t.run.id]);
    });

    assertEquals(t.fence.isTakenOver(t.run.id), false);
    assertEquals(await t.committedStatus(), t.run.status);
    assert(t.run.status !== "running", "the run's final record is its end");
  });
});
