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
import { assertEquals } from "@std/assert";
import { parse, stringify } from "@std/yaml";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { hostname } from "node:os";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  saveGatedWorkflow,
  saveModel,
  saveWorkflow,
} from "./serve_request_harness.ts";
import {
  type AnyRow,
  checkRows,
  type Composition,
  type PinnedRow,
  READ_RUN_PUBLISH_MARKS,
  row,
  type RowRepos,
  runCli,
  runServe,
  serveCtx,
} from "./usecase_sync_fixtures.ts";
import { checkRowsOnV3 } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

async function editedModelYaml(repos: RowRepos, name: string) {
  const model = await saveModel(repos.serveRepo, name);
  const path = repos.a.repoContext.definitionRepo.getPath(
    repos.modelType,
    model.id,
  );
  const doc = parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  doc.tags = { edited: "yes" };
  return stringify(doc);
}

async function editedWorkflowYaml(repos: RowRepos, name: string) {
  const model = await saveModel(repos.serveRepo, "m1");
  const workflow = await saveWorkflow(repos.serveRepo, name, model);
  const path = repos.a.repoContext.workflowRepo.getPath(workflow.id);
  const doc = parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  doc.description = "edited";
  return stringify(doc);
}

/** A pid no process has, so a run it owns has a dead owner. */
const DEAD_PID = 2147483647;

function track(repos: RowRepos, run: ActiveRun): void {
  const tracker = RunTrackerStore.fromSwampDir(swampPath(repos.repoA));
  try {
    tracker.register(run);
  } finally {
    tracker.close();
  }
}

interface StrandedRun {
  workflowName: string;
  runId: string;
}

async function strandedWorkflowRun(repos: RowRepos): Promise<StrandedRun> {
  const model = await saveModel(repos.serveRepo, "m1");
  const workflow = await saveWorkflow(repos.serveRepo, "stranded", model);
  const startedAt = new Date().toISOString();
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "running",
    startedAt,
    pid: DEAD_PID,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt,
      steps: [{ stepName: "noop", status: "running", startedAt }],
    }],
    tags: {},
  });
  await repos.a.repoContext.workflowRunRepo.save(workflow.id, run);
  track(
    repos,
    ActiveRun.createWorkflowRun({
      id: run.id,
      workflowName: workflow.name,
      pid: DEAD_PID,
      hostname: hostname(),
    }),
  );
  return { workflowName: workflow.name, runId: run.id };
}

async function strandedMethodRun(repos: RowRepos): Promise<string> {
  const model = await saveModel(repos.serveRepo, "m1");
  const output = ModelOutput.create({
    definitionId: model.id,
    methodName: "noop",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  output.markRunning(DEAD_PID);
  await repos.a.repoContext.outputRepo.save(repos.modelType, "noop", output);
  track(
    repos,
    ActiveRun.createModelMethodRun({
      id: output.id,
      modelType: repos.modelType.normalized,
      definitionId: model.id,
      methodName: "noop",
      pid: DEAD_PID,
      hostname: hostname(),
    }),
  );
  return model.name;
}

interface SuspendedRun {
  workflowName: string;
  runId: string;
  registry: ActiveRunRegistry;
}

/**
 * Runs a gated workflow until it suspends. A serve-owned run carries an
 * instance id; the CLI refuses to act on such a run, so its run has none.
 */
async function suspendAtGate(
  repos: RowRepos,
  composition: Composition,
): Promise<SuspendedRun> {
  const workflow = await saveGatedWorkflow(repos.serveRepo, "gated", "gate");
  let runId: string | undefined;
  await executeWorkflowWithLocks(
    repos.a.repoDir,
    repos.a.repoContext,
    repos.a.datastoreConfig,
    {
      workflowIdOrName: workflow.name,
      inputs: {},
      ...(composition === "serve" ? { instanceId: crypto.randomUUID() } : {}),
    },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started") runId = event.runId;
    },
    repos.a.syncService,
    undefined,
    { syncGate: undefined },
  );
  if (!runId) throw new Error("the gated run never started");
  return {
    workflowName: workflow.name,
    runId,
    registry: new ActiveRunRegistry(),
  };
}

function modelCreateRow(managedConfig: boolean): AnyRow {
  return row({
    name: `model create${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    cli: (repos) => ({
      args: [
        "model",
        "create",
        repos.modelType.normalized,
        "m2",
        ...json(
          repos,
        ),
      ],
    }),
    serve: (repos) => ({
      type: "model.create",
      payload: { typeArg: repos.modelType.normalized, name: "m2" },
    }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.definitionRepo.findByName(
        repos.modelType,
        "m2",
      );
      assertEquals(found?.name, "m2", "model create saved no model");
    },
  });
}

function modelEditRow(managedConfig: boolean): AnyRow {
  return row({
    name: `model edit${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    seed: (repos) => editedModelYaml(repos, "m1"),
    cli: (repos, content) => ({
      args: ["model", "edit", "m1", ...json(repos)],
      stdin: content,
    }),
    serve: (_repos, content) => ({
      type: "model.edit",
      payload: { modelIdOrName: "m1", content },
    }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.definitionRepo.findByName(
        repos.modelType,
        "m1",
      );
      assertEquals(found?.tags, { edited: "yes" }, "model edit not saved");
    },
  });
}

function workflowCreateRow(managedConfig: boolean): AnyRow {
  return row({
    name: `workflow create${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    cli: (repos) => ({ args: ["workflow", "create", "wf2", ...json(repos)] }),
    serve: () => ({ type: "workflow.create", payload: { name: "wf2" } }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.workflowRepo.findByName("wf2");
      assertEquals(found?.name, "wf2", "workflow create saved no workflow");
    },
  });
}

function workflowEditRow(managedConfig: boolean): AnyRow {
  return row({
    name: `workflow edit${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    seed: (repos) => editedWorkflowYaml(repos, "wf1"),
    cli: (repos, content) => ({
      args: ["workflow", "edit", "wf1", ...json(repos)],
      stdin: content,
    }),
    serve: (_repos, content) => ({
      type: "workflow.edit",
      payload: { workflowIdOrName: "wf1", content },
    }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.workflowRepo.findByName("wf1");
      assertEquals(found?.description, "edited", "workflow edit not saved");
    },
  });
}

const seedModelAndWorkflow = async (repos: RowRepos) => {
  const model = await saveModel(repos.serveRepo, "m1");
  await saveWorkflow(repos.serveRepo, "wf1", model);
};

/**
 * A model and a workflow whose step names the model with an expression, so
 * `workflow evaluate` cannot resolve its model locks and takes the global
 * lock instead.
 */
const seedModelAndDynamicWorkflow = async (repos: RowRepos) => {
  await saveModel(repos.serveRepo, "m1");
  await repos.a.repoContext.workflowRepo.save(Workflow.create({
    name: "wf1",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "noop",
            task: StepTask.modelMethod('${{ "m1" }}', "noop"),
          }),
        ],
      }),
    ],
  }));
};

function modelDeleteRow(managedConfig: boolean): AnyRow {
  return row({
    name: `model delete${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: ["pull", "prepare", "commit", "release"],
      serve: ["push", "release"],
    },
    options: { managedConfig },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["model", "delete", "m1", "--force", ...json(repos)],
    }),
    serve: () => ({
      type: "model.delete",
      payload: { modelIdOrName: "m1", force: true },
    }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.definitionRepo.findByName(
        repos.modelType,
        "m1",
      );
      assertEquals(found, null, "model delete left the model");
    },
  });
}

function workflowDeleteRow(managedConfig: boolean): AnyRow {
  return row({
    name: `workflow delete${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: { cli: ["pull", "push", "release"], serve: ["push", "release"] },
    options: { managedConfig },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({
      args: ["workflow", "delete", "wf1", "--force", ...json(repos)],
    }),
    serve: () => ({
      type: "workflow.delete",
      payload: { workflowIdOrName: "wf1" },
    }),
    verify: async (repos) => {
      const found = await repos.a.repoContext.workflowRepo.findByName("wf1");
      assertEquals(found, null, "workflow delete left the workflow");
    },
  });
}

const ROWS: AnyRow[] = [
  modelCreateRow(false),
  modelCreateRow(true),
  row({
    name: "model create (managedConfig, use case fails)",
    rootUnit: { cli: true },
    syncOrder: { cli: [] },
    refuses: true,
    options: { managedConfig: true },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m2");
    },
    cli: (repos) => ({
      args: [
        "model",
        "create",
        repos.modelType.normalized,
        "m2",
        ...json(repos),
      ],
    }),
    serve: null,
  }),
  modelEditRow(false),
  modelEditRow(true),
  modelDeleteRow(false),
  modelDeleteRow(true),
  row({
    name: "model evaluate",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "prepare", "commit", "release"] },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({ args: ["model", "evaluate", "m1", ...json(repos)] }),
    serve: () => ({
      type: "model.evaluate",
      payload: { modelIdOrName: "m1" },
    }),
  }),
  row({
    name: "model evaluate (all)",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({ args: ["model", "evaluate", "--all", ...json(repos)] }),
    serve: () => ({ type: "model.evaluate", payload: {} }),
  }),
  workflowCreateRow(false),
  workflowCreateRow(true),
  workflowEditRow(false),
  workflowEditRow(true),
  workflowDeleteRow(false),
  workflowDeleteRow(true),
  row({
    name: "workflow evaluate",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "prepare", "commit", "release"] },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({
      args: ["workflow", "evaluate", "wf1", ...json(repos)],
    }),
    serve: () => ({
      type: "workflow.evaluate",
      payload: { workflowIdOrName: "wf1" },
    }),
  }),
  row({
    name: "workflow evaluate (all)",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({
      args: ["workflow", "evaluate", "--all", ...json(repos)],
    }),
    serve: () => ({ type: "workflow.evaluate", payload: {} }),
  }),
  row({
    name: "workflow evaluate (dynamic model references)",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    seed: seedModelAndDynamicWorkflow,
    cli: (repos) => ({
      args: ["workflow", "evaluate", "wf1", ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "workflow delete (use case fails)",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    refuses: true,
    cli: (repos) => ({
      args: ["workflow", "delete", "missing", "--force", ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "model validate (with check options)",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["model", "validate", "m1", "--label", "none", ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "run gc",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "release"] },
    cli: (repos) => ({ args: ["run", "gc", "--force", ...json(repos)] }),
    serve: null,
  }),
  row({
    name: "model method run",
    rootUnit: { cli: true, serve: true },
    rootUnits: { cli: 2, serve: 2 },
    outsideUseCase: {
      cli: READ_RUN_PUBLISH_MARKS,
      serve: READ_RUN_PUBLISH_MARKS,
    },
    syncOrder: {
      cli: [
        "pull",
        "pull",
        "prepare",
        "commit",
        "release",
        "fetch",
        "fetch",
        "fetch",
        "fetch",
        "release",
      ],
      serve: [
        "pull",
        "release",
        "pull",
        "release",
        "prepare",
        "commit",
        "release",
        "fetch",
        "fetch",
        "fetch",
        "fetch",
        "release",
      ],
    },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["model", "method", "run", "m1", "noop", ...json(repos)],
    }),
    // The run is detached; runServe returns once it leaves the registry,
    // which it does only after its push.
    serve: () => ({
      type: "model.method.run",
      payload: { modelIdOrName: "m1", methodName: "noop" },
    }),
  }),
  row({
    name: "workflow run",
    rootUnit: { cli: true },
    syncOrder: {
      cli: [
        "pull",
        "prepare",
        "commit",
        "release",
        "fetch",
        "fetch",
        "fetch",
        "fetch",
        "release",
        "push",
      ],
    },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({ args: ["workflow", "run", "wf1", ...json(repos)] }),
    serve: null,
  }),
  row({
    name: "workflow resume",
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: ["release", "push"],
      serve: ["release", "push", "release"],
    },
    // workflow_resume.ts drives WorkflowExecutionService directly, not
    // through a libswamp use case, so no use-case unit stages these marks.
    outsideUseCase: {
      cli: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      serve: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
    },
    seed: async (repos, composition) => {
      const run = await suspendAtGate(repos, composition);
      if (composition === "serve") {
        // The CLI refuses a serve-owned run, so serve approves it. The
        // workflow does not opt into auto-resume, so the approval only
        // decides the gate.
        await runServe(serveCtx(repos), {
          type: "workflow.approve",
          payload: {
            workflowIdOrName: run.workflowName,
            stepName: "gate",
            runId: run.runId,
          },
        });
        return run;
      }
      await runCli({
        args: [
          "workflow",
          "approve",
          run.workflowName,
          "gate",
          "--run",
          run.runId,
          ...json(repos),
        ],
      });
      return run;
    },
    serveCtx: (run: SuspendedRun) => ({ activeRunRegistry: run.registry }),
    cli: (repos, run: SuspendedRun) => ({
      args: ["workflow", "resume", run.workflowName, ...json(repos)],
    }),
    // The resume is detached; runServe returns once it leaves the registry,
    // which it does only after its push.
    serve: (_repos, run: SuspendedRun) => ({
      type: "workflow.resume",
      payload: { workflowIdOrName: run.workflowName, runId: run.runId },
    }),
  }),
  row({
    name: "workflow approve",
    rootUnit: { serve: true },
    syncOrder: { serve: ["push", "release"] },
    seed: suspendAtGate,
    serveCtx: (run: SuspendedRun) => ({ activeRunRegistry: run.registry }),
    cli: (repos, run: SuspendedRun) => ({
      args: [
        "workflow",
        "approve",
        run.workflowName,
        "gate",
        "--run",
        run.runId,
        ...json(repos),
      ],
    }),
    serve: (_repos, run: SuspendedRun) => ({
      type: "workflow.approve",
      payload: {
        workflowIdOrName: run.workflowName,
        stepName: "gate",
        runId: run.runId,
      },
    }),
  }),
  row({
    name: "workflow reject",
    rootUnit: { serve: true },
    syncOrder: { serve: ["push", "release"] },
    seed: suspendAtGate,
    serveCtx: (run: SuspendedRun) => ({ activeRunRegistry: run.registry }),
    cli: (repos, run: SuspendedRun) => ({
      args: [
        "workflow",
        "reject",
        run.workflowName,
        "gate",
        "--run",
        run.runId,
        ...json(repos),
      ],
    }),
    serve: (_repos, run: SuspendedRun) => ({
      type: "workflow.reject",
      payload: {
        workflowIdOrName: run.workflowName,
        stepName: "gate",
        runId: run.runId,
      },
    }),
  }),
  row({
    name: "workflow cancel",
    rootUnit: { cli: true, serve: true },
    syncOrder: { cli: ["release"], serve: ["push", "release"] },
    // CLI workflow cancel saves the run through workflowRunRepo itself, not a
    // use case, so the root stages its mark; serve goes through
    // workflowCancelSuspended
    outsideUseCase: {
      cli: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
    },
    seed: suspendAtGate,
    serveCtx: (run: SuspendedRun) => ({ activeRunRegistry: run.registry }),
    cli: (repos, run: SuspendedRun) => ({
      args: [
        "workflow",
        "cancel",
        run.workflowName,
        "--run",
        run.runId,
        ...json(repos),
      ],
    }),
    serve: (_repos, run: SuspendedRun) => ({
      type: "workflow.cancel",
      payload: { runId: run.runId, workflowIdOrName: run.workflowName },
    }),
  }),
  row({
    name: "workflow recover",
    rootUnit: { cli: true },
    syncOrder: { cli: [] },
    outsideUseCase: {
      cli: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
    },
    seed: (repos: RowRepos) => strandedWorkflowRun(repos),
    cli: (repos, run: StrandedRun) => ({
      args: [
        "workflow",
        "recover",
        run.workflowName,
        "--run",
        run.runId,
        "--acknowledge-unknown",
        ...json(repos),
      ],
    }),
    serve: null,
  }),
  row({
    name: "run doctor --fix",
    rootUnit: { cli: true },
    syncOrder: { cli: [] },
    outsideUseCase: {
      cli: [
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
    },
    seed: async (repos: RowRepos) => {
      await strandedWorkflowRun(repos);
      await strandedMethodRun(repos);
    },
    cli: (repos) => ({ args: ["run", "doctor", "--fix", ...json(repos)] }),
    serve: null,
  }),
  row({
    name: "model cancel",
    rootUnit: { cli: true },
    syncOrder: { cli: [] },
    outsideUseCase: {
      cli: [
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
      ],
    },
    seed: (repos: RowRepos) => strandedMethodRun(repos),
    cli: (repos, modelName: string) => ({
      args: ["model", "cancel", modelName, ...json(repos)],
    }),
    serve: null,
  }),
];

/**
 * pins current behaviour per row, divergences and gaps included; update the
 * table when unit-of-work ownership moves into the use cases
 */
const EXPECTED: Record<string, PinnedRow> = {
  "model create (managedConfig, use case fails)": {
    cli: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
      "error": "Behavior already exists: m2",
    },
    serve: null,
  },
  "model method run": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "pull[0]",
        "markDirty data/<type>/<id>/report-swamp-method-summary/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary/latest",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/latest",
        "prepare[8]",
        "commit[8]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
      ],
      "remote": {
        "added": [
          "data/<type>/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary-json/1/raw",
          "data/<type>/<id>/report-swamp-method-summary-json/latest",
          "data/<type>/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary/1/raw",
          "data/<type>/<id>/report-swamp-method-summary/latest",
          "definitions-evaluated/<type>/m1.yaml",
          "outputs/<type>/noop/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "pull[0]",
        "markDirty data/<type>/<id>/report-swamp-method-summary/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary/latest",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/latest",
        "prepare[8]",
        "commit[8]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
      ],
      "remote": {
        "added": [
          "data/<type>/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary-json/1/raw",
          "data/<type>/<id>/report-swamp-method-summary-json/latest",
          "data/<type>/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary/1/raw",
          "data/<type>/<id>/report-swamp-method-summary/latest",
          "definitions-evaluated/<type>/m1.yaml",
          "outputs/<type>/noop/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
  },
  "workflow run": {
    cli: {
      "ops": [
        "markDirty workflows-evaluated/workflow-wf1.yaml",
        "markDirty workflows-evaluated/workflow-wf1.yaml",
        "markDirty workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
        "markDirty workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "pull[0]",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "markDirty data/<type>/<id>/report-swamp-method-summary/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary/latest",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/1",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json/latest",
        "prepare[11]",
        "commit[11]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
        "fetch[1]",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[7]",
      ],
      "remote": {
        "added": [
          "data/<type>/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary-json/1/raw",
          "data/<type>/<id>/report-swamp-method-summary-json/latest",
          "data/<type>/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/<type>/<id>/report-swamp-method-summary/1/raw",
          "data/<type>/<id>/report-swamp-method-summary/latest",
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary-json/latest",
          "data/workflow/<id>/report-swamp-workflow-summary/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary/latest",
          "definitions-evaluated/<type>/m1.yaml",
          "outputs/<type>/noop/<id>-<time>.yaml",
          "workflow-runs/<id>/workflow-run-<id>.yaml",
          "workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
          "workflows-evaluated/workflow-wf1.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: null,
  },
  "workflow resume": {
    cli: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[7]",
      ],
      "remote": {
        "added": [
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary-json/latest",
          "data/workflow/<id>/report-swamp-workflow-summary/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary/latest",
        ],
        "removed": [],
        "changed": [
          "workflow-runs/<id>/workflow-run-<id>.yaml",
        ],
      },
    },
    serve: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[7]",
      ],
      "remote": {
        "added": [
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary-json/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary-json/latest",
          "data/workflow/<id>/report-swamp-workflow-summary/1/metadata.yaml",
          "data/workflow/<id>/report-swamp-workflow-summary/1/raw",
          "data/workflow/<id>/report-swamp-workflow-summary/latest",
        ],
        "removed": [],
        "changed": [
          "workflow-runs/<id>/workflow-run-<id>.yaml",
        ],
      },
    },
  },
  "model create": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model create (managedConfig)": {
    // divergence: the CLI publishes managed config with a bare whole-cache
    // markDirty that can never delete; serve marks the one path it wrote
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/models/<type>/m2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty config/models/<type>/m2.yaml",
        "markDirty config/models/<type>/m2.yaml",
        "push[1]",
      ],
      "remote": {
        "added": ["config/models/<type>/m2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "model edit": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model edit (managedConfig)": {
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/models/<type>/m1.yaml"],
      },
    },
    serve: {
      "ops": [
        "markDirty config/models/<type>/m1.yaml",
        "markDirty config/models/<type>/m1.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/models/<type>/m1.yaml"],
      },
    },
  },
  "model delete": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "prepare[0]",
        "commit[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "push[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model delete (managedConfig)": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty config/models/<type>/m1.yaml",
        "markDirty config/models/<type>/m1.yaml",
        "prepare[0 del 1]",
        "commit[0 del 1]",
      ],
      "remote": {
        "added": [],
        "removed": ["config/models/<type>/m1.yaml"],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "markDirty config/models/<type>/m1.yaml",
        "markDirty config/models/<type>/m1.yaml",
        "push[0 del 1]",
      ],
      "remote": {
        "added": [],
        "removed": ["config/models/<type>/m1.yaml"],
        "changed": [],
      },
    },
  },
  "model evaluate": {
    // gap: evaluated definitions are written through an unhooked repository, so
    // nothing is marked and the evaluation never reaches the remote; the CLI
    // still pulls and pushes empty via the lock flush
    cli: {
      "ops": ["pull[0]", "prepare[0]", "commit[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model evaluate (all)": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow create": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow create (managedConfig)": {
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/workflows/workflow-wf2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty config/workflows/workflow-wf2.yaml",
        "markDirty config/workflows/workflow-wf2.yaml",
        "push[1]",
      ],
      "remote": {
        "added": ["config/workflows/workflow-wf2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "workflow edit": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow edit (managedConfig)": {
    cli: {
      "ops": [
        "markDirty config/workflows/workflow-wf1.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "markDirty(bulk)",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/workflows/workflow-wf1.yaml"],
      },
    },
    serve: {
      "ops": [
        "markDirty config/workflows/workflow-wf1.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/workflows/workflow-wf1.yaml"],
      },
    },
  },
  "workflow delete": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "push[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "push[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow delete (managedConfig)": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "push[0 del 1]",
      ],
      "remote": {
        "added": [],
        "removed": ["config/workflows/workflow-wf1.yaml"],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "markDirty config/workflows/workflow-wf1.yaml",
        "push[0 del 1]",
      ],
      "remote": {
        "added": [],
        "removed": ["config/workflows/workflow-wf1.yaml"],
        "changed": [],
      },
    },
  },
  "workflow evaluate": {
    cli: {
      "ops": ["pull[0]", "prepare[0]", "commit[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow evaluate (all)": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow evaluate (dynamic model references)": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "workflow delete (use case fails)": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
      "error": "Workflow not found: missing",
    },
    serve: null,
  },
  "model validate (with check options)": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "run gc": {
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "workflow approve": {
    // gap: the CLI marks the run file but never pushes it (no flush is
    // registered), so the remote keeps the suspended run until a later push
    // from this cache; serve pushes it
    cli: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
  "workflow reject": {
    cli: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
  "workflow cancel": {
    cli: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
  "workflow recover": {
    cli: {
      "ops": [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "run doctor --fix": {
    cli: {
      "ops": [
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "model cancel": {
    cli: {
      "ops": [
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
};

Deno.test("use case sync characterization: model and workflow use cases mark and push today's paths", async (t) => {
  await checkRows(t, ROWS, EXPECTED);
});

Deno.test("use-case sync characterization: on a v3 datastore every model and workflow row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  await checkRowsOnV3(t, ROWS);
});

Deno.test("use-case sync characterization: on a namespaced v3 datastore every model and workflow row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  await checkRowsOnV3(t, ROWS, {}, { namespace: "team" });
});
