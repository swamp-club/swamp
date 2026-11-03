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

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  HTTP_REQUEST_TYPES as CORE_HTTP_REQUEST_TYPES,
  SERVE_REQUEST_PATH as CORE_SERVE_REQUEST_PATH,
} from "../../../../src/serve/protocol.ts";
import {
  HTTP_REQUEST_TYPES,
  HttpReads,
  requestOverHttp,
  SERVE_REQUEST_PATH,
} from "./http_request.ts";
import { RequestError } from "./stream.ts";

const READ = { type: "data.get", id: "r1", payload: { dataName: "big" } };

function replying(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
  return { calls, fetchFn };
}

function ndjson(...frames: unknown[]): Response {
  return new Response(frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
}

Deno.test("HTTP_REQUEST_TYPES: the dashboard's copy matches core's", () => {
  assertEquals(
    [...HTTP_REQUEST_TYPES].sort(),
    [...CORE_HTTP_REQUEST_TYPES].sort(),
  );
  assertEquals(SERVE_REQUEST_PATH, CORE_SERVE_REQUEST_PATH);
});

Deno.test("requestOverHttp: posts the request as JSON with the page's headers and cookie", async () => {
  const { calls, fetchFn } = replying(
    ndjson({ type: "data.get", id: "r1", payload: { ok: true } }),
  );
  await requestOverHttp(
    fetchFn,
    "/w/alpha/api/v1/request",
    { "x-swamp-local-token": "t" },
    READ,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "/w/alpha/api/v1/request");
  assertEquals(calls[0].init.method, "POST");
  assertEquals(calls[0].init.credentials, "same-origin");
  assertEquals(calls[0].init.redirect, "manual");
  assertEquals(calls[0].init.headers, {
    "x-swamp-local-token": "t",
    "content-type": "application/json",
  });
  assertEquals(JSON.parse(String(calls[0].init.body)), READ);
});

Deno.test("requestOverHttp: resolves on the payload frame for its own id", async () => {
  const { fetchFn } = replying(ndjson(
    { type: "event", id: "r1", event: { kind: "progress" } },
    { type: "data.get", id: "other", payload: { wrong: true } },
    { type: "data.get", id: "r1", payload: { right: true } },
  ));
  assertEquals(await requestOverHttp(fetchFn, "/api/v1/request", {}, READ), {
    kind: "payload",
    value: { right: true },
  });
});

Deno.test("requestOverHttp: an error frame rejects with serve's code and details", async () => {
  const { fetchFn } = replying(ndjson({
    type: "error",
    id: "r1",
    error: {
      code: "not_found",
      message: "gone",
      details: { reason: "expired" },
    },
  }));
  const error = await assertRejects(
    () => requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
    RequestError,
    "gone",
  );
  assertEquals(error.code, "not_found");
  assertEquals(error.reason, "expired");
});

Deno.test("requestOverHttp: a body that ends without a reply rejects", async () => {
  const { fetchFn } = replying(new Response(""));
  await assertRejects(
    () => requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
    Error,
    "closed before a response",
  );
});

Deno.test("requestOverHttp: falls back to the socket on 404, 405, use_websocket, or a body serve did not write", async () => {
  const fallbacks = [
    new Response("Not found", { status: 404 }),
    Response.json({ code: "method_not_allowed", message: "no" }, {
      status: 405,
    }),
    Response.json({ code: "use_websocket", message: "busy" }, { status: 429 }),
    new Response("<html>bad gateway</html>", { status: 502 }),
    Response.json({ unexpected: true }, { status: 500 }),
  ];
  for (const response of fallbacks) {
    const { fetchFn } = replying(response);
    assertEquals(
      await requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
      { kind: "route_missing" },
    );
  }
});

Deno.test("requestOverHttp: a 401 from the route means the session or its token is no longer accepted", async () => {
  const { fetchFn } = replying(
    Response.json({
      code: "unauthorized",
      message: "Unauthorized: dashboard session expired",
    }, { status: 401 }),
  );
  assertEquals(await requestOverHttp(fetchFn, "/api/v1/request", {}, READ), {
    kind: "signed_out",
    message: "Unauthorized: dashboard session expired",
  });
});

Deno.test("requestOverHttp: an unauthorized error frame is a permission denial, not a sign-out", async () => {
  const { fetchFn } = replying(ndjson({
    type: "error",
    id: "r1",
    error: { code: "unauthorized", message: "no read on this model" },
  }));
  const error = await assertRejects(
    () => requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
    RequestError,
    "no read on this model",
  );
  assertEquals(error.code, "unauthorized");
});

Deno.test("requestOverHttp: a serve refusal other than 401 rejects instead of falling back", async () => {
  const { fetchFn } = replying(
    Response.json({
      code: "forbidden",
      message: "Forbidden: dashboard session origin mismatch",
    }, { status: 403 }),
  );
  const error = await assertRejects(
    () => requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
    RequestError,
    "origin mismatch",
  );
  assertEquals(error.code, "forbidden");
});

Deno.test("requestOverHttp: a not_leader refusal from a stale follower rejects rather than falling back", async () => {
  const leader = { url: "https://leader.test" };
  const { fetchFn } = replying(
    Response.json({ code: "not_leader", message: "stale", leader }, {
      status: 503,
    }),
  );
  const error = await assertRejects(
    () => requestOverHttp(fetchFn, "/api/v1/request", {}, READ),
    RequestError,
  );
  assertEquals(error.code, "not_leader");
});

Deno.test("HttpReads: a read while the socket is down is refused before any request", async () => {
  const reads = new HttpReads();
  let started = false;
  await assertRejects(
    () =>
      reads.run(false, () => {
        started = true;
        return Promise.resolve("never");
      }),
    Error,
    "Not connected",
  );
  assertEquals(started, false);
});

Deno.test("HttpReads: a disconnect rejects every read in flight as the socket's pending reads are", async () => {
  const reads = new HttpReads();
  const signals: AbortSignal[] = [];
  const pending = [1, 2].map(() =>
    reads.run(
      true,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    )
  );
  reads.abortAll();
  for (const read of pending) {
    const error = await assertRejects(() => read);
    assertInstanceOf(error, Error);
    assertEquals(error.message, "WebSocket closed");
  }
  assertEquals(signals.every((s) => s.aborted), true);
});

Deno.test("HttpReads: a read that settles is no longer aborted by a later disconnect", async () => {
  const reads = new HttpReads();
  let seen: AbortSignal | undefined;
  const value = await reads.run(true, (signal) => {
    seen = signal;
    return Promise.resolve("done");
  });
  reads.abortAll();
  assertEquals(value, "done");
  assertEquals(seen?.aborted, false);
});
