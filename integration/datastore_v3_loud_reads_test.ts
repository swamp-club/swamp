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
 * Loud reads (swamp-club#3617): a record the v3 read model could not
 * materialise, because a chunk its content names is missing, fails a read
 * of its content with `UnreadableRecordError` instead of reading as absent.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { Data } from "../src/domain/data/mod.ts";
import {
  UNREADABLE_RECORD_CODE,
  UnreadableRecordError,
} from "../src/domain/datastore_v3/read_model.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createDataGetDeps, dataGet } from "../src/libswamp/data/get.ts";
import { createModelOutputDataDeps } from "../src/libswamp/models/output_data.ts";
import { collect } from "../src/libswamp/testing.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { buildErrorJson } from "../src/presentation/output/error_output.ts";
import {
  createServeCtx,
  errorFrame,
  saveModel,
  sendRequest,
  type ServeRepo,
} from "./serve_request_harness.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import {
  createDefinitionId,
  Definition,
} from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowHistoryGetDeps } from "../src/libswamp/workflows/history_get.ts";
import { createModelEvaluateDeps } from "../src/libswamp/models/evaluate.ts";
import { createModelValidateDeps } from "../src/libswamp/models/validate.ts";
import { createModelOutputLogsDeps } from "../src/libswamp/models/output_logs.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
import { runCli, runCliRejecting, UNSET_ENV } from "./usecase_sync_fixtures.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { findDefinitionByIdOrName } from "../src/domain/models/model_lookup.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { UserError } from "../src/domain/errors.ts";
import { createWorkflowHistoryLogsDeps } from "../src/libswamp/workflows/history_logs.ts";
import { createModelOutputGetDeps } from "../src/libswamp/models/output_get.ts";
import { createModelMethodHistoryLogsDeps } from "../src/libswamp/models/method_history_logs.ts";
import { captureUnreadableWarnings } from "../src/infrastructure/persistence/unreadable_records_test_helpers.ts";

await initializeLogging({});

/** Content past the inline limit, so its commit names chunks. */
const CONTENT = new Uint8Array(40 * 1024).map((_, i) => i % 251);

/** A JSON resource's content past the inline limit, read as attributes. */
const JSON_CONTENT = new TextEncoder().encode(
  JSON.stringify({ x: "y".repeat(40 * 1024) }),
);

type Repos = Parameters<Parameters<typeof withV3RowRepos>[1]>[0];

/**
 * A commits a model with a binary data item, `big`, and a JSON resource,
 * `main` of spec `state`, whose contents are chunked, then every chunk is
 * removed from the datastore: a fresh checkout cannot materialise either.
 */
async function commitThenLoseChunks(
  repos: Repos,
  datastorePath: string,
) {
  const { model } = await runInRootUnitOfWork(
    repos.a.repoContext,
    { flush: undefined },
    async () => {
      const model = await saveModel(repos.serveRepo, "m1");
      await repos.a.repoContext.unifiedDataRepo.save(
        repos.modelType,
        model.id,
        Data.create({
          name: "big",
          contentType: "application/octet-stream",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", modelName: model.name },
          ownerDefinition: {
            ownerType: "model-method",
            ownerRef: `${repos.modelType.normalized}:${model.id}`,
          },
        }),
        CONTENT,
      );
      await repos.a.repoContext.unifiedDataRepo.save(
        repos.modelType,
        model.id,
        Data.create({
          name: "main",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", modelName: model.name, specName: "state" },
          ownerDefinition: {
            ownerType: "model-method",
            ownerRef: `${repos.modelType.normalized}:${model.id}`,
          },
        }),
        JSON_CONTENT,
      );
      return { model };
    },
  );
  let removed = 0;
  for await (
    const entry of walk(join(datastorePath, "_blobs"), { includeDirs: false })
  ) {
    await Deno.remove(entry.path);
    removed++;
  }
  assert(removed > 0, "the data's content names chunks");
  // Definitions live in each checkout, not the datastore: B has its own copy.
  await new YamlDefinitionRepository(repos.repoB).save(repos.modelType, model);
  return model;
}

/** `dataGet` of the big item in `repoDir`, with its content. */
async function dataGetBig(repoDir: string, repos: Repos, modelId: string) {
  const reader = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "json",
  });
  const deps = createDataGetDeps(
    reader.repoDir,
    reader.datastoreResolver,
    reader.repoContext.unifiedDataRepo,
    reader.repoContext.workflowRepo,
  );
  return {
    reader,
    events: () =>
      collect(dataGet(createLibSwampContext(), deps, {
        modelIdOrName: modelId,
        dataName: "big",
        includeContent: true,
        repoDir: reader.repoDir,
      })),
    modelType: repos.modelType,
  };
}

Deno.test("v3 loud reads: data get of a record a fresh checkout could not materialise fails with its code, and the context hydrates nothing", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await commitThenLoseChunks(repos, datastorePath);
    const { reader, events } = await dataGetBig(repos.repoB, repos, model.id);

    // On v3 there is nothing to hydrate from; the lookup is what is wired.
    assertEquals(reader.repoContext.hydrateFile, undefined);
    assert(reader.repoContext.unreadableContent !== undefined);

    const error = await assertRejects(events);
    assertInstanceOf(error, UnreadableRecordError);
    assertEquals(error.code, UNREADABLE_RECORD_CODE);
    assertEquals(error.record.reason, "missing");
    // --json renders the code beside the message.
    assertEquals(buildErrorJson(error).code, UNREADABLE_RECORD_CODE);

    // Model output data reads the same content through its own repository.
    const outputDeps = createModelOutputDataDeps(
      reader.repoDir,
      reader.datastoreResolver,
      undefined,
      undefined,
      reader.repoContext.unreadableContent,
    );
    await assertRejects(
      () => outputDeps.getContent(repos.modelType, model.id, "big"),
      UnreadableRecordError,
    );
  });
});

Deno.test("v3 loud reads: a repository spelling the checkout differently from its context still fails loudly", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await commitThenLoseChunks(repos, datastorePath);
    const link = `${repos.repoB}-link`;
    await Deno.symlink(repos.repoB, link, { type: "dir" });
    try {
      // The context, and so its lookup, spells the checkout through the
      // link; the repository spells it by its real path, so the content path
      // it misses is not under the lookup's checkout as written and only the
      // canonical-path fallback finds the record (ADV-64).
      const reader = await requireInitializedRepoReadOnly({
        repoDir: link,
        outputMode: "json",
      });
      assertEquals(reader.repoDir, link);
      const catalogStore = new CatalogStore(":memory:");
      try {
        const repo = new FileSystemUnifiedDataRepository(
          repos.repoB,
          swampPath(repos.repoB, SWAMP_SUBDIRS.data),
          catalogStore,
          undefined,
          undefined,
          SOLO_NAMESPACE,
          false,
          undefined,
          undefined,
          reader.repoContext.unreadableContent,
        );
        const error = await assertRejects(() =>
          repo.getContent(repos.modelType, model.id, "big", 1)
        );
        assertInstanceOf(error, UnreadableRecordError);
        assertEquals(error.code, UNREADABLE_RECORD_CODE);
      } finally {
        catalogStore.close();
      }
    } finally {
      await Deno.remove(link);
    }
  });
});

Deno.test("v3 loud reads: the checkout that wrote the record still reads it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await commitThenLoseChunks(repos, datastorePath);
    const content = await repos.a.repoContext.unifiedDataRepo.getContent(
      repos.modelType,
      model.id,
      "big",
    );
    assertEquals(content, CONTENT);
  });
});

/** B's read-only context, after A committed the data and lost its chunks. */
async function readerAfterLoss(repos: Repos, datastorePath: string) {
  const model = await commitThenLoseChunks(repos, datastorePath);
  const reader = await requireInitializedRepoReadOnly({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  return { model, reader };
}

/** Asserts `error` is the unreadable-record error, with its code. */
function assertUnreadable(error: unknown): void {
  assertInstanceOf(error, UnreadableRecordError);
  assertEquals(error.code, UNREADABLE_RECORD_CODE);
}

/** A workflow whose one step runs `modelName`'s noop with `inputs`. */
function workflowWithInputs(
  modelName: string,
  inputs: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name: `flow-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "noop",
            task: StepTask.modelMethod(modelName, "noop", inputs),
          }),
        ],
      }),
    ],
  });
}

/**
 * Asserts an expression's evaluation failed on the unreadable record: the
 * expression error names it, and carries the record's error, with its code,
 * as its cause.
 */
function assertExpressionUnreadable(error: unknown): void {
  assertInstanceOf(error, Error);
  assertStringIncludes(error.message, "cannot be read");
  assertUnreadable(error.cause);
}

Deno.test("v3 loud reads: a workflow step input reading the model map's resource attributes of an unreadable record fails the run naming it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await commitThenLoseChunks(repos, datastorePath);
    const workflow = workflowWithInputs(model.name, {
      x: `\${{ model.${model.name}.resource.state.main.attributes.x }}`,
    });
    await new YamlWorkflowRepository(repos.repoB).save(workflow);
    await closeV3Datastores();
    // The step fails, so the command exits non-zero.
    await assertRejects(
      () =>
        withMockedEnv(UNSET_ENV, () =>
          runCli({
            args: [
              "workflow",
              "run",
              workflow.name,
              "--repo-dir",
              repos.repoB,
              "--json",
            ],
          })),
      Error,
      "set a failing exit code",
    );
    const reader = await requireInitializedRepoReadOnly({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    const run = await reader.repoContext.workflowRunRepo
      .findLatestByWorkflowId(workflow.id);
    assert(run !== null, "the run was recorded");
    assertEquals(run.status, "failed");
    const step = run.jobs[0].steps[0];
    assertEquals(step.status, "failed");
    assertStringIncludes(step.error ?? "", "/main/1/raw cannot be read");
  });
});

Deno.test("v3 loud reads: data query of an unreadable record fails with its code, whether the predicate reads attributes or not", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    // As `swamp data query` and the data.query expression ask it.
    const queryService = reader.repoContext.dataQueryService;
    for (
      const predicate of [
        `modelName == "${model.name}" && attributes.x == "y"`,
        `modelName == "${model.name}" && name == "main"`,
      ]
    ) {
      assertUnreadable(
        await assertRejects(() => queryService.query(predicate)),
      );
    }
    // A predicate matching no unreadable record still answers.
    assertEquals(
      await queryService.query(`modelName == "no-such-model"`),
      [],
    );
  });
});

Deno.test("v3 loud reads: model output logs reads through the context's lookup", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    const deps = createModelOutputLogsDeps(
      reader.repoDir,
      reader.datastoreResolver,
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() =>
        deps.getContent(repos.modelType, model.id, "big")
      ),
    );
  });
});

Deno.test("v3 loud reads: model evaluate of a data.latest expression reading an unreadable record fails it with the record's error", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    const deps = createModelEvaluateDeps(
      reader.repoDir,
      reader.datastoreResolver,
      undefined,
      undefined,
      undefined,
      undefined,
      reader.repoContext.unreadableContent,
    );
    // Saved in B and read back, as `model evaluate` reads it: only an
    // expression the definition's source authored evaluates.
    await new YamlDefinitionRepository(repos.repoB).save(
      repos.modelType,
      Definition.create({
        name: "reader",
        globalArguments: {
          x: `\${{ data.latest("${model.name}", "main").attributes.x }}`,
        },
      }),
    );
    const found = await deps.lookupDefinition("reader");
    assert(found !== null, "the definition is found");
    const result = await deps.evaluateDefinition(
      found.definition,
      found.type,
      new RunSensitiveValues(),
    );
    // The expression fails, as any failed expression does, with the
    // record's error as its cause; without the lookup it read empty
    // attributes.
    const failed = [...(result.failedExpressions?.values() ?? [])];
    assertEquals(failed.length, 1);
    assertExpressionUnreadable(failed[0]);
  });
});

Deno.test("v3 loud reads: model validate's checks read through the context's lookup", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    const deps = createModelValidateDeps(
      reader.repoDir,
      undefined,
      reader.datastoreResolver,
      undefined,
      undefined,
      undefined,
      undefined,
      reader.repoContext.unreadableContent,
    );
    const modelDef = {
      ...modelRegistry.get(repos.modelType)!,
      checks: {
        "reads-big": {
          description: "reads the unreadable record",
          execute: async (context: {
            dataRepository: {
              getContent(
                type: ModelType,
                modelId: string,
                name: string,
              ): Promise<Uint8Array | null>;
            };
          }) => {
            await context.dataRepository.getContent(
              repos.modelType,
              model.id,
              "big",
            );
            return { pass: true };
          },
        },
      },
    };
    const { results } = await deps.validateModel(
      model,
      modelDef,
      repos.modelType,
    );
    const check = results.find((r) => r.name === "Check: reads-big");
    assert(check !== undefined, "the check ran");
    assertEquals(check.passed, false);
    assert(
      check.error?.includes(`The record `) &&
        check.error.includes("cannot be read"),
      `the check failed on the unreadable record: ${check.error}`,
    );
  });
});

Deno.test("v3 loud reads: workflow history outputs of a step whose resource is unreadable fail with its code", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    const workflow = workflowWithInputs(model.name, {});
    const created = WorkflowRun.create(workflow).toData();
    const run = WorkflowRun.fromData({
      ...created,
      status: "succeeded",
      jobs: created.jobs.map((job) => ({
        ...job,
        status: "succeeded",
        steps: job.steps.map((step) => ({
          ...step,
          status: "succeeded",
          output: {
            type: "model_method",
            resources: {
              state: {
                main: {
                  name: "main",
                  version: 1,
                  modelType: repos.modelType.normalized,
                  modelId: model.id,
                  contentType: "application/json",
                },
              },
            },
          },
        })),
      })),
    });
    const deps = createWorkflowHistoryGetDeps(
      reader.repoDir,
      reader.datastoreResolver,
      reader.repoContext.workflowRepo,
      undefined,
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(await assertRejects(() => deps.resolveStepOutputs(run)));
  });
});

Deno.test("v3 loud reads: serve's data get of an unreadable record answers with an error naming it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { model, reader } = await readerAfterLoss(repos, datastorePath);
    const serveRepo: ServeRepo = {
      repoDir: reader.repoDir,
      repoContext: reader.repoContext,
      datastoreConfig: repos.a.datastoreConfig,
      datastoreResolver: reader.datastoreResolver as ServeRepo[
        "datastoreResolver"
      ],
      modelType: repos.modelType,
    };
    const frames = await sendRequest(createServeCtx(serveRepo), {
      type: "data.get",
      id: crypto.randomUUID(),
      payload: { modelIdOrName: model.name, dataName: "main" },
    });
    const error = errorFrame(frames);
    assert(error !== undefined, `an error frame: ${JSON.stringify(frames)}`);
    assert(
      error.error?.message.includes("cannot be read"),
      `the error names the unreadable record: ${JSON.stringify(error)}`,
    );
  });
});

/**
 * A commits, under one workflow, a run record small enough to stay inline
 * and one past the inline limit; an auto-definition and an evaluated
 * definition past it too, then every chunk is removed from the datastore: a
 * fresh checkout materialises only the small run.
 */
async function commitRecordsThenLoseChunks(
  repos: Repos,
  datastorePath: string,
) {
  const workflow = workflowWithInputs("absent", {});
  const failedRun = (error: string) => {
    const created = WorkflowRun.create(workflow).toData();
    return WorkflowRun.fromData({
      ...created,
      status: "failed",
      jobs: created.jobs.map((job) => ({
        ...job,
        status: "failed",
        steps: job.steps.map((step) => ({ ...step, status: "failed", error })),
      })),
    });
  };
  const smallRun = failedRun("small");
  const bigRun = failedRun("e".repeat(40 * 1024));
  // A workflow whose only run is past the limit: a fresh checkout has no
  // directory for it at all.
  const lonelyWorkflow = workflowWithInputs("absent-too", {});
  const lonelyCreated = WorkflowRun.create(lonelyWorkflow).toData();
  const lonelyRun = WorkflowRun.fromData({
    ...lonelyCreated,
    status: "failed",
    jobs: lonelyCreated.jobs.map((job) => ({
      ...job,
      status: "failed",
      steps: job.steps.map((step) => ({
        ...step,
        status: "failed",
        error: "l".repeat(40 * 1024),
      })),
    })),
  });
  // A definition's two outputs: the earlier small, the later past the limit.
  const outputDefinitionId = createDefinitionId(crypto.randomUUID());
  const outputOf = (startedAt: string, message: string) => {
    const output = ModelOutput.create({
      definitionId: outputDefinitionId,
      methodName: "noop",
      startedAt: new Date(startedAt),
      provenance: {
        definitionHash: "h",
        modelVersion: "2026.01.01.1",
        triggeredBy: "manual",
      },
    });
    output.markRunning();
    output.markFailed({ message });
    return output;
  };
  const smallOutput = outputOf("2026-01-01T00:00:00Z", "small");
  const bigOutput = outputOf("2026-01-02T00:00:00Z", "o".repeat(40 * 1024));
  // An evaluated workflow past the limit, as `workflow evaluate` saves it.
  const evaluatedWorkflowName = `evaluated-${crypto.randomUUID().slice(0, 8)}`;
  const evaluatedWorkflow = Workflow.fromData({
    ...workflowWithInputs("absent", { pad: "w".repeat(40 * 1024) }).toData(),
    name: evaluatedWorkflowName,
  });
  const autoName = `auto-${crypto.randomUUID().slice(0, 8)}`;
  const evaluatedName = `evaluated-${crypto.randomUUID().slice(0, 8)}`;
  const context = repos.a.repoContext;
  await runInRootUnitOfWork(context, { flush: undefined }, async () => {
    await context.workflowRunRepo.save(workflow.id, smallRun);
    await context.workflowRunRepo.save(workflow.id, bigRun);
    await context.workflowRunRepo.save(lonelyWorkflow.id, lonelyRun);
    await context.outputRepo.save(repos.modelType, "noop", smallOutput);
    await context.outputRepo.save(repos.modelType, "noop", bigOutput);
    await new YamlEvaluatedWorkflowRepository(
      repos.repoA,
      repos.a.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
      context.markDirty,
    ).save(evaluatedWorkflow, undefined);
    // As `model method run` saves the definition it creates for a type.
    await new YamlDefinitionRepository(
      repos.repoA,
      context.eventBus,
      context.autoDefinitionsDir,
      false,
      context.markDirty,
    ).save(
      repos.modelType,
      Definition.create({
        name: autoName,
        globalArguments: { x: "y".repeat(40 * 1024) },
      }),
    );
    await context.evaluatedDefinitionRepo.save(
      repos.modelType,
      Definition.create({
        name: evaluatedName,
        globalArguments: { x: "z".repeat(40 * 1024) },
      }),
      undefined,
    );
  });
  let removed = 0;
  for await (
    const entry of walk(join(datastorePath, "_blobs"), { includeDirs: false })
  ) {
    await Deno.remove(entry.path);
    removed++;
  }
  assert(removed > 0, "the records' contents name chunks");
  const reader = await requireInitializedRepoReadOnly({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  return {
    workflow,
    smallRun,
    bigRun,
    lonelyWorkflow,
    lonelyRun,
    outputDefinitionId,
    smallOutput,
    bigOutput,
    evaluatedWorkflowName,
    autoName,
    evaluatedName,
    reader,
  };
}

Deno.test("v3 loud reads: a run record a fresh checkout could not materialise fails its lookups with its code, by workflow and by run id", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { workflow, smallRun, bigRun, reader } =
      await commitRecordsThenLoseChunks(repos, datastorePath);
    const runRepo = reader.repoContext.workflowRunRepo;
    // The inline run is there, so only the chunked one is unreadable.
    assertEquals(
      (await runRepo.findById(workflow.id, smallRun.id))?.id,
      smallRun.id,
    );
    assertUnreadable(
      await assertRejects(() => runRepo.findById(workflow.id, bigRun.id)),
    );
    // `workflow history get <run id>` finds a run without its workflow.
    assertUnreadable(
      await assertRejects(() => runRepo.findGlobalById(bigRun.id)),
    );
    // A run that was never recorded is still simply not found.
    const unknown = crypto.randomUUID() as typeof bigRun.id;
    assertEquals(await runRepo.findById(workflow.id, unknown), null);
    assertEquals(await runRepo.findGlobalById(unknown), null);

    // History get's own run repository reads through the context's lookup.
    const historyDeps = createWorkflowHistoryGetDeps(
      reader.repoDir,
      reader.datastoreResolver,
      reader.repoContext.workflowRepo,
      undefined,
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() => historyDeps.matchRunByPartialId(bigRun.id)),
    );
    // So does data get's, built from the context's data repository as the
    // CLI builds it.
    const dataGetDeps = createDataGetDeps(
      reader.repoDir,
      reader.datastoreResolver,
      reader.repoContext.unifiedDataRepo,
      reader.repoContext.workflowRepo,
    );
    assertUnreadable(
      await assertRejects(() =>
        dataGetDeps.findWorkflowRun(workflow.id, bigRun.id)
      ),
    );
  });
});

Deno.test("v3 loud reads: an auto-definition a fresh checkout could not materialise fails a lookup by name with its code", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { autoName, reader } = await commitRecordsThenLoseChunks(
      repos,
      datastorePath,
    );
    const definitionRepo = reader.repoContext.definitionRepo;
    // As `model get <name>` looks it up.
    assertUnreadable(
      await assertRejects(() =>
        findDefinitionByIdOrName(definitionRepo, autoName)
      ),
    );
    assertUnreadable(
      await assertRejects(() =>
        definitionRepo.findByName(repos.modelType, autoName)
      ),
    );
    // A name no definition has is still simply not found.
    assertEquals(
      await findDefinitionByIdOrName(definitionRepo, "no-such-definition"),
      null,
    );
  });
});

Deno.test("v3 loud reads: CLI data versions and data rename of an auto-definition a fresh checkout could not materialise fail naming it, not as no such model (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { autoName } = await commitRecordsThenLoseChunks(
      repos,
      datastorePath,
    );
    await closeV3Datastores();
    const versions = await withMockedEnv(UNSET_ENV, () =>
      runCliRejecting({
        args: [
          "data",
          "versions",
          autoName,
          "anything",
          "--repo-dir",
          repos.repoB,
          "--json",
        ],
      }));
    assertUnreadable(versions);
    // Rename's lookup before it takes the model's lock already reads through
    // the context's definition repository; the rename's own lookup now does
    // too, so the record's error is what it fails with either way.
    const rename = await withMockedEnv(UNSET_ENV, () =>
      runCliRejecting({
        args: [
          "data",
          "rename",
          autoName,
          "old",
          "new",
          "--repo-dir",
          repos.repoB,
          "--json",
        ],
      }));
    assertUnreadable(rename);
    assertStringIncludes((rename as Error).message, autoName);
  });
});

Deno.test("v3 loud reads: an evaluated definition a fresh checkout could not materialise fails its lookup with its code", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { evaluatedName, reader } = await commitRecordsThenLoseChunks(
      repos,
      datastorePath,
    );
    // As `model method run --last-evaluated` loads it.
    assertUnreadable(
      await assertRejects(() =>
        reader.repoContext.evaluatedDefinitionRepo.findByNameWithProvenance(
          repos.modelType,
          evaluatedName,
        )
      ),
    );
    assertEquals(
      await reader.repoContext.evaluatedDefinitionRepo.findByName(
        repos.modelType,
        "no-such-definition",
      ),
      null,
    );
  });
});

Deno.test("v3 loud reads: a run whose workflow has no other run fails its lookup by run id; run listings keep the readable runs and warn naming the unreadable ones (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { workflow, smallRun, bigRun, lonelyWorkflow, lonelyRun, reader } =
      await commitRecordsThenLoseChunks(repos, datastorePath);
    const runRepo = reader.repoContext.workflowRunRepo;
    assertUnreadable(
      await assertRejects(() => runRepo.findGlobalById(lonelyRun.id)),
    );
    // `workflow history logs <run id>` builds its own run repository.
    const logsDeps = createWorkflowHistoryLogsDeps(
      reader.repoDir,
      reader.datastoreResolver,
      reader.repoContext.workflowRepo,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() => logsDeps.matchRunByPartialId(lonelyRun.id)),
    );

    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await runRepo.findAllByWorkflowId(workflow.id)).map((r) => r.id),
        [smallRun.id],
      );
      assertEquals(
        (await runRepo.findAllGlobal()).map((r) => r.run.id),
        [smallRun.id],
      );
    });
    assertEquals(warnings.length, 2, warnings.join("\n"));
    assertStringIncludes(warnings[0], bigRun.id);
    assertStringIncludes(warnings[1], lonelyRun.id);
    assert(!warnings[1].includes(bigRun.id), warnings[1]);
    assert(lonelyWorkflow.id !== workflow.id);
  });
});

Deno.test("v3 loud reads: an output record a fresh checkout could not materialise fails the lookup of its definition's latest output, and output listings warn naming it (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { outputDefinitionId, smallOutput, bigOutput, reader } =
      await commitRecordsThenLoseChunks(repos, datastorePath);
    const outputRepo = reader.repoContext.outputRepo;
    // The later output is the unreadable one: the earlier is not the latest.
    assertUnreadable(
      await assertRejects(() =>
        outputRepo.findLatestByDefinition(repos.modelType, outputDefinitionId)
      ),
    );
    // A lookup by output id cannot tell which unreadable record is it, nor
    // its id from a mistyped one: either is not found, naming the record
    // that may be it, without the unreadable-record code.
    for (
      const id of [bigOutput.id, crypto.randomUUID() as typeof bigOutput.id]
    ) {
      const byId = await assertRejects(
        () => outputRepo.findById(repos.modelType, "noop", id),
        UserError,
      );
      assertEquals(byId.code, "not_found");
      assertStringIncludes(byId.message, `${id} was not found`);
      assertStringIncludes(byId.message, outputDefinitionId);
    }
    assertEquals(
      (await outputRepo.findById(repos.modelType, "noop", smallOutput.id))?.id,
      smallOutput.id,
    );
    // `model output get <model>` and `model method history logs <model>`
    // build their own output repositories.
    const getDeps = await createModelOutputGetDeps(
      reader.repoDir,
      reader.datastoreResolver,
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() =>
        getDeps.findLatestOutput(repos.modelType, outputDefinitionId)
      ),
    );
    const logsDeps = await createModelMethodHistoryLogsDeps(
      reader.repoDir,
      reader.datastoreResolver,
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() =>
        logsDeps.findLatestOutput(repos.modelType, outputDefinitionId)
      ),
    );
    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await getDeps.findOutputsByDefinition(
          repos.modelType,
          outputDefinitionId,
        )).map((o) => o.id),
        [smallOutput.id],
      );
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], outputDefinitionId);
  });
});

Deno.test("v3 loud reads: an evaluated workflow a fresh checkout could not materialise fails --last-evaluated's lookup with its code (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { evaluatedWorkflowName, reader } = await commitRecordsThenLoseChunks(
      repos,
      datastorePath,
    );
    const repo = new YamlEvaluatedWorkflowRepository(
      reader.repoDir,
      reader.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
      undefined,
      reader.repoContext.unreadableContent,
    );
    assertUnreadable(
      await assertRejects(() =>
        repo.findByNameWithProvenance(evaluatedWorkflowName)
      ),
    );
    assertEquals(await repo.findByNameWithProvenance("no-such-workflow"), null);
  });
});
