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

// ---------------------------------------------------------------------------
// Upstream outcome reporting
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  url: string;
}

/**
 * Install a fetch stub driven by a per-call responder, recording every call so
 * a test can assert that a read was (or was not) attempted.
 */
function withScriptedFetch(
  respond: (call: RecordedCall, index: number) => Response | Error,
): { client: SwampClubClient; calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
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
    const call = { method: init?.method ?? "GET", url };
    const index = calls.length;
    calls.push(call);

    const result = respond(call, index);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }) as typeof fetch;

  return {
    client: new SwampClubClient("https://fake.swamp-club.com", "fake-key", 42),
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function issueResponse(status: string): Response {
  return new Response(
    JSON.stringify({ issue: { number: 42, status, type: "bug" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

Deno.test("postLifecycleEntry: reports the entry as accepted on success", async () => {
  const { client, restore } = withScriptedFetch(() =>
    new Response("{}", { status: 201 })
  );
  try {
    const outcome = await client.postLifecycleEntry({
      step: "classified",
      targetStatus: "triaged",
      summary: "ok",
      emoji: "x",
      payload: {},
    });
    assertEquals(outcome, { ok: true });
  } finally {
    restore();
  }
});

Deno.test("postLifecycleEntry: reports a rejection with status and body preserved", async () => {
  const body = JSON.stringify({ error: "payload keys must not start with $" });
  const { client, restore } = withScriptedFetch(() =>
    new Response(body, { status: 400 })
  );
  try {
    const outcome = await client.postLifecycleEntry({
      step: "classified",
      targetStatus: "triaged",
      summary: "ok",
      emoji: "x",
      payload: {},
    });
    assertEquals(outcome, {
      ok: false,
      reason: "rejected",
      status: 400,
      body,
    });
  } finally {
    restore();
  }
});

Deno.test("postLifecycleEntry: reports unavailable when the request throws", async () => {
  const { client, restore } = withScriptedFetch(() =>
    new Error("connection reset")
  );
  try {
    const outcome = await client.postLifecycleEntry({
      step: "classified",
      targetStatus: "triaged",
      summary: "ok",
      emoji: "x",
      payload: {},
    });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.reason, "unavailable");
  } finally {
    restore();
  }
});

Deno.test("submitComment: reports the ripple as accepted on success", async () => {
  const { client, restore } = withScriptedFetch(() =>
    new Response(JSON.stringify({ comment: { id: "c1" } }), { status: 201 })
  );
  try {
    assertEquals(await client.submitComment("thanks"), { ok: true });
  } finally {
    restore();
  }
});

Deno.test("submitComment: reports a rejection rather than returning null", async () => {
  const { client, restore } = withScriptedFetch(() =>
    new Response("nope", { status: 403 })
  );
  try {
    const outcome = await client.submitComment("thanks");
    assertEquals(outcome, {
      ok: false,
      reason: "rejected",
      status: 403,
      body: "nope",
    });
  } finally {
    restore();
  }
});

Deno.test("transitionStatus: a 422 is a no-op when a re-read confirms the requested status", async () => {
  const { client, calls, restore } = withScriptedFetch((call) =>
    call.method === "PATCH"
      ? new Response("precondition", { status: 422 })
      : issueResponse("triaged")
  );
  try {
    assertEquals(await client.transitionStatus("triaged"), {
      ok: true,
      noop: true,
    });
    assertEquals(calls.length, 2);
    assertEquals(calls[1].method, "GET");
  } finally {
    restore();
  }
});

Deno.test("transitionStatus: a 422 is a real failure when the re-read shows another status", async () => {
  const { client, restore } = withScriptedFetch((call) =>
    call.method === "PATCH"
      ? new Response("precondition", { status: 422 })
      : issueResponse("open")
  );
  try {
    const outcome = await client.transitionStatus("triaged");
    assertEquals(outcome.ok, false);
    if (!outcome.ok && outcome.reason === "rejected") {
      assertEquals(outcome.status, 422);
    }
  } finally {
    restore();
  }
});

Deno.test("transitionStatus: retries the re-read once before giving up", async () => {
  const { client, calls, restore } = withScriptedFetch((call, index) => {
    if (call.method === "PATCH") return new Response("", { status: 422 });
    return index === 1 ? new Error("flaky read") : issueResponse("triaged");
  });
  try {
    assertEquals(await client.transitionStatus("triaged"), {
      ok: true,
      noop: true,
    });
    assertEquals(calls.length, 3);
  } finally {
    restore();
  }
});

Deno.test("transitionStatus: a 422 is a real failure when the re-read keeps failing", async () => {
  const { client, calls, restore } = withScriptedFetch((call) =>
    call.method === "PATCH"
      ? new Response("", { status: 422 })
      : new Error("unreachable")
  );
  try {
    const outcome = await client.transitionStatus("triaged");
    assertEquals(outcome.ok, false);
    assertEquals(calls.length, 3);
  } finally {
    restore();
  }
});

Deno.test("updateType: a 422 is a plain failure and attempts no re-read", async () => {
  const { client, calls, restore } = withScriptedFetch(() =>
    new Response("bad type", { status: 422 })
  );
  try {
    const outcome = await client.updateType("bug");
    assertEquals(outcome, {
      ok: false,
      reason: "rejected",
      status: 422,
      body: "bad type",
    });
    assertEquals(calls.length, 1);
  } finally {
    restore();
  }
});

Deno.test("updateAssignees: stays best-effort and never throws on rejection", async () => {
  const { client, calls, restore } = withScriptedFetch(() =>
    new Response("nope", { status: 422 })
  );
  try {
    await client.updateAssignees(["u1"]);
    assertEquals(calls.length, 1);
  } finally {
    restore();
  }
});

Deno.test("fetchIssue: maps the author's user id alongside the handle", async () => {
  const { client, restore } = withScriptedFetch(() =>
    new Response(
      JSON.stringify({
        issue: {
          number: 42,
          authorUsername: "skunk-ape",
          authorId: "user-skunk-ape",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  );
  try {
    const issue = await client.fetchIssue();
    assertEquals(issue?.author, "skunk-ape");
    assertEquals(issue?.authorId, "user-skunk-ape");
  } finally {
    restore();
  }
});

Deno.test("fetchIssue: leaves authorId undefined when the server omits it", async () => {
  const { client, restore } = withScriptedFetch(() => issueResponse("open"));
  try {
    const issue = await client.fetchIssue();
    assertEquals(issue?.authorId, undefined);
  } finally {
    restore();
  }
});

Deno.test("fetchIssue: drops an author id that is not a string", async () => {
  const { client, restore } = withScriptedFetch(() =>
    Response.json({
      issue: { number: 42, authorUsername: "skunk-ape", authorId: 1234 },
    })
  );
  try {
    const issue = await client.fetchIssue();
    assertEquals(issue?.author, "skunk-ape");
    assertEquals(issue?.authorId, undefined);
  } finally {
    restore();
  }
});
