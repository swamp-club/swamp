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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  errorFrom,
  HttpTransport,
  outcomeUnknown,
  refusedBeforeActing,
  refuseInBrowser,
  serveBaseUrl,
} from "./http_transport.ts";
import { FAST, scriptedFetch, SERVE } from "./http_test_helpers.ts";

const always = () => true;
const never = () => false;

Deno.test("HttpTransport.post: an older serve's plain-text 404 reads as route_unavailable", async () => {
  const { fetch } = scriptedFetch([{ status: 404, text: "Not found" }]);
  const transport = new HttpTransport(SERVE, 1000, { fetch });
  const reply = await transport.post("/api/v1/action", "t", {}, {
    route: "action",
    retry: never,
  });
  assertEquals(reply.code, "route_unavailable");
  const error = errorFrom(reply, "action");
  assertEquals(error.code, "route_unavailable");
  assert(error.message.includes("upgrade serve"));
});

Deno.test("HttpTransport.post: retries a rate limit after its Retry-After, then answers", async () => {
  const { fetch, sent } = scriptedFetch([
    {
      status: 429,
      body: { code: "rate_limited" },
      headers: { "retry-after": "0" },
    },
    { status: 200, body: { ok: true } },
  ]);
  const transport = new HttpTransport(SERVE, 1000, { fetch, ...FAST });
  const reply = await transport.post("/x", "t", {}, {
    route: "x",
    retry: refusedBeforeActing,
  });
  assertEquals(reply.status, 200);
  assertEquals(sent.length, 2);
});

Deno.test("HttpTransport.post: stops at the attempt limit and when Retry-After outruns the wait budget", async () => {
  const limited = {
    status: 503,
    body: { code: "x" },
    headers: { "retry-after": "0" },
  };
  const capped = scriptedFetch([limited, limited, limited, limited]);
  await new HttpTransport(SERVE, 1000, { fetch: capped.fetch, ...FAST }).post(
    "/x",
    "t",
    {},
    { route: "x", retry: always },
  );
  assertEquals(capped.sent.length, 3);

  const slow = scriptedFetch([
    { status: 503, body: { code: "x" }, headers: { "retry-after": "120" } },
  ]);
  const reply = await new HttpTransport(SERVE, 1000, {
    fetch: slow.fetch,
    maxRetryWaitMs: 1000,
  }).post("/x", "t", {}, { route: "x", retry: always });
  assertEquals(reply.retryAfterSeconds, 120);
  assertEquals(slow.sent.length, 1);
});

Deno.test("HttpTransport.post: no answer is status 0, network_error or timeout, and names no URL", async () => {
  const down = scriptedFetch(["network_error"]);
  const reply = await new HttpTransport(SERVE, 1000, { fetch: down.fetch })
    .post("/x", "t", {}, { route: "x", retry: never });
  assertEquals([reply.status, reply.code], [0, "network_error"]);
  assert(!errorFrom(reply, "x").message.includes("serve.test"));

  const hung = scriptedFetch(["hang"]);
  const late = await new HttpTransport(SERVE, 20, { fetch: hung.fetch })
    .post("/x", "t", {}, { route: "x", retry: never });
  assertEquals([late.status, late.code], [0, "timeout"]);
  assert(outcomeUnknown(late));
});

Deno.test("HttpTransport.post: the caller's abort ends the call with its reason", async () => {
  const hung = scriptedFetch(["hang"]);
  const controller = new AbortController();
  const call = new HttpTransport(SERVE, 10_000, { fetch: hung.fetch }).post(
    "/x",
    "t",
    {},
    { route: "x", retry: always, signal: controller.signal },
  );
  controller.abort(new Error("stop"));
  await assertRejects(() => call, Error, "stop");
});

Deno.test("HttpTransport.post: reads serve's Date header and sends the bearer", async () => {
  const date = new Date(Date.UTC(2026, 0, 1)).toUTCString();
  const { fetch, sent } = scriptedFetch([
    { status: 200, body: {}, headers: { date } },
  ]);
  const reply = await new HttpTransport(SERVE, 1000, { fetch }).post(
    "/api/v1/action",
    "secret-bearer",
    { a: 1 },
    { route: "action", retry: never },
  );
  assertEquals(reply.serverDateMs, Date.parse(date));
  assertEquals(sent[0].authorization, "Bearer secret-bearer");
  assertEquals(sent[0].url, `${SERVE}/api/v1/action`);
});

Deno.test("refusedBeforeActing: rate limits, busy and timed 503s, but never an unknown outcome", () => {
  const r = (status: number, code: string, retryAfterSeconds?: number) => ({
    status,
    code,
    body: {},
    receivedAtMs: 0,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
  assert(refusedBeforeActing(r(429, "rate_limited")));
  assert(refusedBeforeActing(r(409, "busy", 1)));
  assert(refusedBeforeActing(r(503, "shutting_down", 5)));
  assert(!refusedBeforeActing(r(503, "team_not_ready")));
  assert(!refusedBeforeActing(r(503, "outcome_unknown", 5)));
  assert(!refusedBeforeActing(r(503, "still_working", 1)));
  assert(!refusedBeforeActing(r(409, "already_decided")));
});

Deno.test("refuseInBrowser: refuses where a document exists", () => {
  assertThrows(
    () => refuseInBrowser("SwampActionClient", { document: {} }),
    Error,
    "does not run in a browser",
  );
  refuseInBrowser("SwampActionClient", {});
});

Deno.test("serveBaseUrl: takes http and https, trims a trailing slash, refuses ws", () => {
  assertEquals(serveBaseUrl("https://s.test/"), "https://s.test");
  assertEquals(serveBaseUrl("http://s.test/base/"), "http://s.test/base");
  assertThrows(() => serveBaseUrl("ws://s.test"), Error, "http: or https:");
});
