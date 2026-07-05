// Swamp, an Automation Framework Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import { assertEquals } from "@std/assert";
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
