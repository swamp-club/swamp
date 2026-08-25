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
import { LIFECYCLE_SUMMARY_MAX_CHARS, SwampClubClient } from "./swamp_club.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

function buildClientWithFetchStub(): {
  client: SwampClubClient;
  posts: CapturedPost[];
  restore: () => void;
} {
  const posts: CapturedPost[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (init?.method === "POST" && init?.body) {
      posts.push({
        url,
        body: JSON.parse(init.body as string),
      });
    }

    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const client = new SwampClubClient(
    "https://fake.swamp.club",
    "fake-key",
    42,
  );

  return {
    client,
    posts,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ---------------------------------------------------------------------------
// postLifecycleEntry summary truncation
// ---------------------------------------------------------------------------

Deno.test("postLifecycleEntry: sends summary unchanged when at the limit", async () => {
  const { client, posts, restore } = buildClientWithFetchStub();
  try {
    const summary = "a".repeat(LIFECYCLE_SUMMARY_MAX_CHARS);
    await client.postLifecycleEntry({
      step: "test",
      targetStatus: "open",
      summary,
      emoji: "\u{1F50D}",
      payload: {},
    });

    assertEquals(posts.length, 1);
    assertEquals(posts[0].body.summary, summary);
  } finally {
    restore();
  }
});

Deno.test("postLifecycleEntry: sends summary unchanged when below the limit", async () => {
  const { client, posts, restore } = buildClientWithFetchStub();
  try {
    const summary = "Short summary";
    await client.postLifecycleEntry({
      step: "test",
      targetStatus: "open",
      summary,
      emoji: "\u{1F50D}",
      payload: {},
    });

    assertEquals(posts.length, 1);
    assertEquals(posts[0].body.summary, summary);
  } finally {
    restore();
  }
});

Deno.test("postLifecycleEntry: truncates summary exceeding the limit with ellipsis", async () => {
  const { client, posts, restore } = buildClientWithFetchStub();
  try {
    const summary = "x".repeat(LIFECYCLE_SUMMARY_MAX_CHARS + 500);
    await client.postLifecycleEntry({
      step: "test",
      targetStatus: "open",
      summary,
      emoji: "\u{1F50D}",
      payload: {},
    });

    assertEquals(posts.length, 1);
    const sent = posts[0].body.summary as string;
    assertEquals(sent.length, LIFECYCLE_SUMMARY_MAX_CHARS);
    assertEquals(sent.endsWith("..."), true);
    assertEquals(
      sent,
      "x".repeat(LIFECYCLE_SUMMARY_MAX_CHARS - 3) + "...",
    );
  } finally {
    restore();
  }
});

Deno.test("postLifecycleEntry: truncates summary one char over the limit", async () => {
  const { client, posts, restore } = buildClientWithFetchStub();
  try {
    const summary = "y".repeat(LIFECYCLE_SUMMARY_MAX_CHARS + 1);
    await client.postLifecycleEntry({
      step: "test",
      targetStatus: "open",
      summary,
      emoji: "\u{1F50D}",
      payload: {},
    });

    assertEquals(posts.length, 1);
    const sent = posts[0].body.summary as string;
    assertEquals(sent.length, LIFECYCLE_SUMMARY_MAX_CHARS);
    assertEquals(sent.endsWith("..."), true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// postAttestation
// ---------------------------------------------------------------------------

Deno.test("postAttestation: returns server response on success", async () => {
  const originalFetch = globalThis.fetch;
  const serverResponse = {
    id: "test-uuid",
    postedBy: "user-123",
    postedAt: "2026-08-25T15:00:00Z",
    version: "1",
  };

  globalThis.fetch = ((_input: string | URL | Request): Promise<Response> => {
    return Promise.resolve(
      new Response(JSON.stringify(serverResponse), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const client = new SwampClubClient(
      "https://fake.swamp-club.com",
      "fake-key",
      42,
    );
    const result = await client.postAttestation({ version: "1" });
    assertEquals(result.id, "test-uuid");
    assertEquals(result.postedBy, "user-123");
    assertEquals(result.postedAt, "2026-08-25T15:00:00Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("postAttestation: throws on non-OK response with status and body", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: string | URL | Request): Promise<Response> => {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const client = new SwampClubClient(
      "https://fake.swamp-club.com",
      "fake-key",
      42,
    );
    await assertRejects(
      () => client.postAttestation({ version: "1" }),
      Error,
      "Attestation POST failed: HTTP 403",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
