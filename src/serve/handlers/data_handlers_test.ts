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

import { assertEquals } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { join, SEPARATOR } from "@std/path";
import {
  handleDataDelete,
  handleDataGc,
  handleDataGet,
  handleDataList,
  handleDataPrune,
  handleDataRename,
  handleDataVersions,
  handleRunGc,
  resolveRunGcInput,
} from "./data_handlers.ts";
import type { ConnectionContext } from "./shared.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { walk } from "@std/fs";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import { Data } from "../../domain/data/mod.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { createModelLock } from "../../cli/repo_context.ts";

Deno.test("resolveRunGcInput: uses repository retention when request omits it", () => {
  assertEquals(
    resolveRunGcInput(undefined, { workflowRuns: "2w", outputs: "1d" }),
    {
      dryRun: false,
      workflowRunRetentionDays: 14,
      outputRetentionDays: 1,
    },
  );
});

Deno.test("resolveRunGcInput: auto-definition retention comes from the repository only", () => {
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 3, outputRetentionDays: 2 },
      { autoDefinitions: "60d" },
    ).autoDefinitionRetentionDays,
    60,
  );
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 3, outputRetentionDays: 2 },
      { retention: "30d" },
    ).autoDefinitionRetentionDays,
    undefined,
  );
});

Deno.test("resolveRunGcInput: request retention overrides repository retention", () => {
  assertEquals(
    resolveRunGcInput(
      { dryRun: true, workflowRunRetentionDays: 3, outputRetentionDays: 2 },
      { workflowRuns: "2w", outputs: "1d" },
    ),
    {
      dryRun: true,
      workflowRunRetentionDays: 3,
      outputRetentionDays: 2,
    },
  );
});

Deno.test("resolveRunGcInput: a request retention of 0 is kept, not replaced by the policy", () => {
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 0, outputRetentionDays: 0 },
      { workflowRuns: "2w", outputs: "1d" },
    ),
    {
      dryRun: false,
      workflowRunRetentionDays: 0,
      outputRetentionDays: 0,
    },
  );
});

Deno.test("resolveRunGcInput: output policy survives a workflow-only request override", () => {
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 3 },
      { workflowRuns: "2w", outputs: "1d" },
    ),
    {
      dryRun: false,
      workflowRunRetentionDays: 3,
      outputRetentionDays: 1,
    },
  );
});

Deno.test("resolveRunGcInput: omitted output policy uses the output default", () => {
  assertEquals(
    resolveRunGcInput(undefined, { workflowRuns: "2w" }),
    {
      dryRun: false,
      workflowRunRetentionDays: 14,
      outputRetentionDays: 30,
    },
  );
});

Deno.test("resolveRunGcInput: resolves retention and evaluatedSnapshots from the policy", () => {
  assertEquals(
    resolveRunGcInput(undefined, {
      retention: "1w",
      evaluatedSnapshots: "3d",
    }),
    {
      dryRun: false,
      workflowRunRetentionDays: 7,
      outputRetentionDays: 7,
      evaluatedSnapshotRetentionDays: 3,
    },
  );
});

Deno.test("resolveRunGcInput: a request run retention drops the snapshot retention", () => {
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 2 },
      { retention: "1w", evaluatedSnapshots: "3d" },
    ),
    {
      dryRun: false,
      workflowRunRetentionDays: 2,
      outputRetentionDays: 7,
    },
  );
});

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

function createMockSyncService(pushError?: Error): {
  service: DatastoreSyncService;
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
} {
  const pushCalls: DatastoreSyncOptions[] = [];
  const markDirtyCalls: DatastoreSyncOptions[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      pushCalls.push(options ?? {});
      return pushError ? Promise.reject(pushError) : Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      markDirtyCalls.push(options ?? {});
      return Promise.resolve();
    },
  };
  return { service, pushCalls, markDirtyCalls };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

const SYNC_TEST_TYPE = ModelType.create("command/shell");

interface SyncFixture {
  ctx: ConnectionContext;
  dataRepo: FileSystemUnifiedDataRepository;
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
}

async function createSyncFixture(
  dir: string,
  options: { syncService?: boolean; pushError?: Error } = {},
): Promise<SyncFixture> {
  const { service, pushCalls, markDirtyCalls } = createMockSyncService(
    options.pushError,
  );
  const withSync = options.syncService ?? true;
  const markDirty = withSync
    ? (relPath?: string) => service.markDirty(relPath ? { relPath } : undefined)
    : undefined;

  const definitionRepo = new YamlDefinitionRepository(dir);
  const definition = Definition.create({
    name: "sync-model",
    globalArguments: {},
  });
  await definitionRepo.save(SYNC_TEST_TYPE, definition);

  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    new CatalogStore(":memory:"),
    markDirty,
  );
  await dataRepo.save(
    SYNC_TEST_TYPE,
    definition.id,
    Data.create({
      name: "result",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "resource" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "command/shell:execute",
      },
    }),
    new TextEncoder().encode("hello"),
  );
  markDirtyCalls.length = 0;

  const ctx = {
    repoDir: dir,
    repoContext: {
      definitionRepo,
      unifiedDataRepo: dataRepo,
      markDirty,
    } as unknown as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "custom",
      provider: "test",
      namespace: "shared",
      config: {},
      datastorePath: "/tmp/test-datastore",
    } as unknown as ConnectionContext["datastoreConfig"],
    datastoreResolver: undefined,
    syncService: withSync ? service : undefined,
    authConfig: {
      mode: "none" as const,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
  } as unknown as ConnectionContext;

  return { ctx, dataRepo, pushCalls, markDirtyCalls };
}

Deno.test("handleDataDelete: pushes the deletion after per-path markDirty (no bare override)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls, markDirtyCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "data.delete");
    assertEquals(response.payload.data.versionsDeleted, 1);

    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
    const bareCalls = markDirtyCalls.filter((c) => !c.relPath);
    assertEquals(bareCalls.length, 0, "bare markDirty() must not be called");
    // full delete emits per-version-directory signals plus a latest marker, not
    // one data-name signal; the fixture passes absolute paths with the platform
    // separator, normalized in the repo_context wiring
    assertEquals(
      markDirtyCalls.some((c) => c.relPath?.includes(`result${SEPARATOR}`)),
      true,
      "repo must mark deleted version directories and latest marker dirty",
    );
  });
});

Deno.test("handleDataDelete: pushes the deletion when the request is cancelled", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();
    const controller = new AbortController();
    controller.abort();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-cancelled",
      { modelIdOrName: "sync-model", dataName: "result" },
      controller,
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).error.code, "cancelled");
    assertEquals(pushCalls.length, 1);
  });
});

Deno.test("handleDataDelete: a failed push is logged and the delete still succeeds", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir, {
      pushError: new Error("s3 unavailable"),
    });
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-push-fail",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    assertEquals(socket.sent.length, 1);
    assertEquals(JSON.parse(socket.sent[0]).type, "data.delete");
    assertEquals(pushCalls.length, 1);
  });
});

Deno.test("handleDataDelete: works without syncService (local-only mode)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, dataRepo } = await createSyncFixture(dir, {
      syncService: false,
    });
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-local",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.delete");
    const definition = await ctx.repoContext.definitionRepo.findByNameGlobal(
      "sync-model",
    );
    assertEquals(
      await dataRepo.listVersions(
        SYNC_TEST_TYPE,
        definition!.definition.id,
        "result",
      ),
      [],
    );
  });
});

Deno.test("handleDataRename: pushes after rename", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataRename(
      socket,
      ctx,
      "req-rename",
      { modelIdOrName: "sync-model", oldName: "result", newName: "renamed" },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.rename");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleDataGc: pushes after gc", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataGc(
      socket,
      ctx,
      "req-gc",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.gc");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleDataPrune: pushes after prune", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataPrune(
      socket,
      ctx,
      "req-prune",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.prune");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleRunGc: pushes after run gc", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleRunGc(
      socket,
      ctx,
      "req-run-gc",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "run.gc");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleDataGet: forwards reason and entity type for a missing version", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = await createSyncFixture(dir, { syncService: false });
    const socket = createMockSocket();

    await handleDataGet(
      socket,
      ctx,
      "req-get",
      { modelIdOrName: "sync-model", dataName: "result", version: 7 },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "error");
    assertEquals(response.error.code, "data_get_failed");
    assertEquals(response.error.details, {
      reason: "not_found",
      entityType: "Data",
    });
  });
});

Deno.test("handleDataGet: forwards entity type Model for an unknown model", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = await createSyncFixture(dir, { syncService: false });
    const socket = createMockSocket();

    await handleDataGet(
      socket,
      ctx,
      "req-get-model",
      { modelIdOrName: "no-such-model", dataName: "result" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.error.code, "data_get_failed");
    assertEquals(response.error.details, {
      reason: "not_found",
      entityType: "Model",
    });
  });
});

Deno.test("handleDataGet: returns the requested version without error details", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = await createSyncFixture(dir, { syncService: false });
    const socket = createMockSocket();

    await handleDataGet(
      socket,
      ctx,
      "req-get-ok",
      { modelIdOrName: "sync-model", dataName: "result", version: 1 },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "data.get");
    assertEquals(response.payload.data.version, 1);
    assertEquals(response.payload.data.content, "hello");
  });
});

Deno.test("handleDataGet: logs the original of an error it withholds from the client (swamp-club#3465)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, dataRepo } = await createSyncFixture(dir, {
      syncService: false,
    });
    const original =
      "Permission denied (os error 13): readfile '/tmp/repo/.swamp/data/raw'";
    dataRepo.getContent = () => Promise.reject(new Error(original));
    const socket = createMockSocket();

    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => records.push(record) },
      loggers: [
        {
          category: ["serve", "error"],
          lowestLevel: "warning",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    try {
      await handleDataGet(
        socket,
        ctx,
        "req-get-withheld",
        { modelIdOrName: "sync-model", dataName: "result", version: 1 },
        new AbortController(),
        null,
      );
    } finally {
      await reset();
    }

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "error");
    assertEquals(response.error.code, "data_get_failed");
    assertEquals(response.error.message, "An internal error occurred");
    assertEquals(records.length, 1);
    assertEquals(records[0].properties.message, original);
  });
});

Deno.test("handleDataVersions: forwards reason and entity type for unknown data", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = await createSyncFixture(dir, { syncService: false });
    const socket = createMockSocket();

    await handleDataVersions(
      socket,
      ctx,
      "req-versions",
      { modelIdOrName: "sync-model", dataName: "missing" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.error.code, "data_versions_failed");
    assertEquals(response.error.details, {
      reason: "not_found",
      entityType: "Data",
    });
  });
});

Deno.test("handleDataList: forwards reason and entity type for an unknown model", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = await createSyncFixture(dir, { syncService: false });
    const socket = createMockSocket();

    await handleDataList(
      socket,
      ctx,
      "req-list",
      { modelIdOrName: "no-such-model" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.error.code, "data_list_failed");
    assertEquals(response.error.details, {
      reason: "not_found",
      entityType: "Model",
    });
  });
});

Deno.test("handleRunGc: where members forward records, a caller's own cut-off needs admin on every workflow; the configured policy and a dry run still need only write (swamp-club#4290)", async () => {
  const gcAs = async (
    options: {
      forwards: boolean;
      actions: Grant["actions"];
      payload: Parameters<typeof handleRunGc>[3];
    },
  ) => {
    let outcome: { type: string; kept: boolean } | undefined;
    await withTempDir(async (dir) => {
      const { ctx } = await createSyncFixture(dir);
      const workflow = Workflow.create({
        name: "gc-wf",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "gate",
                task: StepTask.model("writer", "execute"),
              }),
            ],
          }),
        ],
      });
      const run = WorkflowRun.create(workflow);
      run.start();
      run.getJob("main")!.getStep("gate")!.recordApprovalDecision({
        approved: true,
        decidedBy: "user:approver",
        decidedAt: "2020-01-01T00:00:00.000Z",
      });
      run.complete();
      const old = WorkflowRun.fromData({
        ...run.toData(),
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T00:00:00.000Z",
      });
      const runRepo = new YamlWorkflowRunRepository(dir);
      await runRepo.save(createWorkflowId(workflow.id), old);
      for await (const entry of walk(dir, { includeDirs: false })) {
        if (entry.name === `workflow-run-${run.id}.yaml`) {
          await Deno.utime(
            entry.path,
            new Date(2020, 0, 1),
            new Date(2020, 0, 1),
          );
        }
      }
      const grant = (kind: "data" | "workflow"): Grant => ({
        id: crypto.randomUUID(),
        subject: { kind: "user", name: "member" },
        effect: "allow",
        actions: options.actions,
        resource: { kind, pattern: "*" },
        state: "active",
        source: "method",
        createdBy: { kind: "user", id: "admin" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const authed = ctx as unknown as Record<string, unknown>;
      authed.authConfig = {
        ...(authed.authConfig as Record<string, unknown>),
        mode: "token",
      };
      authed.policySnapshotLoader = {
        decisionService: new GrantBasedAccessDecisionService(
          new PolicySnapshot(
            [grant("data"), grant("workflow")],
            [],
            createConditionEvaluator(),
          ),
        ),
      } as unknown as PolicySnapshotLoader;
      (authed.repoContext as Record<string, unknown>).takesForwardedRunRecords =
        options.forwards;
      const socket = createMockSocket();
      await handleRunGc(
        socket,
        ctx,
        "req-run-gc-guarded",
        options.payload,
        new AbortController(),
        { kind: "user", id: "member" },
      );
      outcome = {
        type: JSON.parse(socket.sent[0]).type,
        kept: (await new YamlWorkflowRunRepository(dir).findById(
          createWorkflowId(workflow.id),
          createWorkflowRunId(run.id),
        )) !== null,
      };
    });
    return outcome!;
  };
  const override = {
    dryRun: false,
    workflowRunRetentionDays: 0,
    outputRetentionDays: 0,
  };

  assertEquals(
    await gcAs({ forwards: true, actions: ["write"], payload: override }),
    { type: "error", kept: true },
  );
  assertEquals(
    await gcAs({
      forwards: true,
      actions: ["write", "admin"],
      payload: override,
    }),
    { type: "run.gc", kept: false },
  );
  assertEquals(
    await gcAs({
      forwards: true,
      actions: ["write"],
      payload: { dryRun: false },
    }),
    { type: "run.gc", kept: false },
  );
  assertEquals(
    await gcAs({
      forwards: true,
      actions: ["write"],
      payload: { ...override, dryRun: true },
    }),
    { type: "run.gc", kept: true },
  );
  assertEquals(
    await gcAs({ forwards: false, actions: ["write"], payload: override }),
    { type: "run.gc", kept: false },
  );
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function createAutoDefinitionGcFixture(dir: string) {
  await new RepoMarkerRepository().write(RepoPath.create(dir), {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
    repoId: crypto.randomUUID(),
    garbageCollection: { autoDefinitions: "30d" },
  });
  const autoDefinitionsDir = join(dir, ".swamp", "auto-definitions");
  const autoDefinitionRepo = new YamlDefinitionRepository(
    dir,
    undefined,
    autoDefinitionsDir,
    false,
  );
  const definition = Definition.create({
    name: "idle",
    type: SYNC_TEST_TYPE.normalized,
    typeVersion: "2026.01.01.1",
  });
  await autoDefinitionRepo.save(SYNC_TEST_TYPE, definition);
  const path = join(
    autoDefinitionsDir,
    SYNC_TEST_TYPE.normalized,
    "idle.yaml",
  );
  const old = new Date(Date.now() - 40 * 86_400_000);
  await Deno.utime(path, old, old);
  const idle = { definition, path };
  const datastoreConfig = {
    type: "filesystem",
    path: join(dir, ".swamp"),
  } as unknown as ConnectionContext["datastoreConfig"];
  const { ctx } = await createSyncFixture(dir, { syncService: false });
  const gcCtx = {
    ...ctx,
    datastoreConfig,
    repoContext: {
      ...ctx.repoContext,
      autoDefinitionsDir,
      autoDefinitionRepo,
      outputRepo: new YamlOutputRepository(dir),
      evaluatedDefinitionRepo: new YamlEvaluatedDefinitionRepository(dir),
      workflowRepo: { findAll: () => Promise.resolve([]) },
    },
  } as unknown as ConnectionContext;
  return { ctx: gcCtx, idle, datastoreConfig };
}

Deno.test("handleRunGc: removes idle auto-definitions when the repository sets autoDefinitions", async () => {
  await withTempDir(async (dir) => {
    const { ctx, idle } = await createAutoDefinitionGcFixture(dir);
    const socket = createMockSocket();

    await handleRunGc(
      socket,
      ctx,
      "req-run-gc",
      { dryRun: false, workflowRunRetentionDays: 1, outputRetentionDays: 1 },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.payload.data.autoDefinitionsDeleted, 1);
    assertEquals(await pathExists(idle.path), false);
  });
});

Deno.test("handleRunGc: keeps an idle auto-definition whose model lock a run holds", async () => {
  await withTempDir(async (dir) => {
    const { ctx, idle, datastoreConfig } = await createAutoDefinitionGcFixture(
      dir,
    );
    const lock = await createModelLock(
      datastoreConfig,
      SYNC_TEST_TYPE.normalized,
      idle.definition.id,
    );
    await lock.acquire();
    try {
      const socket = createMockSocket();
      await handleRunGc(
        socket,
        ctx,
        "req-run-gc",
        { dryRun: false },
        new AbortController(),
        null,
      );
      const response = JSON.parse(socket.sent[0]);
      assertEquals(response.payload.data.autoDefinitionsDeleted, 0);
      assertEquals(await pathExists(idle.path), true);
    } finally {
      await lock.release();
    }
  });
});
