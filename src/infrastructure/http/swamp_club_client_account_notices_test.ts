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
import { SwampClubClient } from "./swamp_club_client.ts";
import { MAX_ACCOUNT_NOTICES_BODY_BYTES } from "./account_notice_schemas.ts";

const SERVER = "https://club.test";
const KEY = "key-123";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./account_notices_response.fixture.json", import.meta.url),
  ),
);

function stubClient(handler: (url: URL, init?: RequestInit) => Response) {
  const requests: { url: URL; headers: Headers; redirect?: string }[] = [];
  const client = new SwampClubClient(SERVER, {}, {
    fetch: (url, init) => {
      init?.signal?.throwIfAborted();
      const parsed = new URL(String(url));
      requests.push({
        url: parsed,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      });
      return Promise.resolve(handler(parsed, init));
    },
  });
  return { client, requests };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

Deno.test("accountNotices: returns the parsed trial notices", async () => {
  const { client, requests } = stubClient(() => Response.json(fixture.notices));
  const result = await client.accountNotices(KEY, signal());
  assertEquals(result.kind, "ok");
  if (result.kind === "ok") {
    assertEquals(result.notices.map((n) => n.kind), [
      "trial-ended",
      "trial-ending",
    ]);
  }
  assertEquals(requests[0].url.pathname, "/api/v1/account/notices");
  assertEquals(requests[0].headers.get("x-api-key"), KEY);
  // a redirect could carry the key to another host
  assertEquals(requests[0].redirect, "error");
});

Deno.test("accountNotices: 403 notices_require_user is a collective key", async () => {
  const { client } = stubClient(() =>
    Response.json(fixture.collectiveKey, { status: 403 })
  );
  assertEquals(await client.accountNotices(KEY, signal()), {
    kind: "unavailable",
  });
});

Deno.test("accountNotices: any other 403 is a failure, not a collective key", async () => {
  for (
    const body of [
      JSON.stringify({ error: "forbidden" }),
      "<html>blocked</html>",
      "",
    ]
  ) {
    const { client } = stubClient(() => new Response(body, { status: 403 }));
    assertEquals(await client.accountNotices(KEY, signal()), {
      kind: "failed",
      reason: "HTTP 403",
    });
  }
});

Deno.test("accountNotices: 401 is a rejected key", async () => {
  const { client } = stubClient(() =>
    Response.json(fixture.unauthorized, { status: 401 })
  );
  assertEquals(await client.accountNotices(KEY, signal()), {
    kind: "rejected",
  });
});

Deno.test("accountNotices: 404 means the server has no account notices", async () => {
  const { client } = stubClient(() => new Response("", { status: 404 }));
  assertEquals(await client.accountNotices(KEY, signal()), {
    kind: "unsupported",
  });
});

Deno.test("accountNotices: 429 backs off, with Retry-After when given", async () => {
  const { client } = stubClient(() =>
    new Response("", { status: 429, headers: { "retry-after": "120" } })
  );
  assertEquals(await client.accountNotices(KEY, signal()), {
    kind: "backoff",
    retryAfterSeconds: 120,
  });
  const bare = stubClient(() => new Response("", { status: 429 }));
  assertEquals(await bare.client.accountNotices(KEY, signal()), {
    kind: "backoff",
  });
});

Deno.test("accountNotices: a 5xx or malformed body is a failure", async () => {
  const down = stubClient(() => new Response("", { status: 502 }));
  assertEquals(await down.client.accountNotices(KEY, signal()), {
    kind: "failed",
    reason: "HTTP 502",
  });
  const junk = stubClient(() => new Response("not json"));
  assertEquals(await junk.client.accountNotices(KEY, signal()), {
    kind: "failed",
    reason: "malformed response",
  });
});

Deno.test("accountNotices: a body over the cap is refused, declared or streamed", async () => {
  const big = JSON.stringify({
    notices: [],
    pad: "x".repeat(MAX_ACCOUNT_NOTICES_BODY_BYTES),
  });
  const declared = stubClient(() =>
    new Response(big, { headers: { "content-length": String(big.length) } })
  );
  assertEquals(await declared.client.accountNotices(KEY, signal()), {
    kind: "failed",
    reason: "response too large",
  });
  // no content-length: the stream itself is cut off at the cap
  const streamed = stubClient(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
    )
  );
  assertEquals(await streamed.client.accountNotices(KEY, signal()), {
    kind: "failed",
    reason: "response too large",
  });
});

Deno.test("accountNotices: a network failure or abort is a failure, never a throw", async () => {
  const client = new SwampClubClient(SERVER, {}, {
    fetch: () => Promise.reject(new TypeError("connection refused")),
  });
  assertEquals(await client.accountNotices(KEY, signal()), {
    kind: "failed",
    reason: "connection failed",
  });
  const aborted = new AbortController();
  aborted.abort();
  const { client: stub } = stubClient(() => Response.json(fixture.empty));
  assertEquals(await stub.accountNotices(KEY, aborted.signal), {
    kind: "failed",
    reason: "timeout",
  });
});
