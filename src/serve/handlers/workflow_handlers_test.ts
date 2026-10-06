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

import { assertEquals, assertThrows } from "@std/assert";
import { dirname } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import {
  applyTriggerOverrides,
  handleWorkflowCancel,
  handleWorkflowEdit,
  handleWorkflowHistoryGet,
  handleWorkflowRunSearch,
  handleWorkflowSearch,
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
import { type ActiveRun, ActiveRunRegistry } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import { SUSPENDED_RUN_BUSY_MESSAGE } from "../suspended_run_cancel.ts";
import { createSocketSubscriber, subscribeUntilDetach } from "./shared.ts";
import { redactingFor } from "./nested_run_redaction.ts";

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
  approveRequiresExplicitGrant: false,
  signalRequiresExplicitGrant: false,
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
      workflowRepo: {
        findAll: () => Promise.resolve(workflows),
        findById: (id: string) =>
          Promise.resolve(workflows.find((w) => w.id === id) ?? null),
        findByName: (name: string) =>
          Promise.resolve(workflows.find((w) => w.name === name) ?? null),
      },
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
        findAllGlobal: () =>
          Promise.resolve(
            Object.entries(definitionNames).map(([id, name]) => ({
              definition: { id, name, tags: {} },
              type: { normalized: "command/shell" },
            })),
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

// ── nested run links (swamp-club#2736) ─────────────────────────────────

/**
 * Persists a run of `history-wf` cancelled while its one step waited on a
 * run of `secret-wf`, which detaches the step with an error naming that run.
 */
async function seedDetachedNestedRun(
  dir: string,
  secretRunId: string,
): Promise<Workflow> {
  const workflow = Workflow.create({
    name: "history-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-child",
            task: StepTask.workflow("secret-wf"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("call-child")!;
  step.start();
  step.waitForNestedRun({
    workflowId: crypto.randomUUID(),
    workflowName: "secret-wf",
    runId: secretRunId,
  });
  run.endAsCancelled("stop");
  await new YamlWorkflowRunRepository(dir).save(workflow.id, run);
  return workflow;
}

Deno.test("handleWorkflowHistoryGet: hides a step's nested run, and the error naming it, from a principal who may not read its workflow", async () => {
  await withHistoryRepo(async (dir) => {
    const secretRunId = crypto.randomUUID();
    const workflow = await seedDetachedNestedRun(dir, secretRunId);
    const frame = await historyGet(
      makeHistoryCtx(dir, workflow, [grantFor("wf", "workflow", "history-wf")]),
      searchPrincipal,
    );
    const step = frame.payload?.data.jobs[0].steps[0] as Record<
      string,
      unknown
    >;
    assertEquals(step.nestedRun, undefined);
    assertEquals(String(step.error).includes("secret"), false);

    const shown = await historyGet(
      makeHistoryCtx(dir, workflow, [grantFor("wf", "workflow", "*")]),
      searchPrincipal,
    );
    const shownStep = shown.payload?.data.jobs[0].steps[0] as Record<
      string,
      unknown
    >;
    assertEquals(
      (shownStep.nestedRun as { runId: string }).runId,
      secretRunId,
    );
    assertEquals(String(shownStep.error).includes(secretRunId), true);
  });
});

Deno.test("createSocketSubscriber: without a transform a failed send throws to the buffer rather than escaping as a rejection", () => {
  const socket = {
    readyState: WebSocket.OPEN,
    send: () => {
      throw new Error("socket closed");
    },
  } as unknown as WebSocket;
  const subscriber = createSocketSubscriber(socket, "req-1");
  assertThrows(() => subscriber.onEvent(1, { kind: "started" }), Error);
  assertThrows(() => subscriber.onTerminal({ kind: "done" }), Error);
});

Deno.test("subscribeUntilDetach: a redacting subscriber gets every event in order without links it may not read, and leaves the buffer intact", async () => {
  const ctx = makeSearchCtx([readGrant("child", "child-wf")]);
  const buffer = new RunEventBuffer(16);
  const run = {
    id: "child-run",
    workflowId: crypto.randomUUID(),
    workflowName: "child-wf",
    status: "succeeded",
    jobs: [],
    parentRun: {
      workflowId: crypto.randomUUID(),
      workflowName: "parent-wf",
      runId: "parent-run",
      stepName: "call-child",
    },
  };
  buffer.push({ kind: "started", runId: "child-run" });
  buffer.push({ kind: "completed", run });

  const { socket, frames } = makeSearchSocket();
  const subscribed = subscribeUntilDetach(
    buffer,
    socket,
    "req-1",
    new AbortController(),
    0,
    redactingFor(ctx, socket, searchPrincipal),
  );
  buffer.finish({ kind: "done" });
  await subscribed;

  const sent = frames as unknown as Array<{
    type: string;
    event?: { kind: string; seq: number; run?: Record<string, unknown> };
  }>;
  assertEquals(sent.map((f) => f.event?.kind ?? f.type), [
    "started",
    "completed",
    "done",
  ]);
  assertEquals(sent[1].event?.seq, 2);
  assertEquals(sent[1].event?.run?.parentRun, undefined);
  assertEquals(sent[1].event?.run?.workflowName, "child-wf");

  const { socket: plain, frames: unredacted } = makeSearchSocket();
  await subscribeUntilDetach(buffer, plain, "req-2", new AbortController());
  const replayed = unredacted as unknown as Array<{
    event?: { run?: { parentRun?: { workflowName: string } } };
  }>;
  assertEquals(replayed[1].event?.run?.parentRun?.workflowName, "parent-wf");
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

Deno.test("handleWorkflowHistoryGet: forwards reason and entity type for an unknown run", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const frames: Array<{ error?: { code: string; details?: unknown } }> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (data: string) => frames.push(JSON.parse(data)),
    } as unknown as WebSocket;

    await handleWorkflowHistoryGet(
      socket,
      makeHistoryCtx(dir, workflow),
      "req-history-missing",
      { workflowIdOrName: "no-such-run" },
      new AbortController(),
      null,
    );

    assertEquals(frames[0].error?.code, "workflow_history_get_failed");
    assertEquals(frames[0].error?.details, {
      reason: "not_found",
      entityType: "Workflow run or workflow",
    });
  });
});

// --- handleWorkflowEdit (swamp-club#2426) ---

const WORKFLOW_EDITOR: Principal = { kind: "user", id: "editor" };

function workflowGrant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "editor" },
    effect: "allow",
    actions: ["write"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function editSocket(): WebSocket & { sent: string[] } {
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

/** An edit context over a real workflow repository in `repoDir`. */
function workflowEditCtx(
  repoDir: string,
  workflowRepo: YamlWorkflowRepository,
  grants?: Grant[],
): ConnectionContext {
  const ctx: Record<string, unknown> = {
    repoDir,
    repoContext: { workflowRepo },
    datastoreConfig: { type: "filesystem" },
    datastoreResolver: {},
    authConfig: { ...searchAuthBase, mode: grants ? "token" : "none" },
  };
  if (grants) {
    ctx.policySnapshotLoader = {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      ),
    } as unknown as PolicySnapshotLoader;
  }
  return ctx as unknown as ConnectionContext;
}

async function withWorkflowRepo(
  fn: (dir: string, repo: YamlWorkflowRepository) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({
    prefix: "swamp-workflow-edit-test-",
  });
  try {
    await fn(tempDir, new YamlWorkflowRepository(tempDir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function saveEditWorkflow(
  repo: YamlWorkflowRepository,
  name: string,
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
            name: "write",
            task: StepTask.model("writer", "execute"),
          }),
        ],
      }),
    ],
  });
  await repo.save(workflow);
  return workflow;
}

function workflowYaml(
  workflow: Workflow,
  overrides: Record<string, unknown> = {},
): string {
  // A JSON round trip drops the undefined fields stringifyYaml rejects.
  const data = JSON.parse(JSON.stringify(workflow.toData()));
  return stringifyYaml({ ...data, ...overrides });
}

function sentFrames(socket: { sent: string[] }) {
  return socket.sent.map((raw) => JSON.parse(raw));
}

Deno.test("handleWorkflowEdit: rejects a request without content instead of opening an editor on the server", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await saveEditWorkflow(repo, "no-content-wf");
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      workflowEditCtx(dir, repo),
      "req-no-content",
      { workflowIdOrName: "no-content-wf" },
      new AbortController(),
      null,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error.code, "invalid_request");
  });
});

Deno.test("handleWorkflowEdit: a request by id cannot sidestep a name-scoped deny", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "prod-deploy");
    const ctx = workflowEditCtx(dir, repo, [
      workflowGrant({}),
      workflowGrant({
        effect: "deny",
        resource: { kind: "workflow", pattern: "prod-*" },
      }),
    ]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-by-id",
      {
        workflowIdOrName: workflow.id,
        content: workflowYaml(workflow, { description: "edited" }),
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals(
      (await repo.findByName("prod-deploy"))?.description,
      undefined,
    );
  });
});

Deno.test("handleWorkflowEdit: a tag-conditioned deny applies to the edited workflow", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "tagged-wf", {
      env: "prod",
    });
    const ctx = workflowEditCtx(dir, repo, [
      workflowGrant({}),
      workflowGrant({ effect: "deny", condition: 'tags.env == "prod"' }),
    ]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-tag-deny",
      { workflowIdOrName: "tagged-wf", content: workflowYaml(workflow) },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
  });
});

Deno.test("handleWorkflowEdit: a retag into a denied scope sends one error and writes nothing", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "retag-wf", {
      env: "dev",
    });
    const ctx = workflowEditCtx(dir, repo, [
      workflowGrant({}),
      workflowGrant({ effect: "deny", condition: 'tags.env == "prod"' }),
    ]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-retag-denied",
      {
        workflowIdOrName: "retag-wf",
        content: workflowYaml(workflow, { tags: { env: "prod" } }),
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals((await repo.findByName("retag-wf"))?.tags, { env: "dev" });
  });
});

Deno.test("handleWorkflowEdit: an allowed rename saves the edited workflow", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "old-name");
    const ctx = workflowEditCtx(dir, repo, [workflowGrant({})]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-rename",
      {
        workflowIdOrName: "old-name",
        content: workflowYaml(workflow, { name: "new-name" }),
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "workflow.edit");
    assertEquals((await repo.findByName("new-name"))?.id, workflow.id);
  });
});

Deno.test("handleWorkflowEdit: reports an unknown workflow as not found", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      workflowEditCtx(dir, repo),
      "req-missing",
      { workflowIdOrName: "no-such-wf", content: "name: no-such-wf\n" },
      new AbortController(),
      null,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error.code, "not_found");
  });
});

// ── workflow.cancel (swamp-club#2651) ────────────────────────────────

interface CancelFrame {
  type: string;
  payload?: { data: { runId: string; workflowName: string; status: string } };
  error?: { code: string; message: string };
}

/** A registered run of `deploy` whose abort runs `onAbort`. */
function cancellableRun(
  runId: string,
  onAbort: () => void,
  kind: ActiveRun["kind"] = "workflow-resume",
): ActiveRun {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  return {
    runId,
    kind,
    resourceName: "deploy",
    buffer: new RunEventBuffer(10),
    controller,
    startedAt: new Date(),
    completion: new Promise<void>(() => {}),
    principalId: null,
  };
}

/**
 * A cancel context over `deploy`. With `suspendedRunId`, the run repository
 * holds that run persisted as suspended, as a resume leaves it when it saves
 * the run at its next gate: the cancel locates it before reserving the id.
 */
function makeCancelCtx(
  registry: ActiveRunRegistry,
  suspendedRunId?: string,
): ConnectionContext {
  const workflow = Workflow.create({ name: "deploy" });
  const suspended = suspendedRunId === undefined ? [] : [{
    run: {
      id: suspendedRunId,
      workflowId: workflow.id,
      workflowName: "deploy",
      status: "suspended",
    },
    workflowId: workflow.id,
  }];
  return {
    authConfig: { ...searchAuthBase, mode: "none" },
    activeRunRegistry: registry,
    repoContext: {
      workflowRepo: makeWorkflowRepo(new Map([["deploy", workflow]])),
      workflowRunRepo: {
        findGlobalById: (runId: string) =>
          Promise.resolve(suspended.find((s) => s.run.id === runId) ?? null),
      },
    },
  } as unknown as ConnectionContext;
}

async function cancelRun(
  registry: ActiveRunRegistry,
  runId: string,
  workflowIdOrName?: string,
  persistedSuspended = false,
): Promise<CancelFrame[]> {
  const frames: CancelFrame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;
  await handleWorkflowCancel(
    socket,
    makeCancelCtx(registry, persistedSuspended ? runId : undefined),
    "req-cancel",
    { runId, workflowIdOrName },
    new AbortController(),
    null,
  );
  return frames;
}

function abortMessage(run: ActiveRun): string | undefined {
  const reason = run.controller.signal.reason;
  return reason instanceof Error ? reason.message : undefined;
}

Deno.test("handleWorkflowCancel: reports busy when another operation takes the id as the aborted run leaves", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  const held: { release?: (() => void) | null } = {};
  const run = cancellableRun(runId, () => {
    registry.deregister(runId);
    held.release = registry.reserve(runId);
  });
  registry.register(run);

  try {
    // The aborted resume saved the run suspended at its next gate.
    const frames = await cancelRun(registry, runId, undefined, true);

    assertEquals(abortMessage(run), "cancelled by anonymous");
    assertEquals(frames.length, 1);
    assertEquals(frames[0].type, "error");
    assertEquals(frames[0].error, {
      code: "workflow_cancel_failed",
      message: SUSPENDED_RUN_BUSY_MESSAGE,
    });
  } finally {
    held.release?.();
  }
});

/**
 * A registry in which a resume registers `replacement` under the id just as
 * the cancel reserves it: after the aborted run left, before the persisted
 * cancel can claim the id.
 */
class ResumeRaceRegistry extends ActiveRunRegistry {
  replacement: ActiveRun | undefined;

  override reserve(runId: string): (() => void) | null {
    if (this.replacement) {
      this.register(this.replacement);
      this.replacement = undefined;
    }
    return super.reserve(runId);
  }
}

Deno.test("handleWorkflowCancel: aborts a run a resume registered again after the aborted run left", async () => {
  const registry = new ResumeRaceRegistry();
  const runId = crypto.randomUUID();
  const run = cancellableRun(runId, () => registry.deregister(runId));
  const replacement = cancellableRun(runId, () => {});
  registry.register(run);
  registry.replacement = replacement;

  try {
    // The aborted resume saved the run suspended at its next gate.
    const frames = await cancelRun(registry, runId, undefined, true);

    assertEquals(abortMessage(run), "cancelled by anonymous");
    assertEquals(abortMessage(replacement), "cancelled by anonymous");
    assertEquals(frames.length, 1);
    assertEquals(frames[0].payload?.data, {
      runId,
      workflowName: "deploy",
      status: "cancellation_requested",
    });
  } finally {
    registry.deregister(runId);
  }
});

Deno.test("handleWorkflowCancel: does not abort a registered method run", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  const run = cancellableRun(runId, () => {}, "method-run");
  registry.register(run);

  try {
    const frames = await cancelRun(registry, runId);

    assertEquals(run.controller.signal.aborted, false);
    assertEquals(frames[0].error, {
      code: "workflow_cancel_failed",
      message: `No cancellable run with id ${runId}`,
    });
  } finally {
    registry.deregister(runId);
  }
});

Deno.test("handleWorkflowCancel: does not abort a run of another workflow than the payload names", async () => {
  const registry = new ActiveRunRegistry();
  const runId = crypto.randomUUID();
  const run = cancellableRun(runId, () => {});
  registry.register(run);

  try {
    const frames = await cancelRun(registry, runId, "other");

    assertEquals(run.controller.signal.aborted, false);
    assertEquals(frames[0].error, {
      code: "workflow_cancel_failed",
      message: `No cancellable run with id ${runId}`,
    });
  } finally {
    registry.deregister(runId);
  }
});

Deno.test("handleWorkflowCancel: a run id that is not a UUID gets the not-found reply without a repository read", async () => {
  const registry = new ActiveRunRegistry();
  const ctx = makeCancelCtx(registry);
  const unreachable = () => {
    throw new Error("a malformed run id must not reach a repository");
  };
  (ctx.repoContext as unknown as Record<string, unknown>).workflowRepo = {
    findByName: unreachable,
    findById: unreachable,
    findAll: unreachable,
  };
  (ctx.repoContext as unknown as Record<string, unknown>).workflowRunRepo = {
    findById: unreachable,
    findGlobalById: unreachable,
    findGlobalByStatus: unreachable,
  };

  for (const runId of ["-", "../x", "not-a-uuid"]) {
    for (const workflowIdOrName of [undefined, "deploy"]) {
      const frames: CancelFrame[] = [];
      const socket = {
        readyState: WebSocket.OPEN,
        send: (data: string) => frames.push(JSON.parse(data)),
      } as unknown as WebSocket;

      await handleWorkflowCancel(
        socket,
        ctx,
        "req-cancel",
        { runId, workflowIdOrName },
        new AbortController(),
        null,
      );

      assertEquals(frames.length, 1);
      assertEquals(frames[0].error, {
        code: "workflow_cancel_failed",
        message: `No cancellable run with id ${runId}`,
      });
    }
  }
});
