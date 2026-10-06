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
  handleDashboardSession,
  InMemoryDashboardSessionStore,
  resolveDashboardSessionForOrigin,
} from "./dashboard_session_handler.ts";
import { DASHBOARD_SESSION_COOKIE } from "./token_auth.ts";
import type { DeviceAuthDeps } from "./device_auth_handler.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

function createDeps() {
  return {
    secure: true,
    sessions: new InMemoryDashboardSessionStore(),
    authenticate: (token: string) =>
      Promise.resolve(
        token === "admin.secret" || token === "oauth-operator.secret"
          ? { ok: true as const }
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

Deno.test("resolveDashboardSessionForOrigin: requires the origin that established the session", () => {
  const sessions = new InMemoryDashboardSessionStore();
  const sessionId = sessions.create("admin.secret", "http://localhost:9090");
  assertEquals(
    resolveDashboardSessionForOrigin(
      sessionId,
      "http://localhost:9090",
      sessions,
    ),
    "admin.secret",
  );
  assertEquals(
    resolveDashboardSessionForOrigin(
      sessionId,
      "http://localhost:3000",
      sessions,
    ),
    null,
  );
  assertEquals(
    resolveDashboardSessionForOrigin(sessionId, null, sessions),
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
      headers: { cookie },
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
      headers: { cookie: secondCookie },
    }),
    deps,
  );
  assertEquals(firstSession?.status, 401);
  assertEquals(secondSession?.status, 200);
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
