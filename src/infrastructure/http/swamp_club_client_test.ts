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
import { assertStringIncludes } from "@std/assert/string-includes";
import { SwampClubClient } from "./swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";

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

Deno.test("SwampClubClient - sends x-api-key header for whoami", async () => {
  let capturedApiKey = "";
  const mock = startMockServer((req) => {
    capturedApiKey = req.headers.get("x-api-key") ?? "";
    return Response.json({ authenticated: true, username: "u" });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.whoami("my-api-key");
    assertEquals(capturedApiKey, "my-api-key");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - submitIssue posts source=swamp with input fields", async () => {
  let capturedBody: Record<string, unknown> = {};
  let capturedApiKey = "";
  const mock = startMockServer(async (req) => {
    capturedApiKey = req.headers.get("x-api-key") ?? "";
    capturedBody = await req.json();
    return Response.json(
      { issue: { number: 42, id: "issue-id-1" } },
      { status: 201 },
    );
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.submitIssue("my-api-key", {
      type: "bug",
      title: "Crash on launch",
      body: "Repro steps...",
    });
    assertEquals(result.number, 42);
    assertEquals(result.id, "issue-id-1");
    assertEquals(capturedApiKey, "my-api-key");
    assertEquals(capturedBody.source, "swamp");
    assertEquals(capturedBody.type, "bug");
    assertEquals(capturedBody.title, "Crash on launch");
    assertEquals(capturedBody.body, "Repro steps...");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - submitIssue throws UserError on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Bad request", { status: 400 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () =>
        client.submitIssue("key", {
          type: "feature",
          title: "t",
          body: "b",
        }),
      UserError,
      "Failed to submit issue",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssueStatus sends PATCH with status", async () => {
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedApiKey = "";
  const mock = startMockServer(async (req) => {
    capturedMethod = req.method;
    capturedApiKey = req.headers.get("x-api-key") ?? "";
    capturedBody = await req.json();
    return Response.json({ issue: { number: 42, status: "closed" } });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.updateIssueStatus("my-key", 42, "closed");
    assertEquals(capturedMethod, "PATCH");
    assertEquals(capturedApiKey, "my-key");
    assertEquals(capturedBody.status, "closed");
    assertEquals(result.status, "closed");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssueStatus throws on 404", async () => {
  const mock = startMockServer((_req) =>
    new Response("Not found", { status: 404 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateIssueStatus("key", 999, "closed"),
      UserError,
      "Issue #999 not found",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssueStatus throws on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Forbidden", { status: 403 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateIssueStatus("key", 42, "open"),
      UserError,
      "Failed to update issue #42 status",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssue sends PATCH with title and body", async () => {
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedApiKey = "";
  const mock = startMockServer(async (req) => {
    capturedMethod = req.method;
    capturedApiKey = req.headers.get("x-api-key") ?? "";
    capturedBody = await req.json();
    return Response.json({
      issue: { number: 42, title: "New title", body: "New body" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.updateIssue("my-key", 42, {
      title: "New title",
      body: "New body",
    });
    assertEquals(capturedMethod, "PATCH");
    assertEquals(capturedApiKey, "my-key");
    assertEquals(capturedBody.title, "New title");
    assertEquals(capturedBody.body, "New body");
    assertEquals(result.title, "New title");
    assertEquals(result.body, "New body");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssue sends only provided fields", async () => {
  let capturedBody: Record<string, unknown> = {};
  const mock = startMockServer(async (req) => {
    capturedBody = await req.json();
    return Response.json({
      issue: { number: 1, title: "Updated title", body: "Same body" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.updateIssue("key", 1, { title: "Updated title" });
    assertEquals(capturedBody.title, "Updated title");
    assertEquals(capturedBody.body, undefined);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssue throws on 404", async () => {
  const mock = startMockServer((_req) =>
    new Response("Not found", { status: 404 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateIssue("key", 999, { title: "x" }),
      UserError,
      "Issue #999 not found",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssue throws on 403", async () => {
  const mock = startMockServer((_req) =>
    new Response("Forbidden", { status: 403 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateIssue("key", 42, { title: "x" }),
      UserError,
      "do not have permission",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - updateIssue surfaces profanity on 422", async () => {
  const mock = startMockServer((_req) =>
    Response.json(
      { error: "Profanity detected", flagged: ["badword"] },
      { status: 422 },
    )
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.updateIssue("key", 42, { title: "badword" }),
      UserError,
      "badword",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - 429 surfaces Retry-After in UserError", async () => {
  const mock = startMockServer((_req) =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "30" },
    })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const err = await assertRejects(
      () => client.fetchIssue(undefined, 1),
      UserError,
    );
    assertStringIncludes(err.message, "Rate limit exceeded");
    assertStringIncludes(err.message, "Retry in 30s");
    assertStringIncludes(err.message, "swamp auth login");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient - 429 without Retry-After still surfaces sign-in hint", async () => {
  const mock = startMockServer((_req) =>
    new Response("rate limited", { status: 429 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const err = await assertRejects(
      () => client.fetchIssue(undefined, 1),
      UserError,
    );
    assertStringIncludes(err.message, "Rate limit exceeded");
    assertEquals(err.message.includes("Retry in"), false);
    assertStringIncludes(err.message, "swamp auth login");
  } finally {
    await mock.shutdown();
  }
});

// ── Identity header injection ─────────────────────────────────────────

Deno.test("SwampClubClient sends both identity headers when constructed with bearerToken and distinctId", async () => {
  const captured: Record<string, string | null> = {};
  const mock = startMockServer((req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return Response.json({
      issue: { number: 1, title: "x", type: "bug", status: "open" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`, {
      bearerToken: "swamp_test-key",
      distinctId: "device-uuid-abc",
    });
    await client.fetchIssue("swamp_test-key", 1);
    assertEquals(captured.authorization, "Bearer swamp_test-key");
    assertEquals(captured.distinctId, "device-uuid-abc");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient sends only Swamp-Distinct-Id when bearerToken is absent", async () => {
  const captured: Record<string, string | null> = {};
  const mock = startMockServer((req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return Response.json({
      issue: { number: 1, title: "x", type: "bug", status: "open" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`, {
      distinctId: "device-uuid-xyz",
    });
    await client.fetchIssue(undefined, 1);
    assertEquals(captured.authorization, null);
    assertEquals(captured.distinctId, "device-uuid-xyz");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient sends no identity headers when constructed without identity", async () => {
  const captured: Record<string, string | null> = {};
  const mock = startMockServer((req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return Response.json({
      issue: { number: 1, title: "x", type: "bug", status: "open" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.fetchIssue(undefined, 1);
    assertEquals(captured.authorization, null);
    assertEquals(captured.distinctId, null);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient sends constructor bearer when no caller Authorization is set", async () => {
  // Half (a) of the precedence contract: when nothing on the call sets
  // Authorization, the constructor-supplied bearer goes out.
  const captured: Record<string, string | null> = {};
  const mock = startMockServer((req) => {
    captured.authorization = req.headers.get("authorization");
    return Response.json({
      issue: { number: 1, title: "x", type: "bug", status: "open" },
    });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`, {
      bearerToken: "swamp_only-from-constructor",
    });
    // fetchIssue passes apiKey via `x-api-key`, NOT Authorization, so the
    // constructor's Authorization Bearer is the only one set on this call.
    await client.fetchIssue(undefined, 1);
    assertEquals(captured.authorization, "Bearer swamp_only-from-constructor");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("SwampClubClient lets caller-supplied Authorization win over constructor identity", async () => {
  // Half (b) of the precedence contract: createApiKey() sends its own
  // Authorization header carrying the BetterAuth session token. That
  // caller-supplied header must win over the constructor's personal-key
  // bearer or the user-session flow breaks.
  const captured: Record<string, string | null> = {};
  const mock = startMockServer((req) => {
    captured.authorization = req.headers.get("authorization");
    captured.distinctId = req.headers.get("swamp-distinct-id");
    return Response.json({ id: "key-id", key: "swamp_new-key" });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`, {
      bearerToken: "swamp_ctor-bearer",
      distinctId: "device-1",
    });
    await client.createApiKey("session-token-xyz", "my-laptop");
    // Caller's session-token Authorization wins.
    assertEquals(captured.authorization, "Bearer session-token-xyz");
    // Constructor's distinctId still goes out — the caller didn't set
    // Swamp-Distinct-Id, so there is no conflict.
    assertEquals(captured.distinctId, "device-1");
  } finally {
    await mock.shutdown();
  }
});
