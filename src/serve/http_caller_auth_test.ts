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

import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  ANONYMOUS_PRINCIPAL,
  authenticateHttpCaller,
  bearerToken,
  type HttpCaller,
  type HttpCallerSessionAuth,
} from "./http_caller_auth.ts";
import type {
  DashboardSession,
  DashboardSessionStore,
} from "./dashboard_session_store.ts";
import {
  DASHBOARD_SESSION_COOKIE,
  type ServerTokenAuthResult,
} from "./token_auth.ts";
import { checkIpBurst, resetRateLimitState } from "./rate_limiter.ts";

function request(authorization?: string): Request {
  return new Request("http://serve.test/api/v1/request", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

const validToken: ServerTokenAuthResult = {
  ok: true,
  principalId: "user:adam",
  collectives: ["acme"],
  groups: ["ops"],
  tokenName: "laptop",
  tokenCreatedAt: "2026-11-01T00:00:00.000Z",
};

function uniqueIp(): string {
  return `ip-${crypto.randomUUID()}`;
}

Deno.test("authenticateHttpCaller: auth mode none gives the anonymous caller without asking for a token", async () => {
  let asked = false;
  const caller = await authenticateHttpCaller(request(), "10.0.0.1", {
    authMode: "none",
    authenticate: () => {
      asked = true;
      return Promise.resolve(validToken);
    },
  });

  assertEquals(asked, false);
  assertEquals((caller as HttpCaller).principal, ANONYMOUS_PRINCIPAL);
  assertEquals((caller as HttpCaller).access.principal, null);
  assertEquals((caller as HttpCaller).token, undefined);
});

Deno.test("authenticateHttpCaller: a request without a bearer token is refused with 401", async () => {
  const response = await authenticateHttpCaller(
    request("Basic dXNlcjpwYXNz"),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: () => Promise.resolve(validToken),
    },
  );

  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, "unauthorized");
});

Deno.test("authenticateHttpCaller: a token the server rejects is refused with 401 naming the reason", async () => {
  const response = await authenticateHttpCaller(
    request(`Bearer ${crypto.randomUUID()}`),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: () =>
        Promise.resolve({ ok: false, error: "gone", reason: "revoked" }),
    },
  );

  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).message, "Unauthorized: revoked");
});

Deno.test("authenticateHttpCaller: a valid token gives its principal, memberships and token identity", async () => {
  const token = crypto.randomUUID();
  let presented = "";
  const sourceIp = uniqueIp();
  const caller = await authenticateHttpCaller(
    request(`Bearer ${token}`),
    sourceIp,
    {
      authMode: "token",
      authenticate: (value) => {
        presented = value;
        return Promise.resolve(validToken);
      },
    },
  );

  assertEquals(presented, token);
  const authenticated = caller as HttpCaller;
  assertEquals(authenticated.principal, "user:adam");
  assertEquals(authenticated.access.collectives, ["acme"]);
  assertEquals(authenticated.access.groups, ["ops"]);
  assertEquals(authenticated.access.sourceIp, sourceIp);
  assertEquals(authenticated.token, {
    name: "laptop",
    createdAt: "2026-11-01T00:00:00.000Z",
    principalId: "user:adam",
  });
});

Deno.test("bearerToken: reads only a non-empty Bearer credential, case-insensitively", () => {
  assertEquals(bearerToken(request("bearer abc")), "abc");
  assertEquals(bearerToken(request("Bearer ")), null);
  assertEquals(bearerToken(request("Token abc")), null);
  assertEquals(bearerToken(request()), null);
});

Deno.test("authenticateHttpCaller: repeated failures with one token are rate-limited with 429 and Retry-After", async () => {
  const token = `Bearer ${crypto.randomUUID()}`;
  const sourceIp = uniqueIp();
  const deps = {
    authMode: "token",
    authenticate: (): Promise<ServerTokenAuthResult> =>
      Promise.resolve({ ok: false, error: "bad", reason: "secret-mismatch" }),
  };
  let last: HttpCaller | Response | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    last = await authenticateHttpCaller(request(token), sourceIp, deps);
    if (last instanceof Response && last.status === 429) break;
  }

  assertInstanceOf(last, Response);
  assertEquals(last.status, 429);
  assertEquals(last.headers.get("Retry-After") !== null, true);
});

Deno.test("authenticateHttpCaller: concurrent requests on one valid bearer token are all accepted", async () => {
  const token = `Bearer ${crypto.randomUUID()}.secret`;
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const deps = {
    authMode: "token",
    authenticate: async (): Promise<ServerTokenAuthResult> => {
      await released;
      return validToken;
    },
    limitPrincipalRate: false,
  };
  const reads = Array.from(
    { length: 20 },
    () => authenticateHttpCaller(request(token), uniqueIp(), deps),
  );
  release();
  for (const result of await Promise.all(reads)) {
    assertEquals(result instanceof Response, false);
  }
});

Deno.test("authenticateHttpCaller: limitPrincipalRate false leaves the per-principal rate unchecked", async () => {
  const principalId = `user:${crypto.randomUUID()}`;
  const authenticate = () =>
    Promise.resolve({ ...validToken, principalId } as ServerTokenAuthResult);
  let limited = false;
  for (let i = 0; i < 250 && !limited; i++) {
    const result = await authenticateHttpCaller(
      request(`Bearer ${crypto.randomUUID()}`),
      uniqueIp(),
      { authMode: "token", authenticate, now: () => 0 },
    );
    limited = result instanceof Response && result.status === 429;
  }
  assertEquals(limited, true, "the default applies the principal rate");

  const unlimitedPrincipal = `user:${crypto.randomUUID()}`;
  for (let i = 0; i < 250; i++) {
    const result = await authenticateHttpCaller(
      request(`Bearer ${crypto.randomUUID()}`),
      uniqueIp(),
      {
        authMode: "token",
        authenticate: () =>
          Promise.resolve(
            {
              ...validToken,
              principalId: unlimitedPrincipal,
            } as ServerTokenAuthResult,
          ),
        now: () => 0,
        limitPrincipalRate: false,
      },
    );
    assertEquals(result instanceof Response, false, `request ${i}`);
  }
});

const DASHBOARD_ORIGIN = "https://serve.test";

function sessionStore(): DashboardSessionStore & {
  sessions: Map<string, DashboardSession>;
  add(tokenName?: string): DashboardSession;
} {
  const sessions = new Map<string, DashboardSession>();
  return {
    sessions,
    add(tokenName = "laptop") {
      const id = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
      const session: DashboardSession = {
        id,
        tokenName,
        tokenCreatedAt: "2026-11-01T00:00:00.000Z",
        origin: DASHBOARD_ORIGIN,
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-02T00:00:00.000Z",
      };
      sessions.set(id, session);
      return session;
    },
    create: () => Promise.reject(new Error("not used")),
    get: (id) => Promise.resolve(sessions.get(id) ?? null),
    delete: (id) => {
      sessions.delete(id);
      return Promise.resolve();
    },
  };
}

function cookieRequest(sessionId: string, origin?: string): Request {
  const headers: Record<string, string> = {
    cookie: `${DASHBOARD_SESSION_COOKIE}=${sessionId}`,
  };
  if (origin !== undefined) headers.origin = origin;
  return new Request("https://serve.test/api/v1/request", {
    method: "POST",
    headers,
  });
}

function sessionAuth(
  sessions: DashboardSessionStore,
  result: ServerTokenAuthResult = validToken,
): HttpCallerSessionAuth & { asked: DashboardSession[] } {
  const asked: DashboardSession[] = [];
  return {
    asked,
    sessions,
    authenticate: (session) => {
      asked.push(session);
      return Promise.resolve(result);
    },
  };
}

function rejectBearer(): Promise<ServerTokenAuthResult> {
  return Promise.reject(new Error("a session caller presents no bearer token"));
}

Deno.test("authenticateHttpCaller: a dashboard session from its own origin gives the session token's caller", async () => {
  const store = sessionStore();
  const session = store.add();
  const auth = sessionAuth(store);
  const caller = await authenticateHttpCaller(
    cookieRequest(session.id, DASHBOARD_ORIGIN),
    uniqueIp(),
    { authMode: "token", authenticate: rejectBearer, dashboardSession: auth },
  );

  assertEquals(auth.asked, [session]);
  assertEquals((caller as HttpCaller).principal, "user:adam");
  assertEquals((caller as HttpCaller).token?.name, "laptop");
});

Deno.test("authenticateHttpCaller: a dashboard session is refused without an Origin header or from another origin", async () => {
  const store = sessionStore();
  const session = store.add();
  const auth = sessionAuth(store);
  for (
    const origin of [
      undefined,
      "https://evil.test",
      "https://serve.test:8443",
      "http://serve.test",
    ]
  ) {
    const response = await authenticateHttpCaller(
      cookieRequest(session.id, origin),
      uniqueIp(),
      { authMode: "token", authenticate: rejectBearer, dashboardSession: auth },
    );
    assertInstanceOf(response, Response);
    assertEquals(response.status, 403, `origin ${origin}`);
    assertEquals((await response.json()).code, "forbidden");
  }
  assertEquals(auth.asked, []);
});

Deno.test("authenticateHttpCaller: an unknown dashboard session is refused with 401", async () => {
  const store = sessionStore();
  const response = await authenticateHttpCaller(
    cookieRequest("f".repeat(64), DASHBOARD_ORIGIN),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: rejectBearer,
      dashboardSession: sessionAuth(store),
    },
  );
  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals(
    (await response.json()).message,
    "Unauthorized: dashboard session expired",
  );
});

Deno.test("authenticateHttpCaller: a session whose token was revoked is refused and deleted", async () => {
  resetRateLimitState();
  const store = sessionStore();
  const session = store.add();
  const response = await authenticateHttpCaller(
    cookieRequest(session.id, DASHBOARD_ORIGIN),
    uniqueIp(),
    {
      authMode: "token",
      authenticate: rejectBearer,
      dashboardSession: sessionAuth(store, {
        ok: false,
        error: "revoked",
        reason: "revoked",
      }),
    },
  );
  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals(store.sessions.has(session.id), false);
});

Deno.test("authenticateHttpCaller: failed dashboard session attempts count toward the IP burst", async () => {
  const store = sessionStore();
  const sourceIp = uniqueIp();
  let last: HttpCaller | Response | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await authenticateHttpCaller(
      cookieRequest(crypto.randomUUID(), DASHBOARD_ORIGIN),
      sourceIp,
      {
        authMode: "token",
        authenticate: rejectBearer,
        dashboardSession: sessionAuth(store),
      },
    );
    if (last instanceof Response && last.status === 429) break;
  }
  assertInstanceOf(last, Response);
  assertEquals(last.status, 429);
});

Deno.test("authenticateHttpCaller: a session from another origin does not count toward the IP burst", async () => {
  const store = sessionStore();
  const session = store.add();
  const sourceIp = uniqueIp();
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await authenticateHttpCaller(
      cookieRequest(session.id, "https://evil.test"),
      sourceIp,
      {
        authMode: "token",
        authenticate: rejectBearer,
        dashboardSession: sessionAuth(store),
      },
    );
    assertInstanceOf(response, Response);
    assertEquals(response.status, 403, `attempt ${attempt}`);
    await response.body?.cancel();
  }
});

Deno.test("authenticateHttpCaller: concurrent reads on one session token are all accepted", async () => {
  const store = sessionStore();
  const tokenName = `tab-${crypto.randomUUID()}`;
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const auth: HttpCallerSessionAuth = {
    sessions: store,
    authenticate: async () => {
      await released;
      return validToken;
    },
  };
  const reads = Array.from({ length: 20 }, () =>
    authenticateHttpCaller(
      cookieRequest(store.add(tokenName).id, DASHBOARD_ORIGIN),
      uniqueIp(),
      {
        authMode: "token",
        authenticate: rejectBearer,
        dashboardSession: auth,
        limitPrincipalRate: false,
      },
    ));
  release();
  for (const result of await Promise.all(reads)) {
    assertEquals(result instanceof Response, false);
  }
});

Deno.test("authenticateHttpCaller: repeated failed session authentications on one token are rate-limited", async () => {
  const store = sessionStore();
  const tokenName = `revoked-${crypto.randomUUID()}`;
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await authenticateHttpCaller(
      cookieRequest(store.add(tokenName).id, DASHBOARD_ORIGIN),
      uniqueIp(),
      {
        authMode: "token",
        authenticate: rejectBearer,
        dashboardSession: sessionAuth(store, {
          ok: false,
          error: "revoked",
          reason: "revoked",
        }),
      },
    );
    assertInstanceOf(response, Response);
    statuses.push(response.status);
    await response.body?.cancel();
  }
  assertEquals(statuses, [401, 401, 401, 401, 401, 429, 429]);
});

Deno.test("authenticateHttpCaller: without the session dep a dashboard cookie is not a credential", async () => {
  const store = sessionStore();
  const session = store.add();
  const response = await authenticateHttpCaller(
    cookieRequest(session.id, DASHBOARD_ORIGIN),
    uniqueIp(),
    { authMode: "token", authenticate: rejectBearer },
  );
  assertInstanceOf(response, Response);
  assertEquals(response.status, 401);
  assertEquals(
    (await response.json()).message,
    "Unauthorized: token required",
  );
});

Deno.test("authenticateHttpCaller: a bearer token wins over a dashboard cookie", async () => {
  const store = sessionStore();
  const session = store.add();
  const auth = sessionAuth(store);
  const req = new Request("https://serve.test/api/v1/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${crypto.randomUUID()}`,
      cookie: `${DASHBOARD_SESSION_COOKIE}=${session.id}`,
      origin: DASHBOARD_ORIGIN,
    },
  });
  const caller = await authenticateHttpCaller(req, uniqueIp(), {
    authMode: "token",
    authenticate: () => Promise.resolve(validToken),
    dashboardSession: auth,
  });
  assertEquals((caller as HttpCaller).principal, "user:adam");
  assertEquals(auth.asked, []);
});

Deno.test("authenticateHttpCaller: a request that presents no credential does not count toward the IP burst", async () => {
  const ip = uniqueIp();
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await authenticateHttpCaller(request(), ip, {
      authMode: "token",
      authenticate: () => Promise.resolve(validToken),
    });
    assertInstanceOf(response, Response);
    assertEquals(response.status, 401);
    await response.body?.cancel();
  }
  assertEquals(checkIpBurst(ip).allowed, true);
});
