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
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { MAX_ACTIVE_REQUESTS } from "../src/serve/connection.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleHttpActionRequest } from "../src/serve/http_action_route.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { SERVE_ACTION_PATH } from "../src/serve/protocol.ts";
import type { ServerTokenAuthResult } from "../src/serve/token_auth.ts";
import {
  CALLER,
  createServeCtx,
  grant,
  saveGatedWorkflow,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

// deno-lint-ignore no-explicit-any
type ActionBody = Record<string, any>;

const CLIENT = "integration:test-app";

function authenticate(token: string): Promise<ServerTokenAuthResult> {
  const name = token.split(".")[0];
  return Promise.resolve({
    ok: true,
    principalId: name.startsWith("person-")
      ? `user:${name}`
      : `user:${CALLER.id}`,
    collectives: [],
    groups: [],
    tokenName: "caller",
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
    client: CLIENT,
  } as ServerTokenAuthResult);
}

const everyAction = () =>
  grant({
    actions: ["read", "write", "run", "approve", "signal"],
    resource: { kind: "workflow", pattern: "*" },
  });

interface Node {
  url: string;
  sourceIps: string[];
  stop: () => Promise<void>;
}

function serveNode(ctx: ConnectionContext): Node {
  const sourceIps: string[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      sourceIps.push(req.headers.get("x-forwarded-for") ?? "");
      return handleHttpActionRequest(req, "127.0.0.1", { ctx, authenticate });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    sourceIps,
    stop: () => server.shutdown(),
  };
}

async function withTeam(
  fn: (nodes: {
    leader: Node;
    follower: Node;
    repo: ServeRepo;
    ctx: ConnectionContext;
    barriers: () => number;
  }) => Promise<void>,
  options: {
    leaderUrl?: string;
    stale?: boolean;
    grants?: Grant[];
    fetch?: typeof fetch;
  } = {},
): Promise<void> {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, options.grants ?? [everyAction()], {
      detached: true,
    });
    const leader = serveNode(ctx);
    const address = options.leaderUrl ?? leader.url;
    const known: () => ServeLeader = () => ({
      instanceId: "leader",
      address,
    } as ServeLeader);
    const leaderLink = new LeaderLink({
      leader: known,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    let barriers = 0;
    const follower = serveNode({
      ...ctx,
      followerGate: {
        role: "follower",
        leader: known,
        isStale: () => options.stale === true,
      },
      leaderLink,
      feedBarrier: () => {
        barriers++;
        return Promise.resolve();
      },
    } as ConnectionContext);
    try {
      await fn({ leader, follower, repo, ctx, barriers: () => barriers });
    } finally {
      // a run still writing would hold the temp dir open
      await waitFor(
        () => (ctx.activeRunRegistry?.size ?? 0) === 0,
        "runs left the registry",
      ).catch(() => {});
      leaderLink.close();
      await follower.stop();
      await leader.stop();
    }
  });
}

async function post(
  node: Node,
  body: unknown,
  token: string | null = "caller.secret",
): Promise<{ status: number; body: ActionBody }> {
  const response = await fetch(`${node.url}${SERVE_ACTION_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

function test(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name: `serve HTTP action route through a follower: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

test("a start and a decision record the leader's principal and client", async () => {
  await withTeam(async ({ leader, follower, repo, ctx, barriers }) => {
    const name = `forwarded-${crypto.randomUUID()}`;
    const workflow = await saveGatedWorkflow(repo, name, "gate");
    const started = await post(follower, {
      type: "workflow.run",
      payload: { workflowIdOrName: name, idempotencyKey: "one" },
    });
    assertEquals(started.status, 202, JSON.stringify(started.body));
    assert(barriers() > 0, "the forwarded start waited for this node's copy");
    assert(leader.sourceIps.length > 0, "the leader took the request");
    await waitFor(
      () => (ctx.activeRunRegistry?.size ?? 0) === 0,
      "the run left the registry",
    );
    const runId = started.body.data.runId;
    const runs = repo.repoContext.workflowRunRepo;
    const run = (await runs.findAllByWorkflowId(workflow.id))[0];
    assertEquals(run.id, runId);
    assertEquals(run.initiatedBy, `user:${CALLER.id}`);
    assertEquals(run.client, CLIENT);

    const suspendedAt = run.getJob("main")!.getStep("gate")!.startedAt!
      .toISOString();
    const approve = {
      type: "workflow.approve",
      payload: {
        workflowIdOrName: name,
        runId,
        stepName: "gate",
        suspendedAt,
      },
    };
    const [fromFollower, fromLeader] = await Promise.all([
      post(follower, approve),
      post(leader, approve),
    ]);
    const statuses = [fromFollower.status, fromLeader.status].sort();
    assertEquals(
      statuses,
      [200, 409],
      JSON.stringify([fromFollower, fromLeader]),
    );
    const recorded = (await runs.findAllByWorkflowId(workflow.id))[0]
      .getJob("main")!.getStep("gate")!.approvalDecision!;
    assertEquals(recorded.decidedBy, `user:${CALLER.id}`);
    assertEquals(recorded.client, CLIENT);
  });
});

test("a retried start through either node makes one run", async () => {
  await withTeam(async ({ leader, follower, repo, ctx }) => {
    const name = `retry-across-${crypto.randomUUID()}`;
    const workflow = await saveGatedWorkflow(repo, name, "gate");
    const body = {
      type: "workflow.run",
      payload: { workflowIdOrName: name, idempotencyKey: "same" },
    };
    const [a, b] = await Promise.all([
      post(follower, body),
      post(leader, body),
    ]);
    assertEquals(a.body.data.runId, b.body.data.runId);
    await waitFor(
      () => (ctx.activeRunRegistry?.size ?? 0) === 0,
      "the run left the registry",
    );
    assertEquals(
      (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(workflow.id))
        .length,
      1,
    );
  });
});

test("a stale follower refuses a read so the caller can retry", async () => {
  await withTeam(async ({ follower }) => {
    const reply = await post(follower, { type: "workflow.approvals" });
    assertEquals(reply.status, 503);
  }, { stale: true });
});

test("an older leader with no route is a retryable refusal", async () => {
  const older = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response("Not found", { status: 404 }),
  );
  try {
    await withTeam(async ({ follower }) => {
      const reply = await post(follower, {
        type: "workflow.run",
        payload: { workflowIdOrName: "w", idempotencyKey: "k" },
      });
      assertEquals(reply.status, 503);
      assertEquals(reply.body.code, "leader_upgrade_required");
    }, { leaderUrl: `http://127.0.0.1:${older.addr.port}` });
  } finally {
    await older.shutdown();
  }
});

test("a status miss on a follower asks the leader", async () => {
  await withTeam(async ({ leader, follower }) => {
    const before = leader.sourceIps.length;
    const reply = await post(follower, {
      type: "workflow.history.get",
      payload: { runId: crypto.randomUUID() },
    });
    assertEquals(reply.status, 404);
    assertEquals(leader.sourceIps.length, before + 1);
  });
});

async function startGatedThrough(
  node: Node,
  repo: ServeRepo,
  ctx: ConnectionContext,
): Promise<{ name: string; runId: string; decide: Record<string, unknown> }> {
  const name = `through-${crypto.randomUUID()}`;
  const workflow = await saveGatedWorkflow(repo, name, "gate");
  const started = await post(node, {
    type: "workflow.run",
    payload: { workflowIdOrName: name, idempotencyKey: crypto.randomUUID() },
  });
  assertEquals(started.status, 202, JSON.stringify(started.body));
  await waitFor(
    () => (ctx.activeRunRegistry?.size ?? 0) === 0,
    "the run left the registry",
  );
  const runId = started.body.data.runId as string;
  const run = (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
    workflow.id,
  )).find((r) => r.id === runId)!;
  return {
    name,
    runId,
    decide: {
      workflowIdOrName: name,
      runId,
      stepName: "gate",
      suspendedAt: run.getJob("main")!.getStep("gate")!.startedAt!
        .toISOString(),
    },
  };
}

async function storedRun(repo: ServeRepo, name: string, runId: string) {
  const workflow = await repo.repoContext.workflowRepo.findByName(name);
  return (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
    workflow!.id,
  )).find((r) => r.id === runId)!;
}

test("reject, approvals, resume and signal work and record the caller", async () => {
  await withTeam(async ({ follower, repo, ctx }) => {
    const rejected = await startGatedThrough(follower, repo, ctx);
    const listed = await post(follower, { type: "workflow.approvals" });
    assertEquals(listed.status, 200, JSON.stringify(listed.body));
    assert(
      listed.body.data.approvals.some((row: { runId: string }) =>
        row.runId === rejected.runId
      ),
    );
    const reply = await post(follower, {
      type: "workflow.reject",
      payload: rejected.decide,
    });
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    const decision = (await storedRun(repo, rejected.name, rejected.runId))
      .getJob("main")!.getStep("gate")!.approvalDecision!;
    assertEquals(decision.approved, false);
    assertEquals(decision.decidedBy, `user:${CALLER.id}`);
    assertEquals(decision.client, CLIENT);

    const approved = await startGatedThrough(follower, repo, ctx);
    assertEquals(
      (await post(follower, {
        type: "workflow.approve",
        payload: approved.decide,
      })).status,
      200,
    );
    const resumed = await post(follower, {
      type: "workflow.resume",
      payload: { workflowIdOrName: approved.name, runId: approved.runId },
    });
    assertEquals(resumed.status, 202, JSON.stringify(resumed.body));
    await waitFor(
      async () =>
        (await storedRun(repo, approved.name, approved.runId)).status ===
          "succeeded",
      "the resumed run finishes",
    );

    const waits = `signalled-${crypto.randomUUID()}`;
    await repo.repoContext.workflowRepo.save(Workflow.create({
      name: waits,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "wait",
          task: StepTask.waitForSignal(
            3600,
            { type: "object", properties: { verdict: { type: "string" } } },
            "verdict",
          ),
        })],
      })],
    }));
    const started = await post(follower, {
      type: "workflow.run",
      payload: { workflowIdOrName: waits, idempotencyKey: crypto.randomUUID() },
    });
    assertEquals(started.status, 202, JSON.stringify(started.body));
    await waitFor(
      async () =>
        (await storedRun(repo, waits, started.body.data.runId)).status ===
          "suspended",
      "the run waits for its signal",
    );
    const signalled = await post(follower, {
      type: "workflow.signal",
      payload: { workflow: waits, key: "verdict", payload: { verdict: "go" } },
    });
    assertEquals(signalled.status, 200, JSON.stringify(signalled.body));
    assertEquals(signalled.body.data.signal.submittedBy, `user:${CALLER.id}`);
  });
});

test("what the follower refuses never reaches the leader", async () => {
  await withTeam(async ({ leader, follower }) => {
    const noToken = await post(follower, { type: "workflow.approvals" }, null);
    assertEquals(noToken.status, 401, JSON.stringify(noToken.body));
    const cookie = await fetch(`${follower.url}${SERVE_ACTION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "swamp-dashboard-session=anything",
      },
      body: JSON.stringify({ type: "workflow.approvals" }),
    });
    assertEquals(cookie.status, 401);
    await cookie.body?.cancel();
    const unlisted = await post(follower, {
      type: "workflow.delete",
      payload: { workflowIdOrName: "x" },
    });
    assertEquals(unlisted.status, 404);
    assertEquals(unlisted.body.code, "type_not_allowed");
    const field = await post(follower, {
      type: "workflow.run",
      payload: {
        workflowIdOrName: "x",
        idempotencyKey: "k",
        lockHolderTokens: "held",
      },
    });
    assertEquals(field.status, 400);
    assertEquals(field.body.code, "invalid_request");
    assertEquals(leader.sourceIps, []);
  });
});

test("a caller with no grant reads the same through the follower as on the leader", async () => {
  const unrelated = grant({
    subject: { kind: "user", name: "someone-else" },
    actions: ["read", "run", "approve"],
    resource: { kind: "workflow", pattern: "*" },
  });
  await withTeam(async ({ leader, follower, repo }) => {
    const name = `refused-${crypto.randomUUID()}`;
    await saveGatedWorkflow(repo, name, "gate");
    const missing = crypto.randomUUID();
    for (
      const body of [
        { type: "workflow.history.get", payload: { runId: missing } },
        {
          type: "workflow.approve",
          payload: {
            workflowIdOrName: name,
            runId: missing,
            stepName: "gate",
            suspendedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]
    ) {
      const through = await post(follower, body);
      const direct = await post(leader, body);
      assertEquals(through.status, direct.status);
      const { requestId: _a, ...left } = through.body;
      const { requestId: _b, ...right } = direct.body;
      assertEquals(left, right);
    }
  }, { grants: [unrelated] });
});

test("a run-conditional deny applies through the follower", async () => {
  const grants = [
    everyAction(),
    grant({
      effect: "deny",
      actions: ["approve"],
      resource: { kind: "workflow", pattern: "*" },
      condition: "principal.sub == run.initiator.sub",
    }),
  ];
  await withTeam(async ({ follower, repo, ctx }) => {
    const gated = await startGatedThrough(follower, repo, ctx);
    const refused = await post(follower, {
      type: "workflow.approve",
      payload: gated.decide,
    });
    assertEquals(refused.status, 403, JSON.stringify(refused.body));
    assertEquals(refused.body.code, "forbidden");
    assertEquals(
      (await storedRun(repo, gated.name, gated.runId)).getJob("main")!
        .getStep("gate")!.approvalDecision,
      undefined,
    );
  }, { grants });
});

test("a leader that can't be reached is a retryable refusal", async () => {
  await withTeam(async ({ follower }) => {
    const response = await fetch(`${follower.url}${SERVE_ACTION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller.secret",
      },
      body: JSON.stringify({
        type: "workflow.run",
        payload: { workflowIdOrName: "x", idempotencyKey: "k" },
      }),
    });
    assertEquals(response.status, 503);
    assert(response.headers.get("retry-after"), "the caller is told to retry");
    await response.body?.cancel();
  }, {
    fetch: () => Promise.reject(new TypeError("connection refused")),
  });
});

test("a status nobody holds is not found once the leader has been asked", async () => {
  await withTeam(async ({ leader, follower }) => {
    const reply = await post(follower, {
      type: "workflow.history.get",
      payload: { runId: crypto.randomUUID() },
    });
    assertEquals(reply.status, 404, JSON.stringify(reply.body));
    assertEquals(reply.body.code, "not_found");
    assertEquals(leader.sourceIps.length, 1);
  });
});

test("a status miss held at the leader still counts against the caller's in-flight limit", async () => {
  const person = `person-${crypto.randomUUID()}`;
  const grants = [
    grant({
      subject: { kind: "user", name: person },
      actions: ["read"],
      resource: { kind: "workflow", pattern: "*" },
    }),
  ];
  let held = 0;
  const { promise: letGo, resolve: release } = Promise.withResolvers<void>();
  const slowLeader = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async () => {
      held++;
      await letGo;
      return Response.json({ code: "not_found", message: "Not found" }, {
        status: 404,
      });
    },
  );
  try {
    await withTeam(async ({ follower }) => {
      const status = () =>
        post(follower, {
          type: "workflow.history.get",
          payload: { runId: crypto.randomUUID() },
        }, `${person}.secret`);
      const waiting = Array.from({ length: MAX_ACTIVE_REQUESTS }, status);
      await waitFor(
        () => held === MAX_ACTIVE_REQUESTS,
        "every miss reached the leader",
      );
      const over = await status();
      assertEquals(over.status, 429, JSON.stringify(over.body));
      release();
      for (const reply of await Promise.all(waiting)) {
        assertEquals(reply.status, 404);
      }
      const after = await status();
      assertEquals(after.status, 404, JSON.stringify(after.body));
    }, { leaderUrl: `http://127.0.0.1:${slowLeader.addr.port}`, grants });
  } finally {
    release();
    await slowLeader.shutdown();
  }
});

test("one person's rate limit through a follower leaves another's alone", async () => {
  const person = `person-${crypto.randomUUID()}`;
  const other = `person-${crypto.randomUUID()}`;
  const reads = (name: string) =>
    grant({
      subject: { kind: "user", name },
      actions: ["read"],
      resource: { kind: "workflow", pattern: "*" },
    });
  await withTeam(async ({ follower }) => {
    let limited = false;
    for (let i = 0; i < 260 && !limited; i++) {
      const reply = await post(
        follower,
        { type: "workflow.approvals" },
        `${person}.secret`,
      );
      limited = reply.status === 429;
    }
    assert(limited, "the caller reached the limit");
    const fine = await post(
      follower,
      { type: "workflow.approvals" },
      `${other}.secret`,
    );
    assertEquals(fine.status, 200, JSON.stringify(fine.body));
  }, { grants: [reads(person), reads(other)] });
});
