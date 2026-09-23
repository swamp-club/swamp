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
import { dirname } from "@std/path";
import {
  applyTriggerOverrides,
  handleWorkflowHistoryGet,
  handleWorkflowRunSearch,
  handleWorkflowSearch,
  resolveWorkflowFields,
  WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
} from "./workflow_handlers.ts";
import "../../domain/models/models.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { ConnectionContext } from "./shared.ts";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import type { ServeConfigFile } from "../serve_config.ts";
import type { TriggerOverride } from "../../libswamp/mod.ts";

function makeWorkflowRepo(
  workflows: Map<string, Workflow>,
): WorkflowRepository {
  return {
    findByName: (name: string) => Promise.resolve(workflows.get(name) ?? null),
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;
}

Deno.test("resolveWorkflowFields: returns tags when workflow has them", async () => {
  const wf = Workflow.create({
    name: "tagged-workflow",
    tags: { env: "staging", team: "ops" },
  });
  const repo = makeWorkflowRepo(new Map([["tagged-workflow", wf]]));

  const fields = await resolveWorkflowFields(repo, "tagged-workflow");

  assertEquals(fields.name, "tagged-workflow");
  assertEquals(fields.tags, { env: "staging", team: "ops" });
});

Deno.test("resolveWorkflowFields: omits tags when workflow has none", async () => {
  const wf = Workflow.create({ name: "plain-workflow" });
  const repo = makeWorkflowRepo(new Map([["plain-workflow", wf]]));

  const fields = await resolveWorkflowFields(repo, "plain-workflow");

  assertEquals(fields.name, "plain-workflow");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveWorkflowFields: falls back to name-only when workflow not found", async () => {
  const repo = makeWorkflowRepo(new Map());

  const fields = await resolveWorkflowFields(repo, "missing-workflow");

  assertEquals(fields.name, "missing-workflow");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveWorkflowFields: falls back to findById when findByName returns null", async () => {
  const wf = Workflow.create({
    id: "abc-123",
    name: "id-workflow",
    tags: { env: "prod" },
  });
  const repo = {
    findByName: () => Promise.resolve(null),
    findById: (id: unknown) =>
      Promise.resolve(String(id) === "abc-123" ? wf : null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;

  const fields = await resolveWorkflowFields(repo, "abc-123");

  assertEquals(fields.name, "id-workflow");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveWorkflowFields: falls back to name-only when repo throws", async () => {
  const repo = {
    findByName: () => Promise.reject(new Error("PermissionDenied")),
    findById: () => Promise.reject(new Error("PermissionDenied")),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;

  const fields = await resolveWorkflowFields(repo, "erroring-workflow");

  assertEquals(fields.name, "erroring-workflow");
  assertEquals(fields.tags, undefined);
});

// ── applyTriggerOverrides ────────────────────────────────────────────

Deno.test("applyTriggerOverrides: calls updateTriggerOverrides with overrides from config", async () => {
  let capturedOverrides: ReadonlyMap<string, TriggerOverride> | undefined;
  const ctx = {
    scheduledExecution: {
      updateTriggerOverrides: (
        overrides: ReadonlyMap<string, TriggerOverride>,
      ) => {
        capturedOverrides = overrides;
        return Promise.resolve(1);
      },
    },
  } as unknown as ConnectionContext;

  const config: ServeConfigFile = {
    triggers: {
      "daily-report": { schedule: "0 8 * * 1-5" },
      "scan-cves": { schedule: "0 3 * * *", inputs: { channel: "#sec" } },
    },
  };

  await applyTriggerOverrides(ctx, config);

  assertEquals(capturedOverrides?.size, 2);
  assertEquals(capturedOverrides?.get("daily-report"), {
    schedule: "0 8 * * 1-5",
  });
  assertEquals(capturedOverrides?.get("scan-cves"), {
    schedule: "0 3 * * *",
    inputs: { channel: "#sec" },
  });
});

Deno.test("applyTriggerOverrides: passes empty map when config has no triggers", async () => {
  let capturedOverrides: ReadonlyMap<string, TriggerOverride> | undefined;
  const ctx = {
    scheduledExecution: {
      updateTriggerOverrides: (
        overrides: ReadonlyMap<string, TriggerOverride>,
      ) => {
        capturedOverrides = overrides;
        return Promise.resolve(0);
      },
    },
  } as unknown as ConnectionContext;

  await applyTriggerOverrides(ctx, {});

  assertEquals(capturedOverrides?.size, 0);
});

Deno.test("applyTriggerOverrides: skips when scheduledExecution is undefined", async () => {
  const ctx = {} as unknown as ConnectionContext;
  await applyTriggerOverrides(ctx, {
    triggers: { w: { schedule: "* * * * *" } },
  });
});

Deno.test("applyTriggerOverrides: catches and logs errors from updateTriggerOverrides", async () => {
  const ctx = {
    scheduledExecution: {
      updateTriggerOverrides: () => {
        return Promise.reject(new Error("scheduler boom"));
      },
    },
  } as unknown as ConnectionContext;

  await applyTriggerOverrides(ctx, {
    triggers: { w: { schedule: "* * * * *" } },
  });
});

// ── workflow.search / workflow.run.search pagination ─────────────────────

interface SentFrame {
  type: string;
  payload?: {
    data: { results?: Array<Record<string, unknown>> };
    total?: number;
  };
  error?: { code: string };
}

function makeSearchSocket(): { socket: WebSocket; frames: SentFrame[] } {
  const frames: SentFrame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;
  return { socket, frames };
}

const searchAuthBase: Omit<ServeAuthConfig, "mode"> = {
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
};

const searchPrincipal: Principal = { kind: "user", id: "reader" };

function readGrant(id: string, pattern: string): Grant {
  return {
    id,
    effect: "allow",
    state: "active",
    source: "method",
    subject: { kind: "user", name: "reader" },
    actions: ["read"],
    resource: { kind: "workflow", pattern },
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * Five workflows, wf-0 (newest runs) … wf-4, `runsPerWorkflow` runs each;
 * wf-i has i + 1 steps.
 * With `grants` the context enforces token-mode authorization; without,
 * mode none.
 */
function makeSearchCtx(
  grants?: Grant[],
  runsPerWorkflow = 1,
): ConnectionContext {
  const workflows = [0, 1, 2, 3, 4].map((i) => ({
    id: crypto.randomUUID(),
    name: `wf-${i}`,
    jobs: [{ steps: Array.from({ length: i + 1 }, () => ({})) }],
  }));
  const ctx: Record<string, unknown> = {
    authConfig: { ...searchAuthBase, mode: grants ? "token" : "none" },
    repoContext: {
      workflowRepo: { findAll: () => Promise.resolve(workflows) },
      workflowRunRepo: {
        findAllSummariesFromIndex: (workflowId: string) => {
          const i = workflows.findIndex((w) => w.id === workflowId);
          return Promise.resolve(
            Array.from({ length: runsPerWorkflow }, (_, r) => ({
              id: crypto.randomUUID(),
              workflowId,
              workflowName: workflows[i].name,
              status: "succeeded",
              startedAt: new Date(Date.UTC(2026, 0, 10 - i, 0, 0, r)),
              tags: {},
              inputs: {},
            })),
          );
        },
      },
    },
  };
  if (grants) {
    const snapshot = new PolicySnapshot(grants, []);
    ctx.policySnapshotLoader = {
      snapshot,
      decisionService: new GrantBasedAccessDecisionService(snapshot),
    } as unknown as PolicySnapshotLoader;
  }
  return ctx as unknown as ConnectionContext;
}

function names(frame: SentFrame, key: string): unknown[] {
  return (frame.payload?.data.results ?? []).map((r) => r[key]);
}

Deno.test("handleWorkflowSearch: pages with offset and limit and reports total", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowSearch(
    socket,
    makeSearchCtx(),
    "req-1",
    new AbortController(),
    null,
    { offset: 1, limit: 2 },
  );

  assertEquals(frames.length, 1);
  assertEquals(names(frames[0], "name"), ["wf-1", "wf-2"]);
  assertEquals(names(frames[0], "stepCount"), [2, 3]);
  assertEquals(frames[0].payload?.total, 5);
});

Deno.test("handleWorkflowSearch: returns every workflow when no limit is sent", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowSearch(
    socket,
    makeSearchCtx(),
    "req-2",
    new AbortController(),
    null,
  );

  assertEquals(names(frames[0], "name").length, 5);
  assertEquals(frames[0].payload?.total, 5);
});

Deno.test("handleWorkflowSearch: pages after authorization so hidden workflows do not shorten a page", async () => {
  const { socket, frames } = makeSearchSocket();
  // wf-1 is not granted; a page of two must still hold two readable items.
  const ctx = makeSearchCtx([
    readGrant("g0", "wf-0"),
    readGrant("g2", "wf-2"),
    readGrant("g3", "wf-3"),
  ]);
  await handleWorkflowSearch(
    socket,
    ctx,
    "req-3",
    new AbortController(),
    searchPrincipal,
    { offset: 0, limit: 2 },
  );

  assertEquals(names(frames[0], "name"), ["wf-0", "wf-2"]);
  assertEquals(frames[0].payload?.total, 3);
});

Deno.test("handleWorkflowRunSearch: pages newest-first runs and reports total beside data", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSearch(
    socket,
    makeSearchCtx(),
    "req-4",
    new AbortController(),
    null,
    { offset: 2, limit: 2 },
  );

  assertEquals(frames.length, 1);
  assertEquals(names(frames[0], "workflowName"), ["wf-2", "wf-3"]);
  assertEquals(frames[0].payload?.total, 5);
  assertEquals("total" in (frames[0].payload?.data ?? {}), false);
});

Deno.test("handleWorkflowRunSearch: pages after authorization", async () => {
  const { socket, frames } = makeSearchSocket();
  const ctx = makeSearchCtx([
    readGrant("g1", "wf-1"),
    readGrant("g3", "wf-3"),
    readGrant("g4", "wf-4"),
  ]);
  await handleWorkflowRunSearch(
    socket,
    ctx,
    "req-5",
    new AbortController(),
    searchPrincipal,
    { offset: 1, limit: 5 },
  );

  assertEquals(names(frames[0], "workflowName"), ["wf-3", "wf-4"]);
  assertEquals(frames[0].payload?.total, 3);
});

Deno.test("handleWorkflowRunSearch: applies the default limit when none is sent", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSearch(
    socket,
    makeSearchCtx(undefined, 101),
    "req-6",
    new AbortController(),
    null,
  );

  assertEquals(
    names(frames[0], "runId").length,
    WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
  );
  assertEquals(frames[0].payload?.total, 505);
});

// --- workflow.history.get step outputs ---

const HISTORY_MODEL_TYPE = "command/shell";
const WRITER_ID = "0b8a3c1e-4f1d-4c7a-9a55-000000000001";
const SECRETS_ID = "0b8a3c1e-4f1d-4c7a-9a55-000000000002";

async function withHistoryRepo(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function historyResource(name: string, modelId: string, modelName: string) {
  return {
    id: `data-${name}`,
    name,
    version: 1,
    modelType: HISTORY_MODEL_TYPE,
    modelId,
    modelName,
    specName: "result",
    contentType: "application/json",
    tags: {},
    attributes: null,
    content: null,
  };
}

/**
 * Persists a run of `history-wf` whose one step wrote a resource for the
 * `writer` model and one for the `secrets` model, with their contents in the
 * datastore, and returns the workflow.
 */
async function seedHistoryRun(dir: string): Promise<Workflow> {
  const workflow = Workflow.create({
    name: "history-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "write",
            task: StepTask.model("writer", "execute"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("write")!;
  step.start();
  step.succeed({
    type: "model_method",
    model: "writer",
    method: "execute",
    resources: {
      result: {
        record: historyResource("record", WRITER_ID, "writer"),
        token: historyResource("token", SECRETS_ID, "secrets"),
      },
    },
  });
  job.succeed();
  run.complete();
  await new YamlWorkflowRunRepository(dir).save(workflow.id, run);

  const catalogStore = createCatalogStore(dir);
  try {
    const dataRepo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalogStore,
    );
    const contents: Array<[string, string, Record<string, unknown>]> = [
      [WRITER_ID, "record", { stdout: "hello" }],
      [SECRETS_ID, "token", { apiKey: "not-for-you" }],
    ];
    for (const [modelId, name, attributes] of contents) {
      const path = dataRepo.getContentPath(
        ModelType.create(HISTORY_MODEL_TYPE),
        modelId,
        name,
        1,
      );
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, JSON.stringify(attributes));
    }
  } finally {
    catalogStore.close();
  }
  return workflow;
}

function makeHistoryCtx(
  dir: string,
  workflow: Workflow,
  grants?: Grant[],
): ConnectionContext {
  const definitionNames: Record<string, string> = {
    [WRITER_ID]: "writer",
    [SECRETS_ID]: "secrets",
  };
  const ctx: Record<string, unknown> = {
    repoDir: dir,
    authConfig: { ...searchAuthBase, mode: grants ? "token" : "none" },
    repoContext: {
      workflowRepo: makeWorkflowRepo(new Map([[workflow.name, workflow]])),
      definitionRepo: {
        findByNameGlobal: () => Promise.resolve(null),
        findById: (_type: unknown, id: string) =>
          Promise.resolve(
            definitionNames[id]
              ? { name: definitionNames[id], tags: {} }
              : null,
          ),
      },
    },
  };
  if (grants) {
    const snapshot = new PolicySnapshot(grants, []);
    ctx.policySnapshotLoader = {
      snapshot,
      decisionService: new GrantBasedAccessDecisionService(snapshot),
    } as unknown as PolicySnapshotLoader;
  }
  return ctx as unknown as ConnectionContext;
}

function grantFor(id: string, kind: string, pattern: string): Grant {
  return {
    ...readGrant(id, pattern),
    resource: { kind, pattern },
  } as Grant;
}

interface HistoryFrame {
  type: string;
  payload?: {
    data: {
      jobs: Array<{ steps: Array<{ outputs?: Record<string, unknown> }> }>;
    };
  };
  error?: { code: string };
}

async function historyGet(
  ctx: ConnectionContext,
  principal: Principal | null,
): Promise<HistoryFrame> {
  const frames: HistoryFrame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;
  await handleWorkflowHistoryGet(
    socket,
    ctx,
    "req-history",
    { workflowIdOrName: "history-wf" },
    new AbortController(),
    principal,
  );
  assertEquals(frames.length, 1);
  return frames[0];
}

Deno.test("handleWorkflowHistoryGet: returns step outputs read from the datastore", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);

    const frame = await historyGet(makeHistoryCtx(dir, workflow), null);

    assertEquals(frame.payload?.data.jobs[0].steps[0].outputs, {
      stdout: "hello",
      apiKey: "not-for-you",
    });
  });
});

Deno.test("handleWorkflowHistoryGet: leaves out outputs of models the principal cannot read as data", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const ctx = makeHistoryCtx(dir, workflow, [
      grantFor("wf", "workflow", "history-wf"),
      grantFor("writer-data", "data", "writer"),
    ]);

    const frame = await historyGet(ctx, searchPrincipal);

    assertEquals(frame.payload?.data.jobs[0].steps[0].outputs, {
      stdout: "hello",
    });
  });
});

Deno.test("handleWorkflowHistoryGet: a principal with no data read sees no outputs", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const ctx = makeHistoryCtx(dir, workflow, [
      grantFor("wf", "workflow", "history-wf"),
    ]);

    const frame = await historyGet(ctx, searchPrincipal);

    assertEquals(frame.type, "workflow.history.get");
    assertEquals(frame.payload?.data.jobs[0].steps[0].outputs, undefined);
  });
});
