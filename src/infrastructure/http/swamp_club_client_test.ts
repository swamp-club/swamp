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
