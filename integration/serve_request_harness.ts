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
 * drives serve requests through `handleMessage`, the real dispatch path,
 * against a real repository on disk; shared by the request characterization and
 * id-deny conformance tests
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

export interface ServeRequest {
  type: string;
  id: string;
  payload?: Record<string, unknown>;
}

export type Frame = Record<string, unknown> & {
  type: string;
  id?: string;
  error?: { code: string; message: string };
  payload?: Record<string, unknown>;
};

export interface ServeRepo {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: ConnectionContext["datastoreConfig"];
  datastoreResolver: ConnectionContext["datastoreResolver"];
  modelType: ModelType;
}

export interface ServeRepoOptions {
  scopedType?: boolean;
}

export const CALLER: Principal = { kind: "user", id: "caller" };

/**
 * the model type is registered per run (crypto.randomUUID) so deno test
 * --repeats re-exercises it
 */
export async function withServeRepo(
  fn: (repo: ServeRepo) => Promise<void>,
  options: ServeRepoOptions = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-requests-" });
  const modelType = ModelType.create(
    `${options.scopedType ? "@" : ""}test/serve-${
      crypto.randomUUID().slice(0, 8)
    }`,
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

export interface ServeCtxOptions {
  detached?: boolean;
  syncService?: ConnectionContext["syncService"];
  syncGate?: ConnectionContext["syncGate"];
  runTracker?: ConnectionContext["runTracker"];
  managedDefinitionsDir?: ConnectionContext["managedDefinitionsDir"];
  vaultsDir?: ConnectionContext["vaultsDir"];
  /**
   * a specific active run registry for a test that must see runs it registered
   * itself; takes precedence over `detached`
   */
  activeRunRegistry?: ConnectionContext["activeRunRegistry"];
  restrictedModelTypes?: string[];
  /** serve's `tag-requires-explicit-grant`: a `write` grant does not imply `tag` */
  tagRequiresExplicitGrant?: boolean;
}

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
    restrictedModelTypes: options.restrictedModelTypes ?? [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
    signalRequiresExplicitGrant: false,
    tagRequiresExplicitGrant: options.tagRequiresExplicitGrant ?? false,
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
            { writeImpliesTag: !authConfig.tagRequiresExplicitGrant },
          ),
        } as unknown as PolicySnapshotLoader,
      }
      : {}),
  } as ConnectionContext;
}

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
  await handleMessage(
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

export function errorFrame(frames: Frame[]): Frame | undefined {
  return frames.find((frame) => frame.type === "error");
}

export async function saveModel(
  repo: ServeRepo,
  name: string,
  tags: Record<string, string> = {},
): Promise<Definition> {
  const definition = Definition.create({ name, globalArguments: {}, tags });
  await repo.repoContext.definitionRepo.save(repo.modelType, definition);
  return definition;
}

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

export const OVER_FRAME_LIMIT_BYTES = 64 * 1024 * 1024 + 1024;

export async function saveLargeText(repo: ServeRepo): Promise<void> {
  const model = await saveModel(repo, "big-model");
  const data = Data.create({
    name: "big",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode("x".repeat(OVER_FRAME_LIMIT_BYTES)),
  );
}
