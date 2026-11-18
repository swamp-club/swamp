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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SignInCodeStore } from "../src/domain/access/sign_in_code.ts";
import type { ServerCredential } from "../src/domain/auth/server_credential.ts";
import { resetWorkspaceSignInGaps } from "../src/domain/auth/server_login_hint.ts";
import { UserError } from "../src/domain/errors.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { FileServerCredentialRepository } from "../src/infrastructure/persistence/server_credential_repository.ts";
import { ProcessRuntime } from "../src/infrastructure/runtime/process_runtime.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
} from "../src/cli/remote_run.ts";
import { resolveServeUpstream } from "../src/cli/serve_upstream.ts";
import {
  authInfoBody,
  exchangeTarget,
  handleAuthExchange,
} from "../src/serve/auth_exchange_handler.ts";
import { createWorkspaceRouter } from "../src/serve/host/workspace_router.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { createSignInCodeRedeemClient } from "../src/serve/sign_in_code_redeem_client.ts";
import { handleSignInCodeRedeem } from "../src/serve/sign_in_code_redeem_handler.ts";

await initializeLogging({});

const ROOT_TOKEN = "root-alice.root-secret-value";
const WORKSPACE_PATH = "/w/team";
const ROOT_EXPIRES_AT = new Date(Date.now() + 2 * 86_400_000).toISOString();

interface Seen {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface Host {
  readonly hostAddress: string;
  readonly workspaceAddress: string;
  readonly configDir: string;
  readonly seen: Seen[];
  readonly minted: Set<string>;
  store(credential: Partial<ServerCredential> & { serverUrl: string }): Promise<
    void
  >;
  stored(serverUrl: string): Promise<ServerCredential | null>;
  /** one CLI process: its own runtime, so nothing carries over from the last */
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly codeRequests: () => number;
  readonly exchanges: () => number;
}

interface HostOptions {
  /** a reverse proxy's path in front of the host; such a host is a stand-in */
  readonly prefix?: string;
  readonly offerExchange?: boolean;
  readonly rootStatus?: number;
  readonly env?: Record<string, string | undefined>;
}

/**
 * the root and the workspace are separate serves behind the host's real router,
 * which a refusal has to cross; with a prefix one server plays the host
 */
async function withHost(
  options: HostOptions,
  fn: (host: Host) => Promise<void>,
): Promise<void> {
  const prefix = options.prefix ?? "";
  const configDir = await Deno.makeTempDir({ prefix: "swamp-ws-sign-in-" });
  const seen: Seen[] = [];
  const minted = new Set<string>();
  const codes = new SignInCodeStore();
  let base = "";
  const exchangeDeps = () => ({
    mode: "oauth" as const,
    admissionLists: () => ({ allowedCollectives: [], allowedUsers: [] }),
    redeemer: createSignInCodeRedeemClient(
      exchangeTarget(base, `${base}${WORKSPACE_PATH}`)!,
    ),
    mint: (input: { notAfter: string }) => {
      const token = `ws-${crypto.randomUUID()}.secret`;
      minted.add(token);
      return Promise.resolve({ token, expiresAt: input.notAfter });
    },
    sourceIp: "127.0.0.1",
  });

  const record = async (req: Request, path: string): Promise<string> => {
    const body = req.body === null ? "" : await req.clone().text();
    seen.push({
      path,
      authorization: req.headers.get("authorization"),
      body,
    });
    return body;
  };
  const local = (req: Request, path: string, body: string) =>
    new Request(new URL(path, "http://127.0.0.1"), {
      method: req.method,
      headers: req.headers,
      ...(req.method === "GET" ? {} : { body }),
    });
  const bearer = (req: Request) =>
    req.headers.get("authorization")?.slice("Bearer ".length) ?? "";

  const workspace = async (req: Request, path: string): Promise<Response> => {
    const body = await record(req, `${prefix}${WORKSPACE_PATH}${path}`);
    if (path === "/auth/info") {
      return Response.json(
        authInfoBody(
          { mode: "oauth", oauthProvider: "https://club.example" },
          options.offerExchange ?? true,
        ),
      );
    }
    if (path === "/auth/exchange") {
      return (await handleAuthExchange(
        local(req, path, body),
        exchangeDeps(),
      ))!;
    }
    if (req.headers.get("upgrade") === "websocket") {
      if (!minted.has(bearer(req))) {
        return new Response("Unauthorized: unknown", { status: 401 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const { type, id } = JSON.parse(String(event.data));
        socket.send(JSON.stringify({ type, id, payload: { ok: true } }));
      };
      return response;
    }
    return new Response(null, { status: 404 });
  };

  const root = async (req: Request, path: string): Promise<Response> => {
    const body = await record(req, `${prefix}${path}`);
    const redeemed = await handleSignInCodeRedeem(local(req, path, body), {
      codes,
      sourceIp: "127.0.0.1",
    });
    if (redeemed !== null) return redeemed;
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 404 });
    }
    if (options.rootStatus !== undefined) {
      return new Response(null, { status: options.rootStatus });
    }
    if (bearer(req) !== ROOT_TOKEN) {
      return new Response("Unauthorized: unknown", { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = async (event) => {
      const message = JSON.parse(String(event.data));
      const issued = await codes.issue(message.payload.name, {
        principal: "user:sub-alice",
        username: "alice",
        email: "alice@example.com",
        collectives: [],
        groups: [],
        expiresAt: ROOT_EXPIRES_AT,
      });
      assert(issued.ok);
      socket.send(JSON.stringify({
        type: message.type,
        id: message.id,
        payload: {
          data: {
            name: message.payload.name,
            code: issued.code,
            expiresAt: issued.expiresAt,
          },
        },
      }));
    };
    return response;
  };

  const listen = (handler: Deno.ServeHandler<Deno.NetAddr>) =>
    Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
  const servers: Deno.HttpServer<Deno.NetAddr>[] = [];
  const shutdown = new AbortController();
  if (prefix === "") {
    const rootServe = listen((req) => root(req, new URL(req.url).pathname));
    const workspaceServe = listen((req) =>
      workspace(req, new URL(req.url).pathname)
    );
    const router = createWorkspaceRouter({
      directory: {
        workspace: (name) =>
          name === "team"
            ? { kind: "running", port: workspaceServe.addr.port }
            : undefined,
        root: () => ({ kind: "running", port: rootServe.addr.port }),
      },
      protocol: "http",
      trustProxy: false,
      signal: shutdown.signal,
    });
    servers.push(
      listen((req, info) => router.handle(req, info)),
      rootServe,
      workspaceServe,
    );
  } else {
    servers.push(listen((req) => {
      const path = new URL(req.url).pathname;
      if (!path.startsWith(prefix)) {
        return new Response(null, { status: 404 });
      }
      const rest = path.slice(prefix.length) || "/";
      return rest === WORKSPACE_PATH || rest.startsWith(`${WORKSPACE_PATH}/`)
        ? workspace(req, rest.slice(WORKSPACE_PATH.length) || "/")
        : root(req, rest);
    }));
  }
  base = `http://127.0.0.1:${servers[0].addr.port}${prefix}`;
  try {
    resetRateLimitState();
    resetWorkspaceSignInGaps();
    await withMockedEnv(
      {
        SWAMP_CONFIG_DIR: configDir,
        SWAMP_SERVER_TOKEN: undefined,
        SWAMP_SERVER_URL: undefined,
        SWAMP_SERVER_TOKEN_FILE: undefined,
        SWAMP_SERVE_URL: undefined,
        SWAMP_SERVE_EXTRA_HEADERS: undefined,
        SWAMP_SERVE_TIMEOUT_MS: undefined,
        ...options.env,
      },
      () =>
        fn({
          hostAddress: base,
          workspaceAddress: `${base}${WORKSPACE_PATH}`,
          configDir,
          seen,
          minted,
          store: (credential) =>
            new FileServerCredentialRepository({ configDir, fileOnly: true })
              .save({
                tokenName: "alice@example.com",
                token: ROOT_TOKEN,
                principalId: "user:sub-alice",
                obtainedAt: new Date().toISOString(),
                ...credential,
              }),
          stored: (serverUrl) =>
            new FileServerCredentialRepository({ configDir, fileOnly: true })
              .get(serverUrl),
          run: (body) => new ProcessRuntime(crypto.randomUUID()).run(body),
          codeRequests: () =>
            seen.filter((s) =>
              s.path === `${prefix}/` && s.authorization !== null
            ).length,
          exchanges: () =>
            seen.filter((s) =>
              s.path === `${prefix}${WORKSPACE_PATH}/auth/exchange`
            ).length,
        }),
    );
  } finally {
    shutdown.abort();
    for (const server of servers) await server.shutdown();
    await Deno.remove(configDir, { recursive: true }).catch((e) => {
      if (Deno.build.os !== "windows") throw e;
    });
  }
}

/** a command run with --server <address>: resolve its token, send one request */
function command(host: Host, address: string): Promise<unknown> {
  return host.run(async () => {
    const token = await resolveServerTokenFromOptions(address, {
      server: address,
    });
    return await requestServerResponse(
      { server: address, token, remoteIndicator: false, log: () => {} },
      { type: "server.version", payload: {} },
    );
  });
}

function assertRootTokenOnlyAtRoot(host: Host): void {
  const workspacePath = new URL(host.workspaceAddress).pathname;
  for (const request of host.seen) {
    if (request.path.startsWith(workspacePath)) {
      assert(
        request.authorization !== `Bearer ${ROOT_TOKEN}` &&
          !request.body.includes(ROOT_TOKEN),
        `the workspace received the root token at ${request.path}`,
      );
    }
  }
}

Deno.test("workspace sign-in from the CLI: one host login reaches a workspace, stores its token, and the next command makes no exchange", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress });

    assertEquals(await command(host, host.workspaceAddress), { ok: true });
    const stored = await host.stored(host.workspaceAddress);
    assert(stored !== null && host.minted.has(stored.token));
    assert(stored.expiresAt !== undefined);
    assertEquals(host.exchanges(), 1);

    assertEquals(await command(host, host.workspaceAddress), { ok: true });
    assertEquals(host.exchanges(), 1);
    assertEquals(host.codeRequests(), 1);
    assertRootTokenOnlyAtRoot(host);
  });
});

Deno.test("workspace sign-in from the CLI: a host behind a path signs in at that path's root", async () => {
  await withHost({ prefix: "/proxy/swamp" }, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    assertEquals(await command(host, host.workspaceAddress), { ok: true });
    assertEquals(host.codeRequests(), 1);
    assertRootTokenOnlyAtRoot(host);
  });
});

Deno.test("workspace sign-in from the CLI: a workspace that offers no exchange gives the existing error", async () => {
  await withHost({ offerExchange: false }, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    const error = await assertRejects(
      () => command(host, host.workspaceAddress),
      UserError,
    );
    assertEquals(
      error.message,
      `Authentication failed — run: swamp auth server-login --server ${
        host.workspaceAddress.replace("http:", "ws:")
      }`,
    );
    assertEquals(host.codeRequests(), 0);
  });
});

Deno.test("workspace sign-in from the CLI: no host token names the one sign-in that covers the host", async () => {
  await withHost({}, async (host) => {
    const error = await assertRejects(
      () => command(host, host.workspaceAddress),
      UserError,
    );
    assertEquals(
      error.message,
      `Authentication failed — run: swamp auth server-login --server ${host.hostAddress} (one sign-in to the host covers its workspaces)`,
    );
  });
});

Deno.test("workspace sign-in from the CLI: an expired workspace token is replaced by one exchange before it is sent", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    await host.store({
      serverUrl: host.workspaceAddress,
      token: "ws-expired.secret",
      obtainedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    assertEquals(await command(host, host.workspaceAddress), { ok: true });
    assertEquals(host.exchanges(), 1);
    assert(
      !host.seen.some((s) => s.authorization === "Bearer ws-expired.secret"),
      "the expired token was sent",
    );
  });
});

Deno.test("workspace sign-in from the CLI: a workspace token stored by server-login is used as it is", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    const token = "ws-login.secret";
    host.minted.add(token);
    await host.store({ serverUrl: host.workspaceAddress, token });

    assertEquals(await command(host, host.workspaceAddress), { ok: true });
    assertEquals(host.exchanges(), 0);
  });
});

Deno.test("workspace sign-in from the CLI: a host token from SWAMP_SERVER_TOKEN is never exchanged", async () => {
  const env = { SWAMP_SERVER_TOKEN: ROOT_TOKEN };
  await withHost({ env }, async (host) => {
    await withMockedEnv({ SWAMP_SERVER_URL: host.hostAddress }, async () => {
      await host.store({ serverUrl: host.hostAddress, token: "other.secret" });
      const error = await assertRejects(
        () => command(host, host.workspaceAddress),
        UserError,
      );
      assertEquals(host.codeRequests(), 0);
      assertEquals(await host.stored(host.workspaceAddress), null);
      assert(error.message.includes("SWAMP_SERVER_TOKEN is not used"));
    });
  });
});

Deno.test("workspace sign-in from the CLI: a team-mode checkout at a workspace address signs in the same way", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    await withMockedEnv(
      { SWAMP_SERVE_URL: host.workspaceAddress },
      async () => {
        const resolve = () =>
          host.run(() =>
            resolveServeUpstream({
              engine: "v3",
              commandPath: ["data", "get"],
              getCaCerts: () => undefined,
            })
          );
        const target = await resolve();
        assert(target?.token !== undefined && host.minted.has(target.token));
        await resolve();
        assertEquals(host.exchanges(), 1);
        assertRootTokenOnlyAtRoot(host);
      },
    );
  });
});

Deno.test("workspace sign-in from the CLI: an unreachable root leaves a team-mode command running as before", async () => {
  await withHost({ rootStatus: 502 }, async (host) => {
    await host.store({ serverUrl: host.hostAddress });
    await withMockedEnv(
      { SWAMP_SERVE_URL: host.workspaceAddress },
      async () => {
        const target = await host.run(() =>
          resolveServeUpstream({
            engine: "v3",
            commandPath: ["data", "get"],
            getCaCerts: () => undefined,
          })
        );
        assert(target !== undefined);
        assertEquals(target.token, undefined);
        assertEquals(host.exchanges(), 0);
      },
    );
  });
});

Deno.test("workspace sign-in from the CLI: a host that refuses its stored token says to sign in to the host, through the host's router", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress, token: "revoked.secret" });
    const error = await assertRejects(
      () => command(host, host.workspaceAddress),
      UserError,
    );
    assert(
      error.message.includes(`the host at ${host.hostAddress} refused your`),
      error.message,
    );
    assert(
      error.message.includes(
        `swamp auth server-login --server ${host.hostAddress}`,
      ),
      error.message,
    );
  });
});

Deno.test("workspace sign-in from the CLI: a workspace token expiring with its host token says to sign in to the host", async () => {
  await withHost({}, async (host) => {
    await host.store({ serverUrl: host.hostAddress, token: "expired.secret" });
    await host.store({
      serverUrl: host.workspaceAddress,
      token: "ws-expired.secret",
      obtainedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const error = await assertRejects(
      () => command(host, host.workspaceAddress),
      UserError,
    );
    assert(error.message.includes("refused your sign-in"), error.message);
    assert(
      !host.seen.some((s) => s.authorization === "Bearer ws-expired.secret"),
      "the expired token was sent",
    );
  });
});
