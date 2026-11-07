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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { setConnectionClient } from "../src/serve/handlers/shared.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { handleMessage, MAX_ACTIVE_REQUESTS } from "../src/serve/connection.ts";
import { handleHttpActionRequest } from "../src/serve/http_action_route.ts";
import { SERVE_ACTION_PATH } from "../src/serve/protocol.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import {
  DASHBOARD_SESSION_COOKIE,
  type ServerTokenAuthResult,
} from "../src/serve/token_auth.ts";
import {
  CALLER,
  createServeCtx,
  type Frame,
  grant,
  saveGatedWorkflow,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

// deno-lint-ignore no-explicit-any
type ActionBody = Record<string, any>;

const CLIENT = "integration:test-app";

const TOKENS: Record<string, string> = {
  caller: `user:${CALLER.id}`,
  other: "user:other",
};

function authenticate(token: string): Promise<ServerTokenAuthResult> {
  const name = token.split(".")[0];
  // a person of a test's own, so spending an allowance touches no other test
  const principalId = name.startsWith("person-")
    ? `user:${name}`
    : TOKENS[name];
  if (principalId === undefined || token.endsWith(".wrong")) {
    return Promise.resolve({
      ok: false,
      error: "bad token",
      reason: "secret-mismatch",
    } as unknown as ServerTokenAuthResult);
  }
  return Promise.resolve({
    ok: true,
    principalId,
    collectives: [],
    groups: [],
    tokenName: token.split(".")[0],
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
    client: CLIENT,
  } as ServerTokenAuthResult);
}

const everyAction = () =>
  grant({
    actions: ["read", "write", "run", "approve", "signal"],
    resource: { kind: "workflow", pattern: "*" },
  });

interface Route {
  url: string;
  post: (
    body: unknown,
    options?: { token?: string | null; ip?: string; headers?: HeadersInit },
  ) => Promise<{ status: number; body: ActionBody; headers: Headers }>;
  shutdown: () => Promise<void>;
}

function startRoute(ctx: ConnectionContext): Route {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) =>
      handleHttpActionRequest(
        req,
        req.headers.get("x-test-ip") ?? "127.0.0.1",
        { ctx, authenticate },
      ),
  );
  const url = `http://127.0.0.1:${server.addr.port}${SERVE_ACTION_PATH}`;
  return {
    url,
    post: async (body, options = {}) => {
      const token = options.token === undefined
        ? "caller.secret"
        : options.token;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...(options.ip ? { "x-test-ip": options.ip } : {}),
          ...options.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: JSON.parse(text),
        headers: response.headers,
      };
    },
    shutdown: () => server.shutdown(),
  };
}

async function withRoute(
  grants: ReturnType<typeof grant>[] | undefined,
  fn: (route: Route, repo: ServeRepo, ctx: ConnectionContext) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, grants, { detached: true });
    const route = startRoute(ctx);
    try {
      await fn(route, repo, ctx);
    } finally {
      // a run still writing would hold the temp dir open
      await settled(ctx).catch(() => {});
      await route.shutdown();
    }
  });
}

const start = (
  name: string,
  key: string,
  inputs?: Record<string, unknown>,
) => ({
  type: "workflow.run",
  payload: {
    workflowIdOrName: name,
    idempotencyKey: key,
    ...(inputs ? { inputs } : {}),
  },
});

const status = (runId: string) => ({
  type: "workflow.history.get",
  payload: { runId },
});

async function settled(ctx: ConnectionContext): Promise<void> {
  await waitFor(
    () => (ctx.activeRunRegistry?.size ?? 0) === 0,
    "runs left the registry",
  );
}

async function startGated(
  route: Route,
  repo: ServeRepo,
  ctx: ConnectionContext,
  name = `gated-${crypto.randomUUID()}`,
): Promise<{ name: string; runId: string; suspendedAt: string }> {
  try {
    await saveGatedWorkflow(repo, name, "gate");
  } catch { /* already saved by an earlier call */ }
  const started = await route.post(start(name, crypto.randomUUID()));
  assertEquals(started.status, 202, JSON.stringify(started.body));
  await settled(ctx);
  const runId = started.body.data.runId as string;
  const approvals = await route.post({ type: "workflow.approvals" });
  assertEquals(approvals.status, 200);
  const row = approvals.body.data.approvals.find(
    (a: { runId: string }) => a.runId === runId,
  );
  assert(row, "the run has an approval row");
  return { name, runId, suspendedAt: row.suspendedAt };
}

const decision = (
  type: "workflow.approve" | "workflow.reject",
  gated: { name: string; runId: string; suspendedAt: string },
  extra: Record<string, unknown> = {},
) => ({
  type,
  payload: {
    workflowIdOrName: gated.name,
    runId: gated.runId,
    stepName: "gate",
    suspendedAt: gated.suspendedAt,
    ...extra,
  },
});

async function storedRun(repo: ServeRepo, name: string, runId: string) {
  const workflow = await repo.repoContext.workflowRepo.findByName(name);
  return await repo.repoContext.workflowRunRepo.findById(
    workflow!.id,
    createWorkflowRunId(runId),
  );
}

async function runCount(repo: ServeRepo, name: string): Promise<number> {
  const workflow = await repo.repoContext.workflowRepo.findByName(name);
  return (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
    workflow!.id,
  ))
    .length;
}

function withoutRequestId(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

function test(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name: `serve HTTP action route: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      // the limiter is module state, so a repeat would inherit the spent allowance
      resetRateLimitState();
      await fn();
    },
  });
}

test("a start is accepted, then status reports the run paused at its gate", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const read = await route.post(status(gated.runId));
    assertEquals(read.status, 200, JSON.stringify(read.body));
    assertEquals(read.body.data.status, "suspended");
    const gate = read.body.data.jobs[0].steps[0];
    assertEquals(gate.status, "waiting_approval");
  });
});

test("a repeated decision records one decision and gets already_decided", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const first = await route.post(decision("workflow.approve", gated));
    assertEquals(first.status, 200, JSON.stringify(first.body));
    const before = (await storedRun(repo, gated.name, gated.runId))!;
    const decidedAt = before.getJob("main")!.getStep("gate")!.approvalDecision;

    const second = await route.post(decision("workflow.approve", gated));
    assertEquals(second.status, 409);
    assertEquals(second.body.code, "already_decided");
    const third = await route.post(decision("workflow.reject", gated));
    assertEquals(third.body.code, "already_decided");

    const after = (await storedRun(repo, gated.name, gated.runId))!;
    assertEquals(
      after.getJob("main")!.getStep("gate")!.approvalDecision,
      decidedAt,
    );
    assertEquals(after.status, before.status);
  });
});

test("two decisions at the same moment record one", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const replies = await Promise.all([
      route.post(decision("workflow.approve", gated, { reason: "first" })),
      route.post(decision("workflow.reject", gated, { reason: "second" })),
      route.post(decision("workflow.approve", gated, { reason: "third" })),
    ]);
    const won = replies.filter((reply) => reply.status === 200);
    assertEquals(won.length, 1, JSON.stringify(replies.map((r) => r.body)));
    for (const reply of replies.filter((r) => r.status !== 200)) {
      assertEquals(reply.status, 409);
      assert(
        ["already_decided", "busy"].includes(reply.body.code),
        reply.body.code,
      );
    }
    const run = (await storedRun(repo, gated.name, gated.runId))!;
    const recorded = run.getJob("main")!.getStep("gate")!.approvalDecision!;
    assertEquals(recorded.reason, won[0].body.data.reason);
  });
});

test("a decision for an earlier attempt of a re-opened gate is refused on HTTP and WebSocket", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const rejected = await route.post(decision("workflow.reject", gated));
    assertEquals(rejected.status, 200, JSON.stringify(rejected.body));

    const reopen = await sendOverWebSocket(ctx, {
      type: "workflow.resume",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: gated.name,
        runId: gated.runId,
        from: "gate",
      },
    });
    assertEquals(reopen.find((f) => f.type === "error"), undefined);
    await settled(ctx);

    const stale = await route.post(decision("workflow.approve", gated));
    assertEquals(stale.status, 409, JSON.stringify(stale.body));
    assertEquals(stale.body.code, "gate_reopened");

    const overSocket = await sendOverWebSocket(ctx, {
      type: "workflow.approve",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: gated.name,
        runId: gated.runId,
        stepName: "gate",
        suspendedAt: gated.suspendedAt,
      },
    });
    const refused = overSocket.find((f) => f.type === "error");
    assertEquals(
      (refused?.error as { details?: { refusalCode?: string } }).details
        ?.refusalCode,
      "gate_reopened",
    );

    const run = (await storedRun(repo, gated.name, gated.runId))!;
    const gate = run.getJob("main")!.getStep("gate")!;
    assertEquals(gate.status, "waiting_approval");
    assertEquals(gate.approvalDecision, undefined);
    assertNotEquals(gate.startedAt?.toISOString(), gated.suspendedAt);

    const current = await route.post(
      decision("workflow.approve", {
        ...gated,
        suspendedAt: gate.startedAt!.toISOString(),
      }),
    );
    assertEquals(current.status, 200, JSON.stringify(current.body));
  });
});

test("a step name used in two jobs is refused until the job is named", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `two-gates-${crypto.randomUUID()}`;
    await repo.repoContext.workflowRepo.save(Workflow.create({
      name,
      jobs: ["a", "b"].map((job) =>
        Job.create({
          name: job,
          steps: [
            Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
          ],
        })
      ),
    }));
    const started = await route.post(start(name, crypto.randomUUID()));
    assertEquals(started.status, 202, JSON.stringify(started.body));
    await settled(ctx);
    const runId = started.body.data.runId;
    const run = (await storedRun(repo, name, runId))!;
    const waiting = ["a", "b"].find((job) =>
      run.getJob(job)!.getStep("gate")!.status === "waiting_approval"
    )!;
    const gated = {
      name,
      runId,
      suspendedAt: run.getJob(waiting)!.getStep("gate")!.startedAt!
        .toISOString(),
    };

    const ambiguous = await route.post(decision("workflow.approve", gated));
    assertEquals(ambiguous.status, 409);
    assertEquals(ambiguous.body.code, "ambiguous_gate");

    const named = await route.post(
      decision("workflow.approve", gated, { jobName: waiting }),
    );
    assertEquals(named.status, 200, JSON.stringify(named.body));
    const again = await route.post(
      decision("workflow.approve", gated, { jobName: waiting }),
    );
    assertEquals(again.body.code, "already_decided");
  });
});

test("a retried start gets the first run, and a run count of one", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `retried-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const first = await route.post(start(name, "button-1"));
    const second = await route.post(start(name, "button-1"));
    assertEquals(second.status, 202);
    assertEquals(second.body.data.runId, first.body.data.runId);
    assertEquals(first.body.data.replayed, false);
    assertEquals(second.body.data.replayed, true);
    await settled(ctx);
    const afterRun = await route.post(start(name, "button-1"));
    assertEquals(afterRun.body.data.runId, first.body.data.runId);
    assertEquals(await runCount(repo, name), 1);

    const other = await route.post(start(name, "button-2"));
    assertNotEquals(other.body.data.runId, first.body.data.runId);
    await settled(ctx);
    assertEquals(await runCount(repo, name), 2);
  });
});

test("starts at the same moment with one key make one run", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `concurrent-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const replies = await Promise.all(
      [1, 2, 3, 4].map(() => route.post(start(name, "same"))),
    );
    for (const reply of replies) assertEquals(reply.status, 202);
    assertEquals(new Set(replies.map((r) => r.body.data.runId)).size, 1);
    await settled(ctx);
    assertEquals(await runCount(repo, name), 1);
  });
});

test("a start key survives a deleted run index", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `rebuilt-${crypto.randomUUID()}`;
    const workflow = await saveGatedWorkflow(repo, name, "gate");
    const first = await route.post(start(name, "survives"));
    await settled(ctx);
    const indexes: string[] = [];
    for await (
      const entry of walk(join(repo.repoDir, ".swamp"), {
        match: [/\.runs-index\.json$/],
      })
    ) {
      if (entry.path.includes(workflow.id)) indexes.push(entry.path);
    }
    assertEquals(indexes.length, 1, "the run index was found");
    await Deno.remove(indexes[0]);
    const again = await route.post(start(name, "survives"));
    assertEquals(again.body.data.runId, first.body.data.runId);
    assertEquals(again.body.data.replayed, true);
    assertEquals(await runCount(repo, name), 1);
  });
});

test("one key on two workflows starts two runs, and other inputs are refused", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const a = `key-a-${crypto.randomUUID()}`;
    const b = `key-b-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, a, "gate");
    await saveGatedWorkflow(repo, b, "gate");
    const first = await route.post(start(a, "shared"));
    const second = await route.post(start(b, "shared"));
    assertEquals(second.status, 202);
    assertNotEquals(second.body.data.runId, first.body.data.runId);
    await settled(ctx);

    const conflict = await route.post(start(a, "shared", { other: true }));
    assertEquals(conflict.status, 409);
    assertEquals(conflict.body.code, "idempotency_conflict");
    assertEquals(await runCount(repo, a), 1);
  });
});

test("the same key with other runtime tags is refused", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `tags-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const tagged = (env: string) => ({
      type: "workflow.run",
      payload: {
        workflowIdOrName: name,
        idempotencyKey: "tagged",
        runtimeTags: { env },
      },
    });
    assertEquals((await route.post(tagged("a"))).status, 202);
    await settled(ctx);
    assertEquals((await route.post(tagged("a"))).body.data.replayed, true);
    const other = await route.post(tagged("b"));
    assertEquals(other.status, 409);
    assertEquals(other.body.code, "idempotency_conflict");
  });
});

test("a socket caller's refusal carries no gate state, and the route's does", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    await route.post(decision("workflow.approve", gated));
    const frames = await sendOverWebSocket(ctx, {
      type: "workflow.approve",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: gated.name,
        runId: gated.runId,
        stepName: "gate",
      },
    });
    const error = frames.find((f) => f.type === "error")?.error as {
      details?: Record<string, unknown>;
    };
    assertEquals(error.details?.gateState, undefined);
    const overRoute = await route.post(decision("workflow.approve", gated));
    assertEquals(overRoute.body.code, "already_decided");
  });
});

test("another person's use of a key starts their own run", async () => {
  await withRoute([
    everyAction(),
    grant({
      subject: { kind: "user", name: "other" },
      actions: ["read", "run"],
      resource: { kind: "workflow", pattern: "*" },
    }),
  ], async (route, repo, ctx) => {
    const name = `people-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const mine = await route.post(start(name, "button"));
    const theirs = await route.post(start(name, "button"), {
      token: "other.secret",
    });
    assertEquals(theirs.status, 202);
    assertNotEquals(theirs.body.data.runId, mine.body.data.runId);
    await settled(ctx);
    assertEquals(await runCount(repo, name), 2);
  });
});

test("a caller that disconnects after starting leaves the run going", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });
    const name = `disconnect-${crypto.randomUUID()}`;
    const workflow = await saveGatedWorkflow(repo, name, "gate");
    const controller = new AbortController();
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        handleHttpActionRequest(req, "127.0.0.1", {
          ctx,
          authenticate,
          dispatch: (...args) => {
            // gone once serve has the request, before any reply can be read
            controller.abort();
            return handleMessage(...args);
          },
        }),
    );
    try {
      await fetch(`http://127.0.0.1:${server.addr.port}${SERVE_ACTION_PATH}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer caller.secret",
        },
        body: JSON.stringify(start(name, "gone")),
      }).then((r) => r.body?.cancel()).catch(() => {});
      await waitFor(async () => {
        const runs = await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
          workflow.id,
        );
        return runs.length === 1 && runs[0].status === "suspended";
      }, "the run reached its gate after the caller left");
      await settled(ctx);
    } finally {
      await server.shutdown();
    }
  });
});

test("a resume is limited to a suspended run", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const resumeBody = {
      type: "workflow.resume",
      payload: { workflowIdOrName: gated.name, runId: gated.runId },
    };
    const rejected = await route.post(decision("workflow.reject", gated));
    assertEquals(rejected.status, 200);

    const retried = await route.post(resumeBody);
    assertEquals(retried.status, 409, JSON.stringify(retried.body));
    assertEquals(retried.body.code, "run_not_suspended");
    assertEquals(
      (await storedRun(repo, gated.name, gated.runId))!.status,
      "failed",
    );

    const missing = await route.post({
      ...resumeBody,
      payload: { ...resumeBody.payload, runId: crypto.randomUUID() },
    });
    assertEquals(missing.status, 404);
  });
});

test("a mistyped workflow reads as not found to a caller who may run it", async () => {
  await withRoute([everyAction()], async (route) => {
    const reply = await route.post(start("no-such-workflow", "k"));
    assertEquals(reply.status, 404, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "not_found");
    const resume = await route.post({
      type: "workflow.resume",
      payload: {
        workflowIdOrName: "no-such-workflow",
        runId: crypto.randomUUID(),
      },
    });
    assertEquals(resume.status, 404, JSON.stringify(resume.body));
  });
});

test("a refused attempt stays gate_reopened when its message is withheld", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `withheld-${crypto.randomUUID()}`;
    const step = "/home/gate";
    await saveGatedWorkflow(repo, name, step);
    const started = await route.post(start(name, crypto.randomUUID()));
    await settled(ctx);
    const runId = started.body.data.runId;
    const reply = await route.post({
      type: "workflow.approve",
      payload: {
        workflowIdOrName: name,
        runId,
        stepName: step,
        suspendedAt: "2020-01-01T00:00:00.000Z",
      },
    });
    assertEquals(reply.status, 409, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "gate_reopened");
  });
});

test("a malformed attempt over the WebSocket is a refusal of the value, not a re-opened gate", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const frames = await sendOverWebSocket(ctx, {
      type: "workflow.approve",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: gated.name,
        runId: gated.runId,
        stepName: "gate",
        suspendedAt: "yesterday",
      },
    });
    const error = frames.find((f) => f.type === "error")?.error as {
      message: string;
      details?: { refusalCode?: string };
    };
    assertEquals(error.details?.refusalCode, "validation_failed");
    assert(error.message.includes("ISO 8601"), error.message);
  });
});

test("a resume that hits a fault is not a final refusal", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const runs = repo.repoContext.workflowRunRepo;
    const original = runs.findById;
    runs.findById = () => Promise.reject(new Error("disk went away"));
    try {
      const reply = await route.post({
        type: "workflow.resume",
        payload: { workflowIdOrName: gated.name, runId: gated.runId },
      });
      assertEquals(reply.status, 500, JSON.stringify(reply.body));
      assertEquals(reply.body.code, "action_failed");
    } finally {
      runs.findById = original;
    }
  });
});

test("an approved run can be resumed over the route", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const approved = await route.post(decision("workflow.approve", gated));
    assertEquals(approved.status, 200);
    assertEquals(approved.body.data.autoResumed, false);
    const resumed = await route.post({
      type: "workflow.resume",
      payload: { workflowIdOrName: gated.name, runId: gated.runId },
    });
    assertEquals(resumed.status, 202, JSON.stringify(resumed.body));
    assertEquals(resumed.body.data.runId, gated.runId);
    await settled(ctx);
    await waitFor(
      async () =>
        (await storedRun(repo, gated.name, gated.runId))?.status ===
          "succeeded",
      "the resumed run finished",
    );
  });
});

test("a cookie alone is refused, whatever session it names", async () => {
  await withRoute([everyAction()], async (route) => {
    const reply = await route.post({ type: "workflow.approvals" }, {
      token: null,
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=any-session` },
    });
    assertEquals(reply.status, 401);
    assertEquals(reply.body.code, "unauthorized");
  });
});

test("types and fields not on the lists are refused", async () => {
  await withRoute([everyAction()], async (route) => {
    for (
      const type of ["data.get", "workflow.delete", "workflow.run.summary"]
    ) {
      const reply = await route.post({ type, payload: {} });
      assertEquals(reply.status, 404, type);
      assertEquals(reply.body.code, "type_not_allowed");
    }
    const runId = crypto.randomUUID();
    const refused: [string, Record<string, unknown>][] = [
      ["workflow.run", { workflowIdOrName: "w" }],
      ["workflow.run", {
        workflowIdOrName: "w",
        idempotencyKey: "k",
        lockHolderTokens: "x",
      }],
      ["workflow.run", {
        workflowIdOrName: "w",
        idempotencyKey: "k",
        skipAllChecks: true,
      }],
      ["workflow.run", {
        workflowIdOrName: "w",
        idempotencyKey: "k",
        initiatedBy: "someone",
      }],
      ["workflow.run", {
        workflowIdOrName: "w",
        idempotencyKey: "k",
        client: "direct:cli",
      }],
      ["workflow.resume", { workflowIdOrName: "w", runId, from: "gate" }],
      ["workflow.resume", {
        workflowIdOrName: "w",
        runId,
        suspendedOnly: false,
      }],
      ["workflow.resume", { workflowIdOrName: "w" }],
      ["workflow.approve", {
        workflowIdOrName: "w",
        stepName: "s",
        suspendedAt: "2026-01-01T00:00:00.000Z",
      }],
      ["workflow.approve", { workflowIdOrName: "w", runId, stepName: "s" }],
      ["workflow.approve", {
        workflowIdOrName: "w",
        runId,
        stepName: "s",
        suspendedAt: "2026-01-01T00:00:00.000Z",
        decidedBy: "someone",
      }],
      ["workflow.reject", {
        workflowIdOrName: "w",
        runId,
        stepName: "s",
        suspendedAt: "2026-01-01T00:00:00.000Z",
        strictGate: false,
      }],
      ["workflow.history.get", { runId: "abc" }],
      ["workflow.history.get", { runId, exactRun: false }],
      ["workflow.history.get", { workflowIdOrName: "w" }],
    ];
    for (const [type, payload] of refused) {
      const reply = await route.post({ type, payload });
      assertEquals(reply.status, 400, JSON.stringify({ type, payload, reply }));
      assertEquals(reply.body.code, "invalid_request");
    }
    const withId = await route.post({ type: "workflow.approvals", id: "mine" });
    assertEquals(withId.status, 400);
  });
});

test("the body must be JSON of a bounded size", async () => {
  await withRoute([everyAction()], async (route) => {
    const notJson = await route.post("nope");
    assertEquals(notJson.status, 400);
    const big = await route.post(
      start("w", "k", { blob: "x".repeat(200 * 1024) }),
    );
    assertEquals(big.status, 413);
    const plain = await fetch(route.url, {
      method: "POST",
      headers: {
        authorization: "Bearer caller.secret",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ type: "workflow.approvals" }),
    });
    assertEquals(plain.status, 415);
    await plain.body?.cancel();
    const get = await fetch(route.url, {
      headers: { authorization: "Bearer caller.secret" },
    });
    assertEquals(get.status, 405);
    await get.body?.cancel();
  });
});

test("a caller with no grant gets the same reply for a real run and a missing one", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const missing = crypto.randomUUID();
    const as = { token: "other.secret" };

    const real = await route.post(status(gated.runId), as);
    const none = await route.post(status(missing), as);
    assertEquals(real.status, 404);
    assertEquals(none.status, 404);
    assertEquals(withoutRequestId(real.body), withoutRequestId(none.body));

    const realGate = await route.post(decision("workflow.approve", gated), as);
    const noRun = await route.post(
      decision("workflow.approve", { ...gated, runId: missing }),
      as,
    );
    const noWorkflow = await route.post(
      decision("workflow.approve", { ...gated, name: "not-a-workflow" }),
      as,
    );
    assertEquals(realGate.status, 403);
    assertEquals(withoutRequestId(realGate.body), withoutRequestId(noRun.body));
    assertEquals(
      withoutRequestId(realGate.body),
      withoutRequestId(noWorkflow.body),
    );
    assertEquals(JSON.stringify(realGate.body).includes(gated.name), false);

    const noRunGrant = await route.post(start(gated.name, "k"), as);
    const noSuchWorkflow = await route.post(start("not-a-workflow", "k"), as);
    assertEquals(noRunGrant.status, 403);
    assertEquals(
      withoutRequestId(noRunGrant.body),
      withoutRequestId(noSuchWorkflow.body),
    );
  });
});

test("a wildcard read with a deny on one workflow reads like a missing run", async () => {
  await withServeRepo(async (repo) => {
    const name = `denied-${crypto.randomUUID()}`;
    const ctx = createServeCtx(repo, [
      everyAction(),
      grant({
        effect: "deny",
        subject: { kind: "user", name: "other" },
        actions: ["read"],
        resource: { kind: "workflow", pattern: name },
      }),
      grant({
        subject: { kind: "user", name: "other" },
        actions: ["read"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ], { detached: true });
    const route = startRoute(ctx);
    try {
      const gated = await startGated(route, repo, ctx, name);
      const as = { token: "other.secret" };
      const real = await route.post(status(gated.runId), as);
      const none = await route.post(status(crypto.randomUUID()), as);
      assertEquals(real.status, 404);
      assertEquals(withoutRequestId(real.body), withoutRequestId(none.body));
    } finally {
      await route.shutdown();
    }
  });
});

test("status reads one run by id: a miss never scans history, and no outputs are read", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    // on the class: the history read builds a repository of its own
    const proto = YamlWorkflowRunRepository.prototype;
    const original = proto.findAllGlobal;
    let scans = 0;
    proto.findAllGlobal = function (this: YamlWorkflowRunRepository) {
      scans++;
      return original.call(this);
    };
    try {
      const miss = await route.post(status(crypto.randomUUID()));
      assertEquals(miss.status, 404);
      const hit = await route.post(status(gated.runId.toUpperCase()));
      assertEquals(hit.status, 200, JSON.stringify(hit.body));
      assertEquals(hit.body.data.id, gated.runId);
      assertEquals(scans, 0);
    } finally {
      proto.findAllGlobal = original;
    }
  });
});

test("a run held elsewhere is busy, unless its gate was already decided", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const registry = ctx.activeRunRegistry!;
    const hold = registry.reserve(gated.runId)!;
    try {
      const busy = await route.post(decision("workflow.approve", gated));
      assertEquals(busy.status, 409);
      assertEquals(busy.body.code, "busy");
      assertEquals(
        (await storedRun(repo, gated.name, gated.runId))!.getJob("main")!
          .getStep("gate")!.approvalDecision,
        undefined,
      );
    } finally {
      hold();
    }
    const approved = await route.post(decision("workflow.approve", gated));
    assertEquals(approved.status, 200, JSON.stringify(approved.body));

    const heldAgain = registry.reserve(gated.runId)!;
    try {
      const again = await route.post(decision("workflow.approve", gated));
      assertEquals(again.status, 409);
      assertEquals(again.body.code, "already_decided");
    } finally {
      heldAgain();
    }
  });
});

test("a broken workflow file discloses no path", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const dir = join(repo.repoDir, "workflows");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workflow-broken.yaml"),
      "id: not-a-uuid\nname: broken\njobs: 3\n",
    );
    const reply = await route.post(start("broken", "k"));
    assert(reply.status >= 400, JSON.stringify(reply.body));
    assertEquals(JSON.stringify(reply.body).includes(repo.repoDir), false);
    assertEquals(JSON.stringify(reply.body).includes(".yaml"), false);
  });
});

test("one person's rate limit leaves another's allowance alone", async () => {
  await withRoute([everyAction()], async (route) => {
    const person = `person-${crypto.randomUUID()}.secret`;
    let limited = false;
    for (let i = 0; i < 260 && !limited; i++) {
      const reply = await route.post({ type: "workflow.approvals" }, {
        token: person,
      });
      limited = reply.status === 429;
      if (limited) assertEquals(reply.body.code, "rate_limited");
    }
    assert(limited, "the caller reached the limit");
    const other = await route.post(
      { type: "workflow.approvals" },
      { token: "other.secret" },
    );
    assertNotEquals(other.status, 429);
  });
});

test("wrong secrets lock out the guesser's address, not the token's holder", async () => {
  await withRoute([everyAction()], async (route) => {
    const body = { type: "workflow.approvals" };
    const guesser = { token: "caller.wrong", ip: "203.0.113.9" };
    let last = await route.post(body, guesser);
    for (let i = 0; i < 6; i++) last = await route.post(body, guesser);
    assertEquals(last.status, 429);
    const holder = await route.post(body, {
      token: "caller.secret",
      ip: "203.0.113.10",
    });
    assertEquals(holder.status, 200, JSON.stringify(holder.body));
  });
});

test("an existing grant condition applies as it does over the WebSocket", async () => {
  await withServeRepo(async (repo) => {
    const name = `conditional-${crypto.randomUUID()}`;
    const ctx = createServeCtx(repo, [
      everyAction(),
      grant({
        effect: "deny",
        actions: ["approve"],
        resource: { kind: "workflow", pattern: "*" },
        condition: `principal.sub == "${CALLER.id}"`,
      }),
    ], { detached: true });
    const route = startRoute(ctx);
    try {
      const gated = await startGated(route, repo, ctx, name);
      const reply = await route.post(decision("workflow.approve", gated));
      assertEquals(reply.status, 403, JSON.stringify(reply.body));
      const overSocket = await sendOverWebSocket(ctx, {
        type: "workflow.approve",
        id: crypto.randomUUID(),
        payload: {
          workflowIdOrName: name,
          runId: gated.runId,
          stepName: "gate",
        },
      });
      assertEquals(
        overSocket.find((f) => f.type === "error")?.error?.code,
        "unauthorized",
      );
      const run = (await storedRun(repo, name, gated.runId))!;
      assertEquals(
        run.getJob("main")!.getStep("gate")!.approvalDecision,
        undefined,
      );
    } finally {
      await route.shutdown();
    }
  });
});

const FORBID_SELF_APPROVAL = () =>
  grant({
    effect: "deny",
    actions: ["approve"],
    resource: { kind: "workflow", pattern: "*" },
    condition: "principal.sub == run.initiator.sub",
  });

const FORBID_SELF_WITH_APPROVER = () => [
  everyAction(),
  FORBID_SELF_APPROVAL(),
  grant({
    subject: { kind: "user", name: "person-other" },
    actions: ["read", "approve"],
    resource: { kind: "workflow", pattern: "*" },
  }),
];

for (const type of ["workflow.approve", "workflow.reject"] as const) {
  test(`${type}: a run-conditional deny gives the same refusal at a waiting gate and on a run that has ended`, async () => {
    await withRoute(FORBID_SELF_WITH_APPROVER(), async (route, repo, ctx) => {
      const gated = await startGated(route, repo, ctx);
      const other = "person-other.secret";

      const waiting = await route.post(decision(type, gated));
      assertEquals(waiting.status, 403, JSON.stringify(waiting.body));

      const rejected = await route.post(decision("workflow.reject", gated), {
        token: other,
      });
      assertEquals(rejected.status, 200, JSON.stringify(rejected.body));
      await settled(ctx);

      const ended = await route.post(decision(type, gated));
      assertEquals(ended.status, 403, JSON.stringify(ended.body));
      assertEquals(
        withoutRequestId(ended.body),
        withoutRequestId(waiting.body),
      );

      const repeated = await route.post(decision(type, gated), {
        token: other,
      });
      assertEquals(repeated.status, 409);
      assertEquals(repeated.body.code, "already_decided");
    });
  });

  test(`${type}: a run-conditional deny refuses on a run held elsewhere, where someone else is told busy`, async () => {
    await withRoute(FORBID_SELF_WITH_APPROVER(), async (route, repo, ctx) => {
      const gated = await startGated(route, repo, ctx);
      const hold = ctx.activeRunRegistry!.reserve(gated.runId)!;
      try {
        const refused = await route.post(decision(type, gated));
        assertEquals(refused.status, 403, JSON.stringify(refused.body));

        const busy = await route.post(decision(type, gated), {
          token: "person-other.secret",
        });
        assertEquals(busy.status, 409, JSON.stringify(busy.body));
        assertEquals(busy.body.code, "busy");
      } finally {
        hold();
      }
    });
  });
}

for (const type of ["workflow.approve", "workflow.reject"] as const) {
  test(`${type}: a refusal by a run condition is one reply, whichever way the run was found`, async () => {
    await withRoute(FORBID_SELF_WITH_APPROVER(), async (route, repo, ctx) => {
      const gated = await startGated(route, repo, ctx);
      const frame = {
        type,
        id: crypto.randomUUID(),
        payload: {
          workflowIdOrName: gated.name,
          runId: gated.runId,
          stepName: "gate",
          strictGate: true,
        },
      };
      const hold = ctx.activeRunRegistry!.reserve(gated.runId)!;
      try {
        const held = await sendOverWebSocket(ctx, frame);
        assertEquals(held.map((f) => f.error?.code), ["unauthorized"]);
      } finally {
        hold();
      }
      const rejected = await route.post(decision("workflow.reject", gated), {
        token: "person-other.secret",
      });
      assertEquals(rejected.status, 200, JSON.stringify(rejected.body));
      await settled(ctx);
      const ended = await sendOverWebSocket(ctx, frame);
      assertEquals(ended.map((f) => f.error?.code), ["unauthorized"]);
    });
  });
}

test("a deny on the client refuses the decision", async () => {
  await withRoute(
    [
      everyAction(),
      grant({
        effect: "deny",
        actions: ["approve"],
        resource: { kind: "workflow", pattern: "*" },
        condition: `client == "${CLIENT}"`,
      }),
    ],
    async (route, repo, ctx) => {
      const gated = await startGated(route, repo, ctx);
      const reply = await route.post(decision("workflow.approve", gated));
      assertEquals(reply.status, 403, JSON.stringify(reply.body));
      assertEquals(reply.body.code, "forbidden");
    },
  );
});

async function saveWorkflowOf(
  repo: ServeRepo,
  jobs: { name: string; steps: Step[] }[],
  autoResume?: boolean,
): Promise<string> {
  const name = `made-${crypto.randomUUID()}`;
  await repo.repoContext.workflowRepo.save(Workflow.create({
    name,
    ...(autoResume !== undefined ? { autoResume } : {}),
    jobs: jobs.map((job) => Job.create(job)),
  }));
  return name;
}

const gateStep = (name: string, timeout?: number) =>
  Step.create({ name, task: StepTask.manualApproval("ok?", timeout) });

/** a gate waiting with a later step not reached, which a live run moves past */
async function suspendedWithUnreachedStep(
  repo: ServeRepo,
): Promise<{ name: string; runId: string; suspendedAt: string }> {
  const name = `unreached-${crypto.randomUUID()}`;
  const workflow = Workflow.create({
    name,
    jobs: [Job.create({
      name: "main",
      steps: [gateStep("gate"), gateStep("later")],
    })],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const gate = job.getStep("gate")!;
  gate.start();
  gate.waitForApproval();
  run.suspend();
  await repo.repoContext.workflowRunRepo.save(workflow.id, run);
  return { name, runId: run.id, suspendedAt: gate.startedAt!.toISOString() };
}

async function startSignalled(
  route: Route,
  repo: ServeRepo,
  autoResume?: boolean,
): Promise<{ name: string; runId: string }> {
  const name = await saveWorkflowOf(repo, [{
    name: "main",
    steps: [Step.create({
      name: "wait",
      task: StepTask.waitForSignal(
        3600,
        { type: "object", properties: { verdict: { type: "string" } } },
        "verdict",
      ),
    })],
  }], autoResume);
  const started = await route.post(start(name, crypto.randomUUID()));
  assertEquals(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.data.runId as string;
  await waitFor(
    async () => (await storedRun(repo, name, runId))?.status === "suspended",
    "the run waits for its signal",
  );
  return { name, runId };
}

test("a signal resumes the waiting run, records who sent it, and is audited", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const audit = capturingAudit(ctx);
    const { name, runId } = await startSignalled(route, repo, true);
    const reply = await route.post({
      type: "workflow.signal",
      payload: { workflow: name, key: "verdict", payload: { verdict: "ship" } },
    });
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    assertEquals(reply.body.data.signal.submittedBy, `user:${CALLER.id}`);
    assertEquals(reply.body.data.runId, runId);
    await waitFor(
      async () => (await storedRun(repo, name, runId))?.status === "succeeded",
      "the signalled run finishes",
    );
    const event = audit.find((e) =>
      e.action === "workflow.signal" && e.stage === "response"
    );
    assert(event, "the signal is audited");
    assertEquals(event.principalId, CALLER.id);
    assertEquals(event.client, CLIENT);
  });
});

test("a signal to a workflow that does not auto-resume leaves the run for a resume", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const { name, runId } = await startSignalled(route, repo);
    const reply = await route.post({
      type: "workflow.signal",
      payload: { workflow: name, key: "verdict", payload: { verdict: "ship" } },
    });
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    await settled(ctx);
    assertEquals((await storedRun(repo, name, runId))?.status, "suspended");
    const resumed = await route.post({
      type: "workflow.resume",
      payload: { workflowIdOrName: name, runId },
    });
    assertEquals(resumed.status, 202, JSON.stringify(resumed.body));
    await waitFor(
      async () => (await storedRun(repo, name, runId))?.status === "succeeded",
      "the resumed run finishes",
    );
  });
});

test("an approval of a workflow that auto-resumes reports it and the run finishes", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = await saveWorkflowOf(
      repo,
      [{ name: "main", steps: [gateStep("gate")] }],
      true,
    );
    const started = await route.post(start(name, crypto.randomUUID()));
    assertEquals(started.status, 202, JSON.stringify(started.body));
    await settled(ctx);
    const runId = started.body.data.runId as string;
    const run = (await storedRun(repo, name, runId))!;
    const gated = {
      name,
      runId,
      suspendedAt: run.getJob("main")!.getStep("gate")!.startedAt!
        .toISOString(),
    };
    const approved = await route.post(decision("workflow.approve", gated));
    assertEquals(approved.status, 200, JSON.stringify(approved.body));
    assertEquals(approved.body.data.autoResumed, true);
    await waitFor(
      async () =>
        (await storedRun(repo, name, gated.runId))?.status === "succeeded",
      "the approved run finishes",
    );
  });
});

test("a signal from a caller with no grant reads like one for nothing", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const { name, runId } = await startSignalled(route, repo);
    const signal = (key: string) => ({
      type: "workflow.signal",
      payload: { workflow: name, key, payload: { verdict: "ship" } },
    });
    const refused = await route.post(signal("verdict"), {
      token: "other.secret",
    });
    const missing = await route.post(signal("no-such-key"));
    assertEquals(refused.status, 404, JSON.stringify(refused.body));
    assertEquals(missing.status, 404, JSON.stringify(missing.body));
    assertEquals(
      withoutRequestId(refused.body),
      withoutRequestId(missing.body),
    );
    assertEquals((await storedRun(repo, name, runId))?.status, "suspended");
  });
});

test("a retried signal with one key delivers once", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const { name } = await startSignalled(route, repo);
    const body = {
      type: "workflow.signal",
      payload: {
        workflow: name,
        key: "verdict",
        payload: { verdict: "ship" },
        idempotencyKey: "signal-once",
      },
    };
    const first = await route.post(body);
    assertEquals(first.status, 200, JSON.stringify(first.body));
    const second = await route.post(body);
    if (second.status === 200) {
      assertEquals(second.body.data.signal.id, first.body.data.signal.id);
    } else {
      assertEquals(second.status, 404, JSON.stringify(second.body));
    }
  });
});

test("workflow.reject: a same-name step and an old attempt are refused, as for approve", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = await saveWorkflowOf(
      repo,
      ["a", "b"].map((job) => ({ name: job, steps: [gateStep("gate")] })),
    );
    const started = await route.post(start(name, crypto.randomUUID()));
    await settled(ctx);
    const runId = started.body.data.runId as string;
    const run = (await storedRun(repo, name, runId))!;
    const waiting = ["a", "b"].find((job) =>
      run.getJob(job)!.getStep("gate")!.status === "waiting_approval"
    )!;
    const suspendedAt = run.getJob(waiting)!.getStep("gate")!.startedAt!
      .toISOString();
    const gated = { name, runId, suspendedAt };

    const ambiguous = await route.post(decision("workflow.reject", gated));
    assertEquals(ambiguous.body.code, "ambiguous_gate");

    const old = await route.post(decision("workflow.reject", {
      ...gated,
      suspendedAt: "2020-01-01T00:00:00.000Z",
    }, { jobName: waiting }));
    assertEquals(old.status, 409, JSON.stringify(old.body));
    assertEquals(old.body.code, "gate_reopened");
    assertEquals(
      (await storedRun(repo, name, runId))!.getJob(waiting)!.getStep("gate")!
        .approvalDecision,
      undefined,
    );
  });
});

test("the time alone picks the gate of a step name in two jobs over the WebSocket", async () => {
  await withServeRepo(async (repo) => {
    const name = `two-waiting-${crypto.randomUUID()}`;
    const workflow = Workflow.create({
      name,
      jobs: ["a", "b"].map((job) =>
        Job.create({ name: job, steps: [gateStep("gate")] })
      ),
    });
    await repo.repoContext.workflowRepo.save(workflow);
    const run = WorkflowRun.create(workflow);
    run.start();
    for (const job of ["a", "b"]) {
      run.getJob(job)!.start();
      run.getJob(job)!.getStep("gate")!.start();
      run.getJob(job)!.getStep("gate")!.waitForApproval();
    }
    const second = run.getJob("b")!.getStep("gate")!;
    const later = new Date(second.startedAt!.getTime() + 1000);
    const data = run.toData();
    data.jobs.find((j) => j.jobName === "b")!.steps[0].startedAt = later
      .toISOString();
    const stored = WorkflowRun.fromData(data);
    stored.suspend();
    await repo.repoContext.workflowRunRepo.save(workflow.id, stored);
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });

    const frames = await sendOverWebSocket(ctx, {
      type: "workflow.approve",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: name,
        runId: stored.id,
        stepName: "gate",
        suspendedAt: later.toISOString(),
      },
    });
    assertEquals(frames.find((f) => f.type === "error"), undefined);
    const after = (await storedRun(repo, name, stored.id))!;
    assertEquals(
      after.getJob("a")!.getStep("gate")!.approvalDecision,
      undefined,
    );
    assert(after.getJob("b")!.getStep("gate")!.approvalDecision?.approved);
  });
});

test("a gate past its timeout is gate_closed and records nothing", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = await saveWorkflowOf(repo, [{
      name: "main",
      steps: [gateStep("gate", 1)],
    }]);
    const started = await route.post(start(name, crypto.randomUUID()));
    await settled(ctx);
    const runId = started.body.data.runId as string;
    const run = (await storedRun(repo, name, runId))!;
    const gated = {
      name,
      runId,
      suspendedAt: run.getJob("main")!.getStep("gate")!.startedAt!
        .toISOString(),
    };
    await waitFor(async () => {
      const listed = await route.post({ type: "workflow.approvals" });
      return listed.body.data.expired.some((row: { runId: string }) =>
        row.runId === runId
      );
    }, "the gate is past its timeout");
    const reply = await route.post(decision("workflow.approve", gated));
    assertEquals(reply.status, 409, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "gate_closed");
    assertEquals(
      (await storedRun(repo, name, runId))!.getJob("main")!.getStep("gate")!
        .approvalDecision,
      undefined,
    );
  });
});

test("a step the run has not reached is gate_not_open", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const gated = await suspendedWithUnreachedStep(repo);
    const reply = await route.post(
      decision("workflow.approve", gated, { stepName: "later" }),
    );
    assertEquals(reply.status, 409, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "gate_not_open");
  });
});

test("a gate of a run walking again is busy, not closed", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const gated = await suspendedWithUnreachedStep(repo);
    const workflow = await repo.repoContext.workflowRepo.findByName(gated.name);
    const run = (await storedRun(repo, gated.name, gated.runId))!;
    await repo.repoContext.workflowRunRepo.save(
      workflow!.id,
      WorkflowRun.fromData({ ...run.toData(), status: "running" }),
    );
    const reply = await route.post(decision("workflow.approve", gated));
    assertEquals(reply.status, 409, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "busy");
    assert(reply.headers.get("retry-after"), "the caller is told to retry");
  });
});

test("a keyed start and a limited resume are refused, not dropped, with no registry", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()]);
    const name = `no-registry-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const started = await sendOverWebSocket(ctx, {
      type: "workflow.run",
      id: crypto.randomUUID(),
      payload: { workflowIdOrName: name, idempotencyKey: "k" },
    });
    assertEquals(started.map((f) => f.error?.code), ["runs_unavailable"]);
    assertEquals(await runCount(repo, name), 0);
    const resumed = await sendOverWebSocket(ctx, {
      type: "workflow.resume",
      id: crypto.randomUUID(),
      payload: {
        workflowIdOrName: name,
        runId: crypto.randomUUID(),
        suspendedOnly: true,
      },
    });
    assertEquals(resumed.map((f) => f.error?.code), ["runs_unavailable"]);
  });
});

// called directly: a served request's signal also aborts when its reply ends
test("a read past the deadline is stopped, and other work carries on", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });
    const seen: { type: string; socket: WebSocket }[] = [];
    let release = () => {};
    const handled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = async (body: unknown) => {
      const response = await handleHttpActionRequest(
        new Request(`http://127.0.0.1${SERVE_ACTION_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer caller.secret",
          },
          body: JSON.stringify(body),
        }),
        "127.0.0.1",
        {
          ctx,
          authenticate,
          deadlineMs: 20,
          dispatch: (socket, _ctx, _active, event) => {
            seen.push({ type: JSON.parse(String(event.data)).type, socket });
            return handled;
          },
        },
      );
      assertEquals(response.status, 503);
      await response.body?.cancel();
    };
    try {
      await send({ type: "workflow.approvals" });
      await send({
        type: "workflow.approve",
        payload: {
          workflowIdOrName: "x",
          runId: crypto.randomUUID(),
          stepName: "gate",
          suspendedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      assertEquals(seen.map(({ type }) => type), [
        "workflow.approvals",
        "workflow.approve",
      ]);
      assert(seen[0].socket.readyState !== WebSocket.OPEN, "the read stopped");
      assertEquals(seen[1].socket.readyState, WebSocket.OPEN);
    } finally {
      release();
    }
  });
});

test("a retry after the run has ended gets that run, and starts nothing", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `ended-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const first = await route.post(start(name, "ended-key"));
    await settled(ctx);
    const runId = first.body.data.runId as string;
    const row = (await route.post({ type: "workflow.approvals" })).body.data
      .approvals.find((a: { runId: string }) => a.runId === runId);
    const rejected = await route.post(decision("workflow.reject", {
      name,
      runId,
      suspendedAt: row.suspendedAt,
    }));
    assertEquals(rejected.status, 200, JSON.stringify(rejected.body));
    const retried = await route.post(start(name, "ended-key"));
    assertEquals(retried.status, 202, JSON.stringify(retried.body));
    assertEquals(retried.body.data.runId, runId);
    assertEquals(retried.body.data.replayed, true);
    assertEquals(await runCount(repo, name), 1);
  });
});

test("a start that fails before it started frees its key, so a retry starts afresh", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `failed-start-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const runs = repo.repoContext.workflowRunRepo;
    const save = runs.save.bind(runs);
    let fail = true;
    runs.save = (...args) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("the store is away"));
      }
      return save(...args);
    };
    try {
      const failed = await route.post(start(name, "fresh-key"));
      assert(failed.status >= 500, JSON.stringify(failed.body));
    } finally {
      runs.save = save;
    }
    await settled(ctx);
    const retried = await route.post(start(name, "fresh-key"));
    assertEquals(retried.status, 202, JSON.stringify(retried.body));
    assertEquals(retried.body.data.replayed, false);
  });
});

test("a key survives a restart of serve", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `restart-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const first = await route.post(start(name, "restart-key"));
    await settled(ctx);
    const restarted = startRoute(
      createServeCtx(repo, [everyAction()], { detached: true }),
    );
    try {
      const retried = await restarted.post(start(name, "restart-key"));
      assertEquals(retried.status, 202, JSON.stringify(retried.body));
      assertEquals(retried.body.data.runId, first.body.data.runId);
      assertEquals(retried.body.data.replayed, true);
    } finally {
      await restarted.shutdown();
    }
  });
});

test("a run named under another workflow is not found and is left alone", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const other = `other-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, other, "gate");
    const reply = await route.post(
      decision("workflow.approve", { ...gated, name: other }),
    );
    assertEquals(reply.status, 404, JSON.stringify(reply.body));
    assertEquals(
      (await storedRun(repo, gated.name, gated.runId))!.getJob("main")!
        .getStep("gate")!.approvalDecision,
      undefined,
    );
  });
});

test("two resumes at the same moment continue the run once", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const approved = await route.post(decision("workflow.approve", gated));
    assertEquals(approved.status, 200, JSON.stringify(approved.body));
    const resume = {
      type: "workflow.resume",
      payload: { workflowIdOrName: gated.name, runId: gated.runId },
    };
    const replies = await Promise.all([route.post(resume), route.post(resume)]);
    const went = replies.filter((reply) => reply.status === 202);
    assertEquals(went.length, 1, JSON.stringify(replies.map((r) => r.body)));
    const other = replies.find((reply) => reply.status !== 202)!;
    assertEquals(other.status, 409, JSON.stringify(other.body));
    assert(
      ["busy", "run_not_suspended"].includes(other.body.code),
      other.body.code,
    );
    await settled(ctx);
    assertEquals(await runCount(repo, gated.name), 1);
  });
});

test("a person over the run limit gets too_many_runs, and nothing starts", async () => {
  await withServeRepo(async (repo) => {
    const registry = new ActiveRunRegistry({ maxPerPrincipal: 1 });
    const ctx = createServeCtx(repo, [everyAction()], {
      activeRunRegistry: registry,
    });
    const route = startRoute(ctx);
    const held = crypto.randomUUID();
    try {
      const name = `limited-${crypto.randomUUID()}`;
      await saveGatedWorkflow(repo, name, "gate");
      registry.register(
        {
          runId: held,
          principalId: `user:${CALLER.id}`,
          type: "workflow",
          controller: new AbortController(),
        } as unknown as Parameters<typeof registry.register>[0],
      );
      const reply = await route.post(start(name, "limited-key"));
      assertEquals(reply.status, 429, JSON.stringify(reply.body));
      assertEquals(reply.body.code, "too_many_runs");
      assert(reply.body.message.includes(CALLER.id) === false);
      assertEquals(await runCount(repo, name), 0);
    } finally {
      registry.deregister(held);
      await route.shutdown();
    }
  });
});

test("a server that can't keep a run going refuses starts and resumes, and still answers reads", async () => {
  await withServeRepo(async (repo) => {
    const route = startRoute(createServeCtx(repo, [everyAction()]));
    try {
      const name = `no-registry-${crypto.randomUUID()}`;
      await saveGatedWorkflow(repo, name, "gate");
      const run = await route.post(start(name, "key"));
      assertEquals(run.status, 503, JSON.stringify(run.body));
      assertEquals(run.body.code, "runs_unavailable");
      const resume = await route.post({
        type: "workflow.resume",
        payload: { workflowIdOrName: name, runId: crypto.randomUUID() },
      });
      assertEquals(resume.body.code, "runs_unavailable");
      const read = await route.post({ type: "workflow.approvals" });
      assertEquals(read.status, 200);
    } finally {
      await route.shutdown();
    }
  });
});

test("inputs the workflow refuses are a 400 that starts nothing, and free the key", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const name = `typed-${crypto.randomUUID()}`;
    await repo.repoContext.workflowRepo.save(Workflow.create({
      name,
      inputs: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      jobs: [Job.create({ name: "main", steps: [gateStep("gate")] })],
    }));
    const refused = await route.post(start(name, "typed-key", { count: "x" }));
    assertEquals(refused.status, 400, JSON.stringify(refused.body));
    assertEquals(refused.body.code, "invalid_request");
    assertEquals(await runCount(repo, name), 0);
    const fixed = await route.post(start(name, "typed-key", { count: 1 }));
    assertEquals(fixed.status, 202, JSON.stringify(fixed.body));
    assertEquals(fixed.body.data.replayed, false);
    await settled(ctx);
  });
});

test("authorization off records no invented decider", async () => {
  await withRoute(undefined, async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const reply = await route.post(decision("workflow.approve", gated), {
      token: null,
    });
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    const run = (await storedRun(repo, gated.name, gated.runId))!;
    assertEquals(
      run.getJob("main")!.getStep("gate")!.approvalDecision?.decidedBy,
      "@anonymous",
    );
  });
});

test("the deadline answers a retryable reply while the work carries on", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });
    let release = () => {};
    const handled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        handleHttpActionRequest(req, "127.0.0.1", {
          ctx,
          authenticate,
          deadlineMs: 20,
          dispatch: () => handled,
        }),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.addr.port}${SERVE_ACTION_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer caller.secret",
          },
          body: JSON.stringify({ type: "workflow.approvals" }),
        },
      );
      assertEquals(response.status, 503);
      assertEquals((await response.json()).code, "still_working");
    } finally {
      release();
      await server.shutdown();
    }
  });
});

test("no reply on the route carries where the repo is on the server", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const gated = await startGated(route, repo, ctx);
    const replies = [
      await route.post(status(gated.runId)),
      await route.post({ type: "workflow.approvals" }),
      await route.post(decision("workflow.approve", gated)),
      await route.post({
        type: "workflow.resume",
        payload: { workflowIdOrName: gated.name, runId: gated.runId },
      }),
    ];
    await settled(ctx);
    replies.push(await route.post(status(gated.runId)));
    replies.push(await route.post(start(gated.name, crypto.randomUUID())));
    await settled(ctx);
    for (const reply of replies) {
      const text = JSON.stringify(reply.body);
      assert(reply.status < 300, text);
      assertEquals(text.includes(repo.repoDir), false, text);
    }
    assertEquals(replies[0].body.data.path, undefined);
    const signalled = await startSignalled(route, repo);
    const signal = await route.post({
      type: "workflow.signal",
      payload: {
        workflow: signalled.name,
        key: "verdict",
        payload: { verdict: "ship" },
      },
    });
    assertEquals(signal.status, 200, JSON.stringify(signal.body));
    assertEquals(JSON.stringify(signal.body).includes(repo.repoDir), false);
  });
});

test("a body nested as deep as its size allows gets a JSON reply", async () => {
  await withRoute([everyAction()], async (route, repo) => {
    const name = `deep-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const depth = 60_000;
    const deep = "[".repeat(depth) + "]".repeat(depth);
    const bodies = [
      `{"type":"workflow.signal","payload":{"workflow":"${name}","key":"k","payload":${deep}}}`,
      `{"type":"workflow.run","payload":{"workflowIdOrName":"${name}","idempotencyKey":"deep","inputs":{"a":${deep}}}}`,
    ];
    for (const body of bodies) {
      const reply = await route.post(body);
      assertEquals(reply.status, 400, JSON.stringify(reply.body).slice(0, 200));
      assertEquals(reply.body.code, "invalid_request");
    }
    assertEquals(await runCount(repo, name), 0);
  });
});

test("a handler that throws at once gets a reply and frees its slot", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });
    const person = `person-${crypto.randomUUID()}`;
    for (let i = 0; i <= MAX_ACTIVE_REQUESTS; i++) {
      const response = await handleHttpActionRequest(
        new Request(`http://127.0.0.1${SERVE_ACTION_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${person}.secret`,
          },
          body: JSON.stringify({ type: "workflow.approvals" }),
        }),
        "127.0.0.1",
        {
          ctx,
          authenticate,
          dispatch: () => {
            throw new Error("thrown before any await");
          },
        },
      );
      assertEquals(response.status, 500);
      assertEquals((await response.json()).code, "outcome_unknown");
    }
  });
});

test("a handler that ends with no reply is not reported as success", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [everyAction()], { detached: true });
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        handleHttpActionRequest(req, "127.0.0.1", {
          ctx,
          authenticate,
          dispatch: () => Promise.resolve(),
        }),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.addr.port}${SERVE_ACTION_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer caller.secret",
          },
          body: JSON.stringify(start("w", "k")),
        },
      );
      assertEquals(response.status, 500);
      assertEquals((await response.json()).code, "outcome_unknown");
    } finally {
      await server.shutdown();
    }
  });
});

function capturingAudit(ctx: ConnectionContext): AuditEvent[] {
  const events: AuditEvent[] = [];
  (ctx as { auditEmitter?: unknown }).auditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
    durableStalled: false,
  };
  (ctx as { instanceId?: string }).instanceId = "test-instance";
  return events;
}

const AUDIT_DIFFERS = new Set([
  "id",
  "eventId",
  "timestamp",
  "requestId",
  "sourceIp",
  "hash",
  "prevHash",
]);

function comparable(event: AuditEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => !AUDIT_DIFFERS.has(key)),
  );
}

test("audit events and run records match the same actions over the WebSocket", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const audit = capturingAudit(ctx);
    const name = `parity-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");

    const http = await route.post(start(name, crypto.randomUUID()));
    await settled(ctx);
    const httpRunId = http.body.data.runId;
    const socketStart = await sendOverWebSocket(ctx, {
      type: "workflow.run",
      id: crypto.randomUUID(),
      payload: { workflowIdOrName: name },
    });
    const started = socketStart.find((f) =>
      f.type === "event" && (f.event as { kind: string }).kind === "started"
    )!;
    const socketRunId = (started.event as { runId: string }).runId;

    const httpRun = (await storedRun(repo, name, httpRunId))!;
    const socketRun = (await storedRun(repo, name, socketRunId))!;
    assertEquals(httpRun.initiatedBy, socketRun.initiatedBy);
    assertEquals(httpRun.client, socketRun.client);
    assertEquals(httpRun.client, CLIENT);
    assertEquals(httpRun.triggerSource, socketRun.triggerSource);

    const gate = (run: typeof httpRun) =>
      run.getJob("main")!.getStep("gate")!.startedAt!.toISOString();
    const approved = await route.post(
      decision("workflow.approve", {
        name,
        runId: httpRunId,
        suspendedAt: gate(httpRun),
      }),
    );
    assertEquals(approved.status, 200, JSON.stringify(approved.body));
    await sendOverWebSocket(ctx, {
      type: "workflow.approve",
      id: crypto.randomUUID(),
      payload: { workflowIdOrName: name, runId: socketRunId, stepName: "gate" },
    });
    const decided = async (runId: string) => {
      const { decidedAt: _decidedAt, ...rest } =
        (await storedRun(repo, name, runId))!
          .getJob("main")!.getStep("gate")!.approvalDecision!;
      return rest;
    };
    assertEquals(await decided(httpRunId), await decided(socketRunId));

    await waitFor(() => audit.length >= 4, "every action was audited");
    const of = (action: string) =>
      audit.filter((e) => e.action === action).map(comparable);
    const [httpStart, socketStartAudit] = of("workflow.run");
    assertEquals(httpStart, socketStartAudit);
    const [httpApprove, socketApprove] = of("workflow.approve");
    assertEquals(httpApprove, socketApprove);
  });
});

test("a replayed start is marked in the audit log", async () => {
  await withRoute([everyAction()], async (route, repo, ctx) => {
    const audit = capturingAudit(ctx);
    const name = `replay-audit-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    await route.post(start(name, "again"));
    await settled(ctx);
    await route.post(start(name, "again"));
    await waitFor(
      () => audit.filter((e) => e.action === "workflow.run").length === 2,
      "both starts audited",
    );
    const details = audit.filter((e) => e.action === "workflow.run")
      .map((e) => e.detail);
    assertEquals(details, [undefined, "replayed start"]);
  });
});

async function sendOverWebSocket(
  ctx: ConnectionContext,
  request: { type: string; id: string; payload?: Record<string, unknown> },
): Promise<Frame[]> {
  const frames: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(data),
    close() {},
  } as unknown as WebSocket;
  setConnectionClient(socket, CLIENT);
  const active = new Map<string, AbortController>();
  await handleMessage(
    socket,
    ctx,
    active,
    new MessageEvent("message", { data: JSON.stringify(request) }),
    CALLER,
  );
  await settled(ctx);
  return frames.map((frame) => JSON.parse(frame) as Frame);
}

function withCeilingRoute(
  ceiling: { actions: string[]; resource: string }[],
  fn: (
    route: Route,
    repo: ServeRepo,
    ctx: ConnectionContext,
    setCeiling: (next: { actions: string[]; resource: string }[]) => void,
  ) => Promise<void>,
): Promise<void> {
  return withServeRepo(async (repo) => {
    let current = Ceiling.parse({ version: 1, ceiling });
    const ctx = createServeCtx(repo, [everyAction()], {
      detached: true,
      integrations: {
        standingOf: () => ({ kind: "active", ceiling: current }),
      },
    });
    const route = startRoute(ctx);
    try {
      await fn(route, repo, ctx, (next) => {
        current = Ceiling.parse({ version: 1, ceiling: next });
      });
    } finally {
      await settled(ctx).catch(() => {});
      await route.shutdown();
    }
  });
}

const EVERY_CEILING_ACTION = ["approve", "read", "run", "signal"];

test("the action route: a ceiling allowing only run starts a run and can't approve its gate", async () => {
  await withCeilingRoute(
    [{ actions: EVERY_CEILING_ACTION, resource: "workflow:*" }],
    async (route, repo, ctx, setCeiling) => {
      const gated = await startGated(route, repo, ctx);
      setCeiling([{ actions: ["run"], resource: "workflow:*" }]);
      const refused = await route.post(decision("workflow.approve", gated));
      assertEquals(refused.status, 403, JSON.stringify(refused.body));
      setCeiling([{ actions: ["approve"], resource: "workflow:*" }]);
      const approved = await route.post(decision("workflow.approve", gated));
      assert(approved.status < 300, JSON.stringify(approved.body));
    },
  );
});

test("the action route: a run above the ceiling is refused, and an empty ceiling refuses reads", async () => {
  await withCeilingRoute(
    [{ actions: ["read"], resource: "workflow:*" }],
    async (route, repo, _ctx, setCeiling) => {
      const name = `gated-${crypto.randomUUID()}`;
      await saveGatedWorkflow(repo, name, "gate");
      const refused = await route.post(start(name, crypto.randomUUID()));
      assertEquals(refused.status, 403, JSON.stringify(refused.body));
      assertEquals(await runCount(repo, name), 0);
      setCeiling([]);
      const approvals = await route.post({ type: "workflow.approvals" });
      assertEquals(approvals.status, 403, JSON.stringify(approvals.body));
    },
  );
});
