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
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { provisionHostedWorkspace } from "../src/cli/hosted_workspace_provision.ts";
import type { AdmissionLists } from "../src/domain/access/admission.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import { SignInCodeStore } from "../src/domain/access/sign_in_code.ts";
import type { ServerToken } from "../src/domain/models/access/server_token_model.ts";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../src/domain/serve_audit/audit_sink.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { HostedWorkspaceRootAccess } from "../src/libswamp/hosted_workspace/deps.ts";
import {
  type AuthExchangeDeps,
  authInfoBody,
  exchangeOffered,
  exchangeTarget,
  handleAuthExchange,
} from "../src/serve/auth_exchange_handler.ts";
import { createExchangeTokenMinter } from "../src/serve/device_auth_handler.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { hostRootWorkspaces } from "../src/serve/host_root_workspaces.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { createSignInCodeRedeemClient } from "../src/serve/sign_in_code_redeem_client.ts";
import { handleSignInCodeRedeem } from "../src/serve/sign_in_code_redeem_handler.ts";
import { createTokenAdmissionChecker } from "../src/serve/token_admission.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
import {
  createServeCtx,
  type Frame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const HOST_ADDRESS = "https://host.example";
const ROOT_TOKEN = "root-alice.root-secret-value";
const ALICE: Principal = { kind: "user", id: "sub-alice" };
const BOB: Principal = { kind: "user", id: "sub-bob" };
// the router strips /w/<name> before a request reaches the workspace's serve
const WORKSPACE_EXCHANGE_URL = "http://127.0.0.1/auth/exchange";
const ROOT_ADMIN_GRANT = (subject: string) =>
  grant({
    subject: { kind: "user", name: subject },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
const ROOT_TOKEN_EXPIRES_AT = new Date(Date.now() + 2 * 86_400_000)
  .toISOString();

function rootToken(principalId: string, collectives: string[]): ServerToken {
  return {
    name: "root-alice",
    state: "active",
    principalId,
    principalEmail: "alice@example.com",
    oauthIdentity: { email: "alice@example.com", username: "alice" },
    client: "direct:cli",
    collectives,
    groups: ["ops"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: ROOT_TOKEN_EXPIRES_AT,
    vaultName: TOKEN_SECRETS_VAULT_NAME,
    secretKey: "server-token-root-alice",
  };
}

async function rootLogin(record: ServerToken) {
  const auth = await authenticateServerToken(
    ROOT_TOKEN,
    "/nonexistent",
    {} as RepositoryContext,
    null,
    undefined,
    {
      readToken: () => Promise.resolve(record),
      readSecret: () => Promise.resolve("root-secret-value"),
    },
  );
  assert(auth.ok);
  return {
    tokenExpiresAt: auth.tokenExpiresAt,
    identity: auth.oauthIdentity,
    collectives: auth.collectives,
    groups: auth.groups,
  };
}

function collectingSink(): AuditSink & { events: AuditEvent[] } {
  const sink = {
    name: "test-collector",
    durable: false,
    events: [] as AuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.events.push(...events);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

interface Received {
  readonly exchange: string[];
  readonly redeemReplies: string[];
}

interface Host {
  readonly root: ServeRepo;
  readonly workspace: ServeRepo;
  readonly codes: SignInCodeStore;
  rootCtx(mode: "token" | "oauth"): ConnectionContext;
  exchange(
    name: string,
    options: { mode: "token" | "oauth"; lists?: AdmissionLists },
  ): {
    deps: AuthExchangeDeps;
    received: Received;
    audit: AuditSink & { events: AuditEvent[] };
    emitter: AuditEmitter;
  };
  readonly clock: { advance(ms: number): void };
}

async function withHost(fn: (host: Host) => Promise<void>): Promise<void> {
  await withServeRepo(async (root) => {
    await withServeRepo(async (workspace) => {
      const provider = new ControlPlaneVaultProvider(
        new FileSystemControlPlaneStore(swampPath(workspace.repoDir)),
      );
      await provider.initialize();
      VaultService.registerGlobalProvider(
        TOKEN_SECRETS_VAULT_NAME,
        "control_plane",
        provider,
      );
      const hostDir = await Deno.makeTempDir({ prefix: "swamp-host-" });
      let skew = 0;
      const codes = new SignInCodeStore({ now: () => Date.now() + skew });
      const rootAccess = (
        mode: "token" | "oauth",
      ): HostedWorkspaceRootAccess => ({
        mode,
        oauthProvider: mode === "oauth" ? "https://club.example" : null,
        allowedUsers: [],
        allowedCollectives: [],
        nameCache: {},
      });
      const hosted = (mode: "token" | "oauth") => {
        const base = hostRootWorkspaces(
          { dir: join(hostDir, "workspaces"), address: HOST_ADDRESS },
          {},
          () => rootAccess(mode),
        )!;
        return {
          ...base,
          signInCodes: codes,
          services: {
            ...base.services,
            provisioner: {
              provision: (
                dir: string,
                spec: Parameters<typeof provisionHostedWorkspace>[1],
              ) => provisionHostedWorkspace(dir, spec),
            },
          },
        };
      };
      try {
        resetRateLimitState();
        await fn({
          root,
          workspace,
          codes,
          clock: { advance: (ms) => skew += ms },
          rootCtx: (mode) =>
            createServeCtx(
              root,
              [
                ROOT_ADMIN_GRANT(ALICE.id),
                ROOT_ADMIN_GRANT("alice"),
              ],
              {
                authMode: mode,
                resolvedUserNames: { [ALICE.id]: "alice", [BOB.id]: "bob" },
                hostedWorkspaces: hosted(mode),
              },
            ),
          exchange: (name, options) => {
            const received: Received = { exchange: [], redeemReplies: [] };
            const audit = collectingSink();
            const emitter = new AuditEmitter([audit]);
            const target = exchangeTarget(
              HOST_ADDRESS,
              `${HOST_ADDRESS}/w/${name}`,
            )!;
            const redeemer = createSignInCodeRedeemClient({
              ...target,
              // the host's router at the root's public address
              fetch: async (input, init) => {
                const response = await handleSignInCodeRedeem(
                  new Request(input, init),
                  { codes, sourceIp: "127.0.0.1" },
                );
                const reply = response ?? new Response(null, { status: 404 });
                const text = await reply.text();
                received.redeemReplies.push(
                  JSON.stringify([...reply.headers]) + text,
                );
                return new Response(text, {
                  status: reply.status,
                  headers: reply.headers,
                });
              },
            });
            return {
              received,
              audit,
              emitter,
              deps: {
                mode: options.mode,
                admissionLists: () =>
                  options.lists ?? { allowedCollectives: [], allowedUsers: [] },
                redeemer,
                mint: createExchangeTokenMinter(
                  workspace.repoDir,
                  workspace.repoContext,
                ),
                sourceIp: "198.51.100.4",
                auditEmitter: emitter,
                instanceId: `${name}-serve`,
              },
            };
          },
        });
      } finally {
        VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
        if (Deno.build.os === "windows") {
          await Deno.remove(hostDir, { recursive: true }).catch(() => {});
        } else {
          await Deno.remove(hostDir, { recursive: true });
        }
      }
    });
  });
}

function request(type: string, name?: string) {
  return {
    type,
    id: crypto.randomUUID(),
    ...(name === undefined ? {} : { payload: { name } }),
  };
}

function data(frames: Frame[], type: string): Record<string, unknown> {
  const frame = frames.find((f) => f.type === type);
  assert(frame, `no ${type} reply in ${JSON.stringify(frames)}`);
  return (frame.payload as { data: Record<string, unknown> }).data;
}

async function signIn(
  ctx: ConnectionContext,
  name: string,
  principal: Principal,
  record: ServerToken,
): Promise<string> {
  const issued = data(
    await sendRequest(ctx, request("workspace.sign-in", name), principal, {
      client: "direct:cli",
      login: await rootLogin(record),
    }),
    "workspace.sign-in",
  );
  return issued.code as string;
}

// the client hands the workspace the code and nothing else
async function exchangeAt(
  workspace: ReturnType<Host["exchange"]>,
  code: string,
): Promise<Response> {
  const body = JSON.stringify({ code });
  const req = new Request(WORKSPACE_EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  workspace.received.exchange.push(
    JSON.stringify([...req.headers]) + body,
  );
  return (await handleAuthExchange(req, workspace.deps))!;
}

Deno.test("serve workspace sign-in: the holder of a root token gets a workspace token that works at the workspace, and the root token goes only to the root", async () => {
  await withHost(async (host) => {
    const ctx = host.rootCtx("oauth");
    data(
      await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE),
      "workspace.create",
    );
    const code = await signIn(
      ctx,
      "edge-dns",
      ALICE,
      rootToken("user:sub-alice", ["acme"]),
    );
    const lists = { allowedCollectives: ["acme"], allowedUsers: [] };
    const edge = host.exchange("edge-dns", { mode: "oauth", lists });
    const response = await exchangeAt(edge, code);
    assertEquals(response.status, 200);
    const body = await response.json() as {
      token: string;
      expiresAt: string;
    };

    for (
      const seen of [...edge.received.exchange, ...edge.received.redeemReplies]
    ) {
      assert(!seen.includes(ROOT_TOKEN), "the workspace saw the root token");
      assert(
        !seen.includes("root-secret-value"),
        "the workspace saw its secret",
      );
    }

    let allowed = lists;
    const admission = createTokenAdmissionChecker({
      lists: () => allowed,
      hasStoredLogin: () => Promise.resolve(false),
    });
    const auth = await authenticateServerToken(
      body.token,
      host.workspace.repoDir,
      host.workspace.repoContext,
      admission,
    );
    assert(auth.ok, JSON.stringify(auth));
    assertEquals(auth.principalId, "user:sub-alice");
    assertEquals(auth.collectives, ["acme"]);
    assertEquals(auth.client, "direct:cli");
    assertEquals(auth.oauthIdentity, {
      email: "alice@example.com",
      username: "alice",
    });

    // a workspace token never outlives the root token it came from
    assert(
      Date.parse(auth.tokenExpiresAt!) <= Date.parse(ROOT_TOKEN_EXPIRES_AT),
    );
    assertEquals(body.expiresAt, auth.tokenExpiresAt);

    // the workspace's own lists keep applying to the token it minted
    allowed = { allowedCollectives: ["other-org"], allowedUsers: [] };
    const refused = await authenticateServerToken(
      body.token,
      host.workspace.repoDir,
      host.workspace.repoContext,
      createTokenAdmissionChecker({
        lists: () => allowed,
        hasStoredLogin: () => Promise.resolve(false),
      }),
    );
    assertEquals(refused.ok, false);
  });
});

Deno.test("serve workspace sign-in: a code for one workspace is refused at another, and is then spent", async () => {
  await withHost(async (host) => {
    const ctx = host.rootCtx("oauth");
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    await sendRequest(ctx, request("workspace.create", "billing"), ALICE);
    const code = await signIn(
      ctx,
      "edge-dns",
      ALICE,
      rootToken("user:sub-alice", ["acme"]),
    );
    const billing = host.exchange("billing", { mode: "oauth" });
    assertEquals((await exchangeAt(billing, code)).status, 401);
    const edge = host.exchange("edge-dns", { mode: "oauth" });
    assertEquals((await exchangeAt(edge, code)).status, 401);
  });
});

Deno.test("serve workspace sign-in: a code is refused the second time it is used, and after it expires", async () => {
  await withHost(async (host) => {
    const ctx = host.rootCtx("oauth");
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const record = rootToken("user:sub-alice", ["acme"]);
    const edge = host.exchange("edge-dns", { mode: "oauth" });

    const used = await signIn(ctx, "edge-dns", ALICE, record);
    assertEquals((await exchangeAt(edge, used)).status, 200);
    assertEquals((await exchangeAt(edge, used)).status, 401);

    const stale = await signIn(ctx, "edge-dns", ALICE, record);
    host.clock.advance(60_000);
    assertEquals((await exchangeAt(edge, stale)).status, 401);
    assertEquals(host.codes.size, 0, "an expired code is gone");
  });
});

Deno.test("serve workspace sign-in: a principal the workspace's lists do not admit gets no token, and the refusal is in the workspace's audit log", async () => {
  await withHost(async (host) => {
    const ctx = host.rootCtx("oauth");
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const code = await signIn(
      ctx,
      "edge-dns",
      BOB,
      {
        ...rootToken("user:sub-bob", []),
        oauthIdentity: { email: "bob@example.com", username: "bob" },
      },
    );
    const edge = host.exchange("edge-dns", {
      mode: "oauth",
      lists: { allowedCollectives: ["acme"], allowedUsers: [] },
    });
    const response = await exchangeAt(edge, code);
    assertEquals(response.status, 403);
    assertEquals((await response.json()).error, "not_admitted");
    await edge.emitter.flush();
    const denied = edge.audit.events.find((e) =>
      e.action === "auth.exchange.denied"
    );
    assertEquals(denied?.principalId, "sub-bob");
    assertEquals(denied?.outcome, "denied");
    assertEquals(denied?.instanceId, "edge-dns-serve");
    assert(
      !edge.audit.events.some((e) => e.action === "auth.exchange.completed"),
    );
  });
});

Deno.test("serve workspace sign-in: a serve given no root address answers the exchange as not offered, and /auth/info does not offer it", async () => {
  const none = exchangeTarget(undefined, `${HOST_ADDRESS}/w/edge-dns`);
  const response = await handleAuthExchange(
    new Request(WORKSPACE_EXCHANGE_URL, {
      method: "POST",
      body: JSON.stringify({ code: "swsc1.abc" }),
    }),
    exchangeOffered(none, "oauth") ? ({} as AuthExchangeDeps) : null,
  );
  assertEquals(response?.status, 404);
  assertEquals(await response?.json(), { error: "exchange_not_offered" });
  const config = {
    mode: "oauth" as const,
    oauthProvider: "https://club.example",
  };
  assertEquals(authInfoBody(config, exchangeOffered(none, "oauth")), {
    mode: "oauth",
    verificationBaseUri: "https://club.example",
  });
  const given = exchangeTarget(HOST_ADDRESS, `${HOST_ADDRESS}/w/edge-dns`);
  assertEquals(
    authInfoBody(config, exchangeOffered(given, "oauth")).exchange,
    true,
  );
  assertEquals(exchangeOffered(given, "none"), false);
});

Deno.test("serve workspace sign-in: a token-mode root creates a workspace, and its creator gets a token inside it through the exchange", async () => {
  await withHost(async (host) => {
    const ctx = host.rootCtx("token");
    const alice: Principal = { kind: "user", id: "alice" };
    data(
      await sendRequest(ctx, request("workspace.create", "edge-dns"), alice),
      "workspace.create",
    );
    const record: ServerToken = {
      ...rootToken("user:alice", []),
      principalEmail: "",
      client: "direct:token",
    };
    delete (record as { oauthIdentity?: unknown }).oauthIdentity;
    const code = await signIn(ctx, "edge-dns", alice, record);
    const edge = host.exchange("edge-dns", { mode: "token" });
    const response = await exchangeAt(edge, code);
    assertEquals(response.status, 200);
    const { token } = await response.json() as { token: string };
    const auth = await authenticateServerToken(
      token,
      host.workspace.repoDir,
      host.workspace.repoContext,
      null,
    );
    assert(auth.ok, JSON.stringify(auth));
    assertEquals(auth.principalId, "user:alice");
    assertEquals(auth.oauthIdentity, undefined);
  });
});

Deno.test("serve workspace sign-in: token mode trusts whoever mints root tokens, and an oauth workspace refuses a token minted by hand", async () => {
  await withHost(async (host) => {
    const tokenRoot = host.rootCtx("token");
    const bob: Principal = { kind: "user", id: "bob" };
    await sendRequest(tokenRoot, request("workspace.create", "edge-dns"), bob);
    // a root token a root admin minted for bob, not one bob holds
    const mintedForBob: ServerToken = {
      ...rootToken("user:bob", []),
      principalEmail: "",
      client: "direct:token",
    };
    delete (mintedForBob as { oauthIdentity?: unknown }).oauthIdentity;
    const tokenCode = await signIn(tokenRoot, "edge-dns", bob, mintedForBob);
    const tokenWorkspace = host.exchange("edge-dns", { mode: "token" });
    assertEquals((await exchangeAt(tokenWorkspace, tokenCode)).status, 200);

    const oauthRoot = host.rootCtx("oauth");
    await sendRequest(oauthRoot, request("workspace.create", "billing"), ALICE);
    const handMinted: ServerToken = {
      ...rootToken("user:sub-alice", ["acme"]),
      client: "direct:token",
    };
    delete (handMinted as { oauthIdentity?: unknown }).oauthIdentity;
    const oauthCode = await signIn(oauthRoot, "billing", ALICE, handMinted);
    const oauthWorkspace = host.exchange("billing", { mode: "oauth" });
    const refused = await exchangeAt(oauthWorkspace, oauthCode);
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).error, "not_admitted");
  });
});
