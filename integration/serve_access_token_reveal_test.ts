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

import { assert, assertEquals, assertExists } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createServerTokenCreateDeps,
  serverTokenCreate,
} from "../src/libswamp/access/token_create.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeControlPlaneVault } from "../src/domain/vaults/control_plane_vault_init.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../src/domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { handleConnection, handleMessage } from "../src/serve/connection.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  handleAccessTokenRevoke,
  handleAccessTokenRotate,
} from "../src/serve/handlers/access_handlers.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
import {
  forwardCredentialOf,
  rememberForwardCredential,
} from "../src/serve/follower_forwarder.ts";
import {
  FOLLOWER_FORWARDED_REQUESTS,
  FOLLOWER_READ_REQUESTS,
} from "../src/serve/follower_requests.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { SYNC_GATED_REQUESTS } from "../src/serve/sync_gate.ts";
import { CONFIRMED_WRITE_REQUESTS } from "../src/serve/write_confirmation.ts";
import { getSwampLogger } from "../src/infrastructure/logging/logger.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { grant as harnessGrant } from "./serve_request_harness.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const ADMIN: Principal = { kind: "user", id: "admin" };
const MEMBER: Principal = { kind: "user", id: "member" };

interface Frame {
  type: string;
  id?: string;
  error?: { code: string; message: string };
  payload?: { data?: Record<string, unknown> };
}

interface TokenRepo {
  repoDir: string;
  repoContext: RepositoryContext;
  mint(name: string, principalId: string): Promise<void>;
  rotate(name: string): Promise<void>;
  revoke(name: string): Promise<void>;
  ctx(): ConnectionContext;
}

async function withTokenRepo(
  fn: (repo: TokenRepo) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-token-reveal-" });
  const repoContext = createRepositoryContext({ repoDir });
  const libCtx = createLibSwampContext();
  try {
    const version = "20260101.120000.0";
    const initEvents = await collect(
      repoInit(libCtx, createRepoInitDeps(version), {
        path: repoDir,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(initEvents.some((event) => event.kind === "error"), false);
    await initializeControlPlaneVault(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
      false,
    );
    const ctx = (): ConnectionContext => ({
      repoDir,
      repoContext,
      datastoreConfig: {
        type: "filesystem",
      } as ConnectionContext["datastoreConfig"],
      datastoreResolver: {} as ConnectionContext["datastoreResolver"],
      policySnapshotLoader: {
        decisionService: new GrantBasedAccessDecisionService(
          new PolicySnapshot(
            [
              harnessGrant({
                subject: { kind: "user", name: ADMIN.id },
                actions: ["admin"],
                resource: { kind: "access", pattern: "*" },
              }),
              harnessGrant({
                subject: { kind: "user", name: MEMBER.id },
                actions: ["read", "write", "run"],
                resource: { kind: "model", pattern: "*" },
              }),
            ],
            [],
            createConditionEvaluator(),
          ),
          { writeImpliesTag: true },
        ),
      } as unknown as PolicySnapshotLoader,
      authConfig: {
        mode: "token",
        admins: [],
        allowedCollectives: [],
        allowedUsers: [],
        oauthProvider: "",
        groupsField: "groups",
        restrictedModelTypes: [],
        restrictedCommands: [],
        approveRequiresExplicitGrant: false,
        signalRequiresExplicitGrant: false,
        tagRequiresExplicitGrant: false,
      },
      instanceId: "instance-1",
    });
    const repo: TokenRepo = {
      repoDir,
      repoContext,
      async mint(name, principalId) {
        const events = await collect(
          serverTokenCreate(
            libCtx,
            await createServerTokenCreateDeps(libCtx, repoDir, repoContext),
            {
              name,
              principalId,
              principalEmail: `${name}@example.com`,
              durationMs: 60 * 60 * 1000,
              vaultName: TOKEN_SECRETS_VAULT_NAME,
            },
          ),
        );
        assertExists(
          events.find((event) => event.kind === "completed"),
          `mint ${name}: ${JSON.stringify(events)}`,
        );
      },
      async rotate(name) {
        const sent: string[] = [];
        await handleAccessTokenRotate(
          replySocket(sent),
          ctx(),
          `rotate-${name}`,
          { name },
          new AbortController(),
          ADMIN,
        );
        assertEquals(JSON.parse(sent[0]).type, "access.token.rotate", sent[0]);
      },
      async revoke(name) {
        const sent: string[] = [];
        await handleAccessTokenRevoke(
          replySocket(sent),
          ctx(),
          `revoke-${name}`,
          { name },
          new AbortController(),
          ADMIN,
        );
        assertEquals(JSON.parse(sent[0]).type, "access.token.revoke", sent[0]);
      },
      ctx,
    };
    await fn(repo);
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function replySocket(sent: string[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
}

async function request(
  ctx: ConnectionContext,
  principal: Principal,
  frame: { type: string; id: string; payload?: Record<string, unknown> },
  send?: (data: string) => void,
): Promise<Frame[]> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      send?.(data);
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  const active = new Map<string, AbortController>();
  handleMessage(
    socket,
    ctx,
    active,
    new MessageEvent("message", { data: JSON.stringify(frame) }),
    principal,
  );
  await waitFor(() => !active.has(frame.id), `${frame.type} finished`);
  return sent.map((raw) => JSON.parse(raw) as Frame)
    .filter((f) => f.id === frame.id);
}

function reveal(name: string, id = `reveal-${name}`) {
  return { type: "access.token.reveal", id, payload: { name } };
}

async function secretOf(repoDir: string, name: string): Promise<string> {
  return await (await VaultService.fromRepository(repoDir)).get(
    TOKEN_SECRETS_VAULT_NAME,
    `server-token-${name}`,
    "test:token-reveal",
  );
}

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  console.info = capture;
  console.debug = capture;
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join("\n");
}

Deno.test("access.token.reveal: an admin reveals a rotated token through serve, and its member authenticates with it", async () => {
  await withTokenRepo(async (repo) => {
    await repo.mint("member-token", "user:member");
    await repo.rotate("member-token");

    const frames = await request(repo.ctx(), ADMIN, reveal("member-token"));

    assertEquals(frames.length, 1, JSON.stringify(frames));
    assertEquals(frames[0].type, "access.token.reveal");
    const data = frames[0].payload?.data as { token: string; name: string };
    assertEquals(data.name, "member-token");
    assertEquals(
      data.token,
      `member-token.${await secretOf(repo.repoDir, "member-token")}`,
    );
    const auth = await authenticateServerToken(
      data.token,
      repo.repoDir,
      repo.repoContext,
    );
    assert(auth.ok, JSON.stringify(auth));
    assertEquals(auth.principalId, "user:member");
  });
});

Deno.test("access.token.reveal: a caller without admin on access is refused and sees no secret", async () => {
  await withTokenRepo(async (repo) => {
    await repo.mint("member-token", "user:member");
    const secret = await secretOf(repo.repoDir, "member-token");

    const frames = await request(repo.ctx(), MEMBER, reveal("member-token"));

    assertEquals(frames.length, 1, JSON.stringify(frames));
    assertEquals(frames[0].type, "error");
    assertEquals(frames[0].error?.code, "unauthorized");
    assert(!JSON.stringify(frames).includes(secret));
  });
});

Deno.test("access.token.reveal: a login token is not revealable, even by an admin, and can still be revoked", async () => {
  await withTokenRepo(async (repo) => {
    await repo.mint("oauth-1a2b3c4d", "user:alice");
    const secret = await secretOf(repo.repoDir, "oauth-1a2b3c4d");

    const frames = await request(repo.ctx(), ADMIN, reveal("oauth-1a2b3c4d"));

    assertEquals(frames[0].type, "error");
    assertEquals(frames[0].error?.code, "token_not_revealable");
    assert(!JSON.stringify(frames).includes(secret));
    await repo.revoke("oauth-1a2b3c4d");
  });
});

Deno.test("access.token.reveal: a revoked token is refused, here and on another node reading the same records", async () => {
  await withTokenRepo(async (repo) => {
    await repo.mint("member-token", "user:member");
    await repo.revoke("member-token");

    const frames = await request(repo.ctx(), ADMIN, reveal("member-token"));
    assertEquals(frames[0].type, "error");
    assertEquals(frames[0].error?.code, "token_revoked");

    const otherNode = createRepositoryContext({ repoDir: repo.repoDir });
    try {
      const fromOther = await request(
        { ...repo.ctx(), repoContext: otherNode, instanceId: "instance-2" },
        ADMIN,
        reveal("member-token", "reveal-other"),
      );
      assertEquals(fromOther[0].error?.code, "token_revoked");
    } finally {
      otherNode.catalogStore.close();
    }
  });
});

Deno.test("access.token.reveal: the plaintext is masked in anything logged while the reply is sent, and in no frame of a failed send", async () => {
  await withTokenRepo(async (repo) => {
    await repo.mint("member-token", "user:member");
    const secret = await secretOf(repo.repoDir, "member-token");
    const logger = getSwampLogger(["test", "token-reveal"]);

    let frames: Frame[] = [];
    const output = await captureOutput(async () => {
      frames = await request(
        repo.ctx(),
        ADMIN,
        reveal("member-token"),
        (data) => {
          logger.error`echoing a reply that failed to send: ${data}`;
          throw new Error(`send failed for ${data}`);
        },
      );
    });

    assert(output.includes("echoing a reply"), output);
    assert(!output.includes(secret), output);
    assert(!JSON.stringify(frames).includes(secret));
  });
});

Deno.test("access.token.reveal: forwarded to the leader, never answered by a follower or behind a sync gate", () => {
  assert(FOLLOWER_FORWARDED_REQUESTS.has("access.token.reveal"));
  assert(!FOLLOWER_READ_REQUESTS.has("access.token.reveal"));
  assert(!SYNC_GATED_REQUESTS.has("access.token.reveal"));
  assert(!CONFIRMED_WRITE_REQUESTS.has("access.token.reveal"));
});

Deno.test({
  name:
    "access.token.reveal: a follower relays it to the leader with the caller's credential, so the leader's token check decides",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTokenRepo(async (repo) => {
      const received: { auth: string | null; frame: unknown }[] = [];
      const leaderHttp = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) => {
          const auth = req.headers.get("authorization");
          const { socket, response } = Deno.upgradeWebSocket(req);
          socket.onmessage = (event) => {
            const frame = JSON.parse(String(event.data));
            received.push({ auth, frame });
            socket.send(JSON.stringify({
              type: "error",
              id: frame.id,
              error: { code: "unauthorized", message: "token revoked" },
            }));
          };
          return response;
        },
      );
      const leader: ServeLeader = {
        instanceId: "leader-1",
        fence: 2,
        address: `http://127.0.0.1:${leaderHttp.addr.port}`,
        since: "2026-11-05T12:00:00.000Z",
      };
      const leaderLink = new LeaderLink({ leader: () => leader });
      const ctx = repo.ctx();
      ctx.followerGate = {
        role: "follower",
        leader: () => leader,
        isStale: () => false,
      };
      ctx.leaderLink = leaderLink;
      const followerHttp = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) => {
          const credential = forwardCredentialOf(
            req,
            { kind: "bearer", token: "admin-token.revoked-secret" },
            "127.0.0.1",
          );
          const { socket, response } = Deno.upgradeWebSocket(req);
          rememberForwardCredential(socket, credential);
          handleConnection(socket, ctx, ADMIN);
          return response;
        },
      );
      const client = new WebSocket(
        `ws://127.0.0.1:${followerHttp.addr.port}/`,
      );
      const frames: Frame[] = [];
      client.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      try {
        await new Promise((resolve) => (client.onopen = resolve));
        client.send(JSON.stringify(reveal("member-token")));
        await waitFor(() => frames.length === 1, "the leader's answer");
        assertEquals(received.length, 1);
        assertEquals(received[0].auth, "Bearer admin-token.revoked-secret");
        assertEquals(
          (received[0].frame as { type: string }).type,
          "access.token.reveal",
        );
        assertEquals(frames[0].error?.code, "unauthorized");
      } finally {
        client.close();
        leaderLink.close();
        await followerHttp.shutdown();
        await leaderHttp.shutdown();
      }
    });
  },
});

async function withMockServe(
  answer: (frame: { type: string; id: string }) => unknown,
  fn: (url: string, seen: { auth: string | null; type: string }[]) => Promise<
    void
  >,
): Promise<void> {
  const seen: { auth: string | null; type: string }[] = [];
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const auth = req.headers.get("authorization");
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("not found", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        seen.push({ auth, type: frame.type });
        socket.send(JSON.stringify(answer(frame)));
      };
      return response;
    },
  );
  try {
    await fn(`ws://127.0.0.1:${http.addr.port}`, seen);
  } finally {
    await http.shutdown();
  }
}

Deno.test({
  name:
    "access token reveal --server: asks serve for the token and opens no repository",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { accessTokenRevealCommand } = await import(
      "../src/cli/commands/access_token_reveal.ts"
    );
    const { Command } = await import("@cliffy/command");
    await withMockServe((frame) => ({
      type: "access.token.reveal",
      id: frame.id,
      payload: {
        data: {
          name: "member-token",
          token: "member-token.s3cret-value",
          expired: false,
          vaultRef: {
            vaultName: "_token-secrets",
            secretKey: "server-token-member-token",
          },
        },
      },
    }), async (url, seen) => {
      const root = new Command()
        .noExit()
        .globalOption("--json", "JSON output")
        .command("reveal", accessTokenRevealCommand);
      const output = await captureOutput(async () => {
        await root.parse([
          "reveal",
          "member-token",
          "--json",
          "--yes",
          "--server",
          url,
          "--token",
          "admin-token.secret",
          "--repo-dir",
          "/nonexistent-swamp-repo",
        ]);
      });
      assertEquals(seen, [{
        auth: "Bearer admin-token.secret",
        type: "access.token.reveal",
      }]);
      assert(output.includes("member-token.s3cret-value"), output);
    });
  },
});

Deno.test({
  name:
    "access token reveal --server: a serve that predates the request is reported as needing an upgrade",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { accessTokenRevealCommand } = await import(
      "../src/cli/commands/access_token_reveal.ts"
    );
    const { Command } = await import("@cliffy/command");
    await withMockServe((frame) => ({
      type: "error",
      id: frame.id,
      error: { code: "invalid_request", message: "Invalid request" },
    }), async (url) => {
      const root = new Command()
        .noExit()
        .globalOption("--json", "JSON output")
        .command("reveal", accessTokenRevealCommand);
      let caught: unknown;
      await captureOutput(async () => {
        try {
          await root.parse([
            "reveal",
            "member-token",
            "--yes",
            "--server",
            url,
            "--token",
            "admin-token.secret",
          ]);
        } catch (error) {
          caught = error;
        }
      });
      assert(caught instanceof Error, String(caught));
      assert(
        caught.message.includes("upgrade swamp on the server"),
        caught.message,
      );
    });
  },
});
