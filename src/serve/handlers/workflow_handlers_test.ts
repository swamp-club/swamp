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
import {
  applyTriggerOverrides,
  handleWorkflowRunSearch,
  handleWorkflowSearch,
  resolveWorkflowFields,
  WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
} from "./workflow_handlers.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
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
