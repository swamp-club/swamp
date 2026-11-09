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

import { Ceiling } from "../src/domain/access/ceiling.ts";
import type {
  IntegrationLookup,
  IntegrationStanding,
} from "../src/domain/access/integration_directory.ts";
import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ServerToken } from "../src/domain/models/access/server_token_model.ts";
import { parsePrincipal } from "../src/domain/access/principal.ts";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { handleConnection } from "../src/serve/connection.ts";
import {
  forwardCredentialOf,
  rememberForwardCredential,
} from "../src/serve/follower_forwarder.ts";
import {
  bindAuthenticatedConnection,
  type ConnectionContext,
} from "../src/serve/handlers/shared.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { handleHttpRequest } from "../src/serve/http_request_route.ts";
import { requestServerResponse } from "../src/cli/remote_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  handleSignalHttpRequest,
  matchSignalRoute,
} from "../src/serve/signal_http.ts";
import {
  authenticateServerToken,
  extractWebSocketToken,
} from "../src/serve/token_auth.ts";
import "../src/domain/models/models.ts";
import {
  createServeCtx,
  grant,
  saveGatedWorkflow,
  type ServeRepo,
  testDelegationOf,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const TOKEN = "caller-token.secret-value";
const CLIENT = "integration:ops-slack";

function tokenRecord(client: string | undefined): ServerToken {
  return {
    name: "caller-token",
    state: "active",
    principalId: "user:caller",
    principalEmail: "caller@example.com",
    ...(client !== undefined ? { client } : {}),
    collectives: [],
    groups: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "token-vault",
    secretKey: "server-token-caller-token",
  };
}

// an integration client acts under a delegation, which a server token never
// carries, so the test adds one as a delegated token's authentication would
function authenticator(client: string | undefined) {
  return async (token: string) => {
    const result = await authenticateServerToken(
      token,
      "/nonexistent",
      {} as RepositoryContext,
      undefined,
      {
        readToken: () => Promise.resolve(tokenRecord(client)),
        readSecret: () => Promise.resolve("secret-value"),
      },
    );
    return result.ok && client?.startsWith("integration:")
      ? { ...result, delegation: testDelegationOf(client) }
      : result;
  };
}

const WORKFLOW_GRANT = grant({
  actions: ["read", "run", "approve", "signal"],
  resource: { kind: "workflow", pattern: "*" },
});

function serveNode(
  ctx: ConnectionContext,
  client: string | undefined,
  onUpgrade: (socket: WebSocket, req: Request) => void = () => {},
) {
  const authenticate = authenticator(client);
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const route = matchSignalRoute(new URL(req.url).pathname);
      if (route) {
        return await handleSignalHttpRequest(
          req,
          route,
          "127.0.0.1",
          {
            ctx,
            authenticate,
          } as Parameters<typeof handleSignalHttpRequest>[3],
        );
      }
      const extracted = extractWebSocketToken(req)!;
      const result = await authenticate(extracted.token);
      assert(result.ok, "the token authenticates");
      const { socket, response } = Deno.upgradeWebSocket(
        req,
        extracted.transport === "subprotocol"
          ? { protocol: `bearer.${extracted.token}` }
          : {},
      );
      onUpgrade(socket, req);
      bindAuthenticatedConnection(socket, result);
      handleConnection(socket, ctx, parsePrincipal(result.principalId));
      return response;
    },
  );
}

interface Cluster {
  leader: { repo: ServeRepo; events: AuditEvent[] };
  leaderAddress: string;
  followerAddress: string;
}

// the follower binds a different client on purpose: only the leader's own read
// of the forwarded credential may count
async function withCluster(
  client: string | undefined,
  fn: (cluster: Cluster) => Promise<void>,
  standings: {
    leader?: IntegrationLookup;
    follower?: IntegrationLookup;
  } = {},
): Promise<void> {
  await withServeRepo(async (leaderRepo) => {
    const events: AuditEvent[] = [];
    const leaderCtx = createServeCtx(leaderRepo, [WORKFLOW_GRANT], {
      integrations: standings.leader,
    });
    leaderCtx.auditEmitter = {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as ConnectionContext["auditEmitter"];
    const leaderHttp = serveNode(leaderCtx, client);
    const leaderAddress = `http://127.0.0.1:${leaderHttp.addr.port}`;
    await withServeRepo(async (followerRepo) => {
      const leader: ServeLeader = {
        instanceId: "leader-1",
        fence: 2,
        address: leaderAddress,
        since: "2026-10-29T12:00:00.000Z",
      };
      const leaderLink = new LeaderLink({ leader: () => leader });
      const followerCtx = createServeCtx(followerRepo, [WORKFLOW_GRANT], {
        integrations: standings.follower,
      });
      followerCtx.followerGate = {
        role: "follower",
        leader: () => leader,
        isStale: () => false,
      };
      followerCtx.leaderLink = leaderLink;
      const followerHttp = serveNode(
        followerCtx,
        standings.follower ? client : "direct:token",
        (socket, req) => {
          rememberForwardCredential(
            socket,
            forwardCredentialOf(
              req,
              { kind: "bearer", token: TOKEN },
              "127.0.0.1",
            ),
          );
        },
      );
      try {
        await fn({
          leader: { repo: leaderRepo, events },
          leaderAddress,
          followerAddress: `http://127.0.0.1:${followerHttp.addr.port}`,
        });
      } finally {
        leaderLink.close();
        await followerHttp.shutdown();
      }
    });
    await leaderHttp.shutdown();
  });
}

interface Frame {
  type: string;
  id?: string;
}

async function request(
  address: string,
  message: { type: string; id: string; payload: Record<string, unknown> },
  isFinal: (frame: Frame) => boolean,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const socket = new WebSocket(address.replace("http", "ws"), [
    `bearer.${TOKEN}`,
  ]);
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise((resolve) => (socket.onopen = resolve));
  socket.send(JSON.stringify(message));
  await waitFor(
    () => frames.some((frame) => isFinal(frame) && frame.id === message.id),
    `${message.type} finished`,
  );
  const closed = new Promise((resolve) => (socket.onclose = resolve));
  socket.close();
  await closed;
  return frames;
}

async function runAndApprove(
  address: string,
  repo: ServeRepo,
  name: string,
  extraPayload: Record<string, unknown> = {},
): Promise<WorkflowRun> {
  const workflow = await saveGatedWorkflow(repo, name, "gate");
  await request(address, {
    type: "workflow.run",
    id: `run-${name}`,
    payload: { workflowIdOrName: name, ...extraPayload },
  }, (frame) => frame.type === "done" || frame.type === "error");
  await request(address, {
    type: "workflow.approve",
    id: `approve-${name}`,
    payload: { workflowIdOrName: name, stepName: "gate", ...extraPayload },
  }, (frame) => frame.type === "workflow.approve" || frame.type === "error");
  const [run] = await repo.repoContext.workflowRunRepo.findAllByWorkflowId(
    createWorkflowId(workflow.id),
  );
  return run;
}

function eventsFor(events: AuditEvent[], action: string): AuditEvent[] {
  return events.filter((event) => event.action === action);
}

const testOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "serve client: a forwarded run and approval record the same client as direct ones",
  ...testOptions,
  fn: async () => {
    await withCluster(
      CLIENT,
      async ({ leader, leaderAddress, followerAddress }) => {
        const direct = await runAndApprove(
          leaderAddress,
          leader.repo,
          "direct",
        );
        const forwarded = await runAndApprove(
          followerAddress,
          leader.repo,
          "forwarded",
        );
        for (const run of [direct, forwarded]) {
          assertEquals(run.client, CLIENT);
          assertEquals(
            run.getJob("main")!.getStep("gate")!.approvalDecision?.client,
            CLIENT,
          );
        }
        for (const action of ["workflow.run", "workflow.approve"]) {
          const events = eventsFor(leader.events, action);
          assertEquals(events.length, 2, action);
          assertEquals(events.map((event) => event.client), [CLIENT, CLIENT]);
        }
      },
    );
  },
});

Deno.test({
  name:
    "serve client: a client in a request payload has no effect, direct or forwarded",
  ...testOptions,
  fn: async () => {
    await withCluster(
      CLIENT,
      async ({ leader, leaderAddress, followerAddress }) => {
        const forged = { client: "direct:cli", decidedBy: "user:forged" };
        for (
          const [address, name] of [
            [leaderAddress, "direct-forged"],
            [followerAddress, "forwarded-forged"],
          ]
        ) {
          const run = await runAndApprove(address, leader.repo, name, forged);
          const decision =
            run.getJob("main")!.getStep("gate")!.approvalDecision;
          assertEquals(run.client, CLIENT, name);
          assertEquals(decision?.client, CLIENT, name);
          assertEquals(decision?.decidedBy, "user:caller", name);
        }
        assertEquals(
          leader.events.filter((event) => event.client === "direct:cli"),
          [],
        );
      },
    );
  },
});

Deno.test({
  name:
    "serve client: a token from before clients records none anywhere, and the run still completes its gate",
  ...testOptions,
  fn: async () => {
    await withCluster(undefined, async ({ leader, leaderAddress }) => {
      const run = await runAndApprove(leaderAddress, leader.repo, "old-token");
      const decision = run.getJob("main")!.getStep("gate")!.approvalDecision;
      assertEquals(decision?.approved, true);
      assertEquals("client" in run.toData(), false);
      assertEquals("client" in decision!, false);
      assert(leader.events.length > 0);
      assertEquals(leader.events.some((event) => "client" in event), false);
    });
  },
});

Deno.test({
  name:
    "serve client: a signal forwarded over HTTP records the same client as a direct one",
  ...testOptions,
  fn: async () => {
    await withCluster(
      CLIENT,
      async ({ leader, leaderAddress, followerAddress }) => {
        for (const address of [leaderAddress, followerAddress]) {
          const waitId = crypto.randomUUID();
          const response = await fetch(`${address}/api/v1/signal/${waitId}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ payload: {}, client: "direct:cli" }),
          });
          await response.body?.cancel();
        }
        const signals = eventsFor(leader.events, "workflow.signal");
        assertEquals(signals.length, 2);
        assertEquals(signals.map((event) => event.client), [CLIENT, CLIENT]);
      },
    );
  },
});

Deno.test({
  name:
    "serve client: a rejection records the client like an approval, direct or forwarded",
  ...testOptions,
  fn: async () => {
    await withCluster(
      CLIENT,
      async ({ leader, leaderAddress, followerAddress }) => {
        for (
          const [address, name] of [
            [leaderAddress, "direct-rejected"],
            [followerAddress, "forwarded-rejected"],
          ]
        ) {
          const workflow = await saveGatedWorkflow(leader.repo, name, "gate");
          await request(address, {
            type: "workflow.run",
            id: `run-${name}`,
            payload: { workflowIdOrName: name },
          }, (frame) => frame.type === "done" || frame.type === "error");
          await request(
            address,
            {
              type: "workflow.reject",
              id: `reject-${name}`,
              payload: {
                workflowIdOrName: name,
                stepName: "gate",
                client: "direct:cli",
              },
            },
            (frame) =>
              frame.type === "workflow.reject" || frame.type === "error",
          );
          const [run] = await leader.repo.repoContext.workflowRunRepo
            .findAllByWorkflowId(createWorkflowId(workflow.id));
          const decision = run.getJob("main")!.getStep("gate")!
            .approvalDecision;
          assertEquals(decision?.approved, false, name);
          assertEquals(decision?.client, CLIENT, name);
        }
        const events = eventsFor(leader.events, "workflow.reject");
        assertEquals(events.map((event) => event.client), [CLIENT, CLIENT]);
      },
    );
  },
});

Deno.test({
  name: "serve client: a nested child run inherits the client of its parent",
  ...testOptions,
  fn: async () => {
    await withCluster(CLIENT, async ({ leader, leaderAddress }) => {
      const child = await saveGatedWorkflow(leader.repo, "child", "gate");
      const parent = Workflow.create({
        name: "parent",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({ name: "call", task: StepTask.workflow("child") }),
            ],
          }),
        ],
      });
      await leader.repo.repoContext.workflowRepo.save(parent);
      await request(leaderAddress, {
        type: "workflow.run",
        id: "run-parent",
        payload: { workflowIdOrName: "parent" },
      }, (frame) => frame.type === "done" || frame.type === "error");
      const runs = leader.repo.repoContext.workflowRunRepo;
      const [parentRun] = await runs.findAllByWorkflowId(
        createWorkflowId(parent.id),
      );
      const [childRun] = await runs.findAllByWorkflowId(
        createWorkflowId(child.id),
      );
      assertEquals(parentRun.client, CLIENT);
      assertEquals(childRun.client, CLIENT);
    });
  },
});

Deno.test({
  name: "serve client: a request over the HTTP route records the client",
  ...testOptions,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const events: AuditEvent[] = [];
      const ctx = createServeCtx(repo, [WORKFLOW_GRANT]);
      ctx.auditEmitter = {
        emit: (event: AuditEvent) => events.push(event),
      } as unknown as ConnectionContext["auditEmitter"];
      const authenticate = authenticator(CLIENT);
      const server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) => handleHttpRequest(req, "127.0.0.1", { ctx, authenticate }),
      );
      try {
        await requestServerResponse(
          { server: `ws://127.0.0.1:${server.addr.port}`, token: TOKEN },
          { type: "workflow.history.search", payload: {} },
        ).catch(() => undefined);
        assert(events.length > 0, "the request was audited");
        assertEquals(
          events.map((event) => event.client).filter((c) => c !== CLIENT),
          [],
        );
      } finally {
        await server.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "forwarded ceiling: a follower decides its own reads and the leader decides writes, so a revoke seen by either applies there at once",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const active: IntegrationStanding = {
      kind: "active",
      ceiling: Ceiling.parse({
        version: 1,
        ceiling: [{ actions: ["read", "run"], resource: "workflow:*" }],
      }),
    };
    let onLeader: IntegrationStanding = active;
    let onFollower: IntegrationStanding = active;
    await withCluster(
      CLIENT,
      async ({ leader, leaderAddress, followerAddress }) => {
        const name = `flow-${crypto.randomUUID()}`;
        await saveGatedWorkflow(leader.repo, name, "gate");
        const send = (
          address: string,
          type: string,
          id = crypto.randomUUID(),
        ) =>
          request(
            address,
            { type, id, payload: { workflowIdOrName: name } },
            (frame) =>
              frame.type === "error" || frame.type === "done" ||
              frame.type === type,
          );
        const code = (frames: Frame[]) =>
          (frames.find((f) => f.type === "error") as
            | { error?: { code?: string } }
            | undefined)?.error?.code;
        onLeader = { kind: "revoked" };
        assertEquals(
          code(await send(followerAddress, "workflow.run")),
          "unauthorized",
          "a forwarded write is decided by the leader",
        );
        assertEquals(
          code(await send(leaderAddress, "workflow.run")),
          "unauthorized",
        );
        onFollower = { kind: "revoked" };
        assertEquals(
          code(await send(followerAddress, "workflow.search")),
          "unauthorized",
          "a follower refuses its own reads once it has seen the revoke",
        );
      },
      {
        leader: { standingOf: () => onLeader },
        follower: { standingOf: () => onFollower },
      },
    );
  },
});
