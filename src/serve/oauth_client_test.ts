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

import { assertEquals, assertRejects } from "@std/assert";
import {
  DeviceGrantPollError,
  getUserInfo,
  pollForToken,
  resolveUsername,
  startDeviceGrant,
} from "./oauth_client.ts";

/** Start a simple mock HTTP server that returns canned responses. */
function startMockServer(
  handler: (req: Request) => Response | Promise<Response>,
): { port: number; shutdown: () => Promise<void> } {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen() {} },
    handler,
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    async shutdown() {
      ac.abort();
      await server.finished;
    },
  };
}

// ── startDeviceGrant ────────────────────────────────────────────────────

Deno.test("startDeviceGrant: returns device grant response with camelCase fields", async () => {
  const mock = startMockServer((req) => {
    assertEquals(new URL(req.url).pathname, "/api/auth/device/code");
    assertEquals(req.method, "POST");
    return Response.json({
      device_code: "dev-123",
      user_code: "ABCD-1234",
      verification_uri: "https://example.com/activate",
      verification_uri_complete: "https://example.com/activate?code=ABCD-1234",
      expires_in: 900,
      interval: 5,
    });
  });
  try {
    const result = await startDeviceGrant(
      `http://localhost:${mock.port}`,
      "test-client",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.deviceCode, "dev-123");
    assertEquals(result.userCode, "ABCD-1234");
    assertEquals(result.verificationUri, "https://example.com/activate");
    assertEquals(
      result.verificationUriComplete,
      "https://example.com/activate?code=ABCD-1234",
    );
    assertEquals(result.expiresIn, 900);
    assertEquals(result.interval, 5);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("startDeviceGrant: omits verificationUriComplete when absent", async () => {
  const mock = startMockServer(() =>
    Response.json({
      device_code: "dev-456",
      user_code: "WXYZ-9999",
      verification_uri: "https://example.com/activate",
      expires_in: 600,
      interval: 10,
    })
  );
  try {
    const result = await startDeviceGrant(
      `http://localhost:${mock.port}`,
      "test-client",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.verificationUriComplete, undefined);
    assertEquals(result.deviceCode, "dev-456");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("startDeviceGrant: sends client_id in JSON body", async () => {
  let receivedBody: Record<string, unknown> = {};
  const mock = startMockServer(async (req) => {
    receivedBody = await req.json();
    return Response.json({
      device_code: "d",
      user_code: "U",
      verification_uri: "https://example.com",
      expires_in: 60,
      interval: 5,
    });
  });
  try {
    await startDeviceGrant(
      `http://localhost:${mock.port}`,
      "my-client-id",
      AbortSignal.timeout(5000),
    );
    assertEquals(receivedBody.client_id, "my-client-id");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("startDeviceGrant: throws on HTTP error", async () => {
  const mock = startMockServer(() =>
    new Response("Bad Request", { status: 400 })
  );
  try {
    await assertRejects(
      () =>
        startDeviceGrant(
          `http://localhost:${mock.port}`,
          "test-client",
          AbortSignal.timeout(5000),
        ),
      Error,
      "Device authorization request failed: 400",
    );
  } finally {
    await mock.shutdown();
  }
});

// ── pollForToken ────────────────────────────────────────────────────────

Deno.test("pollForToken: returns access token on success", async () => {
  const mock = startMockServer((req) => {
    assertEquals(new URL(req.url).pathname, "/api/auth/device/token");
    assertEquals(req.method, "POST");
    return Response.json({ access_token: "tok-abc" });
  });
  try {
    const result = await pollForToken(
      `http://localhost:${mock.port}`,
      "client-id",
      "client-secret",
      "device-code",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.accessToken, "tok-abc");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: sends correct JSON body", async () => {
  let receivedBody: Record<string, unknown> = {};
  const mock = startMockServer(async (req) => {
    receivedBody = await req.json();
    return Response.json({ access_token: "tok" });
  });
  try {
    await pollForToken(
      `http://localhost:${mock.port}`,
      "cid",
      "csecret",
      "dcode",
      AbortSignal.timeout(5000),
    );
    assertEquals(receivedBody.client_id, "cid");
    assertEquals(receivedBody.client_secret, "csecret");
    assertEquals(receivedBody.device_code, "dcode");
    assertEquals(
      receivedBody.grant_type,
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: throws DeviceGrantPollError for authorization_pending", async () => {
  const mock = startMockServer(() =>
    Response.json({ error: "authorization_pending" }, { status: 400 })
  );
  try {
    const error = await assertRejects(
      () =>
        pollForToken(
          `http://localhost:${mock.port}`,
          "c",
          "s",
          "d",
          AbortSignal.timeout(5000),
        ),
      DeviceGrantPollError,
      "authorization_pending",
    );
    assertEquals(error.code, "authorization_pending");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: throws DeviceGrantPollError for slow_down", async () => {
  const mock = startMockServer(() =>
    Response.json({ error: "slow_down" }, { status: 400 })
  );
  try {
    const error = await assertRejects(
      () =>
        pollForToken(
          `http://localhost:${mock.port}`,
          "c",
          "s",
          "d",
          AbortSignal.timeout(5000),
        ),
      DeviceGrantPollError,
      "slow_down",
    );
    assertEquals(error.code, "slow_down");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: throws DeviceGrantPollError for expired_token", async () => {
  const mock = startMockServer(() =>
    Response.json({ error: "expired_token" }, { status: 400 })
  );
  try {
    const error = await assertRejects(
      () =>
        pollForToken(
          `http://localhost:${mock.port}`,
          "c",
          "s",
          "d",
          AbortSignal.timeout(5000),
        ),
      DeviceGrantPollError,
      "expired_token",
    );
    assertEquals(error.code, "expired_token");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: throws DeviceGrantPollError for access_denied", async () => {
  const mock = startMockServer(() =>
    Response.json({ error: "access_denied" }, { status: 400 })
  );
  try {
    const error = await assertRejects(
      () =>
        pollForToken(
          `http://localhost:${mock.port}`,
          "c",
          "s",
          "d",
          AbortSignal.timeout(5000),
        ),
      DeviceGrantPollError,
      "access_denied",
    );
    assertEquals(error.code, "access_denied");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("pollForToken: throws generic Error for unknown error code", async () => {
  const mock = startMockServer(() =>
    Response.json({ error: "server_error" }, { status: 500 })
  );
  try {
    await assertRejects(
      () =>
        pollForToken(
          `http://localhost:${mock.port}`,
          "c",
          "s",
          "d",
          AbortSignal.timeout(5000),
        ),
      Error,
      "Token request failed: 500",
    );
  } finally {
    await mock.shutdown();
  }
});

// ── getUserInfo ─────────────────────────────────────────────────────────

Deno.test("getUserInfo: returns user info with collectives", async () => {
  const mock = startMockServer((req) => {
    assertEquals(new URL(req.url).pathname, "/api/auth/oauth2/userinfo");
    assertEquals(req.headers.get("Authorization"), "Bearer my-token");
    return Response.json({
      sub: "user-1",
      email: "user@example.com",
      name: "Test User",
      collectives: ["org-a", "org-b"],
    });
  });
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "my-token",
      "collectives",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.sub, "user-1");
    assertEquals(result.email, "user@example.com");
    assertEquals(result.name, "Test User");
    assertEquals(result.collectives, ["org-a", "org-b"]);
    assertEquals(result.groups, ["org-a", "org-b"]);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: falls back to collectives when groups field absent", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-fallback",
      email: "fallback@example.com",
      collectives: ["team-a"],
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "my-token",
      "collectives",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.groups, ["team-a"]);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: uses custom groupsField", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-2",
      email: "user2@example.com",
      name: "User Two",
      teams: ["team-x"],
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "tok",
      "teams",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.collectives, ["team-x"]);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: defaults collectives and groups to empty arrays when fields are missing", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-3",
      email: "user3@example.com",
      name: "User Three",
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "tok",
      "collectives",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.collectives, []);
    assertEquals(result.groups, []);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: defaults collectives to empty array when field is not an array", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-4",
      email: "user4@example.com",
      name: "User Four",
      groups: "not-an-array",
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "tok",
      "groups",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.collectives, []);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: parses groups field separately from collectives", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-5",
      email: "user5@example.com",
      collectives: ["acme-corp"],
      groups: ["platform-eng", "developers"],
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "tok",
      "collectives",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.collectives, ["acme-corp"]);
    assertEquals(result.groups, ["platform-eng", "developers"]);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: filters non-string values from groups array", async () => {
  const mock = startMockServer(() =>
    Response.json({
      sub: "user-6",
      email: "user6@example.com",
      collectives: [],
      groups: ["valid-group", 42, null, "another-group"],
    })
  );
  try {
    const result = await getUserInfo(
      `http://localhost:${mock.port}`,
      "tok",
      "collectives",
      AbortSignal.timeout(5000),
    );
    assertEquals(result.groups, ["valid-group", "another-group"]);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("getUserInfo: throws on HTTP error", async () => {
  const mock = startMockServer(() =>
    new Response("Forbidden", { status: 403 })
  );
  try {
    await assertRejects(
      () =>
        getUserInfo(
          `http://localhost:${mock.port}`,
          "bad-token",
          "groups",
          AbortSignal.timeout(5000),
        ),
      Error,
      "Userinfo request failed: 403",
    );
  } finally {
    await mock.shutdown();
  }
});

// ── resolveUsername ────────────────────────────────────────────────────

Deno.test("resolveUsername: returns sub on success", async () => {
  const mock = startMockServer(() =>
    Response.json({ sub: "6a4d58696938eea73751f36b" })
  );
  try {
    const sub = await resolveUsername(
      `http://localhost:${mock.port}`,
      "swampadmin",
      "my-token",
      AbortSignal.timeout(5000),
    );
    assertEquals(sub, "6a4d58696938eea73751f36b");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("resolveUsername: throws on 404", async () => {
  const mock = startMockServer(() =>
    new Response("Not Found", { status: 404 })
  );
  try {
    await assertRejects(
      () =>
        resolveUsername(
          `http://localhost:${mock.port}`,
          "nonexistent",
          "my-token",
          AbortSignal.timeout(5000),
        ),
      Error,
      "Username 'nonexistent' not found",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("resolveUsername: throws on other HTTP error", async () => {
  const mock = startMockServer(() =>
    new Response("Forbidden", { status: 403 })
  );
  try {
    await assertRejects(
      () =>
        resolveUsername(
          `http://localhost:${mock.port}`,
          "someuser",
          "bad-token",
          AbortSignal.timeout(5000),
        ),
      Error,
      "Failed to resolve username 'someuser': 403",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("resolveUsername: sends Bearer auth header", async () => {
  let receivedAuth = "";
  const mock = startMockServer((req) => {
    receivedAuth = req.headers.get("authorization") ?? "";
    return Response.json({ sub: "abc" });
  });
  try {
    await resolveUsername(
      `http://localhost:${mock.port}`,
      "testuser",
      "my-secret-token",
      AbortSignal.timeout(5000),
    );
    assertEquals(receivedAuth, "Bearer my-secret-token");
  } finally {
    await mock.shutdown();
  }
});
