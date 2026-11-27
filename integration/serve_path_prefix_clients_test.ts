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
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  requestServerResponse,
  runWorkflowOverServer,
} from "../src/cli/remote_run.ts";
import {
  buildCancelUrl,
  buildServerCancelRequest,
  sendServerCancel,
} from "../src/cli/commands/workflow_cancel.ts";
import { respondToRunCancel } from "../src/cli/commands/serve.ts";
import {
  createConnectionTeardown,
  handleMessage,
} from "../src/serve/connection.ts";
import { handleHttpRequest } from "../src/serve/http_request_route.ts";
import { SERVE_REQUEST_PATH } from "../src/serve/protocol.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import {
  type DeviceAuthDeps,
  handleDeviceAuth,
} from "../src/serve/device_auth_handler.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { ServerCredential } from "../src/domain/auth/server_credential.ts";
import { normalizeServerUrl } from "../src/domain/auth/server_url.ts";
import {
  createServerLoginDeps,
  serverLogin,
} from "../src/libswamp/auth/server_login.ts";
import { ServeDatastoreClient } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { runWorker, type WorkerExitResult } from "../src/worker/connect.ts";
import { IT_DEFINITION_ID, IT_TYPE } from "./remote_execution_test_model.ts";
import {
  remoteStepRequest,
  startOrchestrator,
  TEST_RUNNER_COMMAND,
} from "./remote_execution_harness.ts";
import {
  createServeCtx,
  saveModel,
  saveWorkflow,
  withServeRepo,
} from "./serve_request_harness.ts";
import {
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

await initializeLogging({});

const PREFIX = "/w/x";

const testOptions = { sanitizeOps: false, sanitizeResources: false };

interface Seen {
  method: string;
  path: string;
  upgrade: boolean;
  forwarded: boolean;
  status: number;
}

interface PrefixForwarder {
  /** the forwarder's address with the prefix, as a client is given it */
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
]);

const HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

function forwardedHeaders(
  req: Request,
  drop: ReadonlySet<string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    if (!HOP_BY_HOP.has(name) && !drop.has(name)) headers[name] = value;
  }
  headers["x-forwarded-prefix"] = PREFIX;
  return headers;
}

// WebSocket.close accepts only 1000 and the application range
function relayableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function closeQuietly(socket: WebSocket, code = 1000, reason = ""): void {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) return;
  try {
    socket.close(relayableCode(code), reason);
  } catch {
    // a socket still connecting may refuse a close it will reach anyway
  }
}

/**
 * A reverse proxy that serves PREFIX and strips it, as serve workspaces' host
 * does; anything outside the prefix is refused, so a client that drops the
 * path fails instead of reaching the target.
 */
function startPrefixForwarder(target: string): PrefixForwarder {
  const targetUrl = new URL(target);
  const seen: Seen[] = [];
  const sockets = new Set<WebSocket>();

  const forwardSocket = (req: Request, path: string, search: string) => {
    const offered = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    // the upgrade closes the request's headers
    const headers = forwardedHeaders(req, HANDSHAKE);
    const { socket: client, response } = Deno.upgradeWebSocket(
      req,
      offered.length > 0 ? { protocol: offered[0] } : {},
    );
    const upstream = new WebSocket(
      `ws://${targetUrl.host}${path}${search}`,
      { protocols: offered, headers },
    );
    client.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    sockets.add(client);
    sockets.add(upstream);
    const pending: Array<string | ArrayBuffer> = [];
    client.onmessage = (event) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
      else pending.push(event.data);
    };
    upstream.onopen = () => {
      for (const frame of pending.splice(0)) upstream.send(frame);
    };
    upstream.onmessage = (event) => {
      if (client.readyState === WebSocket.OPEN) client.send(event.data);
    };
    client.onclose = (event) => {
      sockets.delete(client);
      closeQuietly(upstream, event.code, event.reason);
    };
    upstream.onclose = (event) => {
      sockets.delete(upstream);
      closeQuietly(client, event.code, event.reason);
    };
    client.onerror = () => closeQuietly(upstream);
    upstream.onerror = () => closeQuietly(client);
    return response;
  };

  const forwardHttp = async (req: Request, path: string, search: string) => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(`${targetUrl.origin}${path}${search}`, {
      method: req.method,
      headers: forwardedHeaders(req, new Set(["content-length"])),
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
    // fetch has decoded the body but keeps these
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return {
      status: upstream.status,
      response: new Response(upstream.body, {
        status: upstream.status,
        headers,
      }),
    };
  };

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const upgrade =
        (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
      const inside = url.pathname === PREFIX ||
        url.pathname.startsWith(`${PREFIX}/`);
      if (!inside) {
        seen.push({
          method: req.method,
          path: url.pathname,
          upgrade,
          forwarded: false,
          status: 404,
        });
        return new Response("outside the prefix", { status: 404 });
      }
      const path = url.pathname.slice(PREFIX.length) || "/";
      if (upgrade) {
        seen.push({
          method: req.method,
          path: url.pathname,
          upgrade,
          forwarded: true,
          status: 101,
        });
        return forwardSocket(req, path, url.search);
      }
      const { status, response } = await forwardHttp(req, path, url.search);
      seen.push({
        method: req.method,
        path: url.pathname,
        upgrade,
        forwarded: true,
        status,
      });
      return response;
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}${PREFIX}`,
    seen,
    close: async () => {
      for (const socket of sockets) closeQuietly(socket);
      await server.shutdown();
    },
  };
}

function refused(seen: readonly Seen[]): Seen[] {
  return seen.filter((entry) => !entry.forwarded);
}

interface Recorded {
  path: string;
  headers: Headers;
}

Deno.test({
  name:
    "startPrefixForwarder: refuses a path outside the prefix and forwards one inside it stripped, with every end-to-end header and the declared prefix",
  ...testOptions,
  fn: async () => {
    const recorded: Recorded[] = [];
    const target = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        recorded.push({
          path: new URL(req.url).pathname,
          headers: new Headers(req.headers),
        });
        if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          socket.onmessage = (event) => socket.send(`echo:${event.data}`);
          return response;
        }
        return new Response("from the target");
      },
    );
    const forwarder = startPrefixForwarder(
      `http://127.0.0.1:${target.addr.port}`,
    );
    const root = new URL(forwarder.url).origin;
    try {
      const outside = await fetch(`${root}${SERVE_REQUEST_PATH}`, {
        method: "POST",
        body: "{}",
      });
      await outside.body?.cancel();
      assertEquals(outside.status, 404);

      const outsideSocket = new WebSocket(`ws://${new URL(root).host}/`);
      await new Promise<void>((resolve) => {
        outsideSocket.onerror = () => resolve();
        outsideSocket.onclose = () => resolve();
      });
      assertEquals(
        recorded,
        [],
        "nothing outside the prefix reached the target",
      );

      const inside = await fetch(`${forwarder.url}${SERVE_REQUEST_PATH}?a=1`, {
        method: "POST",
        headers: {
          "x-test-extra": "kept",
          "x-forwarded-prefix": "/elsewhere",
        },
        body: "{}",
      });
      assertEquals(await inside.text(), "from the target");
      assertEquals(recorded[0].path, SERVE_REQUEST_PATH);
      assertEquals(recorded[0].headers.get("x-test-extra"), "kept");
      assertEquals(recorded[0].headers.get("x-forwarded-prefix"), PREFIX);

      const socket = new WebSocket(
        `ws://${new URL(forwarder.url).host}${PREFIX}/any`,
        { headers: { "x-test-extra": "kept" } },
      );
      const reply = await new Promise<string>((resolve, reject) => {
        socket.onopen = () => socket.send("ping");
        socket.onmessage = (event) => resolve(String(event.data));
        socket.onerror = () => reject(new Error("the socket failed"));
      });
      closeQuietly(socket);
      assertEquals(reply, "echo:ping");
      assertEquals(recorded[1].path, "/any");
      assertEquals(recorded[1].headers.get("x-test-extra"), "kept");
      assertEquals(recorded[1].headers.get("x-forwarded-prefix"), PREFIX);

      assertEquals(
        forwarder.seen.map((entry) => [entry.path, entry.forwarded]),
        [
          [SERVE_REQUEST_PATH, false],
          ["/", false],
          [`${PREFIX}${SERVE_REQUEST_PATH}`, true],
          [`${PREFIX}/any`, true],
        ],
      );
    } finally {
      await forwarder.close();
      await target.shutdown();
    }
  },
});

function serveCli(ctx: ConnectionContext) {
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        const activeRequests = new Map<string, AbortController>();
        socket.onmessage = (event) =>
          handleMessage(socket, ctx, activeRequests, event);
        socket.onclose = createConnectionTeardown({
          ctx,
          activeRequests,
          activeSubscriptions: new Set(),
          subscriptionTimers: new Map(),
          sessionTimeout: null,
          workerAttachment: undefined,
        });
        return response;
      }
      if (new URL(req.url).pathname === SERVE_REQUEST_PATH) {
        return handleHttpRequest(req, "127.0.0.1", {
          ctx,
          authenticate: () =>
            Promise.reject(new Error("serve runs without auth here")),
        });
      }
      return new Response("not a serve route", { status: 404 });
    },
  );
}

Deno.test({
  name:
    "requestServerResponse and runWorkflowOverServer: the CLI's HTTP and WebSocket requests keep the path of a prefixed serve address",
  ...testOptions,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const model = await saveModel(repo, "prefixed");
      const workflow = await saveWorkflow(
        repo,
        `prefixed-${crypto.randomUUID()}`,
        model,
      );
      const registry = new ActiveRunRegistry();
      const ctx = createServeCtx(repo, undefined, {
        activeRunRegistry: registry,
      });
      const serve = serveCli(ctx);
      const forwarder = startPrefixForwarder(
        `http://127.0.0.1:${serve.addr.port}`,
      );
      try {
        const search = await requestServerResponse<{ data: unknown }>(
          { server: forwarder.url, headers: {} },
          { type: "workflow.history.search", payload: {} },
        );
        assert(search.data !== undefined, "the search answered");
        assertEquals(
          forwarder.seen.map((entry) => [
            entry.method,
            entry.path,
            entry.upgrade,
            entry.status,
          ]),
          [["POST", `${PREFIX}${SERVE_REQUEST_PATH}`, false, 200]],
          "the read went over the HTTP route, not the socket it falls back to",
        );

        const got = await requestServerResponse<
          { data: { name: string } }
        >(
          { server: forwarder.url, headers: {} },
          {
            type: "workflow.get",
            payload: { workflowIdOrName: workflow.name },
          },
        );
        assertEquals(got.data.name, workflow.name);
        assertEquals(forwarder.seen.at(-1)?.upgrade, true);
        assertEquals(forwarder.seen.at(-1)?.path, PREFIX);

        let runId: string | undefined;
        for await (
          const event of runWorkflowOverServer({
            server: forwarder.url,
            headers: {},
            payload: { workflowIdOrName: workflow.name, inputs: {} },
            detach: true,
          })
        ) {
          if (event.kind === "started") runId = event.runId as string;
        }
        assert(runId !== undefined, "the run started");
        assertEquals(forwarder.seen.at(-1)?.upgrade, true);
        assertEquals(forwarder.seen.at(-1)?.path, PREFIX);
        assertEquals(refused(forwarder.seen), []);
      } finally {
        await waitFor(() => registry.size === 0, "the detached run to end");
        await forwarder.close();
        await serve.shutdown();
      }
    });
  },
});

const LOGIN_AUTH_CONFIG: DeviceAuthDeps["authConfig"] = {
  mode: "oauth",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "https://auth.example.com",
  oauthClientId: "test-client-id",
  groupsField: "collectives",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
  signalRequiresExplicitGrant: false,
  tagRequiresExplicitGrant: false,
  stepsRequireExplicitGrant: false,
};

const LOGIN_DEPS: DeviceAuthDeps = {
  authConfig: LOGIN_AUTH_CONFIG,
  repoDir: "/nonexistent",
  repoContext: {} as RepositoryContext,
  // serverLogin turns an interval of 0 into five seconds
  startDeviceGrant: () =>
    Promise.resolve({
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://auth.example.com/device",
      expiresIn: 60,
      interval: 1,
    }),
  pollForToken: () =>
    Promise.resolve({ accessToken: "access-token", tokenType: "Bearer" }),
  getUserInfo: () =>
    Promise.resolve({
      sub: "user-1",
      email: "user@example.com",
      name: "User One",
      collectives: [],
      groups: [],
    }),
  checkAdmission: () => ({ admitted: true, reason: "open" }),
  mintServerToken: () => Promise.resolve("minted-token.secret"),
  storeAccessToken: () => Promise.resolve(),
  clientSecret: "test-client-secret",
};

Deno.test({
  name:
    "serverLogin: the device flow runs against a prefixed serve address and keys the credential by it",
  ...testOptions,
  fn: async () => {
    const serve = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (req) => {
        // serve.ts answers /auth/info inline; this is its answer in oauth mode
        if (
          req.method === "GET" && new URL(req.url).pathname === "/auth/info"
        ) {
          return Response.json({
            mode: "oauth",
            verificationBaseUri: LOGIN_AUTH_CONFIG.oauthProvider,
          });
        }
        return (await handleDeviceAuth(req, LOGIN_DEPS)) ??
          new Response("not a serve route", { status: 404 });
      },
    );
    const forwarder = startPrefixForwarder(
      `http://127.0.0.1:${serve.addr.port}`,
    );
    try {
      const saved: ServerCredential[] = [];
      const kinds: string[] = [];
      for await (
        const event of serverLogin(
          {
            ...createServerLoginDeps(),
            openBrowser: () => Promise.resolve(true),
            saveCredential: (credential) => {
              saved.push(credential);
              return Promise.resolve();
            },
          },
          { serverUrl: forwarder.url, signal: AbortSignal.timeout(30_000) },
        )
      ) {
        kinds.push(event.kind);
        if (event.kind === "error") throw event.error;
      }
      assertEquals(kinds.at(-1), "completed");
      assertEquals(saved.length, 1);
      assertEquals(saved[0].serverUrl, normalizeServerUrl(forwarder.url));
      assertEquals(saved[0].token, "minted-token.secret");
      assertEquals(
        forwarder.seen.map((entry) => [entry.method, entry.path, entry.status]),
        [
          ["GET", `${PREFIX}/auth/info`, 200],
          ["POST", `${PREFIX}/auth/device`, 200],
          ["POST", `${PREFIX}/auth/device/token`, 200],
        ],
      );
    } finally {
      await forwarder.close();
      await serve.shutdown();
    }
  },
});

const CANCEL_ROUTE = /^\/api\/v1\/cancel\/(workflow-run|method-run)\/([^/]+)$/;

Deno.test({
  name:
    "sendServerCancel: a workflow cancel sent to a prefixed serve address reaches the run",
  ...testOptions,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const ctx = createServeCtx(repo);
      const cancelRegistry = new RunCancelRegistry();
      const runId = crypto.randomUUID();
      const run = new AbortController();
      cancelRegistry.register("workflow-run", runId, run);
      // serve's cancel route with auth off, where every caller is an admin
      const serve = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        async (req) => {
          const match = new URL(req.url).pathname.match(CANCEL_ROUTE);
          if (req.method !== "POST" || match === null) {
            return new Response("not a serve route", { status: 404 });
          }
          return await respondToRunCancel(
            ctx,
            {
              req,
              executionType: match[1] as "workflow-run" | "method-run",
              executionId: match[2],
              authority: "admin",
              caller: {
                principal: null,
                collectives: [],
                groups: [],
                sourceIp: "127.0.0.1",
              },
            },
            { cancelRegistry },
          );
        },
      );
      const forwarder = startPrefixForwarder(
        `http://127.0.0.1:${serve.addr.port}`,
      );
      try {
        const url = buildCancelUrl(forwarder.url, runId);
        const answer = await sendServerCancel(
          forwarder.url,
          runId,
          buildServerCancelRequest(url, undefined, "from behind a prefix"),
          undefined,
        );
        assertEquals(answer.status, "cancelled");
        assert(run.signal.aborted, "the run's abort fired");
        assertEquals(
          forwarder.seen.map((
            entry,
          ) => [entry.method, entry.path, entry.status]),
          [["POST", `${PREFIX}/api/v1/cancel/workflow-run/${runId}`, 200]],
        );
      } finally {
        await forwarder.close();
        await serve.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "ServeDatastoreClient: chunk writes and reads through a prefixed serve address stay under the prefix",
  ...testOptions,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const forwarder = startPrefixForwarder(new URL(server.url).origin);
      const client = new ServeDatastoreClient({
        baseUrl: forwarder.url,
        token: "alice-token",
      });
      try {
        const bytes = new TextEncoder().encode(
          `behind a prefix ${crypto.randomUUID()}`,
        );
        const sha = await sha256Hex(bytes);
        const signal = AbortSignal.timeout(30_000);
        await client.putChunk(sha, bytes, signal);
        assertEquals(await client.hasChunks([sha], signal), new Set([sha]));
        assertEquals(await client.getChunk(sha, signal), bytes);
        assert(forwarder.seen.length >= 3, "every call went to the forwarder");
        assertEquals(refused(forwarder.seen), []);
        for (const entry of forwarder.seen) {
          assert(
            entry.path.startsWith(`${PREFIX}/api/v1/datastore/_default/`),
            `${entry.method} ${entry.path} left the datastore route`,
          );
          assert(entry.status < 400, `${entry.path} answered ${entry.status}`);
        }
      } finally {
        client.close();
        await forwarder.close();
      }
    });
  },
});

Deno.test({
  name:
    "runWorker: a worker connected at a prefixed serve address keeps its control socket and data plane under the prefix",
  ...testOptions,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-prefix-worker-" });
    try {
      const orchestrator = await startOrchestrator(dir, { trustProxy: true });
      const forwarder = startPrefixForwarder(
        orchestrator.serverUrl.replace(/^ws:/, "http:"),
      );
      const workerStop = new AbortController();
      let workerDone: Promise<WorkerExitResult> | null = null;
      try {
        const token = await orchestrator.mintToken("prefix-worker");
        workerDone = runWorker({
          url: forwarder.url.replace(/^http:/, "ws:"),
          token,
          labels: { tier: "it" },
          swampVersion: "test",
          cacheDir: join(dir, "worker-cache"),
          signal: workerStop.signal,
          runnerCommand: TEST_RUNNER_COMMAND,
        });
        await waitFor(
          () => orchestrator.gateway.workers().length === 1,
          "worker enrollment",
        );

        const result = await orchestrator.dispatchService.executeRemote(
          remoteStepRequest({ methodArgs: { echo: "behind a prefix" } }),
        );
        assertEquals(
          result.outputs.map((o) => o.specName).sort(),
          ["log", "result"],
        );
        const content = await orchestrator.repoContext.unifiedDataRepo
          .getContent(IT_TYPE, IT_DEFINITION_ID, "result-main");
        assertEquals(
          JSON.parse(new TextDecoder().decode(content!)).echo,
          "behind a prefix",
        );

        assertEquals(refused(forwarder.seen), []);
        assert(
          forwarder.seen.some((entry) =>
            entry.upgrade && entry.path === PREFIX
          ),
          "the control socket opened under the prefix",
        );
        const dataPlane = forwarder.seen.filter((entry) => !entry.upgrade);
        assert(
          dataPlane.length > 0,
          "the data plane went through the forwarder",
        );
        for (const entry of dataPlane) {
          assert(
            entry.path.startsWith(`${PREFIX}/data/`) ||
              entry.path.startsWith(`${PREFIX}/bundle/`),
            `${entry.method} ${entry.path} is not a data-plane route`,
          );
          assert(entry.status < 400, `${entry.path} answered ${entry.status}`);
        }
      } finally {
        workerStop.abort();
        if (workerDone) await workerDone;
        await forwarder.close();
        await orchestrator.shutdown();
      }
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  },
});
