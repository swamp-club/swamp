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

function modelDeleteRow(managedConfig: boolean): AnyRow {
  return row({
    name: `model delete${managedConfig ? " (managedConfig)" : ""}`,
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
  modelEditRow(false),
  modelEditRow(true),
  modelDeleteRow(false),
  modelDeleteRow(true),
  row({
    name: "model evaluate",
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
    seed: seedModelAndWorkflow,
    cli: (repos) => ({
      args: ["workflow", "evaluate", "--all", ...json(repos)],
    }),
    serve: () => ({ type: "workflow.evaluate", payload: {} }),
  }),
  row({
    name: "workflow approve",
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
    // (pushManagedConfigChanges), a whole-cache walk that can never delete;
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
    // pushManagedConfigChanges adds a bare markDirty, so the push walks the
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
