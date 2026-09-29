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
 * Every serve request that names a model, workflow or model's data must be
 * authorized on the resource it resolves to, not the raw string sent
 * (swamp-club#2674). A grant matches a resource name, so authorizing the raw
 * string lets a client reach a resource under a name-scoped deny by sending
 * its UUID instead.
 *
 * The request types are read from the serve request schema. A type whose
 * payload carries a resource identifier needs a case here, or an entry in
 * EXEMPT naming the issue that owns it — so a new request cannot ship
 * without this coverage. Requests go through `handleMessage`, the real
 * dispatch path, against a real repository.
 *
 * Vault requests (vaultName, vaultNameOrId) are swamp-club#2676's.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { stringify as stringifyYaml } from "@std/yaml";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { serverRequestPayloadFields } from "../src/serve/connection.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveData,
  saveGatedWorkflow,
  saveModel,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

/** Payload fields that name a model, workflow, output or run. */
const IDENTIFIER_FIELD =
  /(IdOrName|IdOrModelName|IdOrWorkflow)$|^(outputIdArg|workflowName|definitionName)$/;

/**
 * Request types this test does not cover, each with the issue that owns how
 * it authorizes. Remove an entry when its issue lands; never add one without
 * an owning issue.
 */
const EXEMPT: Record<string, string> = {
  "model.output.get": "swamp-club#2673 (output id prefixes)",
  "model.output.data": "swamp-club#2673 (output id prefixes)",
  "model.output.logs": "swamp-club#2673 (output id prefixes)",
  "model.method.history.get": "swamp-club#2673 (output id prefixes)",
  "model.method.history.logs": "swamp-club#2673 (output id prefixes)",
  "workflow.history.get": "swamp-club#2673 (run id prefixes)",
  "workflow.history.logs": "swamp-club#2673 (run id prefixes)",
  "workflow.schema": "swamp-club#2675 (authorizes *)",
};

const ACTIONS: Grant["actions"] = ["read", "write", "run", "approve"];

/** Allow everything on models, data and workflows, deny anything prod-*. */
const GRANTS: Grant[] = (["model", "data", "workflow"] as const).flatMap((
  kind,
) => [
  grant({ actions: ACTIONS, resource: { kind, pattern: "*" } }),
  grant({
    effect: "deny",
    actions: ACTIONS,
    resource: { kind, pattern: "prod-*" },
  }),
]);

interface Fixtures {
  repo: ServeRepo;
  /** Token mode, enforcing GRANTS. */
  ctx: ConnectionContext;
  /** No enforcement, for setting up state such as suspended runs. */
  admin: ConnectionContext;
  prodModel: Definition;
  devModel: Definition;
  prodWorkflow: Workflow;
  devWorkflow: Workflow;
  prodGated: Workflow;
  devGated: Workflow;
}

async function withFixtures(fn: (f: Fixtures) => Promise<void>) {
  await withServeRepo(async (repo) => {
    const prodModel = await saveModel(repo, "prod-db", { env: "prod" });
    const devModel = await saveModel(repo, "dev-db");
    await saveData(repo, prodModel, "state");
    await saveData(repo, devModel, "state");
    await fn({
      repo,
      ctx: createServeCtx(repo, GRANTS),
      admin: createServeCtx(repo),
      prodModel,
      devModel,
      prodWorkflow: await saveWorkflow(repo, "prod-flow", prodModel),
      devWorkflow: await saveWorkflow(repo, "dev-flow", devModel),
      prodGated: await saveGatedWorkflow(repo, "prod-gated", "gate"),
      devGated: await saveGatedWorkflow(repo, "dev-gated", "gate"),
    });
  });
}

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** Runs `workflow` until it suspends at its gate; returns the run id. */
async function suspend(f: Fixtures, workflow: Workflow): Promise<string> {
  const frames = await sendRequest(
    f.admin,
    request("workflow.run", { workflowIdOrName: workflow.name }),
  );
  const started = frames.find((frame) =>
    (frame.event as { kind?: string } | undefined)?.kind === "started"
  );
  const runId = (started?.event as { runId?: string } | undefined)?.runId;
  assert(runId, `${workflow.name} started a run`);
  return runId;
}

async function approve(f: Fixtures, workflow: Workflow, runId: string) {
  const frames = await sendRequest(
    f.admin,
    request("workflow.approve", {
      workflowIdOrName: workflow.name,
      stepName: "gate",
      runId,
    }),
  );
  assertEquals(errorFrame(frames), undefined, "approved for setup");
}

async function runStatus(f: Fixtures, workflow: Workflow, runId: string) {
  const run = await f.repo.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    runId as never,
  );
  return run?.status;
}

function streamError(frames: Frame[]): unknown {
  return frames.map((frame) =>
    frame.event as { kind?: string; error?: unknown } | undefined
  ).find((event) => event?.kind === "error")?.error;
}

/** Asserts the request was refused on `resource`'s canonical name. */
function assertDenied(frames: Frame[], resource: string) {
  const error = errorFrame(frames);
  assertEquals(error?.error?.code, "unauthorized", JSON.stringify(frames));
  assertStringIncludes(error!.error!.message, resource);
  assertEquals(
    frames.filter((frame) => frame.type === "event").length,
    0,
    "a refused request streams nothing",
  );
}

/** Asserts the request succeeded: its reply type, or a completed stream. */
function assertAllowed(frames: Frame[], type: string) {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  assertEquals(streamError(frames), undefined, JSON.stringify(frames));
  const last = frames.at(-1);
  if (last?.type === "done") return;
  assertEquals(last?.type, type, JSON.stringify(frames));
}

interface Case {
  /**
   * Sends the request for `target` — the prod resource (denied) or the dev
   * one (allowed) — by its UUID, and returns the frames.
   */
  send: (f: Fixtures, target: "prod" | "dev") => Promise<Frame[]>;
  /** The resource named in a denial, e.g. model:prod-db. */
  deniedAs: string;
  /** Checks that a denied request left the prod resource untouched. */
  unchanged?: (f: Fixtures) => Promise<void>;
  /** Replaces the default check that the reply is a denial. */
  refused?: (frames: Frame[]) => void;
}

const model = (f: Fixtures, t: "prod" | "dev") =>
  t === "prod" ? f.prodModel : f.devModel;
const workflow = (f: Fixtures, t: "prod" | "dev") =>
  t === "prod" ? f.prodWorkflow : f.devWorkflow;
const gated = (f: Fixtures, t: "prod" | "dev") =>
  t === "prod" ? f.prodGated : f.devGated;

function simple(
  type: string,
  payload: (f: Fixtures, t: "prod" | "dev") => Record<string, unknown>,
  deniedAs: string,
  unchanged?: (f: Fixtures) => Promise<void>,
): Case {
  return {
    send: (f, t) => sendRequest(f.ctx, request(type, payload(f, t))),
    deniedAs,
    unchanged,
  };
}

const prodModelKept = async (f: Fixtures) => {
  assertNotEquals(
    await f.repo.repoContext.definitionRepo.findByNameGlobal("prod-db"),
    null,
  );
};
const prodDataKept = async (f: Fixtures) => {
  const versions = await f.repo.repoContext.unifiedDataRepo.listVersions(
    f.repo.modelType,
    f.prodModel.id,
    "state",
  );
  assertEquals(versions.length, 1);
};
const prodWorkflowKept = async (f: Fixtures) => {
  assertNotEquals(
    await f.repo.repoContext.workflowRepo.findByName("prod-flow"),
    null,
  );
};

const CASES: Record<string, Case> = {
  "model.method.run": simple(
    "model.method.run",
    (f, t) => ({ modelIdOrName: model(f, t).id, methodName: "noop" }),
    "model:prod-db",
  ),
  "model.method.describe": simple(
    "model.method.describe",
    (f, t) => ({ modelIdOrName: model(f, t).id, methodName: "noop" }),
    "model:prod-db",
  ),
  "model.get": simple(
    "model.get",
    (f, t) => ({ modelIdOrName: model(f, t).id }),
    "model:prod-db",
  ),
  "model.validate": simple(
    "model.validate",
    (f, t) => ({ modelIdOrName: model(f, t).id }),
    "model:prod-db",
  ),
  "model.evaluate": simple(
    "model.evaluate",
    (f, t) => ({ modelIdOrName: model(f, t).id }),
    "model:prod-db",
  ),
  "model.delete": {
    send: async (f, t) => {
      // dev-db is referenced by dev-flow, so delete an unreferenced one.
      const target = t === "prod"
        ? f.prodModel
        : await saveModel(f.repo, "dev-spare");
      return await sendRequest(
        f.ctx,
        request("model.delete", { modelIdOrName: target.id, force: true }),
      );
    },
    deniedAs: "model:prod-db",
    unchanged: prodModelKept,
  },
  "model.edit": simple(
    "model.edit",
    (f, t) => ({
      modelIdOrName: model(f, t).id,
      content: stringifyYaml({
        ...JSON.parse(JSON.stringify(model(f, t).toData())),
        tags: { edited: "true" },
      }),
    }),
    "model:prod-db",
    async (f) => {
      const prod = await f.repo.repoContext.definitionRepo.findByNameGlobal(
        "prod-db",
      );
      assertEquals(prod?.definition.tags, { env: "prod" });
    },
  ),
  "data.get": simple(
    "data.get",
    (f, t) => ({ modelIdOrName: model(f, t).id, dataName: "state" }),
    "data:prod-db",
  ),
  "data.list": simple(
    "data.list",
    (f, t) => ({ modelIdOrName: model(f, t).id }),
    "data:prod-db",
  ),
  "data.versions": simple(
    "data.versions",
    (f, t) => ({ modelIdOrName: model(f, t).id, dataName: "state" }),
    "data:prod-db",
  ),
  "data.delete": simple(
    "data.delete",
    (f, t) => ({ modelIdOrName: model(f, t).id, dataName: "state" }),
    "data:prod-db",
    prodDataKept,
  ),
  "data.rename": simple(
    "data.rename",
    (f, t) => ({
      modelIdOrName: model(f, t).id,
      oldName: "state",
      newName: "renamed",
    }),
    "data:prod-db",
    prodDataKept,
  ),
  "workflow.run": simple(
    "workflow.run",
    (f, t) => ({ workflowIdOrName: workflow(f, t).id }),
    "workflow:prod-flow",
  ),
  "workflow.get": simple(
    "workflow.get",
    (f, t) => ({ workflowIdOrName: workflow(f, t).id }),
    "workflow:prod-flow",
  ),
  "workflow.validate": simple(
    "workflow.validate",
    (f, t) => ({ workflowIdOrName: workflow(f, t).id }),
    "workflow:prod-flow",
  ),
  "workflow.evaluate": simple(
    "workflow.evaluate",
    (f, t) => ({ workflowIdOrName: workflow(f, t).id }),
    "workflow:prod-flow",
  ),
  "workflow.delete": simple(
    "workflow.delete",
    (f, t) => ({ workflowIdOrName: workflow(f, t).id }),
    "workflow:prod-flow",
    prodWorkflowKept,
  ),
  "workflow.edit": simple(
    "workflow.edit",
    (f, t) => ({
      workflowIdOrName: workflow(f, t).id,
      content: stringifyYaml({
        ...JSON.parse(JSON.stringify(workflow(f, t).toData())),
        tags: { edited: "true" },
      }),
    }),
    "workflow:prod-flow",
    async (f) => {
      const prod = await f.repo.repoContext.workflowRepo.findByName(
        "prod-flow",
      );
      assertEquals(prod?.tags, {});
    },
  ),
  "workflow.trigger.set": simple(
    "workflow.trigger.set",
    (f, t) => ({ workflowName: workflow(f, t).id, schedule: "0 * * * *" }),
    "workflow:prod-flow",
  ),
  "workflow.trigger.get": simple(
    "workflow.trigger.get",
    (f, t) => ({ workflowName: workflow(f, t).id }),
    "workflow:prod-flow",
  ),
  "workflow.trigger.remove": {
    send: async (f, t) => {
      // A trigger override must exist for its removal to succeed.
      await sendRequest(
        f.admin,
        request("workflow.trigger.set", {
          workflowName: workflow(f, t).id,
          schedule: "0 * * * *",
        }),
      );
      return await sendRequest(
        f.ctx,
        request("workflow.trigger.remove", {
          workflowName: workflow(f, t).id,
        }),
      );
    },
    deniedAs: "workflow:prod-flow",
  },
  "workflow.approve": {
    send: async (f, t) => {
      const runId = await suspend(f, gated(f, t));
      return await sendRequest(
        f.ctx,
        request("workflow.approve", {
          workflowIdOrName: gated(f, t).id,
          stepName: "gate",
          runId,
        }),
      );
    },
    deniedAs: "workflow:prod-gated",
  },
  "workflow.reject": {
    send: async (f, t) => {
      const runId = await suspend(f, gated(f, t));
      return await sendRequest(
        f.ctx,
        request("workflow.reject", {
          workflowIdOrName: gated(f, t).id,
          stepName: "gate",
          runId,
        }),
      );
    },
    deniedAs: "workflow:prod-gated",
  },
  "workflow.resume": {
    send: async (f, t) => {
      const runId = await suspend(f, gated(f, t));
      await approve(f, gated(f, t), runId);
      return await sendRequest(
        f.ctx,
        request("workflow.resume", {
          workflowIdOrName: gated(f, t).id,
          runId,
        }),
      );
    },
    deniedAs: "workflow:prod-gated",
  },
  "workflow.cancel": {
    // Cancel authorizes the workflow the run belongs to, silently: a refused
    // caller gets the same reply as a missing run. It needs the run registry.
    send: async (f, t) => {
      const runId = await suspend(f, gated(f, t));
      const frames = await sendRequest(
        createServeCtx(f.repo, GRANTS, { detached: true }),
        request("workflow.cancel", {
          workflowIdOrName: gated(f, t).id,
          runId,
        }),
      );
      assertEquals(
        await runStatus(f, gated(f, t), runId),
        t === "prod" ? "suspended" : "cancelled",
      );
      return frames;
    },
    deniedAs: "workflow:prod-gated",
    refused: (frames) =>
      assertEquals(
        errorFrame(frames)?.error?.code,
        "workflow_cancel_failed",
      ),
  },
};

Deno.test("serve id-deny conformance: every request naming a resource has a case or an owning-issue exemption", () => {
  const named = [...serverRequestPayloadFields()]
    .filter(([, fields]) =>
      fields.some((field) => IDENTIFIER_FIELD.test(field))
    )
    .map(([type]) => type)
    .sort();
  const uncovered = named.filter((type) => !CASES[type] && !EXEMPT[type]);
  assertEquals(
    uncovered,
    [],
    "Add a case to CASES — or, only with an owning issue, to EXEMPT — for " +
      "each request type that names a resource",
  );
  const stale = [...Object.keys(CASES), ...Object.keys(EXEMPT)]
    .filter((type) => !named.includes(type));
  assertEquals(stale, [], "CASES and EXEMPT must name real request types");
  const both = Object.keys(CASES).filter((type) => EXEMPT[type]);
  assertEquals(both, [], "A covered type must not also be exempt");
});

for (const [type, testCase] of Object.entries(CASES)) {
  Deno.test(`serve id-deny conformance: ${type} by the UUID of a denied resource is refused on its name`, async () => {
    await withFixtures(async (f) => {
      const frames = await testCase.send(f, "prod");
      if (testCase.refused) testCase.refused(frames);
      else assertDenied(frames, testCase.deniedAs);
      await testCase.unchanged?.(f);
    });
  });

  Deno.test(`serve id-deny conformance: ${type} by the UUID of an allowed resource succeeds`, async () => {
    await withFixtures(async (f) => {
      assertAllowed(await testCase.send(f, "dev"), type);
    });
  });
}

Deno.test("serve id-deny conformance: runs by UUID on the detached path are refused on the resource's name", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, GRANTS, { detached: true });
    assertDenied(
      await sendRequest(
        ctx,
        request("model.method.run", {
          modelIdOrName: f.prodModel.id,
          methodName: "noop",
        }),
      ),
      "model:prod-db",
    );
    assertDenied(
      await sendRequest(
        ctx,
        request("workflow.run", { workflowIdOrName: f.prodWorkflow.id }),
      ),
      "workflow:prod-flow",
    );
    assertAllowed(
      await sendRequest(
        ctx,
        request("model.method.run", {
          modelIdOrName: f.devModel.id,
          methodName: "noop",
        }),
      ),
      "model.method.run",
    );
    assertAllowed(
      await sendRequest(
        ctx,
        request("workflow.run", { workflowIdOrName: f.devWorkflow.id }),
      ),
      "workflow.run",
    );
  });
});

Deno.test("serve id-deny conformance: a workflow named with another workflow's UUID is authorized and acted on as itself", async () => {
  await withFixtures(async (f) => {
    // Named with prod-flow's id. Names win over ids, so a request for that
    // string means this workflow — authorized and acted on as this one,
    // never as prod-flow.
    const impostor = await saveWorkflow(f.repo, f.prodWorkflow.id, f.devModel);

    const got = await sendRequest(
      f.ctx,
      request("workflow.get", { workflowIdOrName: f.prodWorkflow.id }),
    );
    assertAllowed(got, "workflow.get");
    assertEquals(
      (got.at(-1)?.payload?.data as { id?: string } | undefined)?.id,
      impostor.id,
    );

    const ran = await sendRequest(
      f.ctx,
      request("workflow.run", { workflowIdOrName: f.prodWorkflow.id }),
    );
    assertAllowed(ran, "workflow.run");
    const started = ran.find((frame) =>
      (frame.event as { kind?: string } | undefined)?.kind === "started"
    )?.event as { workflowName?: string } | undefined;
    assertEquals(started?.workflowName, impostor.name);

    const deleted = await sendRequest(
      f.ctx,
      request("workflow.delete", { workflowIdOrName: f.prodWorkflow.id }),
    );
    assertAllowed(deleted, "workflow.delete");
    await prodWorkflowKept(f);
    assertEquals(
      await f.repo.repoContext.workflowRepo.findById(
        createWorkflowId(impostor.id),
      ),
      null,
    );
  });
});

Deno.test("serve id-deny conformance: a tag-conditioned deny applies to a model requested by UUID", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, [
      grant({ actions: ACTIONS, resource: { kind: "model", pattern: "*" } }),
      grant({
        effect: "deny",
        actions: ACTIONS,
        resource: { kind: "model", pattern: "*" },
        condition: 'tags.env == "prod"',
      }),
    ]);
    assertDenied(
      await sendRequest(
        ctx,
        request("model.get", { modelIdOrName: f.prodModel.id }),
      ),
      "model:prod-db",
    );
    assertAllowed(
      await sendRequest(
        ctx,
        request("model.get", { modelIdOrName: f.devModel.id }),
      ),
      "model.get",
    );
  });
});

/** Registers a run that never finishes, as a run another request started. */
function registerRun(
  ctx: ConnectionContext,
  run: {
    kind: "method-run" | "workflow-run";
    resourceName: string;
    resourceId?: string;
  },
): { runId: string; controller: AbortController } {
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const buffer = new RunEventBuffer(16);
  buffer.finish({ kind: "done" });
  ctx.activeRunRegistry!.register({
    runId,
    ...run,
    buffer,
    controller,
    startedAt: new Date(),
    completion: Promise.resolve(),
    principalId: null,
  });
  return { runId, controller };
}

Deno.test("serve id-deny conformance: cancelling a run recorded under a raw UUID is authorized on the resolved name", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, GRANTS, { detached: true });
    const audit: AuditEvent[] = [];
    (ctx as { auditEmitter?: unknown }).auditEmitter = {
      emit: (event: AuditEvent) => audit.push(event),
    };
    // An older instance recorded the id the client sent, not the name.
    const { runId, controller } = registerRun(ctx, {
      kind: "method-run",
      resourceName: f.prodModel.id,
    });

    const frames = await sendRequest(
      ctx,
      { type: "cancel", id: runId },
      undefined,
      { awaitRuns: false },
    );

    // A refused bare cancel is silent, like one for an unknown id
    // (swamp-club#2649), so the resource it was checked on is read from the
    // audited denial rather than a reply.
    await waitFor(
      () => audit.some((event) => event.outcome === "denied"),
      "the cancel's denial to be audited",
    );
    assertEquals(frames, [], JSON.stringify(frames));
    const denial = audit.find((event) => event.outcome === "denied");
    assertEquals(denial?.resourceKind, "model");
    assertEquals(denial?.resourceName, "prod-db");
    assertEquals(controller.signal.aborted, false);
  });
});

Deno.test("serve id-deny conformance: attaching to a run authorizes the resource with the recorded id, whatever its recorded name", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, GRANTS, { detached: true });
    // Recorded under an allowed name, but the id is prod-flow's — as when a
    // workflow is renamed mid-run and another takes its old name.
    const prod = registerRun(ctx, {
      kind: "workflow-run",
      resourceName: "dev-flow",
      resourceId: f.prodWorkflow.id,
    });
    assertDenied(
      await sendRequest(
        ctx,
        request("run.attach", { runId: prod.runId }),
        undefined,
        { awaitRuns: false },
      ),
      "workflow:prod-flow",
    );

    const dev = registerRun(ctx, {
      kind: "workflow-run",
      resourceName: "dev-flow",
      resourceId: f.devWorkflow.id,
    });
    const attached = await sendRequest(
      ctx,
      request("run.attach", { runId: dev.runId }),
      undefined,
      { awaitRuns: false },
    );
    assertEquals(errorFrame(attached), undefined, JSON.stringify(attached));
    assertEquals(attached[0]?.type, "run.attached");
  });
});

Deno.test("serve id-deny conformance: a run started by UUID is recorded under the resource's name and id", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, GRANTS, { detached: true });
    const registered: { resourceName: string; resourceId?: string }[] = [];
    const register = ctx.activeRunRegistry!.register.bind(
      ctx.activeRunRegistry!,
    );
    ctx.activeRunRegistry!.register = (run) => {
      registered.push({
        resourceName: run.resourceName,
        resourceId: run.resourceId,
      });
      register(run);
    };

    await sendRequest(
      ctx,
      request("model.method.run", {
        modelIdOrName: f.devModel.id,
        methodName: "noop",
      }),
    );
    await sendRequest(
      ctx,
      request("workflow.run", { workflowIdOrName: f.devWorkflow.id }),
    );

    assertEquals(registered, [
      { resourceName: "dev-db", resourceId: f.devModel.id },
      { resourceName: "dev-flow", resourceId: f.devWorkflow.id },
    ]);
  });
});

Deno.test("serve id-deny conformance: a run's cancel fails, rather than proceeding, when its resource cannot be looked up", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, GRANTS, { detached: true });
    const { runId, controller } = registerRun(ctx, {
      kind: "workflow-run",
      resourceName: "dev-flow",
      resourceId: f.devWorkflow.id,
    });
    const failing = () => Promise.reject(new Error("repository unavailable"));
    ctx.repoContext = {
      ...ctx.repoContext,
      workflowRepo: {
        ...ctx.repoContext.workflowRepo,
        findById: failing,
        findByName: failing,
      },
    } as ConnectionContext["repoContext"];

    const frames = await sendRequest(
      ctx,
      { type: "cancel", id: runId },
      undefined,
      { awaitRuns: false },
    );

    assertEquals(errorFrame(frames)?.error?.code, "run_cancel_failed");
    assertEquals(controller.signal.aborted, false);
  });
});

Deno.test("serve id-deny conformance: an empty name is authorized as the every-resource form it runs as", async () => {
  await withFixtures(async (f) => {
    // libswamp treats an empty name as absent — validate or evaluate
    // everything — so it must be authorized as that form, never as a
    // resource named "".
    const ctx = createServeCtx(f.repo, [
      grant({
        actions: ACTIONS,
        resource: { kind: "model", pattern: "dev-*" },
      }),
      grant({
        actions: ACTIONS,
        resource: { kind: "workflow", pattern: "dev-*" },
      }),
    ]);
    for (
      const [type, field, kind] of [
        ["model.validate", "modelIdOrName", "model"],
        ["model.evaluate", "modelIdOrName", "model"],
        ["workflow.validate", "workflowIdOrName", "workflow"],
        ["workflow.evaluate", "workflowIdOrName", "workflow"],
      ] as const
    ) {
      for (const payload of [{ [field]: "" }, {}]) {
        const frames = await sendRequest(ctx, request(type, payload));
        const error = errorFrame(frames);
        assertEquals(error?.error?.code, "unauthorized", type);
        assert(
          error!.error!.message.endsWith(`${kind}:*`),
          `${type} ${JSON.stringify(payload)}: ${error!.error!.message}`,
        );
      }
    }
  });
});

Deno.test("serve id-deny conformance: an empty data model name takes the every-model form, as libswamp reads it", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, [
      grant({ actions: ACTIONS, resource: { kind: "data", pattern: "dev-*" } }),
    ]);

    // data.get: authorized as "*", never as a model named "".
    const got = errorFrame(
      await sendRequest(
        ctx,
        request("data.get", { modelIdOrName: "", dataName: "state" }),
      ),
    );
    assertEquals(got?.error?.code, "unauthorized");
    assert(got!.error!.message.endsWith("data:*"), got!.error!.message);

    // data.list: takes the any-grant path whose results are filtered per
    // item, not a named check on "".
    const listed = errorFrame(
      await sendRequest(ctx, request("data.list", { modelIdOrName: "" })),
    );
    assertNotEquals(listed?.error?.code, "unauthorized");
  });
});

Deno.test("serve id-deny conformance: cancelling a run whose workflow was deleted is not judged by a newcomer that took its name", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, [
      grant({ actions: ACTIONS, resource: { kind: "workflow", pattern: "*" } }),
      grant({
        effect: "deny",
        actions: ACTIONS,
        resource: { kind: "workflow", pattern: "*" },
        condition: 'tags.env == "prod"',
      }),
    ], { detached: true });
    const original = await saveWorkflow(f.repo, "reused", f.devModel);
    const { runId, controller } = registerRun(ctx, {
      kind: "workflow-run",
      resourceName: "reused",
      resourceId: original.id,
    });
    controller.signal.addEventListener(
      "abort",
      () => ctx.activeRunRegistry!.deregister(runId),
    );
    await f.repo.repoContext.workflowRepo.delete(original.id);
    await saveWorkflow(f.repo, "reused", f.devModel, { env: "prod" });

    await sendRequest(
      ctx,
      request("workflow.cancel", { runId }),
      undefined,
      { awaitRuns: false },
    );

    // The run is authorized on its own workflow — gone, so on its recorded
    // name — never on the newcomer's tags.
    assertEquals(controller.signal.aborted, true);
  });
});

/** Writes a hand-copied definition file: `source`'s content, renamed. */
async function copyDefinitionAs(
  f: Fixtures,
  source: Definition,
  name: string,
): Promise<void> {
  const path = f.repo.repoContext.definitionRepo.getPath(
    f.repo.modelType,
    source.id,
  );
  await Deno.writeTextFile(
    join(dirname(path), `${name}.yaml`),
    (await Deno.readTextFile(path)).replace(
      `name: ${source.name}`,
      `name: ${name}`,
    ),
  );
}

Deno.test("serve id-deny conformance: a model sharing a denied model's id is acted on as itself, never as the denied one", async () => {
  await withFixtures(async (f) => {
    // safe-model is a copied file that kept prod-db's id. A scan of the
    // definitions leaves the id cache pointing at whichever file came last.
    await copyDefinitionAs(f, f.prodModel, "safe-model");
    // Earlier requests read both by name; the later one, for prod-db, leaves
    // the shared id cache pointing at prod-db's file.
    await f.repo.repoContext.definitionRepo.findByNameGlobal("safe-model");
    await f.repo.repoContext.definitionRepo.findByNameGlobal("prod-db");

    const got = await sendRequest(
      f.ctx,
      request("model.get", { modelIdOrName: "safe-model" }),
    );
    assertAllowed(got, "model.get");
    assertEquals(
      (got.at(-1)?.payload?.data as { name?: string } | undefined)?.name,
      "safe-model",
    );

    const deleted = await sendRequest(
      f.ctx,
      request("model.delete", { modelIdOrName: "safe-model", force: true }),
    );
    assertAllowed(deleted, "model.delete");
    await prodModelKept(f);
    assertEquals(
      await f.repo.repoContext.definitionRepo.findByNameGlobal("safe-model"),
      null,
    );
  });
});

Deno.test("serve id-deny conformance: a workflow sharing a denied workflow's id is acted on as itself, never as the denied one", async () => {
  await withFixtures(async (f) => {
    const workflowRepo = f.repo.repoContext.workflowRepo;
    const path = workflowRepo.getPath(f.prodWorkflow.id);
    await Deno.writeTextFile(
      join(dirname(path), "workflow-safe-flow.yaml"),
      (await Deno.readTextFile(path)).replace(
        "name: prod-flow",
        "name: safe-flow",
      ),
    );
    await workflowRepo.findByName("safe-flow");
    await workflowRepo.findByName("prod-flow");

    const got = await sendRequest(
      f.ctx,
      request("workflow.get", { workflowIdOrName: "safe-flow" }),
    );
    assertAllowed(got, "workflow.get");
    assertEquals(
      (got.at(-1)?.payload?.data as { name?: string } | undefined)?.name,
      "safe-flow",
    );

    const deleted = await sendRequest(
      f.ctx,
      request("workflow.delete", { workflowIdOrName: "safe-flow" }),
    );
    assertAllowed(deleted, "workflow.delete");
    await prodWorkflowKept(f);
  });
});
