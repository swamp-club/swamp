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
 * Integration test: `swamp data get` is deprecated in favor of
 * `swamp data query`, and every read names the query that replaces it
 * (swamp-club#2948). Reads through the real data get and data query paths on
 * a temp repo, and checks that each replacement query selects exactly the
 * item data get returned, including when two steps of one run wrote data
 * with the same name.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  createDataGetDeps,
  createLibSwampContext,
  dataGet,
  type DataGetData,
  type DataGetEvent,
  type DataGetInput,
  dataQuery,
  type DataQueryDeps,
  type DataQueryEvent,
  type DataRecord,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import { Data } from "../src/domain/data/data.ts";
import { UserError } from "../src/domain/errors.ts";
import { createModelReferenceResolver } from "../src/domain/models/model_lookup.ts";
import type { GarbageCollectionPolicy } from "../src/domain/data/data_metadata.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createLatestRunResolver } from "../src/domain/workflows/workflow_lookup.ts";
import {
  saveData,
  saveModel,
  saveWorkflowData,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const encode = (value: string) => new TextEncoder().encode(value);

/** Saves `model`'s `result` as written by `jobName`/`stepName` of `run`. */
async function saveStepResult(
  repo: ServeRepo,
  model: Definition,
  run: { id: string; workflowName: string },
  jobName: string,
  stepName: string,
  value: string,
  item: {
    name?: string;
    specName?: string;
    garbageCollection?: GarbageCollectionPolicy;
  } = {},
): Promise<{ id: string; name: string; version: number; data: Data }> {
  const data = Data.create({
    name: item.name ?? "result",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: item.garbageCollection ?? 10,
    tags: {
      type: "resource",
      specName: item.specName ?? "result",
      modelName: model.name,
    },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
      workflowRunId: run.id,
      workflowName: run.workflowName,
      jobName,
      stepName,
    },
  });
  const saved = await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    encode(JSON.stringify(value)),
  );
  return { id: data.id, name: data.name, version: saved.version, data };
}

/**
 * Saves a two-job workflow whose `build/compile` and `verify/check` steps
 * both wrote `result`, and a newer `result` from `build-model` outside it.
 */
async function sharedNameRun(repo: ServeRepo) {
  const buildModel = await saveModel(repo, "build-model");
  const verifyModel = await saveModel(repo, "verify-model");
  const workflow = Workflow.create({
    name: "shared-name",
    jobs: [
      Job.create({
        name: "build",
        steps: [Step.create({
          name: "compile",
          task: StepTask.modelMethod(buildModel.name, "noop"),
        })],
      }),
      Job.create({
        name: "verify",
        steps: [Step.create({
          name: "check",
          task: StepTask.modelMethod(verifyModel.name, "noop"),
        })],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);

  const created = WorkflowRun.create(workflow).toData();
  const runInfo = { id: created.id, workflowName: workflow.name };
  const built = await saveStepResult(
    repo,
    buildModel,
    runInfo,
    "build",
    "compile",
    "built",
  );
  const checked = await saveStepResult(
    repo,
    verifyModel,
    runInfo,
    "verify",
    "check",
    "checked",
  );
  // Report output records no run, job or step on the data, as
  // persistReportData writes it: one on the build step, one for the run.
  const stepReport = await saveData(
    repo,
    buildModel,
    "report-build",
    "report",
  );
  const runReport = await saveWorkflowData(repo, workflow, "report-run");
  const artifactFor = (
    saved: { id: string; name: string; version: number; tags: object },
  ) => ({
    dataId: saved.id,
    name: saved.name,
    version: saved.version,
    tags: { ...saved.tags } as Record<string, string>,
  });
  const run = WorkflowRun.fromData({
    ...created,
    status: "succeeded",
    jobs: created.jobs.map((job) => ({
      ...job,
      status: "succeeded",
      steps: job.steps.map((step) => ({
        ...step,
        status: "succeeded",
        dataArtifacts: job.jobName === "build"
          ? [
            artifactFor({ ...built, tags: built.data.tags }),
            artifactFor(stepReport),
          ]
          : [artifactFor({ ...checked, tags: checked.data.tags })],
      })),
    })),
    workflowDataArtifacts: [artifactFor(runReport)],
  });
  await repo.repoContext.workflowRunRepo.save(workflow.id, run);

  // A later write outside the run makes build-model's run version not latest.
  await saveStepResult(
    repo,
    buildModel,
    { id: crypto.randomUUID(), workflowName: "elsewhere" },
    "other",
    "other",
    "later",
  );
  return { run, built, checked, stepReport, runReport };
}

async function read(
  repo: ServeRepo,
  input: Partial<DataGetInput>,
): Promise<DataGetData> {
  const deps = createDataGetDeps(
    repo.repoDir,
    repo.datastoreResolver,
    repo.repoContext.unifiedDataRepo,
    repo.repoContext.workflowRepo,
    repo.repoContext.definitionRepo,
  );
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      includeContent: true,
      repoDir: repo.repoDir,
      ...input,
    }),
  );
  const last = events.at(-1);
  assert(last?.kind === "completed", JSON.stringify(last));
  return last.data;
}

/** The predicate a POSIX shell passes for the printed query command. */
function predicateOf(command: string): string {
  const match = command.match(/^swamp data query '(.*)'( --select content)?$/);
  assert(match, command);
  return match[1].replaceAll(`'"'"'`, "'");
}

/** Runs the replacement query and returns the records it selects. */
async function queryReplacement(
  repo: ServeRepo,
  data: DataGetData,
): Promise<DataRecord[]> {
  assert(data.replacementQuery, "data get names its replacement query");
  return await repo.repoContext.dataQueryService.query(
    predicateOf(data.replacementQuery),
  ) as DataRecord[];
}

function assertSameItem(records: DataRecord[], data: DataGetData) {
  assertEquals(
    records.map((r) => ({ id: r.id, version: r.version, model: r.modelId })),
    [{ id: data.id, version: data.version, model: data.modelId }],
  );
}

Deno.test("data get: a workflow-scoped read's replacement query selects the same item, and the shared name is warned about", async () => {
  await withServeRepo(async (repo) => {
    const { run, built } = await sharedNameRun(repo);

    for (const runId of [undefined, run.id]) {
      const data = await read(repo, {
        workflowName: "shared-name",
        runId,
        dataName: "result",
      });
      assertEquals(data.id, built.id);
      assertSameItem(await queryReplacement(repo, data), data);

      assertEquals(data.warnings?.length, 2, JSON.stringify(data.warnings));
      assertStringIncludes(data.warnings![0], "swamp data get is deprecated");
      assertStringIncludes(data.warnings![1], "job build, step compile");
      assertStringIncludes(data.warnings![1], "job verify, step check");
    }
  });
});

Deno.test("data get: changing the step in the replacement query reads the other step's item", async () => {
  await withServeRepo(async (repo) => {
    const { checked } = await sharedNameRun(repo);
    const data = await read(repo, {
      workflowName: "shared-name",
      dataName: "result",
    });

    const otherStep = predicateOf(data.replacementQuery!)
      .replace('jobName == "build"', 'jobName == "verify"')
      .replace('stepName == "compile"', 'stepName == "check"');
    const records = await repo.repoContext.dataQueryService.query(
      otherStep,
    ) as DataRecord[];
    assertEquals(records.map((r) => r.id), [checked.id]);
  });
});

Deno.test("data get: a model-scoped read's replacement query selects the same item, latest or pinned", async () => {
  await withServeRepo(async (repo) => {
    const { built } = await sharedNameRun(repo);

    const latest = await read(repo, {
      modelIdOrName: "build-model",
      dataName: "result",
    });
    assertEquals(latest.version, 2);
    assertSameItem(await queryReplacement(repo, latest), latest);
    assertEquals(latest.warnings?.length, 1);

    const pinned = await read(repo, {
      modelIdOrName: "build-model",
      dataName: "result",
      version: built.version,
    });
    assertEquals(pinned.version, 1);
    assertSameItem(await queryReplacement(repo, pinned), pinned);
  });
});

Deno.test("data get: report output, which records no run on the data, gets a replacement query that selects it", async () => {
  await withServeRepo(async (repo) => {
    const { stepReport, runReport } = await sharedNameRun(repo);

    for (
      const [dataName, expected] of [
        ["report-build", stepReport],
        ["report-run", runReport],
      ] as const
    ) {
      const data = await read(repo, { workflowName: "shared-name", dataName });
      assertEquals(data.id, expected.id);
      assertSameItem(await queryReplacement(repo, data), data);
    }
  });
});

Deno.test("data query: garbageCollection matches what data get returns, for count and duration policies", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "gc-model");
    const run = { id: crypto.randomUUID(), workflowName: "gc" };

    for (const policy of [10, "30d"] as const) {
      const saved = await saveStepResult(repo, model, run, "j", "s", "v", {
        name: `gc-${policy}`,
        garbageCollection: policy,
      });
      const data = await read(repo, {
        modelIdOrName: "gc-model",
        dataName: saved.name,
      });
      assertEquals(data.garbageCollection, policy);

      const records = await queryReplacement(repo, data);
      assertEquals(records.map((r) => r.garbageCollection), [policy]);
    }
  });
});

Deno.test("data query: a run-scoped query by spec name gets a hint scoped to the same run", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "classify-model");
    const runId = crypto.randomUUID();
    const saved = await saveStepResult(
      repo,
      model,
      { id: runId, workflowName: "classify" },
      "j",
      "s",
      "v",
      { name: "classification-main", specName: "classification" },
    );

    const queryService = repo.repoContext.dataQueryService;
    const deps: DataQueryDeps = {
      query: (pred, opts) => queryService.query(pred, opts),
      specNameFallback: (pred) => queryService.specNameFallback(pred),
    };
    const run = async (predicate: string) => {
      const events = await collect<DataQueryEvent>(
        dataQuery(createLibSwampContext(), deps, { predicate }),
      );
      const last = events.at(-1);
      assert(last?.kind === "completed", JSON.stringify(last));
      return last.data;
    };

    const missed = await run(
      `workflowRunId == "${runId}" && name == "classification"`,
    );
    assertEquals(missed.total, 0);
    const suggested = missed.specNameHint?.suggestedPredicate;
    assertEquals(
      suggested,
      `workflowRunId == "${runId}" && specName == "classification"`,
    );
    const followed = await queryService.query(suggested!) as DataRecord[];
    assertEquals(followed.map((r) => r.id), [saved.id]);

    // The same spec name in another run is not this run's data: no hint.
    const otherRun = await run(
      `workflowRunId == "${crypto.randomUUID()}" && name == "classification"`,
    );
    assertEquals(otherRun.specNameHint, undefined);

    // Data whose name equals its spec name, excluded by a condition the
    // fallback cannot carry: the name was never the problem, so no hint.
    await saveStepResult(
      repo,
      model,
      { id: runId, workflowName: "classify" },
      "j",
      "s",
      "v",
      { name: "summary", specName: "summary" },
    );
    const filtered = await run(
      `workflowRunId == "${runId}" && name == "summary" && size > 1000000`,
    );
    assertEquals(filtered.total, 0);
    assertEquals(filtered.specNameHint, undefined);
  });
});

// A read without --run follows the workflow's latest run; data query
// follows it with latestRun("<workflow>") (swamp-club#2957).

/**
 * Saves two runs of `two-runs`, each with one step that wrote `result`. The
 * newer run's step wrote first, so the older run holds the higher version
 * and, by version, the latest `result`.
 */
async function twoRuns(repo: ServeRepo) {
  const model = await saveModel(repo, "deploy-model");
  const workflow = Workflow.create({
    name: "two-runs",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "build",
        task: StepTask.modelMethod(model.name, "noop"),
      })],
    })],
  });
  await repo.repoContext.workflowRepo.save(workflow);

  const saveRun = async (startedAt: string, value: string) => {
    const created = WorkflowRun.create(workflow).toData();
    const saved = await saveStepResult(
      repo,
      model,
      { id: created.id, workflowName: workflow.name },
      "main",
      "build",
      value,
    );
    const run = WorkflowRun.fromData({
      ...created,
      status: "succeeded",
      startedAt,
      jobs: created.jobs.map((job) => ({
        ...job,
        status: "succeeded",
        steps: job.steps.map((step) => ({
          ...step,
          status: "succeeded",
          dataArtifacts: [{
            dataId: saved.id,
            name: saved.name,
            version: saved.version,
            tags: { ...saved.data.tags },
          }],
        })),
      })),
    });
    await repo.repoContext.workflowRunRepo.save(workflow.id, run);
    return { run, saved };
  };
  const newer = await saveRun("2026-02-01T00:00:00.000Z", "newer");
  const older = await saveRun("2026-01-01T00:00:00.000Z", "older");
  return { newer, older };
}

/** Runs `predicate` the way swamp data query does on the command line. */
async function queryAsCli(
  repo: ServeRepo,
  predicate: string,
): Promise<DataRecord[]> {
  return await repo.repoContext.dataQueryService.query(predicate, {
    latestRunResolver: createLatestRunResolver(
      repo.repoContext.workflowRepo,
      repo.repoContext.workflowRunRepo,
    ),
  }) as DataRecord[];
}

Deno.test("data query: latestRun selects what data get reads without --run, where workflowName does not", async () => {
  await withServeRepo(async (repo) => {
    const { newer, older } = await twoRuns(repo);
    assert(older.saved.version > newer.saved.version);

    const data = await read(repo, {
      workflowName: "two-runs",
      dataName: "result",
    });
    assertEquals(data.id, newer.saved.id);
    assertEquals(data.version, newer.saved.version);

    // By version, the older run's item is the latest.
    const byName = await queryAsCli(
      repo,
      'workflowName == "two-runs" && name == "result"',
    );
    assertEquals(byName.map((r) => r.workflowRunId), [older.run.id]);

    const latest = await queryAsCli(
      repo,
      'workflowRunId == latestRun("two-runs") && jobName == "main" && ' +
        'stepName == "build" && name == "result" && version >= 0',
    );
    assertSameItem(latest, data);
    assertEquals(latest[0].workflowRunId, newer.run.id);

    // The query data get's notice names follows the same run.
    const notice = data.warnings![0].match(
      /latest run instead, run: (swamp data query .*)\)$/,
    );
    assert(notice, data.warnings![0]);
    assertSameItem(await queryAsCli(repo, predicateOf(notice[1])), data);
  });
});

// ── The documented model-scoped equivalent (swamp-club#2960, #2968) ─────────
//
// `model("<m>") && name == "<n>"` must select what `data get <m> <n>` returns,
// whatever the model argument is and whatever the data's modelName tag says.

/** Runs the documented model-scoped query for `data get <model> <name>`. */
async function queryDocumented(
  repo: ServeRepo,
  model: string,
  dataName: string,
): Promise<DataRecord[]> {
  return await repo.repoContext.dataQueryService.query(
    `model(${JSON.stringify(model)}) && name == ${JSON.stringify(dataName)}`,
    {
      modelResolver: createModelReferenceResolver(
        repo.repoContext.definitionRepo,
      ),
    },
  ) as DataRecord[];
}

/** Saves `dataName` under `model` with exactly `tags`. */
async function saveTagged(
  repo: ServeRepo,
  model: Definition,
  dataName: string,
  tags: Record<string, string>,
): Promise<Data> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags,
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    encode(JSON.stringify({ value: dataName })),
  );
  return data;
}

Deno.test("data query model(): selects what data get returns when the model argument is a definition id", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "by-id");
    await saveData(repo, model, "result");

    const got = await read(repo, {
      modelIdOrName: model.id,
      dataName: "result",
    });
    assertSameItem(await queryDocumented(repo, model.id, "result"), got);
  });
});

Deno.test("data query model(): selects what data get returns after a model rename and for untagged data", async () => {
  await withServeRepo(async (repo) => {
    // Data written before the model was renamed keeps the old modelName tag;
    // data written before the tag existed has none.
    const model = await saveModel(repo, "renamed-model");
    await saveTagged(repo, model, "before-rename", {
      type: "resource",
      modelName: "original-model",
    });
    await saveTagged(repo, model, "untagged", { type: "resource" });

    for (const dataName of ["before-rename", "untagged"]) {
      const got = await read(repo, {
        modelIdOrName: "renamed-model",
        dataName,
      });
      assertSameItem(
        await queryDocumented(repo, "renamed-model", dataName),
        got,
      );
      const byTag = await repo.repoContext.dataQueryService.query(
        `modelName == "renamed-model" && name == ${JSON.stringify(dataName)}`,
      );
      assertEquals(byTag, [], "the modelName tag does not find it");
    }
  });
});

Deno.test("data query model(): after delete and recreate under one name, selects only the current definition's data", async () => {
  await withServeRepo(async (repo) => {
    const first = await saveModel(repo, "recreated");
    await saveData(repo, first, "result");
    await repo.repoContext.definitionRepo.delete(
      repo.modelType,
      first.id,
      first.name,
    );
    const second = await saveModel(repo, "recreated");
    await saveData(repo, second, "result");

    const got = await read(repo, {
      modelIdOrName: "recreated",
      dataName: "result",
    });
    assertEquals(got.modelId, second.id);
    assertSameItem(await queryDocumented(repo, "recreated", "result"), got);
    const byTag = await repo.repoContext.dataQueryService.query(
      'modelName == "recreated" && name == "result"',
    ) as DataRecord[];
    assertEquals(byTag.length, 2, "the tag matches both definitions' data");
  });
});

Deno.test("data query model(): a model with no definition fails as data get does", async () => {
  await withServeRepo(async (repo) => {
    await assertRejects(
      () => queryDocumented(repo, "no-such-model", "result"),
      UserError,
      "Model not found: no-such-model",
    );
  });
});

Deno.test("data query: a read by a renamed data item's old name selects what data get returns", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "renamer");
    await saveData(repo, model, "x");
    const dataRepo = repo.repoContext.unifiedDataRepo;
    await dataRepo.rename(repo.modelType, model.id, "x", "y");

    const oneHop = await read(repo, {
      modelIdOrName: "renamer",
      dataName: "x",
    });
    assertEquals(oneHop.name, "y");
    assertSameItem(await queryDocumented(repo, "renamer", "x"), oneHop);

    // A chain resolves to its end, as data get follows it.
    await dataRepo.rename(repo.modelType, model.id, "y", "z");
    const chain = await read(repo, { modelIdOrName: "renamer", dataName: "x" });
    assertEquals(chain.name, "z");
    assertSameItem(await queryDocumented(repo, "renamer", "x"), chain);

    // A versioned read does not follow, as data get --version does not.
    assertEquals(
      await repo.repoContext.dataQueryService.query(
        'model("renamer") && name == "x" && version >= 0',
        {
          modelResolver: createModelReferenceResolver(
            repo.repoContext.definitionRepo,
          ),
        },
      ),
      [],
    );

    // Writing the old name again ends its forward.
    const rewritten = await saveData(repo, model, "x");
    const fresh = await read(repo, { modelIdOrName: "renamer", dataName: "x" });
    assertEquals(fresh.id, rewritten.id);
    assertSameItem(await queryDocumented(repo, "renamer", "x"), fresh);
  });
});

Deno.test("data query: after a renamed item's old name is deleted, neither data get nor query finds it", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "deleter");
    await saveData(repo, model, "x");
    const dataRepo = repo.repoContext.unifiedDataRepo;
    await dataRepo.rename(repo.modelType, model.id, "x", "y");
    await dataRepo.delete(repo.modelType, model.id, "x");

    const deps = createDataGetDeps(
      repo.repoDir,
      repo.datastoreResolver,
      repo.repoContext.unifiedDataRepo,
      repo.repoContext.workflowRepo,
      repo.repoContext.definitionRepo,
    );
    const events = await collect<DataGetEvent>(
      dataGet(createLibSwampContext(), deps, {
        includeContent: true,
        repoDir: repo.repoDir,
        modelIdOrName: "deleter",
        dataName: "x",
      }),
    );
    assertEquals(events.at(-1)?.kind, "error");
    assertEquals(await queryDocumented(repo, "deleter", "x"), []);
  });
});
