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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleHttpActionRequest } from "../src/serve/http_action_route.ts";
import { SERVE_ACTION_PATH } from "../src/serve/protocol.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { ServeAdmission } from "../src/serve/serve_admission.ts";
import type { ServerTokenAuthResult } from "../src/serve/token_auth.ts";
import {
  CALLER,
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveGatedWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

const everyAction = () =>
  grant({
    actions: ["read", "write", "run", "approve", "signal"],
    resource: { kind: "workflow", pattern: "*" },
  });

function test(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name: `serve admission: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      resetRateLimitState();
      await fn();
    },
  });
}

async function withAdmission(
  fn: (
    repo: ServeRepo,
    ctx: ConnectionContext,
    admission: ServeAdmission,
  ) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const admission = new ServeAdmission();
    const ctx = {
      ...createServeCtx(repo, [everyAction()], { detached: true }),
      admission,
    } as ConnectionContext;
    try {
      await fn(repo, ctx, admission);
    } finally {
      await waitFor(
        () => (ctx.activeRunRegistry?.size ?? 0) === 0,
        "runs left the registry",
      ).catch(() => {});
    }
  });
}

function refusal(frames: Frame[]): {
  code?: string;
  retryAfterSeconds?: unknown;
} {
  const error = errorFrame(frames)?.error as
    | { code: string; retryAfterSeconds?: unknown }
    | undefined;
  return { code: error?.code, retryAfterSeconds: error?.retryAfterSeconds };
}

const runRequest = (id: string, workflow: string) => ({
  type: "workflow.run" as const,
  id,
  payload: { workflowIdOrName: workflow },
});

async function runsOf(repo: ServeRepo, name: string) {
  const workflow = await repo.repoContext.workflowRepo.findByName(name);
  return await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
    workflow!.id,
  );
}

test("run starts, method runs and resumes are refused with not_ready until startup completes", async () => {
  await withAdmission(async (repo, ctx) => {
    const name = `gated-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");

    const started = await sendRequest(ctx, runRequest("start-1", name));
    assertEquals(refusal(started), { code: "not_ready", retryAfterSeconds: 2 });
    assertEquals((await runsOf(repo, name)).length, 0);

    const method = await sendRequest(
      ctx,
      {
        type: "model.method.run",
        id: "method-1",
        payload: {
          modelIdOrName: "anything",
          methodName: "noop",
        },
      } as unknown as Parameters<typeof sendRequest>[1],
    );
    assertEquals(refusal(method), { code: "not_ready", retryAfterSeconds: 2 });

    const resumed = await sendRequest(
      ctx,
      {
        type: "workflow.resume",
        id: "resume-1",
        payload: { workflowIdOrName: name, runId: crypto.randomUUID() },
      } as unknown as Parameters<typeof sendRequest>[1],
    );
    assertEquals(refusal(resumed), {
      code: "not_ready",
      retryAfterSeconds: 2,
    });
  });
});

test("an open node runs work, and a draining one refuses new runs but still records a decision", async () => {
  await withAdmission(async (repo, ctx, admission) => {
    admission.open();
    const name = `gated-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");

    const started = await sendRequest(ctx, runRequest("start-open", name));
    assertEquals(errorFrame(started), undefined, JSON.stringify(started));
    const [run] = await runsOf(repo, name);
    await waitFor(async () => {
      const workflow = await repo.repoContext.workflowRepo.findByName(name);
      const stored = await repo.repoContext.workflowRunRepo.findById(
        workflow!.id,
        createWorkflowRunId(run.id),
      );
      return stored?.status === "suspended";
    }, "the run paused at its gate");

    admission.beginDraining();
    ctx.activeRunRegistry!.beginDraining();

    const refused = await sendRequest(ctx, runRequest("start-drain", name));
    assertEquals(refusal(refused), { code: "draining", retryAfterSeconds: 5 });
    assertEquals((await runsOf(repo, name)).length, 1);

    const approved = await sendRequest(
      ctx,
      {
        type: "workflow.approve",
        id: "approve-drain",
        payload: { workflowIdOrName: name, runId: run.id, stepName: "gate" },
      } as unknown as Parameters<typeof sendRequest>[1],
    );
    assertEquals(errorFrame(approved), undefined, JSON.stringify(approved));
    const [decided] = await runsOf(repo, name);
    assert(
      decided.getJob("main")!.getStep("gate")!.approvalDecision !== undefined,
      "the decision was recorded during the drain",
    );
  });
});

function authenticate(): Promise<ServerTokenAuthResult> {
  return Promise.resolve({
    ok: true,
    principalId: `user:${CALLER.id}`,
    collectives: [],
    groups: [],
    tokenName: "caller",
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
  } as unknown as ServerTokenAuthResult);
}

test("the HTTP action route answers 503 with Retry-After while starting and while draining", async () => {
  await withAdmission(async (repo, ctx, admission) => {
    const name = `gated-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => handleHttpActionRequest(req, "127.0.0.1", { ctx, authenticate }),
    );
    const post = async (key: string) => {
      const response = await fetch(
        `http://127.0.0.1:${server.addr.port}${SERVE_ACTION_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer caller.secret",
          },
          body: JSON.stringify({
            type: "workflow.run",
            payload: { workflowIdOrName: name, idempotencyKey: key },
          }),
        },
      );
      const body = await response.json();
      return { status: response.status, body, headers: response.headers };
    };
    try {
      const starting = await post("one");
      assertEquals(starting.status, 503, JSON.stringify(starting.body));
      assertEquals(starting.body.code, "not_ready");
      assertEquals(starting.headers.get("retry-after"), "2");

      admission.open();
      admission.beginDraining();
      const draining = await post("two");
      assertEquals(draining.status, 503, JSON.stringify(draining.body));
      assertEquals(draining.body.code, "shutting_down");
      assertEquals(draining.headers.get("retry-after"), "5");
      assertEquals((await runsOf(repo, name)).length, 0);
    } finally {
      await server.shutdown();
    }
  });
});
