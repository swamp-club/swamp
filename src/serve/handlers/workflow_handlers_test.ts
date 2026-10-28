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

import { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import {
  applyTriggerOverrides,
  handleWorkflowApprovals,
  handleWorkflowCancel,
  handleWorkflowCreate,
  handleWorkflowDelete,
  handleWorkflowEdit,
  handleWorkflowHistoryGet,
  handleWorkflowHistoryLogs,
  handleWorkflowRunSearch,
  handleWorkflowRunSummary,
  handleWorkflowSearch,
  WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
} from "./workflow_handlers.ts";
import "../../domain/models/models.ts";
import {
  findSpan,
  isChildOf,
  type ReadableSpan,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { SpanStatusCode } from "../../infrastructure/tracing/mod.ts";
import { traceWebSocketRequest } from "../ws_request_span.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import { nestedChain } from "../../domain/workflows/nested_run_test_helpers.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  SEARCH_SCAN_SHARE,
  withScanPermit,
} from "../../infrastructure/persistence/scan_permits.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { DefinitionIdIndex } from "../../infrastructure/persistence/definition_id_index.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { ConnectionContext } from "./shared.ts";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import {
  GrantBasedAccessDecisionService,
  type GrantBasedAccessDecisionServiceOptions,
} from "../../domain/access/grant_based_access_decision_service.ts";
import type { ServeConfigFile } from "../serve_config.ts";
import type { TriggerOverride } from "../../libswamp/workflows/scheduled_execution.ts";
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
    since?: string;
    oldestStartedAt?: string;
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
  tagRequiresExplicitGrant: false,
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
 * `workflowCount` (default five) workflows, wf-0 (newest runs) … wf-4,
 * `runsPerWorkflow` runs each;
 * wf-i has i + 1 steps.
 * With `grants` the context enforces token-mode authorization; without,
 * mode none.
 */
function makeSearchCtx(
  grants?: Grant[],
  runsPerWorkflow = 1,
  workflowCount = 5,
): ConnectionContext {
  const workflows = Array.from({ length: workflowCount }, (_, i) => ({
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
        runIndexSnapshot: (workflowId: string) => {
          const i = workflows.findIndex((w) => w.id === workflowId);
          return Promise.resolve(RunIndexSnapshot.of(
            Array.from({ length: runsPerWorkflow }, (_, r) => ({
              id: crypto.randomUUID(),
              workflowId,
              workflowName: workflows[i].name,
              status: "succeeded",
              startedAt: new Date(Date.UTC(2026, 0, 10 - i, 0, 0, r)),
              tags: {},
              inputs: {},
            })),
          ));
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
  // No since bound: no window to age out of.
  assertEquals("since" in (frames[0].payload ?? {}), false);
  assertEquals("oldestStartedAt" in (frames[0].payload ?? {}), false);
});

Deno.test("handleWorkflowRunSearch: with since, sends it and the oldest match's start beside total", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSearch(
    socket,
    makeSearchCtx(),
    "req-window",
    new AbortController(),
    null,
    { since: "2026-01-07T00:00:00Z", limit: 1 },
  );

  // wf-1..wf-3 match (wf-4 is before since); the page holds wf-0 only.
  assertEquals(names(frames[0], "workflowName"), ["wf-0"]);
  assertEquals(frames[0].payload?.total, 4);
  assertEquals(frames[0].payload?.since, "2026-01-07T00:00:00.000Z");
  assertEquals(
    frames[0].payload?.oldestStartedAt,
    "2026-01-07T00:00:00.000Z",
  );
  assertEquals("oldestStartedAt" in (frames[0].payload?.data ?? {}), false);
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

Deno.test("handleWorkflowSearch: page two of fifty starts at the fifty-first workflow", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowSearch(
    socket,
    makeSearchCtx(undefined, 1, 120),
    "req-page-2",
    new AbortController(),
    null,
    { limit: 50, offset: 50 },
  );

  assertEquals(frames.length, 1);
  const page = names(frames[0], "name");
  assertEquals(page.length, 50);
  assertEquals(page[0], "wf-50");
  assertEquals(page[49], "wf-99");
  assertEquals(frames[0].payload?.total, 120);
});

Deno.test("handleWorkflowRunSearch: workflows, until and triggerSource filter before paging", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSearch(
    socket,
    makeSearchCtx(undefined, 3),
    "req-run-filters",
    new AbortController(),
    null,
    {
      workflows: ["wf-1", "wf-3", "wf-4"],
      // wf-4's runs start on 2026-01-06, before this bound; wf-1's after.
      until: "2026-01-09T00:00:00Z",
      limit: 2,
    },
  );

  assertEquals(names(frames[0], "workflowName"), ["wf-3", "wf-3"]);
  assertEquals(frames[0].payload?.total, 6);

  const sourced = makeSearchSocket();
  await handleWorkflowRunSearch(
    sourced.socket,
    makeSearchCtx(),
    "req-run-source",
    new AbortController(),
    null,
    { triggerSource: "schedule" },
  );
  assertEquals(sourced.frames[0].payload?.total, 0);
});

interface SummaryFrame {
  type: string;
  payload?: {
    data: {
      totals: Record<string, number>;
      workflows: Array<{ workflowName: string; runs: number; recent: [] }>;
      timeline?: Array<{ start: string; runs: number }>;
      oldestStartedAt?: string;
    };
  };
  error?: { code: string; details?: { reason?: string } };
}

Deno.test("handleWorkflowRunSummary: counts every run per workflow, with a timeline", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSummary(
    socket,
    makeSearchCtx(undefined, 3),
    "req-summary",
    new AbortController(),
    null,
    { timeline: true, recentLimit: 2 },
  );

  const frame = frames[0] as unknown as SummaryFrame;
  assertEquals(frame.type, "workflow.run.summary");
  const data = frame.payload!.data;
  assertEquals(data.totals.runs, 15);
  assertEquals(data.totals.succeeded, 15);
  assertEquals(data.totals.workflows, 5);
  assertEquals(data.workflows.map((w) => w.workflowName), [
    "wf-0",
    "wf-1",
    "wf-2",
    "wf-3",
    "wf-4",
  ]);
  assertEquals(data.workflows.map((w) => w.recent.length), [2, 2, 2, 2, 2]);
  assertEquals(data.timeline?.reduce((n, b) => n + b.runs, 0), 15);
});

Deno.test("handleWorkflowRunSummary: unreadable workflows never reach totals or the timeline", async () => {
  const { socket, frames } = makeSearchSocket();
  const ctx = makeSearchCtx(
    [readGrant("g1", "wf-1"), readGrant("g3", "wf-3")],
    2,
  );
  await handleWorkflowRunSummary(
    socket,
    ctx,
    "req-summary-auth",
    new AbortController(),
    searchPrincipal,
    { timeline: true },
  );

  const data = (frames[0] as unknown as SummaryFrame).payload!.data;
  assertEquals(data.totals.runs, 4);
  assertEquals(data.totals.workflows, 2);
  assertEquals(data.workflows.map((w) => w.workflowName), ["wf-1", "wf-3"]);
  assertEquals(data.timeline?.map((b) => b.start), [
    "2026-01-07T00:00:00.000Z",
    "2026-01-09T00:00:00.000Z",
  ]);
});

Deno.test("handleWorkflowRunSummary: since, until and workflows narrow the counts", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSummary(
    socket,
    makeSearchCtx(),
    "req-summary-window",
    new AbortController(),
    null,
    {
      since: "2026-01-07T00:00:00Z",
      until: "2026-01-10T00:00:00Z",
      workflows: ["wf-0", "wf-1", "wf-4"],
    },
  );

  const data = (frames[0] as unknown as SummaryFrame).payload!.data;
  // wf-0 starts on the exclusive until bound; wf-4 is before since.
  assertEquals(data.workflows.map((w) => w.workflowName), ["wf-1"]);
  assertEquals(data.totals.runs, 1);
  assertEquals(data.oldestStartedAt, "2026-01-09T00:00:00.000Z");
  assertEquals(data.timeline, undefined);
});

Deno.test("handleWorkflowRunSummary: an unreadable time is refused as validation_failed", async () => {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowRunSummary(
    socket,
    makeSearchCtx(),
    "req-summary-bad",
    new AbortController(),
    null,
    { since: "whenever" },
  );

  const frame = frames[0] as unknown as SummaryFrame;
  assertEquals(frame.error?.code, "workflow_run_summary_failed");
  assertEquals(frame.error?.details?.reason, "validation_failed");
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

// ── definition index (swamp-club#3968) ─────────────────────────────────

/** A definition named `name` that declares `id`. */
function definitionOf(
  id: string,
  name: string,
  tags: Record<string, string> = {},
): Definition {
  return Definition.fromData({
    ...Definition.create({ name, tags }).toData(),
    id,
  });
}

/**
 * `makeHistoryCtx` with serve's definition index over real definition files:
 * `writer` (tagged `env: dev`), `secrets`, and `unrelated` definitions that
 * own nothing the run wrote. Reads of definition files are counted, and a
 * scan of every definition through the repository fails the test.
 */
async function makeIndexedHistoryCtx(
  dir: string,
  workflow: Workflow,
  grants: Grant[],
  unrelated = 0,
) {
  const repo = new YamlDefinitionRepository(dir);
  const type = ModelType.create(HISTORY_MODEL_TYPE);
  await repo.save(type, definitionOf(WRITER_ID, "writer", { env: "dev" }));
  await repo.save(type, definitionOf(SECRETS_ID, "secrets"));
  for (let i = 0; i < unrelated; i++) {
    await repo.save(type, definitionOf(crypto.randomUUID(), `unrelated-${i}`));
  }
  const counts = { reads: 0, scans: 0 };
  const ctx = makeHistoryCtx(dir, workflow, grants);
  // Grants with conditions decide on the owners' tags.
  const snapshot = new PolicySnapshot(grants, [], createConditionEvaluator());
  ctx.policySnapshotLoader = {
    snapshot,
    decisionService: new GrantBasedAccessDecisionService(snapshot),
  } as unknown as PolicySnapshotLoader;
  const repoContext = ctx.repoContext as unknown as Record<string, unknown>;
  repoContext.definitionRepo = {
    ...(repoContext.definitionRepo as Record<string, unknown>),
    findAllIncludingAutoGlobal: () => {
      counts.scans++;
      return repo.findAllIncludingAutoGlobal();
    },
  };
  ctx.definitionIndex = new DefinitionIdIndex({
    definitionRoots: () => repo.definitionRoots(),
    readDefinitionFile: (path, segments, isSymlink) => {
      counts.reads++;
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
    // Every stat the test's writes set is old enough to trust.
  }, { now: () => Date.now() + 60_000 });
  return { ctx, repo, counts };
}

const indexedHistoryGrants = () => [
  grantFor("wf", "workflow", "history-wf"),
  grantFor("data", "data", "*"),
];

Deno.test("handleWorkflowHistoryGet: reads only the owners' definition files per request, however many definitions there are and however many requests overlap", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const { ctx, counts } = await makeIndexedHistoryCtx(
      dir,
      workflow,
      indexedHistoryGrants(),
      50,
    );

    const first = await historyGet(ctx, searchPrincipal);
    assertEquals(first.payload?.data.jobs[0].steps[0].outputs, {
      stdout: "hello",
      apiKey: "not-for-you",
    });
    // The one listing of all 52 definitions, then the two owners read.
    assertEquals(counts.reads, 52 + 2);

    for (let i = 0; i < 5; i++) await historyGet(ctx, searchPrincipal);
    assertEquals(counts.reads, 54 + 5 * 2);

    await Promise.all(
      Array.from({ length: 10 }, () => historyGet(ctx, searchPrincipal)),
    );
    assertEquals(counts.reads, 64 + 10 * 2);
    assertEquals(counts.scans, 0);
  });
});

Deno.test("handleWorkflowHistoryGet: a tag deny on an owner whose tags changed between requests leaves its output out of the next one", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const deny = {
      ...grantFor("deny-prod", "data", "*"),
      effect: "deny",
      condition: 'tags.env == "prod"',
    } as Grant;
    const { ctx, repo } = await makeIndexedHistoryCtx(dir, workflow, [
      ...indexedHistoryGrants(),
      deny,
    ]);

    const before = await historyGet(ctx, searchPrincipal);
    assertEquals(before.payload?.data.jobs[0].steps[0].outputs, {
      stdout: "hello",
      apiKey: "not-for-you",
    });

    await repo.save(
      ModelType.create(HISTORY_MODEL_TYPE),
      definitionOf(WRITER_ID, "writer", { env: "prod" }),
    );
    await withCapturedSpans(async (spans) => {
      const after = await historyGet(ctx, searchPrincipal);
      assertEquals(after.payload?.data.jobs[0].steps[0].outputs, {
        apiKey: "not-for-you",
      });
      const outputs = findSpan(spans, "swamp.workflow.step_outputs.resolve");
      assertEquals(outputs.attributes["step_outputs.resources_denied"], 1);
      const validate = findSpan(
        spans,
        "swamp.serve.definition_index.validate",
      );
      assertEquals(validate.attributes["definition_index.definitions"], 2);
    });
  });
});

Deno.test("handleWorkflowHistoryGet: a cancelled request replies cancelled without reading any definition", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const { ctx, counts } = await makeIndexedHistoryCtx(
      dir,
      workflow,
      indexedHistoryGrants(),
    );
    const frames: HistoryFrame[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (data: string) => frames.push(JSON.parse(data)),
    } as unknown as WebSocket;
    const controller = new AbortController();
    controller.abort();

    await handleWorkflowHistoryGet(
      socket,
      ctx,
      "req-history-cancelled",
      { workflowIdOrName: "history-wf" },
      controller,
      searchPrincipal,
    );

    assertEquals(frames.map((f) => f.error?.code), ["cancelled"]);
    assertEquals(counts.reads, 0);
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
  options: GrantBasedAccessDecisionServiceOptions = {},
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
        options,
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

// --- handleWorkflowEdit retag needs tag (swamp-club#3085) ---

/** Write on every workflow; tag only on team-a ones; write does not imply tag. */
function teamTagWorkflowCtx(
  dir: string,
  repo: YamlWorkflowRepository,
): ConnectionContext {
  return workflowEditCtx(dir, repo, [
    workflowGrant({}),
    workflowGrant({ actions: ["tag"], condition: 'tags.team == "team-a"' }),
  ], { writeImpliesTag: false });
}

async function editWorkflowTags(
  ctx: ConnectionContext,
  workflow: Workflow,
  tags: Record<string, string>,
) {
  const socket = editSocket();
  await handleWorkflowEdit(
    socket,
    ctx,
    "req-retag",
    {
      workflowIdOrName: workflow.name,
      content: workflowYaml(workflow, { tags }),
    },
    new AbortController(),
    WORKFLOW_EDITOR,
  );
  return sentFrames(socket);
}

Deno.test("handleWorkflowEdit: a retag into another team's tag is refused without a tag grant for its current tags", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "other-wf", {
      team: "team-b",
    });

    const sent = await editWorkflowTags(
      teamTagWorkflowCtx(dir, repo),
      workflow,
      {
        team: "team-a",
      },
    );

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals(sent[0].error.code, "unauthorized");
    assertEquals((await repo.findByName("other-wf"))?.tags, { team: "team-b" });
  });
});

Deno.test("handleWorkflowEdit: a retag out of a granted team's tag is refused", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "own-wf", { team: "team-a" });

    const sent = await editWorkflowTags(
      teamTagWorkflowCtx(dir, repo),
      workflow,
      {
        team: "team-b",
      },
    );

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals((await repo.findByName("own-wf"))?.tags, { team: "team-a" });
  });
});

Deno.test("handleWorkflowEdit: a retag within a granted team's tag is saved", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "own-wf", { team: "team-a" });

    const sent = await editWorkflowTags(
      teamTagWorkflowCtx(dir, repo),
      workflow,
      {
        team: "team-a",
        env: "prod",
      },
    );

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "workflow.edit");
    assertEquals((await repo.findByName("own-wf"))?.tags, {
      team: "team-a",
      env: "prod",
    });
  });
});

Deno.test("handleWorkflowEdit: an edit that keeps the tags needs no tag grant", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "other-wf", {
      team: "team-b",
    });
    const ctx = workflowEditCtx(dir, repo, [workflowGrant({})], {
      writeImpliesTag: false,
    });

    const sent = await editWorkflowTags(ctx, workflow, { team: "team-b" });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "workflow.edit");
  });
});

Deno.test("handleWorkflowEdit: a rename into a name-scoped tag grant is refused, so it cannot be followed by a retag", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "other-wf", {
      team: "team-b",
    });
    const ctx = workflowEditCtx(dir, repo, [
      workflowGrant({}),
      workflowGrant({
        actions: ["tag"],
        resource: { kind: "workflow", pattern: "team-a-*" },
      }),
    ], { writeImpliesTag: false });
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-rename",
      {
        workflowIdOrName: "other-wf",
        content: workflowYaml(workflow, { name: "team-a-loot" }),
        allowRename: true,
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error?.code, "unauthorized");
    assertEquals(await repo.findByName("team-a-loot"), null);
    assertEquals((await repo.findByName("other-wf"))?.tags, { team: "team-b" });
  });
});

Deno.test("handleWorkflowEdit: an edit carrying the tags it loaded cannot undo a retag stored before it saves", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "own-wf", { team: "team-a" });
    // The handler resolves the workflow, the edit loads it, and the save
    // re-reads it; another writer moves it to team-b right after the load.
    let lookups = 0;
    const racing = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop !== "findByName") return Reflect.get(target, prop, receiver);
        return async (name: string) => {
          const found = await target.findByName(name);
          if (++lookups === 2) {
            await target.save(
              Workflow.fromData({
                ...workflow.toData(),
                tags: { team: "team-b" },
              }),
            );
          }
          return found;
        };
      },
    });

    const sent = await editWorkflowTags(
      teamTagWorkflowCtx(dir, racing),
      workflow,
      { team: "team-a" },
    );

    assertEquals(lookups, 3);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error?.code, "unauthorized");
    assertEquals((await repo.findByName("own-wf"))?.tags, { team: "team-b" });
  });
});

Deno.test("handleWorkflowEdit: a write grant still permits a retag when write implies tag", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "other-wf", {
      team: "team-b",
    });

    const sent = await editWorkflowTags(
      workflowEditCtx(dir, repo, [workflowGrant({})]),
      workflow,
      { team: "team-a" },
    );

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "workflow.edit");
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
        allowRename: true,
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

Deno.test("handleWorkflowCancel: a run its abort ended has its suspended nested runs cancelled and listed in the reply", async () => {
  const built = nestedChain();
  const [parent, child] = built.chain;
  // The parent was resumed and is running here: its abort settles it.
  const registry = new ActiveRunRegistry();
  const run = {
    ...cancellableRun(parent.id, () => {
      cancelAndSettle(parent, undefined, "aborted");
      built.runs.add(parent);
      registry.deregister(parent.id);
    }),
    resourceName: parent.workflowName,
  };
  registry.register(run);
  let pushes = 0;
  const ctx = {
    authConfig: { ...searchAuthBase, mode: "none" },
    activeRunRegistry: registry,
    datastoreConfig: { type: "filesystem" },
    syncService: {
      pushChanged: () => {
        pushes++;
        return Promise.resolve();
      },
    },
    repoContext: {
      workflowRepo: {
        findByName: (name: string) =>
          Promise.resolve(
            built.workflows.find((w) => w.name === name) ?? null,
          ),
        findById: built.workflowRepo.findById.bind(built.workflowRepo),
        findAll: () => Promise.resolve(built.workflows),
      },
      workflowRunRepo: {
        findById: built.runs.findById.bind(built.runs),
        save: built.runs.save.bind(built.runs),
        findGlobalById: (runId: string) => {
          const found = built.runs.byId.get(runId.toLowerCase());
          return Promise.resolve(
            found ? { run: found, workflowId: found.workflowId } : null,
          );
        },
      },
    },
  } as unknown as ConnectionContext;
  const frames: {
    type: string;
    payload?: {
      data: { status: string; cancelledNestedRuns?: { runId: string }[] };
    };
  }[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;

  await handleWorkflowCancel(
    socket,
    ctx,
    "req-cancel",
    { runId: parent.id },
    new AbortController(),
    null,
  );

  assertEquals(frames.length, 1);
  assertEquals(frames[0].payload?.data.status, "cancelled");
  assertEquals(
    frames[0].payload?.data.cancelledNestedRuns?.map((r) => r.runId),
    [child.id],
  );
  assertEquals(built.runs.get(child).status, "cancelled");
  assertEquals(built.runs.saved, [child.id]);
  assertEquals(pushes, 1);
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

Deno.test("handleWorkflowEdit: a rename without allowRename is refused and writes nothing", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "keep-wf");
    const ctx = workflowEditCtx(dir, repo, [workflowGrant({})]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-rename-unasked",
      {
        workflowIdOrName: "keep-wf",
        content: workflowYaml(workflow, { name: "keep-wf-template" }),
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals((await repo.findByName("keep-wf"))?.id, workflow.id);
    assertEquals(await repo.findByName("keep-wf-template"), null);
  });
});

Deno.test("handleWorkflowEdit: an allowed rename onto another workflow's name leaves both intact", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const mover = await saveEditWorkflow(repo, "mover-wf");
    const holder = await saveEditWorkflow(repo, "holder-wf");
    const ctx = workflowEditCtx(dir, repo, [workflowGrant({})]);
    const socket = editSocket();

    await handleWorkflowEdit(
      socket,
      ctx,
      "req-rename-taken",
      {
        workflowIdOrName: "mover-wf",
        content: workflowYaml(mover, { name: "holder-wf" }),
        allowRename: true,
      },
      new AbortController(),
      WORKFLOW_EDITOR,
    );

    const sent = sentFrames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals((await repo.findByName("mover-wf"))?.id, mover.id);
    assertEquals((await repo.findByName("holder-wf"))?.id, holder.id);
  });
});

// --- principal on the libswamp spans (swamp-club#3593) ---

const TRACED_EDITOR: Principal = { kind: "user", id: "editor" };

/** A context whose datastore paths resolve under `repoDir`, for deletes. */
function tracedWorkflowCtx(
  repoDir: string,
  workflowRepo: YamlWorkflowRepository,
): ConnectionContext {
  return {
    ...workflowEditCtx(repoDir, workflowRepo),
    datastoreResolver: {
      resolvePath: (subdir: string) => join(repoDir, ".swamp", subdir),
    },
  } as unknown as ConnectionContext;
}

Deno.test("handleWorkflowEdit: records the edited workflow and the requesting principal on the span", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "traced-wf");
    await withCapturedSpans(async (spans) => {
      await handleWorkflowEdit(
        editSocket(),
        workflowEditCtx(dir, repo),
        "req-edit-traced",
        { workflowIdOrName: workflow.id, content: workflowYaml(workflow) },
        new AbortController(),
        TRACED_EDITOR,
      );
      const span = findSpan(spans, "swamp.workflow.edit");
      assertEquals(span.attributes["workflow.name"], "traced-wf");
      assertEquals(span.attributes["workflow.id"], workflow.id);
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

Deno.test("handleWorkflowEdit: records no principal on the span for an unauthenticated request", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "anonymous-wf");
    await withCapturedSpans(async (spans) => {
      await handleWorkflowEdit(
        editSocket(),
        workflowEditCtx(dir, repo),
        "req-edit-anonymous",
        { workflowIdOrName: workflow.id, content: workflowYaml(workflow) },
        new AbortController(),
        null,
      );
      const span = findSpan(spans, "swamp.workflow.edit");
      assertEquals(span.attributes["workflow.name"], "anonymous-wf");
      assertEquals(span.attributes["auth.principal.id"], undefined);
    });
  });
});

Deno.test("handleWorkflowCreate: records the requesting principal on the span", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await withCapturedSpans(async (spans) => {
      await handleWorkflowCreate(
        editSocket(),
        workflowEditCtx(dir, repo),
        "req-create-traced",
        { name: "created-wf" },
        new AbortController(),
        TRACED_EDITOR,
      );
      const span = findSpan(spans, "swamp.workflow.create");
      assertEquals(span.attributes["workflow.name"], "created-wf");
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

Deno.test("handleWorkflowDelete: records the deleted workflow and the requesting principal on the span", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    const workflow = await saveEditWorkflow(repo, "doomed-wf");
    await withCapturedSpans(async (spans) => {
      await handleWorkflowDelete(
        editSocket(),
        tracedWorkflowCtx(dir, repo),
        "req-delete-traced",
        { workflowIdOrName: workflow.id },
        new AbortController(),
        TRACED_EDITOR,
      );
      const span = findSpan(spans, "swamp.workflow.delete");
      assertEquals(span.attributes["workflow.name"], "doomed-wf");
      assertEquals(span.attributes["workflow.id"], workflow.id);
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

// --- traced WebSocket reads (swamp-club#3741) ---

/**
 * Runs `fn` inside the `swamp.serve.request` span connection.ts opens for a
 * WebSocket request, so the handler's spans have the parent they have in
 * serve.
 */
function tracedRequest(
  type: string,
  socket: WebSocket,
  principal: Principal | null,
  fn: () => Promise<void>,
): Promise<void> {
  return traceWebSocketRequest({
    type,
    socket,
    activeRequests: 1,
    principal,
    datastoreType: "filesystem",
    datastoreEngine: "test",
  }, fn);
}

/**
 * Asserts each of `children` is one span started directly under `parent`,
 * and returns `parent`.
 */
function assertChildren(
  spans: readonly ReadableSpan[],
  parent: string,
  children: string[],
): ReadableSpan {
  const parentSpan = findSpan(spans, parent);
  for (const child of children) {
    assertEquals(
      isChildOf(findSpan(spans, child), parentSpan),
      true,
      `${child} is not a child of ${parent}`,
    );
  }
  return parentSpan;
}

Deno.test("handleWorkflowHistoryGet: traces the lookup, authorization, read, redaction and send under the request span", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const ctx = makeHistoryCtx(dir, workflow, [
      grantFor("wf", "workflow", "history-wf"),
      grantFor("writer-data", "data", "writer"),
    ]);
    await withCapturedSpans(async (spans) => {
      const { socket, frames } = makeSearchSocket();
      await tracedRequest(
        "workflow.history.get",
        socket,
        searchPrincipal,
        () =>
          handleWorkflowHistoryGet(
            socket,
            ctx,
            "req-history-traced",
            { workflowIdOrName: "history-wf" },
            new AbortController(),
            searchPrincipal,
          ),
      );
      assertEquals(frames.map((f) => f.type), ["workflow.history.get"]);

      const request = assertChildren(spans, "swamp.serve.request", [
        "swamp.workflow.run_reference.resolve",
        "swamp.serve.authorize",
        "swamp.workflow.history.get",
        "swamp.serve.redact",
        "swamp.serve.response.send",
      ]);
      const get = assertChildren(spans, "swamp.workflow.history.get", [
        "swamp.workflow.step_outputs.resolve",
      ]);
      assertEquals(get.attributes["workflow.name"], "history-wf");
      assertEquals(get.attributes["workflow.id"], workflow.id);
      assertEquals(typeof get.attributes["workflow.run_id"], "string");

      const outputs = findSpan(spans, "swamp.workflow.step_outputs.resolve");
      assertEquals(outputs.attributes["step_outputs.resources_read"], 1);
      assertEquals(outputs.attributes["step_outputs.resources_denied"], 1);
      assertEquals(outputs.attributes["step_outputs.child_runs_read"], 0);

      const traceId = request.spanContext().traceId;
      assertEquals(
        spans.every((s) => s.spanContext().traceId === traceId),
        true,
      );
      assertEquals(request.parentSpanId, undefined);
      assertEquals(
        request.attributes["swamp.serve.request.type"],
        "workflow.history.get",
      );
      assertEquals(request.status.code, SpanStatusCode.UNSET);
    });
  });
});

Deno.test("handleWorkflowHistoryGet: records the error code of an unknown run on the request span", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    await withCapturedSpans(async (spans) => {
      const { socket, frames } = makeSearchSocket();
      await tracedRequest(
        "workflow.history.get",
        socket,
        null,
        () =>
          handleWorkflowHistoryGet(
            socket,
            makeHistoryCtx(dir, workflow),
            "req-history-traced-missing",
            { workflowIdOrName: "no-such-run" },
            new AbortController(),
            null,
          ),
      );
      assertEquals(frames[0].error?.code, "workflow_history_get_failed");

      const request = findSpan(spans, "swamp.serve.request");
      assertEquals(
        request.attributes["swamp.serve.response.error_code"],
        "workflow_history_get_failed",
      );
      // A run that is not found is the caller's error, not the server's.
      assertEquals(
        request.attributes["swamp.serve.response.error_reason"],
        "not_found",
      );
      assertEquals(request.status.code, SpanStatusCode.UNSET);
      assertEquals(
        spans.some((s) => s.name === "swamp.serve.response.send"),
        false,
      );
    });
  });
});

Deno.test("handleWorkflowHistoryLogs: traces the logs read and the send under the request span", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    await withCapturedSpans(async (spans) => {
      const { socket, frames } = makeSearchSocket();
      await tracedRequest(
        "workflow.history.logs",
        socket,
        null,
        () =>
          handleWorkflowHistoryLogs(
            socket,
            makeHistoryCtx(dir, workflow),
            "req-logs-traced",
            { runIdOrWorkflow: "history-wf" },
            new AbortController(),
            null,
          ),
      );
      assertEquals(frames.map((f) => f.type), ["workflow.history.logs"]);

      assertChildren(spans, "swamp.serve.request", [
        "swamp.workflow.run_reference.resolve",
        "swamp.serve.authorize",
        "swamp.workflow.history.logs",
        "swamp.serve.response.send",
      ]);
      const logs = findSpan(spans, "swamp.workflow.history.logs");
      assertEquals(logs.attributes["workflow.name"], "history-wf");
      assertEquals(logs.attributes["workflow.id"], workflow.id);
    });
  });
});

Deno.test("handleWorkflowRunSearch: traces the search, its run selection, redaction and send under the request span", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket, frames } = makeSearchSocket();
    await tracedRequest(
      "workflow.run.search",
      socket,
      null,
      () =>
        handleWorkflowRunSearch(
          socket,
          makeSearchCtx(),
          "req-run-search-traced",
          new AbortController(),
          null,
          { limit: 2 },
        ),
    );
    assertEquals(frames.map((f) => f.type), ["workflow.run.search"]);

    assertChildren(spans, "swamp.serve.request", [
      "swamp.workflow.run_search",
      "swamp.serve.redact",
      "swamp.serve.response.send",
    ]);
    assertChildren(spans, "swamp.workflow.run_search", [
      "swamp.workflow.run_selection",
    ]);
  });
});

Deno.test("handleWorkflowRunSummary: traces the summary, its run selection and send under the request span", async () => {
  await withCapturedSpans(async (spans) => {
    const { socket, frames } = makeSearchSocket();
    await tracedRequest(
      "workflow.run.summary",
      socket,
      null,
      () =>
        handleWorkflowRunSummary(
          socket,
          makeSearchCtx(),
          "req-run-summary-traced",
          new AbortController(),
          null,
          {},
        ),
    );
    assertEquals(frames.map((f) => f.type), ["workflow.run.summary"]);

    assertChildren(spans, "swamp.serve.request", [
      "swamp.workflow.run_summary",
      "swamp.serve.response.send",
    ]);
    assertChildren(spans, "swamp.workflow.run_summary", [
      "swamp.workflow.run_selection",
    ]);
  });
});

Deno.test("handleWorkflowApprovals: traces the approvals read, its definitions load, authorization and send under the request span", async () => {
  await withHistoryRepo(async (dir) => {
    const workflow = await seedHistoryRun(dir);
    const ctx = {
      ...makeHistoryCtx(dir, workflow),
      datastoreResolver: {
        resolvePath: (subdir: string) => join(dir, ".swamp", subdir),
      },
    } as unknown as ConnectionContext;
    ctx.repoContext = {
      ...ctx.repoContext,
      workflowRepo: {
        ...ctx.repoContext.workflowRepo,
        findAll: () => Promise.resolve([workflow]),
      },
      workflowRunRepo: new YamlWorkflowRunRepository(dir),
    };
    await withCapturedSpans(async (spans) => {
      const { socket, frames } = makeSearchSocket();
      await tracedRequest(
        "workflow.approvals",
        socket,
        null,
        () =>
          handleWorkflowApprovals(
            socket,
            ctx,
            "req-approvals-traced",
            new AbortController(),
            null,
          ),
      );
      assertEquals(frames.map((f) => f.type), ["workflow.approvals"]);

      assertChildren(spans, "swamp.serve.request", [
        "swamp.workflow.approvals",
        "swamp.serve.authorize",
        "swamp.serve.response.send",
      ]);
      const load = findSpan(spans, "swamp.workflow.definitions.load");
      assertEquals(
        isChildOf(load, findSpan(spans, "swamp.workflow.approvals")),
        true,
      );
      assertEquals(load.attributes["workflows.count"], 1);
    });
  });
});

// --- handleWorkflowApprovals canDecide (swamp-club#3697) ---

/**
 * Saves a workflow with one manual_approval gate and a run suspended at it,
 * started by `user:alice`.
 */
async function seedGatedRun(
  dir: string,
  repo: YamlWorkflowRepository,
  name: string,
  tags: Record<string, string>,
): Promise<Workflow> {
  const workflow = Workflow.create({
    name,
    tags,
    jobs: [
      Job.create({
        name: "review",
        steps: [
          Step.create({
            name: "approval",
            task: StepTask.manualApproval("Ship it?"),
          }),
        ],
      }),
    ],
  });
  await repo.save(workflow);
  const run = WorkflowRun.create(workflow, {}, "user:alice");
  run.start();
  const job = run.getJob("review")!;
  job.start();
  const step = job.getStep("approval")!;
  step.start();
  step.waitForApproval("Ship it?");
  run.suspend();
  await new YamlWorkflowRunRepository(dir).save(workflow.id, run);
  return workflow;
}

async function listApprovals(
  ctx: ConnectionContext,
  principal: Principal | null,
): Promise<Array<Record<string, unknown>>> {
  const { socket, frames } = makeSearchSocket();
  await handleWorkflowApprovals(
    socket,
    ctx,
    "req-approvals",
    new AbortController(),
    principal,
  );
  assertEquals(frames.map((f) => f.type), ["workflow.approvals"]);
  const data = (frames[0].payload as unknown as {
    data: { approvals: Array<Record<string, unknown>> };
  }).data;
  return data.approvals;
}

function approvalsCtx(
  dir: string,
  repo: YamlWorkflowRepository,
  grants?: Grant[],
  options: GrantBasedAccessDecisionServiceOptions = {},
): ConnectionContext {
  const ctx = workflowEditCtx(dir, repo, grants, options);
  ctx.repoContext = {
    ...ctx.repoContext,
    workflowRunRepo: new YamlWorkflowRunRepository(dir),
  };
  (ctx as unknown as Record<string, unknown>).datastoreResolver = {
    resolvePath: (subdir: string) => join(dir, ".swamp", subdir),
  };
  return ctx;
}

Deno.test("handleWorkflowApprovals: canDecide says whether this caller holds approve on each readable gate's workflow", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await seedGatedRun(dir, repo, "team-a-deploy", { team: "team-a" });
    await seedGatedRun(dir, repo, "team-b-deploy", { team: "team-b" });
    await seedGatedRun(dir, repo, "hidden-deploy", { team: "hidden" });
    const ctx = approvalsCtx(dir, repo, [
      workflowGrant({
        actions: ["read"],
        resource: { kind: "workflow", pattern: "team-*" },
      }),
      workflowGrant({
        actions: ["approve"],
        resource: { kind: "workflow", pattern: "*" },
        condition: 'tags.team == "team-a"',
      }),
    ]);
    const approvals = await listApprovals(ctx, WORKFLOW_EDITOR);
    const byName = new Map(approvals.map((a) => [a.workflowName, a]));
    // The unreadable workflow's gate is dropped before any flag is set.
    assertEquals([...byName.keys()].sort(), ["team-a-deploy", "team-b-deploy"]);
    assertEquals(byName.get("team-a-deploy")?.canDecide, true);
    assertEquals(byName.get("team-b-deploy")?.canDecide, false);
    assertEquals(byName.get("team-a-deploy")?.initiatedBy, "user:alice");
  });
});

Deno.test("handleWorkflowApprovals: canDecide follows run-implies-approve and its explicit-grant setting", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await seedGatedRun(dir, repo, "deploy", {});
    const grants = [
      workflowGrant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ];
    const implied = await listApprovals(
      approvalsCtx(dir, repo, grants),
      WORKFLOW_EDITOR,
    );
    assertEquals(implied.map((a) => a.canDecide), [true]);
    const explicit = await listApprovals(
      approvalsCtx(dir, repo, grants, { runImpliesApprove: false }),
      WORKFLOW_EDITOR,
    );
    assertEquals(explicit.map((a) => a.canDecide), [false]);
  });
});

Deno.test("handleWorkflowApprovals: with authorization off every gate can be decided", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await seedGatedRun(dir, repo, "deploy", {});
    const approvals = await listApprovals(approvalsCtx(dir, repo), null);
    assertEquals(approvals.map((a) => a.canDecide), [true]);
  });
});

/** Records the signal each findByStatus is given, then reads as usual. */
class SignalRecordingRunRepository extends YamlWorkflowRunRepository {
  readonly signals: Array<AbortSignal | undefined> = [];

  override findByStatus(
    workflowId: WorkflowId,
    status: string,
    signal?: AbortSignal,
  ) {
    this.signals.push(signal);
    return super.findByStatus(workflowId, status, signal);
  }
}

Deno.test("handleWorkflowApprovals: a request cancelled while its suspended-run read waits for a scan permit leaves the queue and replies cancelled (swamp-club#4088)", async () => {
  await withWorkflowRepo(async (dir, repo) => {
    await seedGatedRun(dir, repo, "deploy", {});
    const runRepo = new SignalRecordingRunRepository(dir);
    const ctx = approvalsCtx(dir, repo);
    ctx.repoContext = { ...ctx.repoContext, workflowRunRepo: runRepo };

    // Other searches hold the whole search share, so the read's first
    // listing waits in the permit queue.
    const held = Promise.withResolvers<void>();
    const holders = Array.from(
      { length: SEARCH_SCAN_SHARE },
      () => withScanPermit("search", () => held.promise),
    );
    try {
      const { socket, frames } = makeSearchSocket();
      const controller = new AbortController();
      const request = handleWorkflowApprovals(
        socket,
        ctx,
        "req-approvals",
        controller,
        null,
      );
      await waitFor(
        () => runRepo.signals.length > 0,
        "the suspended-run read",
      );
      controller.abort();

      // Answered while the share is still held: the read gave up its place
      // rather than waiting for a permit. The handler replies only once the
      // read has settled, so no listing or record read outlives the reply.
      await request;
      assertEquals(runRepo.signals, [controller.signal]);
      assertEquals(frames.map((f) => f.type), ["error"]);
      assertEquals(frames[0].error?.code, "cancelled");
    } finally {
      held.resolve();
      await Promise.all(holders);
    }
  });
});
