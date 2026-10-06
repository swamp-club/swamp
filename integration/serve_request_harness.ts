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
 * Drives serve requests through `handleMessage` — the real dispatch path —
 * against a real repository on disk. Shared by the serve request
 * characterization and id-deny conformance tests (swamp-club#2674).
 */

import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { handleMessage } from "../src/serve/connection.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { createConditionEvaluator } from "../src/domain/access/policy_snapshot_loader.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";

/** A serve request frame as the client sends it. */
export interface ServeRequest {
  type: string;
  id: string;
  payload?: Record<string, unknown>;
}

/** A frame the server sent back, parsed. */
export type Frame = Record<string, unknown> & {
  type: string;
  id?: string;
  error?: { code: string; message: string };
  payload?: Record<string, unknown>;
};

/** A temp swamp repository with real repositories wired as serve does. */
export interface ServeRepo {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: ConnectionContext["datastoreConfig"];
  datastoreResolver: ConnectionContext["datastoreResolver"];
  /** A per-run model type with one no-op read method, `noop`. */
  modelType: ModelType;
}

/** The principal every conformance request is sent as. */
export const CALLER: Principal = { kind: "user", id: "caller" };

/**
 * Runs `fn` against a fresh initialized repo. The model type is registered
 * per run (crypto.randomUUID) so `deno test --repeats` re-exercises it.
 */
export async function withServeRepo(
  fn: (repo: ServeRepo) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-requests-" });
  const modelType = ModelType.create(
    `test/serve-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  try {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const { repoDir, repoContext, datastoreConfig, datastoreResolver } =
      await requireInitializedRepoUnlocked({ repoDir: dir, outputMode: "log" });
    await fn({
      repoDir,
      repoContext,
      datastoreConfig,
      datastoreResolver:
        datastoreResolver as ConnectionContext["datastoreResolver"],
      modelType,
    });
  } finally {
    modelRegistry.invalidateType(modelType);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** An allow grant for {@link CALLER}; override any field. */
export function grant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: CALLER.id },
    effect: "allow",
    actions: ["read", "write", "run", "approve"],
    resource: { kind: "model", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Options for {@link createServeCtx}. */
export interface ServeCtxOptions {
  /**
   * Give the context an active run registry, so runs take serve's detached
   * path (registered, cancellable, attachable) instead of the inline one.
   */
  detached?: boolean;
  /** The repo's shared sync service, as serve hands it to every handler. */
  syncService?: ConnectionContext["syncService"];
  /** Serve's sync gate; `connection.ts` wraps gated handlers in it. */
  syncGate?: ConnectionContext["syncGate"];
  /** Serve's run tracker. */
  runTracker?: ConnectionContext["runTracker"];
  /** The managed definitions directory, set under `managedConfig`. */
  managedDefinitionsDir?: ConnectionContext["managedDefinitionsDir"];
  /** The repo's vaults directory. */
  vaultsDir?: ConnectionContext["vaultsDir"];
  /**
   * A specific active run registry, for a test that must see runs it
   * registered itself. Takes precedence over `detached`.
   */
  activeRunRegistry?: ConnectionContext["activeRunRegistry"];
}

/**
 * Builds a connection context over `repo`. With `grants`, the context runs in
 * token mode and enforces them; without, it runs in `none` mode.
 */
export function createServeCtx(
  repo: ServeRepo,
  grants?: Grant[],
  options: ServeCtxOptions = {},
): ConnectionContext {
  const authConfig: ServeAuthConfig = {
    mode: grants ? "token" : "none",
    admins: [],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "",
    groupsField: "",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
    signalRequiresExplicitGrant: false,
  };
  return {
    repoDir: repo.repoDir,
    repoContext: repo.repoContext,
    datastoreConfig: repo.datastoreConfig,
    datastoreResolver: repo.datastoreResolver,
    authConfig,
    serveOptions: {} as MergedServeOptions,
    ...(options.detached ? { activeRunRegistry: new ActiveRunRegistry() } : {}),
    ...(options.activeRunRegistry
      ? { activeRunRegistry: options.activeRunRegistry }
      : {}),
    ...(options.syncService ? { syncService: options.syncService } : {}),
    ...(options.syncGate ? { syncGate: options.syncGate } : {}),
    ...(options.runTracker ? { runTracker: options.runTracker } : {}),
    ...(options.managedDefinitionsDir
      ? { managedDefinitionsDir: options.managedDefinitionsDir }
      : {}),
    ...(options.vaultsDir ? { vaultsDir: options.vaultsDir } : {}),
    ...(grants
      ? {
        policySnapshotLoader: {
          decisionService: new GrantBasedAccessDecisionService(
            new PolicySnapshot(grants, [], createConditionEvaluator()),
          ),
        } as unknown as PolicySnapshotLoader,
      }
      : {}),
  } as ConnectionContext;
}

/**
 * Sends one request through `handleMessage` and returns every frame the
 * server sent for it, once the request is no longer active.
 */
export async function sendRequest(
  ctx: ConnectionContext,
  request: ServeRequest,
  principal: Principal | null = CALLER,
  options: { awaitRuns?: boolean } = {},
): Promise<Frame[]> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  const active = new Map<string, AbortController>();
  handleMessage(
    socket,
    ctx,
    active,
    new MessageEvent("message", { data: JSON.stringify(request) }),
    principal,
  );
  // A detached run outlives its request; wait for it to leave the registry,
  // unless the caller registered runs of its own that never finish.
  const awaitRuns = options.awaitRuns ?? true;
  await waitFor(
    () =>
      !active.has(request.id) &&
      (!awaitRuns || (ctx.activeRunRegistry?.size ?? 0) === 0),
    `request ${request.type} ${request.id} finished`,
  );
  return sent
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((frame) => frame.id === undefined || frame.id === request.id);
}

/** The error frame among `frames`, if any. */
export function errorFrame(frames: Frame[]): Frame | undefined {
  return frames.find((frame) => frame.type === "error");
}

/** Saves a model definition of the repo's test type. */
export async function saveModel(
  repo: ServeRepo,
  name: string,
  tags: Record<string, string> = {},
): Promise<Definition> {
  const definition = Definition.create({ name, globalArguments: {}, tags });
  await repo.repoContext.definitionRepo.save(repo.modelType, definition);
  return definition;
}

/** Saves one version of a data item owned by `model`. */
export async function saveData(
  repo: ServeRepo,
  model: Definition,
  dataName: string,
  type = "resource",
): Promise<Data> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type, modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode(JSON.stringify({ value: dataName })),
  );
  return data;
}

/**
 * Saves one version of a data item owned by `model` as step output of `run`,
 * recording the run, job and step the catalog indexes for data query.
 */
export async function saveRunStepData(
  repo: ServeRepo,
  model: Definition,
  run: WorkflowRun,
  dataName: string,
): Promise<Data> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: model.name },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
      workflowId: run.workflowId,
      workflowRunId: run.id,
      workflowName: run.workflowName,
      jobName: "main",
      stepName: "noop",
      source: "step-output",
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode(JSON.stringify({ value: dataName })),
  );
  return data;
}

/**
 * Saves one version of a workflow-scope data item — as a workflow-scope
 * report writes one — stored under the workflow itself.
 */
export async function saveWorkflowData(
  repo: ServeRepo,
  workflow: Workflow,
  dataName: string,
): Promise<Data> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "report", reportScope: "workflow", modelName: workflow.name },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: `workflow:${workflow.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    ModelType.create("workflow"),
    workflow.id,
    data,
    new TextEncoder().encode(JSON.stringify({ value: dataName })),
  );
  return data;
}

/**
 * Saves a succeeded run of `workflow` whose single step recorded `stepData`
 * and whose run recorded `workflowData` as workflow-scope artifacts.
 */
export async function saveRunWithData(
  repo: ServeRepo,
  workflow: Workflow,
  stepData: Data[],
  workflowData: Data[] = [],
): Promise<WorkflowRun> {
  const artifact = (data: Data) => ({
    dataId: data.id,
    name: data.name,
    version: data.version,
    tags: { ...data.tags },
  });
  const created = WorkflowRun.create(workflow).toData();
  const run = WorkflowRun.fromData({
    ...created,
    status: "succeeded",
    jobs: created.jobs.map((job, j) => ({
      ...job,
      status: "succeeded",
      steps: job.steps.map((step, i) => ({
        ...step,
        status: "succeeded",
        dataArtifacts: j === 0 && i === 0 ? stepData.map(artifact) : [],
      })),
    })),
    workflowDataArtifacts: workflowData.map(artifact),
  });
  await repo.repoContext.workflowRunRepo.save(workflow.id, run);
  return run;
}

/** Saves a workflow with one job whose one step runs `model`'s noop method. */
export async function saveWorkflow(
  repo: ServeRepo,
  name: string,
  model: Definition,
  tags: Record<string, string> = {},
): Promise<Workflow> {
  const workflow = Workflow.create({
    name,
    tags,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "noop",
            task: StepTask.modelMethod(model.name, "noop"),
          }),
        ],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  return workflow;
}

/** Saves a workflow that suspends at a manual approval gate named `gate`. */
export async function saveGatedWorkflow(
  repo: ServeRepo,
  name: string,
  gate: string,
  tags: Record<string, string> = {},
): Promise<Workflow> {
  const workflow = Workflow.create({
    name,
    tags,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: gate,
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  return workflow;
}

/**
 * Outputs are filed by their model and start time, so each saved output
 * starts a second after the last: none overwrites another, and the latest
 * saved is the latest output.
 */
let outputSequence = 0;

/**
 * Saves a succeeded `noop` output of `model` whose artifacts are its `state`
 * data item and a `log` item tagged as a log, saving either first if the
 * model has none yet. Pass `id` to choose the output id, for prefix and
 * ambiguity cases.
 */
export async function saveOutput(
  repo: ServeRepo,
  model: Definition,
  id?: string,
): Promise<ModelOutput> {
  const dataRepo = repo.repoContext.unifiedDataRepo;
  const artifacts = [];
  for (const [name, type] of [["state", "resource"], ["log", "log"]]) {
    if (!await dataRepo.findByName(repo.modelType, model.id, name)) {
      await saveData(repo, model, name, type);
    }
    const data = await dataRepo.findByName(repo.modelType, model.id, name);
    artifacts.push({
      dataId: data!.id,
      name,
      version: data!.version,
      tags: { ...data!.tags },
    });
  }
  const output = ModelOutput.create({
    id,
    definitionId: model.id,
    methodName: "noop",
    status: "succeeded",
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, outputSequence++)),
    provenance: {
      definitionHash: "hash",
      modelVersion: "2026.01.01.1",
      triggeredBy: "manual",
    },
    artifacts: { dataArtifacts: artifacts },
  });
  await repo.repoContext.outputRepo.save(repo.modelType, "noop", output);
  return output;
}

/**
 * Saves a pending run of `workflow`. Pass `id` to choose the run id, for
 * prefix and ambiguity cases.
 */
export async function saveRun(
  repo: ServeRepo,
  workflow: Workflow,
  id?: string,
): Promise<WorkflowRun> {
  const created = WorkflowRun.create(workflow);
  const run = id ? WorkflowRun.fromData({ ...created.toData(), id }) : created;
  await repo.repoContext.workflowRunRepo.save(workflow.id, run);
  return run;
}
