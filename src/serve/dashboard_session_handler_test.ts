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
import {
  dashboardSessionLimited,
  handleDashboardSession,
  resolveDashboardSessionForOrigin,
} from "./dashboard_session_handler.ts";
import { checkIpBurst, limitDashboardSessionGuesses } from "./rate_limiter.ts";
import { ControlPlaneDashboardSessionStore } from "./dashboard_session_store.ts";
import { DASHBOARD_SESSION_COOKIE } from "./token_auth.ts";
import {
  type DeviceAuthDeps,
  MAX_AUTH_BODY_BYTES,
} from "./device_auth_handler.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";

function createSessionStore(): ControlPlaneDashboardSessionStore {
  const records = new Map<string, Uint8Array>();
  const store: ControlPlaneStore = {
    put: (key, data) => {
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(records.get(key) ?? null),
    delete: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)),
      ),
  };
  return new ControlPlaneDashboardSessionStore(store);
}

function createDeps() {
  const ip = `session-${crypto.randomUUID()}`;
  return {
    ip,
    limitGuesses: <T extends { readonly ok: boolean }>(
      attempt: () => Promise<T>,
    ) => limitDashboardSessionGuesses(ip, attempt),
    secure: true,
    sessions: createSessionStore(),
    authenticateToken: (token: string) =>
      Promise.resolve(
        token === "admin.secret" || token === "oauth-operator.secret"
          ? {
            ok: true as const,
            tokenName: "admin",
            tokenCreatedAt: "2026-10-06T00:00:00.000Z",
          }
          : {
            ok: false as const,
            response: new Response("Unauthorized", { status: 401 }),
          },
      ),
    authenticateSession: (session: { tokenName: string }) =>
      Promise.resolve(
        session.tokenName === "admin"
          ? {
            ok: true as const,
            tokenName: "admin",
            tokenCreatedAt: "2026-10-06T00:00:00.000Z",
          }
          : {
            ok: false as const,
            response: new Response("Unauthorized", { status: 401 }),
          },
      ),
  };
}

const deviceAuthDeps: DeviceAuthDeps = {
  authConfig: {
    mode: "oauth",
    admins: [],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "https://swamp-club.test",
    oauthClientId: "dashboard-test",
    groupsField: "collectives",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
    signalRequiresExplicitGrant: false,
    tagRequiresExplicitGrant: false,
  },
  repoDir: "/test",
  repoContext: {} as RepositoryContext,
  clientSecret: "test-secret",
  startDeviceGrant: () =>
    Promise.resolve({
      deviceCode: "device-code",
      userCode: "CODE",
      verificationUri: "https://swamp-club.test/device",
      verificationUriComplete: "https://swamp-club.test/device?code=CODE",
      expiresIn: 60,
      interval: 5,
    }),
  pollForToken: () =>
    Promise.resolve({ accessToken: "provider-token", tokenType: "Bearer" }),
  getUserInfo: () =>
    Promise.resolve({
      sub: "operator",
      email: "operator@test",
      name: "Operator",
      collectives: [],
      groups: [],
    }),
  checkAdmission: () => ({ admitted: true, reason: "admitted" }),
  mintServerToken: () => Promise.resolve("oauth-operator.secret"),
  storeAccessToken: () => Promise.resolve(),
};

Deno.test("resolveDashboardSessionForOrigin: requires the origin that established the session", async () => {
  const sessions = createSessionStore();
  const session = await sessions.create({
    tokenName: "admin",
    tokenCreatedAt: "2026-10-06T00:00:00.000Z",
  }, "http://localhost:9090");
  assertEquals(
    await resolveDashboardSessionForOrigin(
      session.id,
      "http://localhost:9090",
      sessions,
    ),
    session,
  );
  assertEquals(
    await resolveDashboardSessionForOrigin(
      session.id,
      "http://localhost:3000",
      sessions,
    ),
    null,
  );
  assertEquals(
    await resolveDashboardSessionForOrigin(session.id, null, sessions),
    null,
  );
});

Deno.test("handleDashboardSession: creates an HttpOnly secure cookie", async () => {
  const deps = createDeps();
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  assertEquals(response?.status, 204);
  const cookie = response?.headers.get("set-cookie") ?? "";
  assertStringIncludes(cookie, `${DASHBOARD_SESSION_COOKIE}=`);
  assertEquals(cookie.includes("admin.secret"), false);
  assertStringIncludes(cookie, "HttpOnly");
  assertStringIncludes(cookie, "SameSite=Strict");
  assertStringIncludes(cookie, "Secure");
});

Deno.test("handleDashboardSession: rejects an invalid credential", async () => {
  const deps = createDeps();
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "invalid.secret" }),
    }),
    deps,
  );
  assertEquals(response?.status, 401);
});

Deno.test("handleDashboardSession: refuses a body over the cap with 413", async () => {
  const deps = createDeps();
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "x".repeat(MAX_AUTH_BODY_BYTES) }),
    }),
    deps,
  );
  assertEquals(response?.status, 413);
});

Deno.test("handleDashboardSession: rejects cross-origin session changes", async () => {
  const deps = createDeps();
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://attacker.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    { ...deps, originAllowed: () => false },
  );
  assertEquals(response?.status, 403);
});

Deno.test("handleDashboardSession: validates and clears a session", async () => {
  const deps = createDeps();
  const create = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  const cookie = create?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const get = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=admin.secret` },
    }),
    deps,
  );
  assertEquals(get?.status, 401);

  const restored = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: {
        cookie,
        "x-swamp-dashboard-origin": "https://serve.test",
      },
    }),
    deps,
  );
  assertEquals(restored?.status, 200);

  const del = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "DELETE",
      headers: { origin: "https://serve.test", cookie },
    }),
    deps,
  );
  assertEquals(del?.status, 204);
  assertStringIncludes(del?.headers.get("set-cookie") ?? "", "Max-Age=0");

  const afterLogout = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie },
    }),
    deps,
  );
  assertEquals(afterLogout?.status, 401);
});

Deno.test("handleDashboardSession: replaces the prior browser session on reauthentication", async () => {
  const deps = createDeps();
  const first = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  const firstCookie = first?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const second = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test", cookie: firstCookie },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  const secondCookie = second?.headers.get("set-cookie")?.split(";", 1)[0] ??
    "";

  const firstSession = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie: firstCookie },
    }),
    deps,
  );
  const secondSession = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: {
        cookie: secondCookie,
        "x-swamp-dashboard-origin": "https://serve.test",
      },
    }),
    deps,
  );
  assertEquals(firstSession?.status, 401);
  assertEquals(secondSession?.status, 200);
});

Deno.test("handleDashboardSession: requires the creating origin to restore a session", async () => {
  const deps = createDeps();
  const create = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  const cookie = create?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: {
        cookie,
        "x-swamp-dashboard-origin": "https://other.test",
      },
    }),
    deps,
  );

  assertEquals(response?.status, 401);
});

Deno.test("handleDashboardSession: preserves a session after a transient validation failure", async () => {
  const deps = createDeps();
  const create = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  const cookie = create?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  let rejectOnce = true;
  const transientDeps = {
    ...deps,
    authenticateSession: (session: { tokenName: string }) => {
      if (rejectOnce) {
        rejectOnce = false;
        return Promise.resolve({
          ok: false as const,
          response: new Response("Unavailable", { status: 503 }),
        });
      }
      return deps.authenticateSession(session);
    },
  };

  const first = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie, "x-swamp-dashboard-origin": "https://serve.test" },
    }),
    transientDeps,
  );
  const retry = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie, "x-swamp-dashboard-origin": "https://serve.test" },
    }),
    transientDeps,
  );

  assertEquals(first?.status, 503);
  assertEquals(retry?.status, 200);
});

Deno.test("handleDashboardSession: completes browser OAuth without returning its server token", async () => {
  const deps = createDeps();
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/device/token", {
      method: "POST",
      headers: { origin: "https://serve.test" },
      body: JSON.stringify({ deviceCode: "device-code" }),
    }),
    { ...deps, deviceAuthDeps },
  );
  assertEquals(response?.status, 204);
  assertStringIncludes(
    response?.headers.get("set-cookie") ?? "",
    `${DASHBOARD_SESSION_COOKIE}=`,
  );
  assertEquals(
    (response?.headers.get("set-cookie") ?? "").includes(
      "oauth-operator.secret",
    ),
    false,
  );
  assertEquals(await response?.text(), "");
});

const ORIGIN = "https://serve.test";

async function sessionCookie(
  deps: ReturnType<typeof createDeps>,
): Promise<string> {
  const create = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  assertEquals(create?.status, 204);
  return create?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function restoreStatus(
  deps: ReturnType<typeof createDeps>,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", { headers }),
    deps,
  );
  await response?.body?.cancel();
  return response?.status;
}

function unknownSessionCookie(): string {
  return `${DASHBOARD_SESSION_COOKIE}=${"0".repeat(64)}`;
}

async function guessUntilRefused(
  deps: ReturnType<typeof createDeps>,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < 51; i++) {
    statuses.push(
      (await restoreStatus(deps, {
        cookie: unknownSessionCookie(),
        "x-swamp-dashboard-origin": ORIGIN,
      }))!,
    );
  }
  return statuses;
}

Deno.test("handleDashboardSession: successful restores never count toward the IP's guesses", async () => {
  const deps = createDeps();
  const cookie = await sessionCookie(deps);
  for (let i = 0; i < 60; i++) {
    assertEquals(
      await restoreStatus(deps, {
        cookie,
        "x-swamp-dashboard-origin": ORIGIN,
      }),
      200,
    );
  }
});

Deno.test("handleDashboardSession: a full shared IP burst does not refuse a valid restore", async () => {
  const deps = createDeps();
  const cookie = await sessionCookie(deps);
  for (let i = 0; i < 51; i++) checkIpBurst(deps.ip);
  assertEquals(checkIpBurst(deps.ip).allowed, false);
  assertEquals(
    await restoreStatus(deps, { cookie, "x-swamp-dashboard-origin": ORIGIN }),
    200,
  );
});

Deno.test("handleDashboardSession: unknown sessions count, then a valid restore from that IP is refused 429", async () => {
  const deps = createDeps();
  const cookie = await sessionCookie(deps);
  const statuses = await guessUntilRefused(deps);
  assertEquals(statuses.slice(0, 50).every((status) => status === 401), true);
  assertEquals(statuses[50], 429);
  const refused = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie, "x-swamp-dashboard-origin": ORIGIN },
    }),
    deps,
  );
  assertEquals(refused?.status, 429);
  assertEquals(Number(refused?.headers.get("retry-after")) > 0, true);
  await refused?.body?.cancel();
});

Deno.test("handleDashboardSession: a refused restore keeps its session", async () => {
  const deps = createDeps();
  const cookie = await sessionCookie(deps);
  await guessUntilRefused(deps);
  assertEquals(
    await restoreStatus(deps, { cookie, "x-swamp-dashboard-origin": ORIGIN }),
    429,
  );
  const fresh = { ...createDeps(), sessions: deps.sessions };
  assertEquals(
    await restoreStatus(fresh, { cookie, "x-swamp-dashboard-origin": ORIGIN }),
    200,
  );
});

Deno.test("handleDashboardSession: a restore without a cookie is not a guess", async () => {
  const deps = createDeps();
  for (let i = 0; i < 60; i++) {
    assertEquals(await restoreStatus(deps, {}), 401);
  }
  const statuses = await guessUntilRefused(deps);
  assertEquals(statuses.slice(0, 50).every((status) => status === 401), true);
  assertEquals(statuses[50], 429);
});

Deno.test("handleDashboardSession: a known session from another origin is not a guess", async () => {
  const deps = createDeps();
  const cookie = await sessionCookie(deps);
  for (let i = 0; i < 60; i++) {
    assertEquals(
      await restoreStatus(deps, {
        cookie,
        "x-swamp-dashboard-origin": "https://other.test",
      }),
      401,
    );
  }
  assertEquals(
    await restoreStatus(deps, { cookie, "x-swamp-dashboard-origin": ORIGIN }),
    200,
  );
});

Deno.test("handleDashboardSession: failed exchanges count toward the IP's guesses and successful ones do not", async () => {
  const deps = createDeps();
  for (let i = 0; i < 60; i++) await sessionCookie(deps);
  const exchange = async (token: string) => {
    const response = await handleDashboardSession(
      new Request("https://serve.test/auth/dashboard/session", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: JSON.stringify({ token }),
      }),
      deps,
    );
    await response?.body?.cancel();
    return response?.status;
  };
  for (let i = 0; i < 50; i++) {
    assertEquals(await exchange("invalid.secret"), 401);
  }
  assertEquals(await exchange("invalid.secret"), 429);
  assertEquals(await exchange("admin.secret"), 429);
});

Deno.test("handleDashboardSession: an exchange refused by a rate limit creates no session and is not a guess", async () => {
  const deps = {
    ...createDeps(),
    authenticateToken: () => Promise.resolve(dashboardSessionLimited(7)),
  };
  for (let i = 0; i < 60; i++) {
    const response = await handleDashboardSession(
      new Request("https://serve.test/auth/dashboard/session", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: JSON.stringify({ token: "admin.secret" }),
      }),
      deps,
    );
    assertEquals(response?.status, 429);
    assertEquals(response?.headers.get("retry-after"), "7");
    assertEquals(response?.headers.get("set-cookie"), null);
    await response?.body?.cancel();
  }
  const statuses = await guessUntilRefused(deps);
  assertEquals(statuses[49], 401);
});

Deno.test("handleDashboardSession: browser OAuth does not go through the guess limit", async () => {
  const deps = {
    ...createDeps(),
    deviceAuthDeps,
    limitGuesses: () => {
      throw new Error("device paths must not spend guesses");
    },
  };
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/device/token", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ deviceCode: "device-code" }),
    }),
    deps,
  );
  assertEquals(response?.status, 204);
});
