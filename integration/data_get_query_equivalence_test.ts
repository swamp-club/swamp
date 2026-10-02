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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  createDataGetDeps,
  createLibSwampContext,
  dataGet,
  type DataGetData,
  type DataGetEvent,
  type DataGetInput,
  type DataRecord,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import { Data } from "../src/domain/data/data.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
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
): Promise<{ id: string; name: string; version: number; data: Data }> {
  const data = Data.create({
    name: "result",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "result", modelName: model.name },
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

Deno.test("data query model(): a model with no definition matches nothing", async () => {
  await withServeRepo(async (repo) => {
    const unresolved: string[] = [];
    const records = await repo.repoContext.dataQueryService.query(
      'model("no-such-model")',
      { onUnresolvedModel: (ref) => unresolved.push(ref) },
    );
    assertEquals(records, []);
    assertEquals(unresolved, ["no-such-model"]);
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
