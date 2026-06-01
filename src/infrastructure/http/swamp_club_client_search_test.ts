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

Deno.test("searchIssues: returns issues and total", async () => {
  const mock = startMockServer((_req) =>
    Response.json({
      issues: [
        {
          number: 1,
          title: "First issue",
          type: "bug",
          status: "open",
          authorUsername: "alice",
          body: "Body text",
          assignees: [{ userId: "u1", username: "bob" }],
          comments: [{ id: "c1" }],
        },
      ],
      total: 42,
    })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.searchIssues("key-123");
    assertEquals(result.total, 42);
    assertEquals(result.issues.length, 1);
    assertEquals(result.issues[0].number, 1);
    assertEquals(result.issues[0].title, "First issue");
    assertEquals(result.issues[0].type, "bug");
    assertEquals(result.issues[0].status, "open");
    assertEquals(result.issues[0].author, "alice");
    assertEquals(result.issues[0].assignees, ["bob"]);
    assertEquals(result.issues[0].commentCount, 1);
  } finally {
    await mock.shutdown();
  }
});

Deno.test("searchIssues: sends query params", async () => {
  let capturedUrl = "";
  const mock = startMockServer((req) => {
    capturedUrl = req.url;
    return Response.json({ issues: [], total: 0 });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.searchIssues("key-123", {
      q: "vault",
      type: "bug",
      status: "open",
      source: "swamp",
      limit: 10,
      offset: 20,
    });
    const url = new URL(capturedUrl);
    assertEquals(url.searchParams.get("q"), "vault");
    assertEquals(url.searchParams.get("type"), "bug");
    assertEquals(url.searchParams.get("status"), "open");
    assertEquals(url.searchParams.get("source"), "swamp");
    assertEquals(url.searchParams.get("limit"), "10");
    assertEquals(url.searchParams.get("offset"), "20");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("searchIssues: omits empty params", async () => {
  let capturedUrl = "";
  const mock = startMockServer((req) => {
    capturedUrl = req.url;
    return Response.json({ issues: [], total: 0 });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.searchIssues(undefined);
    const url = new URL(capturedUrl);
    assertEquals(url.search, "");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("searchIssues: sends api key header", async () => {
  let capturedApiKey: string | null = null;
  const mock = startMockServer((req) => {
    capturedApiKey = req.headers.get("x-api-key");
    return Response.json({ issues: [], total: 0 });
  });
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await client.searchIssues("my-secret-key");
    assertEquals(capturedApiKey, "my-secret-key");
  } finally {
    await mock.shutdown();
  }
});

Deno.test("searchIssues: throws UserError on failure", async () => {
  const mock = startMockServer((_req) =>
    new Response("Bad request", { status: 400 })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    await assertRejects(
      () => client.searchIssues("key"),
      UserError,
      "Failed to search issues",
    );
  } finally {
    await mock.shutdown();
  }
});

Deno.test("searchIssues: handles missing total gracefully", async () => {
  const mock = startMockServer((_req) =>
    Response.json({
      issues: [
        {
          number: 5,
          title: "No total",
          type: "feature",
          status: "open",
          authorUsername: "eve",
          body: "",
          assignees: [],
          comments: [],
        },
      ],
    })
  );
  try {
    const client = new SwampClubClient(`http://localhost:${mock.port}`);
    const result = await client.searchIssues(undefined);
    assertEquals(result.total, 1);
    assertEquals(result.issues.length, 1);
  } finally {
    await mock.shutdown();
  }
});
