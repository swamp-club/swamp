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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SpanStatusCode, withSpan } from "../infrastructure/tracing/mod.ts";
import {
  findSpan,
  isChildOf,
  SpanKind,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import { resolveHttpRoute, traceHttpRequests } from "./http_request_span.ts";

const INFO = {
  remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1234 },
  completed: Promise.resolve(),
} as unknown as Deno.ServeHandlerInfo;

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

Deno.test("resolveHttpRoute: maps known paths to low-cardinality routes", () => {
  const cases: Array<[string, string | undefined]> = [
    ["/", "/"],
    ["/health", "/health"],
    ["/ready", "/ready"],
    ["/auth/info", "/auth/info"],
    ["/auth/device", "/auth/device"],
    ["/auth/device/token", "/auth/device/token"],
    ["/auth/dashboard/device", "/auth/dashboard/device"],
    ["/auth/dashboard/device/token", "/auth/dashboard/device/token"],
    ["/auth/dashboard/session", "/auth/dashboard/session"],
    ["/api/v1/health/stream", "/api/v1/health/stream"],
    ["/api/v1/cancel", "/api/v1/cancel"],
    ["/api/v1/cancel/method-run/abc-123", "/api/v1/cancel/{kind}/{id}"],
    ["/api/v1/cancel/workflow-run/def", "/api/v1/cancel/{kind}/{id}"],
    ["/dashboard", "/dashboard"],
    ["/dashboard/assets/app.js", "/dashboard/*"],
    ["/data", "/data/*"],
    ["/data/models/x/y", "/data/*"],
    ["/bundle/abc", "/bundle/*"],
  ];
  for (const [path, expected] of cases) {
    assertEquals(resolveHttpRoute(path), expected, path);
  }
});

Deno.test("resolveHttpRoute: returns undefined for unknown and webhook paths", () => {
  for (
    const path of [
      "/hooks/s3cr3t-token",
      "/wp-admin",
      "/api/v1/cancel/other-run/x",
      "/api/v1/cancel/method-run/x/extra",
      "/database",
      "/auth/device/token/extra",
    ]
  ) {
    assertEquals(resolveHttpRoute(path), undefined, path);
  }
});

Deno.test("traceHttpRequests: names the span by method and route with status", async () => {
  await withCapturedSpans(async (spans) => {
    const handler = traceHttpRequests(() =>
      new Response("pending", { status: 202 })
    );
    const res = await handler(
      request("/auth/device/token?x=1", { method: "POST" }),
      INFO,
    );
    assertEquals(res.status, 202);
    const span = findSpan(spans, "POST /auth/device/token");
    assertEquals(span.kind, SpanKind.SERVER);
    assertEquals(span.parentSpanId, undefined);
    assertEquals(span.attributes["http.request.method"], "POST");
    assertEquals(span.attributes["http.route"], "/auth/device/token");
    assertEquals(span.attributes["url.path"], undefined);
    assertEquals(span.attributes["http.response.status_code"], 202);
    assertEquals(span.status.code, SpanStatusCode.UNSET);
  });
});

Deno.test("traceHttpRequests: records no path or route for an unknown path", async () => {
  await withCapturedSpans(async (spans) => {
    const handler = traceHttpRequests(() => new Response("ok"));
    await handler(request("/hooks/s3cr3t-token", { method: "POST" }), INFO);
    const span = findSpan(spans, "POST");
    assertEquals(span.attributes["http.route"], undefined);
    assertEquals(span.attributes["url.path"], undefined);
    assertEquals(span.attributes["http.response.status_code"], 200);
  });
});

Deno.test("traceHttpRequests: never records the path under a templated route", async () => {
  await withCapturedSpans(async (spans) => {
    // A webhook route can sit under a templated prefix and hold a secret.
    const handler = traceHttpRequests(() => new Response("ok"));
    await handler(request("/dashboard/s3cr3t-token", { method: "POST" }), INFO);
    const span = findSpan(spans, "POST /dashboard/*");
    for (const value of Object.values(span.attributes)) {
      assert(!String(value).includes("s3cr3t-token"));
    }
  });
});

Deno.test("traceHttpRequests: reports a non-standard method as _OTHER", async () => {
  await withCapturedSpans(async (spans) => {
    const handler = traceHttpRequests(() =>
      new Response("nope", { status: 405 })
    );
    await handler(request("/ready", { method: "FOO1" }), INFO);
    const span = findSpan(spans, "_OTHER /ready");
    assertEquals(span.attributes["http.request.method"], "_OTHER");
    assertEquals(span.attributes["http.request.method_original"], "FOO1");
  });
});

Deno.test("traceHttpRequests: marks 5xx ERROR but not 4xx", async () => {
  await withCapturedSpans(async (spans) => {
    const notFound = traceHttpRequests(() =>
      new Response("nope", { status: 404 })
    );
    const failing = traceHttpRequests(() =>
      new Response("broken", { status: 500 })
    );
    await notFound(request("/auth/info"), INFO);
    await failing(request("/ready"), INFO);
    assertEquals(
      findSpan(spans, "GET /auth/info").status.code,
      SpanStatusCode.UNSET,
    );
    assertEquals(
      findSpan(spans, "GET /ready").status.code,
      SpanStatusCode.ERROR,
    );
  });
});

Deno.test("traceHttpRequests: records a thrown error and rethrows it", async () => {
  await withCapturedSpans(async (spans) => {
    const handler = traceHttpRequests(() => {
      throw new Error("handler exploded");
    });
    await assertRejects(
      async () => await handler(request("/ready"), INFO),
      Error,
      "handler exploded",
    );
    assertEquals(
      findSpan(spans, "GET /ready").status.code,
      SpanStatusCode.ERROR,
    );
  });
});

Deno.test("traceHttpRequests: parents spans started by the handler", async () => {
  await withCapturedSpans(async (spans) => {
    const handler = traceHttpRequests(async () => {
      await withSpan("swamp.serve.auth.mint", {}, () => Promise.resolve());
      return new Response("ok");
    });
    await handler(request("/auth/device/token", { method: "POST" }), INFO);
    assert(
      isChildOf(
        findSpan(spans, "swamp.serve.auth.mint"),
        findSpan(spans, "POST /auth/device/token"),
      ),
    );
  });
});

Deno.test("traceHttpRequests: creates no span for a WebSocket upgrade", async () => {
  await withCapturedSpans(async (spans) => {
    let called = false;
    const handler = traceHttpRequests(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    await handler(request("/", { headers: { upgrade: "WebSocket" } }), INFO);
    assert(called);
    assertEquals(spans.length, 0);
  });
});
