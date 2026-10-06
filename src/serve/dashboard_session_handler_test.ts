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
import { handleDashboardSession } from "./dashboard_session_handler.ts";
import { DASHBOARD_SESSION_COOKIE } from "./token_auth.ts";
import type { DeviceAuthDeps } from "./device_auth_handler.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

const deps = {
  secure: true,
  authenticate: (token: string) => Promise.resolve(token === "admin.secret"),
};

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

Deno.test("handleDashboardSession: creates an HttpOnly secure cookie", async () => {
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      body: JSON.stringify({ token: "admin.secret" }),
    }),
    deps,
  );
  assertEquals(response?.status, 204);
  const cookie = response?.headers.get("set-cookie") ?? "";
  assertStringIncludes(cookie, `${DASHBOARD_SESSION_COOKIE}=admin.secret`);
  assertStringIncludes(cookie, "HttpOnly");
  assertStringIncludes(cookie, "SameSite=Strict");
  assertStringIncludes(cookie, "Secure");
});

Deno.test("handleDashboardSession: rejects an invalid credential", async () => {
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "POST",
      body: JSON.stringify({ token: "invalid.secret" }),
    }),
    deps,
  );
  assertEquals(response?.status, 401);
});

Deno.test("handleDashboardSession: rejects cross-origin session changes", async () => {
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
  const get = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=admin.secret` },
    }),
    deps,
  );
  assertEquals(get?.status, 200);

  const del = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/session", {
      method: "DELETE",
    }),
    deps,
  );
  assertEquals(del?.status, 204);
  assertStringIncludes(del?.headers.get("set-cookie") ?? "", "Max-Age=0");
});

Deno.test("handleDashboardSession: completes browser OAuth without returning its server token", async () => {
  const response = await handleDashboardSession(
    new Request("https://serve.test/auth/dashboard/device/token", {
      method: "POST",
      body: JSON.stringify({ deviceCode: "device-code" }),
    }),
    { ...deps, deviceAuthDeps },
  );
  assertEquals(response?.status, 204);
  assertStringIncludes(
    response?.headers.get("set-cookie") ?? "",
    `${DASHBOARD_SESSION_COOKIE}=oauth-operator.secret`,
  );
  assertEquals(await response?.text(), "");
});
