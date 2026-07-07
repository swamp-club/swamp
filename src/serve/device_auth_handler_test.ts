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

import { assertEquals } from "@std/assert";
import {
  type DeviceAuthDeps,
  handleDeviceAuth,
} from "./device_auth_handler.ts";
import { DeviceGrantPollError } from "./oauth_client.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

function makeMockDeps(
  overrides: Partial<DeviceAuthDeps> = {},
): DeviceAuthDeps {
  return {
    authConfig: {
      mode: "oauth",
      admins: ["user:admin"],
      allowedCollectives: ["team-a"],
      allowedUsers: ["user-1"],
      oauthProvider: "https://auth.example.com",
      oauthClientId: "test-client-id",
      groupsField: "collectives",
    },
    repoDir: "/tmp/test-repo",
    repoContext: {} as RepositoryContext,
    clientSecret: "test-client-secret",
    startDeviceGrant: (_providerUrl, _clientId, _signal) =>
      Promise.resolve({
        deviceCode: "dev-code-123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.com/device",
        verificationUriComplete:
          "https://auth.example.com/device?code=ABCD-EFGH",
        expiresIn: 900,
        interval: 5,
      }),
    pollForToken: (
      _providerUrl,
      _clientId,
      _clientSecret,
      _deviceCode,
      _signal,
    ) =>
      Promise.resolve({
        accessToken: "access-token-xyz",
        tokenType: "Bearer",
      }),
    getUserInfo: (_providerUrl, _accessToken, _groupsField, _signal) =>
      Promise.resolve({
        sub: "user-1",
        email: "user@example.com",
        name: "Test User",
        collectives: ["team-a"],
      }),
    checkAdmission: (
      _userSub,
      _collectives,
      _allowedCollectives,
      _allowedUsers,
    ) => ({
      admitted: true,
      reason: "user is in the allowed-users list",
    }),
    mintServerToken: (
      _principalId,
      _principalEmail,
      _collectives,
      _repoDir,
      _repoContext,
    ) => Promise.resolve("oauth-user-1-1234567890.secret-token"),
    ...overrides,
  };
}

function postRequest(path: string, body?: Record<string, unknown>): Request {
  return new Request(`http://localhost:8080${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function getRequest(path: string): Request {
  return new Request(`http://localhost:8080${path}`, { method: "GET" });
}

// ── Route matching ────────────────────────────────────────────────────

Deno.test("handleDeviceAuth: returns null for non-matching path", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(
    postRequest("/some/other/path"),
    deps,
  );
  assertEquals(result, null);
});

Deno.test("handleDeviceAuth: returns null for /auth but not /auth/device", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(postRequest("/auth"), deps);
  assertEquals(result, null);
});

// ── Method enforcement ────────────────────────────────────────────────

Deno.test("handleDeviceAuth: returns 405 for GET /auth/device", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(getRequest("/auth/device"), deps);
  assertEquals(result?.status, 405);
  const body = await result!.json();
  assertEquals(body.error, "Method not allowed");
});

Deno.test("handleDeviceAuth: returns 405 for GET /auth/device/token", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(
    getRequest("/auth/device/token"),
    deps,
  );
  assertEquals(result?.status, 405);
  const body = await result!.json();
  assertEquals(body.error, "Method not allowed");
});

// ── POST /auth/device ─────────────────────────────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device returns device grant response", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(postRequest("/auth/device"), deps);
  assertEquals(result?.status, 200);
  const body = await result!.json();
  assertEquals(body.deviceCode, "dev-code-123");
  assertEquals(body.userCode, "ABCD-EFGH");
  assertEquals(body.verificationUri, "https://auth.example.com/device");
  assertEquals(body.expiresIn, 900);
  assertEquals(body.interval, 5);
});

Deno.test("handleDeviceAuth: POST /auth/device returns 502 on provider error", async () => {
  const deps = makeMockDeps({
    startDeviceGrant: () => Promise.reject(new Error("connection refused")),
  });
  const result = await handleDeviceAuth(postRequest("/auth/device"), deps);
  assertEquals(result?.status, 502);
  const body = await result!.json();
  assertEquals(body.error, "Failed to start device authorization");
});

// ── POST /auth/device/token — validation ──────────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device/token returns 400 for missing deviceCode", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", {}),
    deps,
  );
  assertEquals(result?.status, 400);
  const body = await result!.json();
  assertEquals(body.error, "Missing or invalid deviceCode");
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 400 for non-string deviceCode", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: 123 }),
    deps,
  );
  assertEquals(result?.status, 400);
  const body = await result!.json();
  assertEquals(body.error, "Missing or invalid deviceCode");
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 400 for invalid JSON", async () => {
  const deps = makeMockDeps();
  const req = new Request("http://localhost:8080/auth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  });
  const result = await handleDeviceAuth(req, deps);
  assertEquals(result?.status, 400);
  const body = await result!.json();
  assertEquals(body.error, "Invalid JSON body");
});

// ── POST /auth/device/token — poll errors ─────────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device/token returns 202 for authorization_pending", async () => {
  const deps = makeMockDeps({
    pollForToken: () =>
      Promise.reject(new DeviceGrantPollError("authorization_pending")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 202);
  const body = await result!.json();
  assertEquals(body.status, "pending");
  assertEquals(body.slowDown, undefined);
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 202 with slowDown for slow_down", async () => {
  const deps = makeMockDeps({
    pollForToken: () => Promise.reject(new DeviceGrantPollError("slow_down")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 202);
  const body = await result!.json();
  assertEquals(body.status, "pending");
  assertEquals(body.slowDown, true);
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 410 for expired_token", async () => {
  const deps = makeMockDeps({
    pollForToken: () =>
      Promise.reject(new DeviceGrantPollError("expired_token")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 410);
  const body = await result!.json();
  assertEquals(body.error, "Device code expired");
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 403 for access_denied", async () => {
  const deps = makeMockDeps({
    pollForToken: () =>
      Promise.reject(new DeviceGrantPollError("access_denied")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 403);
  const body = await result!.json();
  assertEquals(body.error, "Authorization denied by user");
});

// ── POST /auth/device/token — admission ───────────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device/token returns 403 when admission denied", async () => {
  const deps = makeMockDeps({
    checkAdmission: () => ({
      admitted: false,
      reason: "user is not a member of any allowed collective (team-a)",
    }),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 403);
  const body = await result!.json();
  assertEquals(body.error, "Not admitted");
  assertEquals(
    body.reason,
    "user is not a member of any allowed collective (team-a)",
  );
});

// ── POST /auth/device/token — success ─────────────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device/token returns token and principal on success", async () => {
  const deps = makeMockDeps();
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 200);
  const body = await result!.json();
  assertEquals(body.token, "oauth-user-1-1234567890.secret-token");
  assertEquals(body.principal.id, "user:user-1");
  assertEquals(body.principal.email, "user@example.com");
  assertEquals(body.principal.name, "Test User");
  assertEquals(body.principal.collectives, ["team-a"]);
});

Deno.test("handleDeviceAuth: POST /auth/device/token passes correct args to deps", async () => {
  let capturedProviderUrl = "";
  let capturedClientId = "";
  let capturedClientSecret = "";
  let capturedDeviceCode = "";
  let capturedGroupsField = "";
  let capturedPrincipalId = "";
  let capturedPrincipalEmail = "";
  let capturedCollectives: string[] = [];

  const deps = makeMockDeps({
    pollForToken: (
      providerUrl,
      clientId,
      clientSecret,
      deviceCode,
      _signal,
    ) => {
      capturedProviderUrl = providerUrl;
      capturedClientId = clientId;
      capturedClientSecret = clientSecret;
      capturedDeviceCode = deviceCode;
      return Promise.resolve({
        accessToken: "tok-123",
        tokenType: "Bearer",
      });
    },
    getUserInfo: (_providerUrl, _accessToken, groupsField, _signal) => {
      capturedGroupsField = groupsField;
      return Promise.resolve({
        sub: "sub-42",
        email: "sub42@example.com",
        collectives: ["team-x"],
      });
    },
    mintServerToken: (
      principalId,
      principalEmail,
      collectives,
      _repoDir,
      _repoContext,
    ) => {
      capturedPrincipalId = principalId;
      capturedPrincipalEmail = principalEmail;
      capturedCollectives = collectives;
      return Promise.resolve("minted-token.secret");
    },
  });

  await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "my-device-code" }),
    deps,
  );

  assertEquals(capturedProviderUrl, "https://auth.example.com");
  assertEquals(capturedClientId, "test-client-id");
  assertEquals(capturedClientSecret, "test-client-secret");
  assertEquals(capturedDeviceCode, "my-device-code");
  assertEquals(capturedGroupsField, "collectives");
  assertEquals(capturedPrincipalId, "user:sub-42");
  assertEquals(capturedPrincipalEmail, "sub42@example.com");
  assertEquals(capturedCollectives, ["team-x"]);
});

// ── POST /auth/device/token — unexpected error ────────────────────────

Deno.test("handleDeviceAuth: POST /auth/device/token returns 500 on unexpected error", async () => {
  const deps = makeMockDeps({
    pollForToken: () => Promise.reject(new Error("unexpected failure")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 500);
  const body = await result!.json();
  assertEquals(body.error, "Internal error during token exchange");
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 500 on getUserInfo error", async () => {
  const deps = makeMockDeps({
    getUserInfo: () => Promise.reject(new Error("userinfo endpoint down")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 500);
  const body = await result!.json();
  assertEquals(body.error, "Internal error during token exchange");
});

Deno.test("handleDeviceAuth: POST /auth/device/token returns 500 on mintServerToken error", async () => {
  const deps = makeMockDeps({
    mintServerToken: () => Promise.reject(new Error("vault unavailable")),
  });
  const result = await handleDeviceAuth(
    postRequest("/auth/device/token", { deviceCode: "dev-123" }),
    deps,
  );
  assertEquals(result?.status, 500);
  const body = await result!.json();
  assertEquals(body.error, "Internal error during token exchange");
});
