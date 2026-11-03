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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import { MAX_ACTIVE_REQUESTS } from "./connection.ts";
import {
  closeConnectionsForPrincipal,
  type ConnectionContext,
  send,
} from "./handlers/shared.ts";
import {
  handleHttpRequest,
  type HttpRequestRouteDeps,
} from "./http_request_route.ts";
import { MAX_HTTP_REQUEST_BODY_BYTES } from "./protocol.ts";
import type { DashboardSession } from "./dashboard_session_store.ts";
import {
  DASHBOARD_SESSION_COOKIE,
  type ServerTokenAuthResult,
} from "./token_auth.ts";

function authConfig(mode: "none" | "token"): ServeAuthConfig {
  return {
    mode,
    admins: [],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "",
    groupsField: "",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
    signalRequiresExplicitGrant: false,
    tagRequiresExplicitGrant: false,
  };
}

function ctxOf(
  mode: "none" | "token",
  extra: Partial<ConnectionContext> = {},
): ConnectionContext {
  return { authConfig: authConfig(mode), ...extra } as ConnectionContext;
}

function tokenFor(principalId: string): ServerTokenAuthResult {
  return {
    ok: true,
    principalId,
    collectives: [],
    groups: [],
    tokenName: `token-${principalId}`,
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function post(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://serve.test/api/v1/request", {
    method: "POST",
    headers: { authorization: "Bearer test-token", ...headers },
    body,
  });
}

function dataGet(id: string): string {
  return JSON.stringify({
    type: "data.get",
    id,
    payload: { modelIdOrName: "m", dataName: "d" },
  });
}

function deps(
  ctx: ConnectionContext,
  overrides: Partial<HttpRequestRouteDeps> = {},
): HttpRequestRouteDeps {
  return {
    ctx,
    authenticate: () =>
      Promise.resolve(tokenFor(`user:${crypto.randomUUID()}`)),
    ...overrides,
  };
}

async function linesOf(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function uniqueIp(): string {
  return `ip-${crypto.randomUUID()}`;
}

Deno.test("handleHttpRequest: only POST is answered", async () => {
  const response = await handleHttpRequest(
    new Request("http://serve.test/api/v1/request"),
    uniqueIp(),
    deps(ctxOf("none")),
  );
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "POST");
});

Deno.test("handleHttpRequest: a token-mode request without a bearer token is refused with 401", async () => {
  const response = await handleHttpRequest(
    new Request("http://serve.test/api/v1/request", {
      method: "POST",
      body: dataGet("r"),
    }),
    uniqueIp(),
    deps(ctxOf("token")),
  );
  assertEquals(response.status, 401);
});

Deno.test("handleHttpRequest: a body over the cap is refused with 413", async () => {
  const response = await handleHttpRequest(
    post("x".repeat(MAX_HTTP_REQUEST_BODY_BYTES + 1)),
    uniqueIp(),
    deps(ctxOf("token")),
  );
  assertEquals(response.status, 413);
});

Deno.test("handleHttpRequest: a body that is not JSON is refused with 400", async () => {
  const response = await handleHttpRequest(
    post("{not json"),
    uniqueIp(),
    deps(ctxOf("token")),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "invalid_request");
});

Deno.test("handleHttpRequest: a request type outside the allowlist is refused and pointed at the WebSocket", async () => {
  let dispatched = false;
  const response = await handleHttpRequest(
    post(JSON.stringify({ type: "access.reload", id: "r" })),
    uniqueIp(),
    deps(ctxOf("token"), {
      dispatch: () => {
        dispatched = true;
        return undefined;
      },
    }),
  );
  assertEquals(response.status, 404);
  const refusal = await response.json();
  assertEquals(refusal.code, "use_websocket");
  assertStringIncludes(refusal.message, "WebSocket");
  assertEquals(dispatched, false);
});

Deno.test("handleHttpRequest: a follower with a stale copy refuses with the retryable 503", async () => {
  const response = await handleHttpRequest(
    post(dataGet("r")),
    uniqueIp(),
    deps(
      ctxOf("token", {
        followerGate: {
          role: "follower",
          leader: () => undefined,
          isStale: () => true,
        },
      }),
    ),
  );
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "serve_not_leader");
});

Deno.test("handleHttpRequest: every frame the request answers with is one NDJSON line, in order", async () => {
  const response = await handleHttpRequest(
    post(dataGet("r1")),
    uniqueIp(),
    deps(ctxOf("token"), {
      dispatch: (socket) => {
        send(socket, {
          type: "event",
          id: "r1",
          event: { kind: "resolving" },
        });
        send(socket, {
          type: "data.get",
          id: "r1",
          payload: { data: { name: "d" } },
        });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/x-ndjson");
  const lines = await linesOf(response);
  assertEquals(lines.map((line) => line.type), ["event", "data.get"]);
});

Deno.test("handleHttpRequest: a reply over the WebSocket frame limit is delivered whole", async () => {
  const content = "x".repeat(64 * 1024 * 1024);
  const response = await handleHttpRequest(
    post(dataGet("big")),
    uniqueIp(),
    deps(ctxOf("token"), {
      dispatch: (socket) => {
        send(socket, {
          type: "data.get",
          id: "big",
          payload: { data: { content } },
        });
        return Promise.resolve();
      },
    }),
  );

  const [reply] = await linesOf(response);
  assertEquals(reply.type, "data.get");
  const payload = reply.payload as { data: { content: string } };
  assertEquals(payload.data.content.length, content.length);
});

Deno.test("handleHttpRequest: a client that accepts gzip gets a gzip body", async () => {
  const response = await handleHttpRequest(
    post(dataGet("gz"), { "accept-encoding": "gzip, br" }),
    uniqueIp(),
    deps(ctxOf("token"), {
      dispatch: (socket) => {
        send(socket, {
          type: "data.get",
          id: "gz",
          payload: { data: { content: "y".repeat(100_000) } },
        });
        return Promise.resolve();
      },
    }),
  );

  assertEquals(response.headers.get("content-encoding"), "gzip");
  const text = await new Response(
    response.body!.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assertEquals(JSON.parse(text.trim()).id, "gz");
});

Deno.test("handleHttpRequest: concurrent requests are capped per principal", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const release = Promise.withResolvers<void>();
  const routeDeps = deps(ctxOf("token"), {
    authenticate: () => Promise.resolve(tokenFor(principalId)),
    dispatch: () => release.promise,
  });
  const held: Response[] = [];
  for (let i = 0; i < MAX_ACTIVE_REQUESTS; i++) {
    held.push(
      await handleHttpRequest(post(dataGet(`r${i}`)), uniqueIp(), routeDeps),
    );
  }

  const refused = await handleHttpRequest(
    post(dataGet("over")),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(refused.status, 429);
  assertEquals((await refused.json()).code, "use_websocket");

  release.resolve();
  for (const response of held) await response.body?.cancel();
  await waitFor(async () => {
    const again = await handleHttpRequest(
      post(dataGet("after")),
      uniqueIp(),
      deps(ctxOf("token"), {
        authenticate: () => Promise.resolve(tokenFor(principalId)),
        dispatch: () => Promise.resolve(),
      }),
    );
    await again.body?.cancel();
    return again.status === 200;
  }, "the principal's slots were released");
});

function abortableDispatch(
  aborted: PromiseWithResolvers<void>,
): HttpRequestRouteDeps["dispatch"] {
  return (_socket, _ctx, activeRequests) => {
    const controller = new AbortController();
    activeRequests.set("r", controller);
    return new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        aborted.resolve();
        resolve();
      });
    });
  };
}

Deno.test("handleHttpRequest: a client that disconnects aborts its request", async () => {
  const aborted = Promise.withResolvers<void>();
  const response = await handleHttpRequest(
    post(dataGet("r")),
    uniqueIp(),
    deps(ctxOf("token"), { dispatch: abortableDispatch(aborted) }),
  );

  await response.body!.cancel();
  await aborted.promise;
});

Deno.test("handleHttpRequest: revoking the caller's principal aborts its request", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const aborted = Promise.withResolvers<void>();
  const response = await handleHttpRequest(
    post(dataGet("r")),
    uniqueIp(),
    deps(ctxOf("token"), {
      authenticate: () => Promise.resolve(tokenFor(principalId)),
      dispatch: abortableDispatch(aborted),
    }),
  );

  closeConnectionsForPrincipal(principalId);
  await aborted.promise;
  await response.body?.cancel();
});

Deno.test("handleHttpRequest: the real request path answers into the HTTP reply channel", async () => {
  const snapshot = new PolicySnapshot([], []);
  const ctx = ctxOf("token", {
    policySnapshotLoader: {
      snapshot,
      decisionService: new GrantBasedAccessDecisionService(snapshot),
    } as unknown as PolicySnapshotLoader,
    repoContext: {
      definitionRepo: {
        findByNameGlobal: () => Promise.resolve(null),
        findById: () => Promise.resolve(null),
      },
    } as unknown as ConnectionContext["repoContext"],
  });

  const response = await handleHttpRequest(
    post(dataGet("real")),
    uniqueIp(),
    deps(ctx),
  );

  const lines = await linesOf(response);
  assertEquals(lines.length, 1);
  assertEquals([lines[0].type, lines[0].id], ["error", "real"]);
});

Deno.test("handleHttpRequest: anonymous callers are counted per source IP", async () => {
  const release = Promise.withResolvers<void>();
  const busyIp = uniqueIp();
  const held: Response[] = [];
  const routeDeps = deps(ctxOf("none"), { dispatch: () => release.promise });
  for (let i = 0; i < MAX_ACTIVE_REQUESTS; i++) {
    held.push(
      await handleHttpRequest(post(dataGet(`a${i}`)), busyIp, routeDeps),
    );
  }

  const sameIp = await handleHttpRequest(post(dataGet("x")), busyIp, routeDeps);
  const otherIp = await handleHttpRequest(
    post(dataGet("y")),
    uniqueIp(),
    deps(ctxOf("none"), { dispatch: () => Promise.resolve() }),
  );

  assertEquals(sameIp.status, 429);
  assertEquals(otherIp.status, 200);
  await otherIp.body?.cancel();
  release.resolve();
  for (const response of held) await response.body?.cancel();
});

Deno.test("handleHttpRequest: reads are not held to the per-principal request rate", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const routeDeps = deps(ctxOf("token"), {
    authenticate: () => Promise.resolve(tokenFor(principalId)),
    dispatch: () => Promise.resolve(),
    now: () => 0,
  });
  for (let i = 0; i < 250; i++) {
    const response = await handleHttpRequest(
      post(dataGet(`r${i}`)),
      uniqueIp(),
      routeDeps,
    );
    await response.body?.cancel();
    assertEquals(response.status, 200, `request ${i}`);
  }
});

Deno.test("handleHttpRequest: a reply that is not read keeps its slot until it is read to the end", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const routeDeps = deps(ctxOf("token"), {
    authenticate: () => Promise.resolve(tokenFor(principalId)),
    dispatch: (socket, _ctx, _active, event) => {
      const { id } = JSON.parse(String(event.data));
      send(socket, {
        type: "data.get",
        id,
        payload: { data: { content: "x".repeat(1024) } },
      });
      return Promise.resolve();
    },
  });
  const unread: Response[] = [];
  for (let i = 0; i < MAX_ACTIVE_REQUESTS; i++) {
    unread.push(
      await handleHttpRequest(post(dataGet(`u${i}`)), uniqueIp(), routeDeps),
    );
  }

  const refused = await handleHttpRequest(
    post(dataGet("over")),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(refused.status, 429);
  assertEquals((await refused.json()).code, "use_websocket");

  for (const response of unread) {
    const [reply] = await linesOf(response);
    assertEquals(reply.type, "data.get");
  }
  const after = await handleHttpRequest(
    post(dataGet("after")),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(after.status, 200);
  await after.body?.cancel();
});

Deno.test("handleHttpRequest: a gzip reply also keeps its slot until it is read", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const routeDeps = deps(ctxOf("token"), {
    authenticate: () => Promise.resolve(tokenFor(principalId)),
    dispatch: (socket, _ctx, _active, event) => {
      const { id } = JSON.parse(String(event.data));
      send(socket, { type: "data.get", id, payload: { data: {} } });
      return Promise.resolve();
    },
  });
  const unread: Response[] = [];
  for (let i = 0; i < MAX_ACTIVE_REQUESTS; i++) {
    unread.push(
      await handleHttpRequest(
        post(dataGet(`g${i}`), { "accept-encoding": "gzip" }),
        uniqueIp(),
        routeDeps,
      ),
    );
  }

  const refused = await handleHttpRequest(
    post(dataGet("over"), { "accept-encoding": "gzip" }),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(refused.status, 429);

  for (const response of unread) await response.body?.cancel();
  const after = await handleHttpRequest(
    post(dataGet("after")),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(after.status, 200);
  await after.body?.cancel();
});

Deno.test("handleHttpRequest: the dashboard's session cookie from its own origin is answered as its token's caller", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const session: DashboardSession = {
    id: "a".repeat(64),
    tokenName: "laptop",
    tokenCreatedAt: "2026-11-01T00:00:00.000Z",
    origin: "https://serve.test",
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  };
  let principal: unknown;
  const routeDeps = deps(ctxOf("token"), {
    authenticate: () =>
      Promise.reject(new Error("a cookie caller presents no bearer token")),
    dashboardSession: {
      sessions: {
        create: () => Promise.reject(new Error("not used")),
        get: (id) => Promise.resolve(id === session.id ? session : null),
        delete: () => Promise.resolve(),
      },
      authenticate: () => Promise.resolve(tokenFor(principalId)),
    },
    dispatch: (socket, _ctx, _active, _event, callerPrincipal) => {
      principal = callerPrincipal;
      send(socket, {
        type: "data.get",
        id: "r1",
        payload: { data: { name: "d" } },
      });
      return Promise.resolve();
    },
  });
  const request = (origin: string) =>
    new Request("https://serve.test/api/v1/request", {
      method: "POST",
      headers: {
        cookie: `${DASHBOARD_SESSION_COOKIE}=${session.id}`,
        origin,
      },
      body: dataGet("r1"),
    });

  const answered = await handleHttpRequest(
    request("https://serve.test"),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(answered.status, 200);
  assertEquals((await linesOf(answered))[0].payload, { data: { name: "d" } });
  assertEquals(principal, parsePrincipal(principalId));

  const crossOrigin = await handleHttpRequest(
    request("https://evil.test"),
    uniqueIp(),
    routeDeps,
  );
  assertEquals(crossOrigin.status, 403);
  await crossOrigin.body?.cancel();
});
