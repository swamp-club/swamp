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
 * Use-case sync characterization, model and workflow rows (swamp-club#2860).
 * See `usecase_sync_fixtures.ts` for how each row runs and what is observed.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { parse, stringify } from "@std/yaml";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
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
  row,
  type RowRepos,
  runCli,
  runServe,
  serveCtx,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

/** The model's on-disk YAML with a tag added, as an editor would save it. */
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

/** The workflow's on-disk YAML with a new description. */
async function editedWorkflowYaml(repos: RowRepos, name: string) {
  const model = await saveModel(repos.serveRepo, "m1");
  const workflow = await saveWorkflow(repos.serveRepo, name, model);
  const path = repos.a.repoContext.workflowRepo.getPath(workflow.id);
  const doc = parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  doc.description = "edited";
  return stringify(doc);
}

/** A run suspended at a manual approval gate named `gate`. */
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
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    // With managedConfig the CLI stages a bulk mark through the command's
    // root unit after the use case (runManagedConfigMutation, swamp-club#3033),
    // and the root pushes it.
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
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    // With managedConfig the CLI stages a bulk mark through the command's
    // root unit after the use case (runManagedConfigMutation, swamp-club#3033),
    // and the root pushes it.
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
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    // With managedConfig the CLI stages a bulk mark through the command's
    // root unit after the use case (runManagedConfigMutation, swamp-club#3033),
    // and the root pushes it.
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
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    // With managedConfig the CLI stages a bulk mark through the command's
    // root unit after the use case (runManagedConfigMutation, swamp-club#3033),
    // and the root pushes it.
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
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
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
    // Recorded before serve adopted a root unit (swamp-club#3035), and before
    // the CLI's coordinator root, while it pushed only at the teardown flush
    // (swamp-club#3055).
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
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
    // The failure path of the CLI's root unit (swamp-club#3033); serve's
    // belongs to swamp-club#3034.
    serve: null,
  }),
  modelEditRow(false),
  modelEditRow(true),
  modelDeleteRow(false),
  modelDeleteRow(true),
  row({
    name: "model evaluate",
    rootUnit: { cli: true },
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
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
    // Recorded while the CLI pushed only at the coordinator's teardown flush
    // (swamp-club#3055).
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
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
    // Recorded while the CLI pushed only at the coordinator's teardown flush
    // (swamp-club#3055).
    syncOrder: { cli: ["pull", "push", "release"] },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({
      args: ["workflow", "evaluate", "--all", ...json(repos)],
    }),
    serve: () => ({ type: "workflow.evaluate", payload: {} }),
  }),
  row({
    name: "workflow evaluate (dynamic model references)",
    // The CLI's root unit takes the coordinator's push for the global lock
    // (swamp-club#3055); syncOrder was recorded while the root had no push
    // and the lock pushed only at the teardown flush.
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
    // Recorded while the CLI pushed only at the coordinator's flush, which
    // mod.ts runs best-effort after a failed command (swamp-club#3055).
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
    // Check options open with requireInitializedRepo; nothing is written.
    // Recorded while the CLI pushed only at the coordinator's teardown flush
    // (swamp-club#3055).
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
    // Recorded while the CLI pushed only at the coordinator's teardown flush
    // (swamp-club#3055).
    syncOrder: { cli: ["pull", "push", "release"] },
    cli: (repos) => ({ args: ["run", "gc", "--force", ...json(repos)] }),
    serve: null,
  }),
  row({
    name: "model method run",
    rootUnit: { cli: true, serve: true },
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: { cli: [], serve: [] },
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
    syncOrder: { cli: ["pull", "prepare", "commit", "release", "push"] },
    seed: seedModelAndWorkflow,
    cli: (repos) => ({ args: ["workflow", "run", "wf1", ...json(repos)] }),
    // The serve side of this use case belongs to swamp-club#3034.
    serve: null,
  }),
  row({
    name: "workflow resume",
    rootUnit: { cli: true, serve: true },
    // Recorded before the CLI (swamp-club#3033) and serve (swamp-club#3035)
    // adopted a root unit.
    syncOrder: { cli: ["release", "push"], serve: ["push", "release"] },
    // workflow_resume.ts drives WorkflowExecutionService directly, not
    // through a libswamp use case, so no use-case unit stages these marks.
    outsideUseCase: {
      cli: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      ],
      // Serve's resume (startDetachedResume) drives the same service.
      serve: [
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
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
    // Serve runs the handler in a root unit of work (swamp-club#3034),
    // pinned to push before the gate exit, as it did before.
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
    // Serve runs the handler in a root unit of work (swamp-club#3034),
    // pinned to push before the gate exit, as it did before.
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
    // Serve runs the handler in a root unit of work (swamp-club#3034),
    // pinned to push before the gate exit, as it did before.
    rootUnit: { serve: true },
    syncOrder: { serve: ["push", "release"] },
    // CLI workflow cancel saves the run through repoContext.workflowRunRepo
    // itself, not through a use case, so the save marks through
    // signalChange's hook fallback (unit_of_work_scope.ts signalChange in
    // PINNED_MARK_CALL_SITES). Serve goes through workflowCancelSuspended.
    outsideUseCase: {
      cli: ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml"],
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
];

/**
 * Today's behaviour, one entry per row. Every divergence and gap noted
 * below was deliberately left unfixed: datastore refactor phase 2 moves
 * unit-of-work ownership into the use cases and is expected to change these
 * rows, and should update this table as it does.
 */
const EXPECTED: Record<string, PinnedRow> = {
  "model create (managedConfig, use case fails)": {
    // The use case fails before anything is written, so nothing is marked or
    // pushed.
    cli: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
      "error": "Model already exists: m2",
    },
    serve: null,
  },
  "model method run": {
    cli: {
      "ops": [
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": [],
      },
    },
  },
  "workflow run": {
    cli: {
      "ops": [
        "markDirty workflows-evaluated/workflow-wf1.yaml",
        "markDirty workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "pull[0]",
        "markDirty definitions-evaluated/<type>/m1.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty outputs/<type>/noop/<id>-<time>.yaml",
        "markDirty data/<type>/<id>/report-swamp-method-summary",
        "markDirty data/<type>/<id>/report-swamp-method-summary-json",
        "prepare[11]",
        "commit[11]",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
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
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
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
        "markDirty data/workflow/<id>/report-swamp-workflow-summary",
        "markDirty data/workflow/<id>/report-swamp-workflow-summary-json",
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
    // Without managedConfig, definitions are repo-local: nothing is marked or
    // pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // Serve pushes after every write; with nothing marked the push is empty.
    // Datastore refactor phase 2 is expected to change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model create (managedConfig)": {
    // DIVERGENCE: the CLI publishes managed config with a bare markDirty
    // (runManagedConfigMutation), a whole-cache walk that can never delete;
    // serve marks the one path it wrote. Datastore refactor phase 2 is
    // expected to change this.
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/models/<type>/m2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": ["markDirty config/models/<type>/m2.yaml", "push[1]"],
      "remote": {
        "added": ["config/models/<type>/m2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "model edit": {
    // Repo-local without managedConfig: nothing is marked or pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // An empty push, as for model create. Datastore refactor phase 2 is
    // expected to change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model edit (managedConfig)": {
    // DIVERGENCE: a bare markDirty from the CLI, a path mark from serve, as
    // for model create. Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/models/<type>/m1.yaml"],
      },
    },
    serve: {
      "ops": ["markDirty config/models/<type>/m1.yaml", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/models/<type>/m1.yaml"],
      },
    },
  },
  "model delete": {
    // Only the evaluated-definition path is marked (no evaluated file exists,
    // so nothing is deleted); the repo-local definition never reaches the
    // datastore. The CLI's lock flush is two-phase; serve pushes once.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
        "prepare[0]",
        "commit[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["markDirty definitions-evaluated/<type>/<id>.yaml", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model delete (managedConfig)": {
    // Both compositions delete the remote config file; the CLI through its
    // lock flush (two-phase), serve from the handler. Datastore refactor phase
    // 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/<type>/<id>.yaml",
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
    // GAP: evaluated definitions are written through an unhooked repository,
    // so nothing is marked and the evaluation never reaches the remote. The
    // CLI still pulls and pushes empty through the model-lock flush. Datastore
    // refactor phase 2 is expected to change this.
    cli: {
      "ops": ["pull[0]", "prepare[0]", "commit[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    // GAP: serve's model.evaluate neither pushes nor takes the sync gate
    // (connection.ts dispatches it ungated), and its writes are unmarked.
    // Datastore refactor phase 2 is expected to change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "model evaluate (all)": {
    // GAP: unmarked evaluated writes, as above. --all opens with
    // requireInitializedRepo, so the pull and the empty single-phase push are
    // the coordinator's. Datastore refactor phase 2 is expected to change
    // this.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    // GAP: ungated, no push, unmarked writes, as above. Datastore refactor
    // phase 2 is expected to change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow create": {
    // Repo-local without managedConfig: nothing is marked or pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // An empty push after the write. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow create (managedConfig)": {
    // DIVERGENCE: a bare markDirty from the CLI, a path mark from serve.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/workflows/workflow-wf2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": ["markDirty config/workflows/workflow-wf2.yaml", "push[1]"],
      "remote": {
        "added": ["config/workflows/workflow-wf2.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "workflow edit": {
    // Repo-local without managedConfig: nothing is marked or pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // An empty push after the write. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow edit (managedConfig)": {
    // DIVERGENCE: the repository hook marks the path, then
    // runManagedConfigMutation adds a bare markDirty, so the push walks the
    // whole cache; serve marks the path only. Datastore refactor phase 2 is
    // expected to change this.
    cli: {
      "ops": [
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
      "ops": ["markDirty config/workflows/workflow-wf1.yaml", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/workflows/workflow-wf1.yaml"],
      },
    },
  },
  "workflow delete": {
    // Only the evaluated-workflow path is marked; the repo-local workflow
    // never reaches the datastore. Opened with requireInitializedRepo, so the
    // pull and push are the coordinator's. Datastore refactor phase 2 is
    // expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
        "push[0]",
      ],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["markDirty workflows-evaluated/workflow-<id>.yaml", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow delete (managedConfig)": {
    // Both compositions delete the remote config file. Datastore refactor
    // phase 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty workflows-evaluated/workflow-<id>.yaml",
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
    // GAP: unmarked evaluated writes; the CLI pulls and pushes empty through
    // the lock flush. Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["pull[0]", "prepare[0]", "commit[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    // GAP: serve's workflow.evaluate neither pushes nor takes the sync gate,
    // and its writes are unmarked. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow evaluate (all)": {
    // GAP: unmarked evaluated writes. The global path opens with
    // requireInitializedRepo: the coordinator's pull and empty flush.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    // GAP: ungated, no push, unmarked writes. Datastore refactor phase 2 is
    // expected to change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "workflow evaluate (dynamic model references)": {
    // GAP: unmarked evaluated writes, as above. The global lock's
    // coordinator pulls on open and pushes empty at the teardown flush; the
    // command's own root has no push.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "workflow delete (use case fails)": {
    // The lookup fails under the global lock; the coordinator's pull, then
    // its best-effort push after the failure.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
      "error": "Workflow not found: missing",
    },
    serve: null,
  },
  "model validate (with check options)": {
    // Writes nothing: the coordinator's pull and empty teardown push.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "run gc": {
    // Nothing past retention: the coordinator's pull and empty teardown push.
    cli: {
      "ops": ["pull[0]", "push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: null,
  },
  "workflow approve": {
    // GAP: the CLI marks the run file but never pushes it. It opens with
    // requireInitializedRepoUnlocked, which registers no flush, and pushes
    // nothing itself, so the remote keeps the suspended run until some later
    // push from this cache. Serve pushes it. Datastore refactor phase 2 is
    // expected to change this.
    cli: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
  "workflow reject": {
    // GAP: marked, never pushed, as for workflow approve. Datastore refactor
    // phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
  "workflow cancel": {
    // GAP: marked, never pushed, as for workflow approve. Datastore refactor
    // phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["markDirty workflow-runs/<id>/workflow-run-<id>.yaml", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["workflow-runs/<id>/workflow-run-<id>.yaml"],
      },
    },
  },
};

Deno.test("use case sync characterization: model and workflow use cases mark and push today's paths", async (t) => {
  await checkRows(t, ROWS, EXPECTED);
});
