// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { SwampClubClient } from "./swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";

/** Start a simple mock HTTP server that returns canned responses. */
function startMockServer(
  handler: (req: Request) => Response,
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

Deno.test("SwampClubClient - signIn returns token and user on success", async () => {
  const mock = startMockServer((_req) =>
    Response.json({
      token: "session-token-abc",
      user: {
        id: "u1",
        email: "test@example.com",
        name: "Test User",
        username: "testuser",
      },
    })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.signIn("testuser", "password123");
    assertEquals(result.token, "session-token-abc");
    assertEquals(result.user.username, "testuser");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - signIn throws UserError on 401", async () => {
  const mock = startMockServer((_req) =>
    new Response("Unauthorized", { status: 401 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.signIn("bad", "creds"),
      UserError,
      "Invalid username/email or password",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - createApiKey returns id and key", async () => {
  const mock = startMockServer((_req) =>
    Response.json({ id: "key-1", key: "swamp_abc123" })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.createApiKey("token", "test-key");
    assertEquals(result.id, "key-1");
    assertEquals(result.key, "swamp_abc123");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - createApiKey throws on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Bad request", { status: 400 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.createApiKey("token", "test-key"),
      UserError,
      "Failed to create API key",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - whoami returns user info", async () => {
  const mock = startMockServer((_req) =>
    Response.json({
      authenticated: true,
      id: "u1",
      username: "testuser",
      email: "test@example.com",
      name: "Test User",
    })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.whoami("swamp_key123");
    assertEquals(result.authenticated, true);
    assertEquals(result.username, "testuser");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - whoami returns unauthenticated on 401", async () => {
  const mock = startMockServer((_req) =>
    new Response("Unauthorized", { status: 401 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.whoami("bad-key");
    assertEquals(result.authenticated, false);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - throws UserError on connection failure", async () => {
  const client = new SwampClubClient("http://localhost:1");
  await assertRejects(
    () => client.whoami("key"),
    UserError,
    "Could not connect to",
  );
});

Deno.test("SwampClubClient - listApiKeys returns array of keys", async () => {
  const mock = startMockServer((_req) =>
    Response.json([
      {
        id: "key-1",
        name: "test-key",
        start: "swamp_abc",
        prefix: "swamp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null,
        lastRefillAt: null,
        rateLimitEnabled: false,
        rateLimitTimeWindow: 0,
        rateLimitMax: 0,
        requestCount: 0,
        remaining: null,
        refillAmount: null,
        refillInterval: null,
        metadata: null,
        expiresAt: null,
        permissions: null,
        userId: "u1",
      },
    ])
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.listApiKeys("token");
    assertEquals(result.length, 1);
    assertEquals(result[0].id, "key-1");
    assertEquals(result[0].name, "test-key");
    assertEquals(result[0].enabled, true);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - listApiKeys throws on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Unauthorized", { status: 401 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.listApiKeys("bad-token"),
      UserError,
      "Failed to list API keys",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateApiKey succeeds on 200", async () => {
  let capturedAuth = "";
  const mock = startMockServer((req) => {
    capturedAuth = req.headers.get("authorization") ?? "";
    return new Response(null, { status: 200 });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.updateApiKey("token", "key-1", false);
    assertEquals(capturedAuth, "Bearer token");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateApiKey throws on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Not found", { status: 404 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateApiKey("token", "bad-key", false),
      UserError,
      "Failed to update API key",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - deleteApiKey succeeds on 200", async () => {
  let capturedAuth = "";
  const mock = startMockServer((req) => {
    capturedAuth = req.headers.get("authorization") ?? "";
    return new Response(null, { status: 200 });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.deleteApiKey("token", "key-1");
    assertEquals(capturedAuth, "Bearer token");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - deleteApiKey throws on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Server error", { status: 500 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.deleteApiKey("token", "bad-key"),
      UserError,
      "Failed to delete API key",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - sends Authorization Bearer header for whoami", async () => {
  let capturedAuth = "";
  const mock = startMockServer((req) => {
    capturedAuth = req.headers.get("authorization") ?? "";
    return Response.json({ authenticated: true, username: "u" });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.whoami("my-api-key");
    assertEquals(capturedAuth, "Bearer my-api-key");
  } finally {
    await mock.shutdown();
  }
});
