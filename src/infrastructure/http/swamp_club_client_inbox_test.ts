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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SwampClubClient } from "./swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";

const SERVER = "https://club.test";
const KEY = "key-123";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./inbox_responses.fixture.json", import.meta.url),
  ),
);

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/**
 * A client whose fetch answers from `handler` and records every request, and
 * whose sleep records every wait instead of waiting.
 */
function stubClient(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
) {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const client = new SwampClubClient(SERVER, {}, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    fetch: async (url, init) => {
      init?.signal?.throwIfAborted();
      const req: RecordedRequest = {
        url: new URL(String(url)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined,
      };
      requests.push(req);
      return await handler(req);
    },
  });
  return { client, requests, sleeps };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// inboxSummary
// ---------------------------------------------------------------------------

Deno.test("inboxSummary: returns the summary and its ETag", async () => {
  const { client, requests } = stubClient(() =>
    Response.json(fixture.summary, { headers: { etag: '"v1"' } })
  );
  const result = await client.inboxSummary(KEY, null, signal());
  assertEquals(result, { kind: "ok", summary: fixture.summary, etag: '"v1"' });
  assertEquals(requests[0].url.pathname, "/api/inbox/summary");
  assertEquals(requests[0].headers.get("x-api-key"), KEY);
  assertEquals(requests[0].headers.get("if-none-match"), null);
});

Deno.test("inboxSummary: an answer with no ETag returns a null etag", async () => {
  const { client } = stubClient(() => Response.json(fixture.summary));
  const result = await client.inboxSummary(KEY, null, signal());
  assertEquals(result.kind === "ok" && result.etag, null);
});

Deno.test("inboxSummary: sends the etag as If-None-Match and maps 304 to not_modified", async () => {
  const { client, requests } = stubClient(() =>
    new Response(null, { status: 304 })
  );
  const result = await client.inboxSummary(KEY, '"v1"', signal());
  assertEquals(result, { kind: "not_modified" });
  assertEquals(requests[0].headers.get("if-none-match"), '"v1"');
});

Deno.test("inboxSummary: 404 is unsupported", async () => {
  const { client } = stubClient(() => new Response("nope", { status: 404 }));
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "unsupported",
  });
});

Deno.test("inboxSummary: 403 inbox_requires_user is unavailable", async () => {
  const { client } = stubClient(() =>
    Response.json(fixture.inboxRequiresUser, { status: 403 })
  );
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "unavailable",
  });
});

Deno.test("inboxSummary: a gateway's 403 is failed, not unavailable", async () => {
  const { client } = stubClient(() =>
    Response.json({ error: "forbidden" }, { status: 403 })
  );
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "failed",
    reason: "HTTP 403",
  });
});

Deno.test("inboxSummary: 401 is rejected", async () => {
  const { client } = stubClient(() => new Response(null, { status: 401 }));
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "rejected",
  });
});

Deno.test("inboxSummary: 429 returns backoff at once, with no retry and no sleep", async () => {
  const { client, requests, sleeps } = stubClient(() =>
    new Response(null, { status: 429, headers: { "retry-after": "120" } })
  );
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "backoff",
    retryAfterSeconds: 120,
  });
  assertEquals(requests.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("inboxSummary: 429 without Retry-After is backoff with no delay", async () => {
  const { client } = stubClient(() => new Response(null, { status: 429 }));
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "backoff",
  });
});

Deno.test("inboxSummary: 5xx is failed", async () => {
  const { client } = stubClient(() => new Response("oops", { status: 502 }));
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "failed",
    reason: "HTTP 502",
  });
});

Deno.test("inboxSummary: a body that is not JSON or not the contract is failed", async () => {
  for (const body of ["<html>portal</html>", JSON.stringify({ unread: "2" })]) {
    const { client } = stubClient(() => new Response(body, { status: 200 }));
    assertEquals(await client.inboxSummary(KEY, null, signal()), {
      kind: "failed",
      reason: "malformed response",
    });
  }
});

Deno.test("inboxSummary: an aborted signal returns failed rather than throwing", async () => {
  const { client } = stubClient(() => Response.json(fixture.summary));
  const result = await client.inboxSummary(
    KEY,
    null,
    AbortSignal.abort(),
  );
  assertEquals(result, { kind: "failed", reason: "timeout" });
});

Deno.test("inboxSummary: a refused connection returns failed", async () => {
  const { client } = stubClient(() => {
    throw new TypeError("error sending request: connection refused");
  });
  assertEquals(await client.inboxSummary(KEY, null, signal()), {
    kind: "failed",
    reason: "connection failed",
  });
});

Deno.test("inboxSummary: a body cut off by the signal returns failed", async () => {
  const controller = new AbortController();
  const { client } = stubClient(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"unread":'));
        controller.abort();
        c.error(new DOMException("aborted", "AbortError"));
      },
    });
    return new Response(stream, { status: 200 });
  });
  assertEquals(await client.inboxSummary(KEY, null, controller.signal), {
    kind: "failed",
    reason: "timeout",
  });
});

Deno.test("inboxSummary: an etag no header may carry returns failed rather than throwing", async () => {
  const { client, requests } = stubClient(() => Response.json(fixture.summary));
  assertEquals(await client.inboxSummary(KEY, '"v\n1"', signal()), {
    kind: "failed",
    reason: "invalid request header",
  });
  assertEquals(requests.length, 0);
});

/** A 200 whose body errors with `error` after its first bytes. */
function brokenBody(error: Error, onStart?: () => void): Response {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"messages":'));
      onStart?.();
      c.error(error);
    },
  });
  return new Response(stream, { status: 200 });
}

// ---------------------------------------------------------------------------
// listInboxMessages
// ---------------------------------------------------------------------------

Deno.test("listInboxMessages: returns the page and sends no query by default", async () => {
  const { client, requests } = stubClient(() =>
    Response.json(fixture.messagesPage)
  );
  const page = await client.listInboxMessages(KEY);
  assertEquals(page.messages.length, fixture.messagesPage.messages.length);
  assertEquals(page.nextCursor, fixture.messagesPage.nextCursor);
  assertEquals(requests[0].url.pathname, "/api/inbox/messages");
  assertEquals(requests[0].url.search, "");
  assertEquals(requests[0].headers.get("x-api-key"), KEY);
});

Deno.test("listInboxMessages: sends status, limit and before, and nextCursor round-trips", async () => {
  const { client, requests } = stubClient((req) =>
    Response.json(
      req.url.searchParams.has("before")
        ? { messages: [], nextCursor: null }
        : fixture.messagesPage,
    )
  );
  const first = await client.listInboxMessages(KEY, {
    status: "all",
    limit: 2,
  });
  const second = await client.listInboxMessages(KEY, {
    status: "all",
    limit: 2,
    before: first.nextCursor!,
  });
  assertEquals(requests[0].url.searchParams.get("status"), "all");
  assertEquals(requests[0].url.searchParams.get("limit"), "2");
  assertEquals(
    requests[1].url.searchParams.get("before"),
    fixture.messagesPage.nextCursor,
  );
  assertEquals(second, { messages: [], nextCursor: null });
});

Deno.test("listInboxMessages: drops a malformed entry and keeps the rest", async () => {
  const good = fixture.messagesPage.messages;
  const { client } = stubClient(() =>
    Response.json({
      messages: [good[0], { id: "bad" }, good[1]],
      nextCursor: null,
    })
  );
  const page = await client.listInboxMessages(KEY);
  assertEquals(page.messages.map((m) => m.id), [good[0].id, good[1].id]);
});

Deno.test("listInboxMessages: strips terminal escapes from a listed message", async () => {
  const raw = {
    ...fixture.message,
    title: "\x1b[2JHello",
  };
  const { client } = stubClient(() =>
    Response.json({ messages: [raw], nextCursor: null })
  );
  const page = await client.listInboxMessages(KEY);
  assertEquals(page.messages[0].title, "Hello");
});

Deno.test("listInboxMessages: 404 says the server has no inbox", async () => {
  const { client } = stubClient(() => new Response("", { status: 404 }));
  await assertRejects(
    () => client.listInboxMessages(KEY),
    UserError,
    "This Swamp Club server has no inbox.",
  );
});

Deno.test("listInboxMessages: 403 inbox_requires_user asks for a personal key", async () => {
  const { client } = stubClient(() =>
    Response.json(fixture.inboxRequiresUser, { status: 403 })
  );
  await assertRejects(
    () => client.listInboxMessages(KEY),
    UserError,
    "The inbox needs a personal API key; collective keys have no inbox.",
  );
});

Deno.test("listInboxMessages: 401 points at swamp auth login", async () => {
  const { client } = stubClient(() => new Response("", { status: 401 }));
  await assertRejects(
    () => client.listInboxMessages(KEY),
    UserError,
    'Swamp Club rejected your API key. Run "swamp auth login".',
  );
});

Deno.test("listInboxMessages: another failure lifts the error field and never echoes a raw body", async () => {
  const lifted = stubClient(() =>
    Response.json({ error: "maintenance" }, { status: 503 })
  );
  const err = await assertRejects(
    () => lifted.client.listInboxMessages(KEY),
    UserError,
  );
  assertEquals(
    err.message,
    "Failed to list your inbox (HTTP 503): maintenance",
  );

  const proxy = stubClient(() =>
    new Response("<html><body>Bad gateway</body></html>", { status: 502 })
  );
  const proxyErr = await assertRejects(
    () => proxy.client.listInboxMessages(KEY),
    UserError,
  );
  assertEquals(proxyErr.message, "Failed to list your inbox (HTTP 502).");
});

Deno.test("listInboxMessages: a malformed envelope throws", async () => {
  const { client } = stubClient(() => Response.json({ items: [] }));
  await assertRejects(
    () => client.listInboxMessages(KEY),
    UserError,
    "malformed inbox page",
  );
});

Deno.test("listInboxMessages: a body cut off by the caller's signal rethrows the abort", async () => {
  const controller = new AbortController();
  const { client } = stubClient(() =>
    brokenBody(
      new DOMException("aborted", "AbortError"),
      () => controller.abort(),
    )
  );
  const err = await assertRejects(
    () => client.listInboxMessages(KEY, {}, controller.signal),
    DOMException,
  );
  assertEquals(err.name, "AbortError");
});

Deno.test("listInboxMessages: a body read that times out says so, not malformed", async () => {
  const { client } = stubClient(() =>
    brokenBody(new DOMException("timed out", "TimeoutError"))
  );
  const err = await assertRejects(
    () => client.listInboxMessages(KEY),
    UserError,
  );
  assertEquals(err.code, "timeout");
  assertStringIncludes(err.message, "timed out");
});

Deno.test("getInboxMessage: a dropped connection while reading says so, not malformed", async () => {
  const { client } = stubClient(() =>
    brokenBody(new TypeError("connection reset"))
  );
  await assertRejects(
    () => client.getInboxMessage(KEY, fixture.message.id),
    UserError,
    "Could not read the answer from https://club.test: connection reset",
  );
});

// ---------------------------------------------------------------------------
// getInboxMessage
// ---------------------------------------------------------------------------

Deno.test("getInboxMessage: returns the message and encodes the id", async () => {
  const { client, requests } = stubClient(() => Response.json(fixture.message));
  const message = await client.getInboxMessage(KEY, fixture.message.id);
  assertEquals(message.id, fixture.message.id);
  assertEquals(message.action, fixture.message.action);
  await client.getInboxMessage(KEY, "a/b?c");
  assertEquals(
    requests[1].url.pathname,
    "/api/inbox/messages/a%2Fb%3Fc",
  );
});

Deno.test("getInboxMessage: 404 names the message", async () => {
  const { client } = stubClient(() => new Response("", { status: 404 }));
  await assertRejects(
    () => client.getInboxMessage(KEY, "01JBX5Q8ZK00000000000000Z8"),
    UserError,
    "Message 01JBX5Q8ZK00000000000000Z8 not found.",
  );
});

Deno.test("getInboxMessage: 403 inbox_requires_user asks for a personal key", async () => {
  const { client } = stubClient(() =>
    Response.json(fixture.inboxRequiresUser, { status: 403 })
  );
  await assertRejects(
    () => client.getInboxMessage(KEY, fixture.message.id),
    UserError,
    "The inbox needs a personal API key; collective keys have no inbox.",
  );
});

Deno.test("getInboxMessage: a malformed message throws", async () => {
  const { client } = stubClient(() => Response.json({ id: "x" }));
  await assertRejects(
    () => client.getInboxMessage(KEY, "x"),
    UserError,
    "malformed answer for message x",
  );
});

// ---------------------------------------------------------------------------
// markInboxRead
// ---------------------------------------------------------------------------

Deno.test("markInboxRead: sends { ids } and returns only the ids the server confirmed", async () => {
  const [a, b] = fixture.markRead.read as string[];
  const unknown = "01JBX5Q8ZK00000000000000ZZ";
  const { client, requests } = stubClient(() =>
    Response.json(fixture.markRead)
  );
  const read = await client.markInboxRead(KEY, [b, unknown, a]);
  assertEquals(read, [b, a]);
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].url.pathname, "/api/inbox/read");
  assertEquals(requests[0].headers.get("content-type"), "application/json");
  assertEquals(requests[0].body, { ids: [b, unknown, a] });
});

Deno.test("markInboxRead: ignores confirmed ids that were never requested", async () => {
  const { client } = stubClient(() => Response.json({ read: ["a", "other"] }));
  assertEquals(await client.markInboxRead(KEY, ["a"]), ["a"]);
});

Deno.test("markInboxRead: an empty list makes no request", async () => {
  const { client, requests } = stubClient(() => Response.json({ read: [] }));
  assertEquals(await client.markInboxRead(KEY, []), []);
  assertEquals(requests.length, 0);
});

Deno.test("markInboxRead: removes duplicates and sends batches of at most 100", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const { client, requests } = stubClient((req) =>
    Response.json({ read: (req.body as { ids: string[] }).ids })
  );
  const read = await client.markInboxRead(KEY, [...ids, ids[0], ids[1]]);
  assertEquals(read, ids);
  assertEquals(
    requests.map((r) => (r.body as { ids: string[] }).ids.length),
    [100, 100, 50],
  );
});

Deno.test("markInboxRead: 403 inbox_requires_user and 404 throw plain messages", async () => {
  const forbidden = stubClient(() =>
    Response.json(fixture.inboxRequiresUser, { status: 403 })
  );
  await assertRejects(
    () => forbidden.client.markInboxRead(KEY, ["a"]),
    UserError,
    "The inbox needs a personal API key; collective keys have no inbox.",
  );
  const missing = stubClient(() => new Response("", { status: 404 }));
  await assertRejects(
    () => missing.client.markInboxRead(KEY, ["a"]),
    UserError,
    "This Swamp Club server has no inbox.",
  );
});

Deno.test("markInboxRead: a malformed answer throws", async () => {
  const { client } = stubClient(() => Response.json({ ok: true }));
  const err = await assertRejects(
    () => client.markInboxRead(KEY, ["a"]),
    UserError,
  );
  assertStringIncludes(err.message, "malformed");
  assert(!err.message.includes("ok"));
});
